/**
 * The endpoint core: operations over the shadowed terminal controller and the
 * owner-scoped registry. Every operation runs against terminals this plugin
 * created; `send` regains control by re-attaching when the user holds it; the
 * attachment consumer maintains the sanitized transcript, settles write
 * acknowledgements, and fires (once per episode) an inject notice when the
 * user takes over.
 *
 * Conventions (plugin-development-guide.md §3):
 *   C4 — operations return canonical JSON values; rendering lives in tools.ts.
 *   C5 — non-ideal business outcomes (limit_reached, regained_control, the
 *        wait_for five-state) are values; infrastructure failures throw.
 *   C6 — the caller's signal is honored at every await point.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/endpoint
 */
import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentChannel } from './attachment.js'
import { EndpointRegistry, mintTerminalId, type ManagedTerminal } from './registry.js'
import { sanitizeTerminalText } from './sanitize.js'
import { remoteErrorCode, remoteErrorDetails, type TerminalFrameShadow, type TerminalOwnerLike, type TerminalSurface, type WebTerminalInfoShadow } from './shadow.js'
import { compilePattern, resolveTimeoutMs, sleepWithAbort, waitForPattern, type TerminalReadResult, type TerminalSessionSnapshot, type WaitOutcome } from './wait-for.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'sidebar-terminal-tools': { kind: 'sidebar-terminal-tools' } & ContextFormed
  }
}

/** Resolved configuration consumed by the endpoint core. */
export interface EndpointCoreConfig {
  readonly transcriptLines: number
  readonly transcriptBytes: number
  readonly defaultTimeoutMs: number
  readonly minTimeoutMs: number
  readonly maxTimeoutMs: number
  readonly pollIntervalMs: number
  readonly tailLines: number
  readonly maxLineTextChars: number
  readonly maxTailBytes: number
  readonly maxMessageChars: number
}

/** The agent surface the endpoint core needs: owner identity plus inject(). */
export type OwnerAgent = TerminalOwnerLike & { inject(message: unknown): void }

/** Successful `sidebar_terminal_open` value. */
export interface OpenedTerminal {
  readonly outcome: 'opened'
  readonly terminalId: string
  readonly shell: string
  readonly shellPath: string | null
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: WebTerminalInfoShadow['state']
}

/** Canonical quota-exhaustion value of `sidebar_terminal_open`. */
export interface LimitReached {
  readonly outcome: 'limit_reached'
  readonly limit: number
  readonly message: string
}

/** `sidebar_terminal_send` value. */
export interface SendResult {
  readonly wrote: number
  readonly regained_control: boolean
  readonly state: WebTerminalInfoShadow['state']
}

/** `sidebar_terminal_read` value: the paged transcript plus terminal state. */
export interface ReadPage extends TerminalReadResult {
  readonly state: WebTerminalInfoShadow['state']
  readonly exitCode: number | null
}

/** `sidebar_terminal_list` entry. */
export interface TerminalSummary {
  readonly terminalId: string
  readonly title: string
  readonly shell: string
  readonly cwd: string
  readonly state: WebTerminalInfoShadow['state']
  readonly exitCode: number | null
  readonly lines: number
  readonly controller: 'plugin' | 'user' | 'none'
}

/**
 * Classify who holds input control in one attachment frame.
 * @param info - the frame's terminal metadata.
 * @param writable - whether this attachment holds input control (the frame's
 * writability bit; upstream replaced `info.controllerId` with it).
 * @returns 'user' when someone else controls a running terminal, 'ours' when
 * this attachment does, 'unattached' once the process left the running state
 * (input control is meaningless there).
 */
export function detectControllerChange(info: WebTerminalInfoShadow, writable: boolean): 'user' | 'ours' | 'unattached' {
  if (writable) return 'ours'
  return info.state === 'running' ? 'user' : 'unattached'
}

/** The takeover reminder the model receives via `agent.inject`. */
const NOTICE_TEMPLATE = (terminalId: string): string =>
  `Sidebar terminal ${terminalId}: the user took over input and may have run their own commands. Read the transcript before acting; your next sidebar_terminal_send will reclaim control.`

/**
 * Build the one-shot user-takeover notice (a frozen user-role message whose
 * id `createUserMessage` mints internally).
 * @param terminalId - the taken-over terminal.
 * @param maxMessageChars - hard bound on the notice text.
 */
export function buildUserNotice(terminalId: string, maxMessageChars: number): UserMessage {
  const text = NOTICE_TEMPLATE(terminalId)
  return createUserMessage({
    content: [{ type: 'text', text: text.length <= maxMessageChars ? text : `${text.slice(0, Math.max(0, maxMessageChars - 1))}…` }],
    source: {
      kind: 'sidebar-terminal-tools',
      form: 'notice',
      summary: boundContextSummary(`user took over terminal ${terminalId}`),
    },
  })
}

/** Unknown-terminal error for ids outside this owner's registry. */
function unknownTerminal(ownerId: string, terminalId: string): Error {
  return new Error(`unknown sidebar terminal ${JSON.stringify(terminalId)} for session ${JSON.stringify(ownerId)}; open one with sidebar_terminal_open or list with sidebar_terminal_list`)
}

/** Map a terminal state to the wait_for session-status shape. */
function statusOf(info: WebTerminalInfoShadow): TerminalSessionSnapshot['status'] {
  return info.state === 'running'
    ? { kind: 'running' }
    : { kind: 'exited', exitCode: info.exitCode, signal: null }
}

/**
 * Start (or restart) the background attachment consumer for one managed
 * terminal. Each frame is processed as it arrives — no queueing between
 * frames — which is the backpressure answer for the controller's 2 MiB
 * per-follower cap; `ack` frames settle the channel's write waiters.
 * @returns a latch that settles once the baseline snapshot was processed (or
 * the stream ended/failed before one arrived).
 */
function attachAttachment(
  surface: TerminalSurface,
  registry: EndpointRegistry,
  owner: OwnerAgent,
  terminalId: string,
  managed: ManagedTerminal,
  config: EndpointCoreConfig,
): Promise<void> {
  // Disposing the previous channel first drops its queued frames with it:
  // the control broadcast our own re-attach causes must not reach the old
  // consumer (that would double-append output and self-notify a takeover).
  managed.attachment?.dispose()
  const channel = new AttachmentChannel()
  managed.attachment = channel
  managed.takeoverNotified = false
  let settleStarted!: () => void
  const started = new Promise<void>(resolve => { settleStarted = resolve })
  const signal = channel.abort.signal

  void (async () => {
    let first = true
    try {
      const iterator = surface.attach(owner, terminalId, channel.input, signal)[Symbol.asyncIterator]()
      const onAbort = (): void => { void iterator.return?.(undefined) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) break
          const frame: TerminalFrameShadow = next.value
          if (frame.type === 'snapshot') {
            managed.info = frame.info
            managed.writable = frame.writable
            managed.transcript.replace(sanitizeTerminalText(frame.screen))
          } else if (frame.type === 'output') {
            managed.transcript.append(sanitizeTerminalText(frame.data))
          } else if (frame.type === 'state') {
            managed.info = frame.info
            managed.writable = frame.writable
            const control = detectControllerChange(frame.info, frame.writable)
            if (control === 'user' && !managed.takeoverNotified) {
              managed.takeoverNotified = true
              try {
                owner.inject(buildUserNotice(terminalId, config.maxMessageChars))
              } catch {
                // The owning agent may already be gone; the notice is best-effort.
              }
            } else if (control === 'ours') {
              managed.takeoverNotified = false
            }
          } else {
            channel.settleAck(frame)
          }
          if (first) {
            first = false
            settleStarted()
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    } catch {
      // Stream failure (terminal closed underneath, owner disposed): the last
      // known info/transcript stay readable; the tools surface them as-is.
    } finally {
      channel.end(new Error(`terminal ${terminalId} attachment ended before the write was acknowledged`))
      if (first) settleStarted()
    }
  })()

  return started
}

/** Bind `read` for wait_for to the live registry record (NO_SESSION → gone). */
function waitRead(ownerId: string, terminalId: string, registry: EndpointRegistry, config: EndpointCoreConfig): () => TerminalReadResult {
  return () => {
    const managed = registry.get(ownerId, terminalId)
    if (managed === undefined) throw Object.assign(new Error(`terminal ${terminalId} is gone`), { code: 'NO_SESSION' })
    return managed.transcript.read({ offset: 0, count: config.transcriptLines })
  }
}

/**
 * The endpoint operations the tools layer drives. Every method is owner-
 * scoped: a terminal created by one agent's session is invisible to every
 * other agent.
 */
export interface Endpoint {
  open(owner: OwnerAgent, request: { cols?: number; rows?: number; shellPath?: string }): Promise<OpenedTerminal | LimitReached>
  send(owner: OwnerAgent, terminalId: string, text: string, options?: { enter?: boolean }): Promise<SendResult>
  read(owner: OwnerAgent, terminalId: string, request: { offset?: number; count?: number }): ReadPage
  waitFor(owner: OwnerAgent, terminalId: string, request: { pattern: string; timeoutMs?: number }, signal: AbortSignal): Promise<WaitOutcome>
  close(owner: OwnerAgent, terminalId: string): Promise<{ closed: boolean; terminalId: string }>
  list(owner: OwnerAgent): readonly TerminalSummary[]
}

/**
 * Compose the endpoint core over one controller surface and registry.
 * @param surface - the shadowed `ctx.terminalController` (attach carries the
 * synthesized invocation's uplink; see `terminalSurfaceOf`).
 * @param registry - this plugin's owner-scoped terminal registry.
 * @param config - resolved bounds.
 */
export function createEndpoint(
  surface: TerminalSurface,
  registry: EndpointRegistry,
  config: EndpointCoreConfig,
): Endpoint {
  const limits = { maxLines: config.transcriptLines, maxBytes: config.transcriptBytes }

  return {
    async open(owner, request) {
      const cols = request.cols ?? 80
      const rows = request.rows ?? 24
      const terminalId = mintTerminalId(registry.nextSequence())
      let info: WebTerminalInfoShadow
      try {
        info = await surface.create(
          owner,
          { id: terminalId, cols, rows, ...(request.shellPath === undefined ? {} : { shellPath: request.shellPath }) },
          new AbortController().signal,
        )
      } catch (error) {
        if (remoteErrorCode(error) === 'terminal/limit-reached') {
          const limit = remoteErrorDetails(error)?.limit
          return {
            outcome: 'limit_reached',
            limit: typeof limit === 'number' ? limit : 8,
            message: 'The session terminal quota is exhausted (terminals are shared with your manual sidebar terminals); close terminals you no longer need with sidebar_terminal_close and retry.',
          }
        }
        throw error
      }
      const managed = registry.register(owner, terminalId, info, limits)
      await attachAttachment(surface, registry, owner, terminalId, managed, config)
      return {
        outcome: 'opened',
        terminalId,
        shell: info.shell.name,
        shellPath: info.shell.path,
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
        state: info.state,
      }
    },

    async send(owner, terminalId, text, options) {
      const managed = registry.get(owner.id, terminalId)
      if (managed === undefined) throw unknownTerminal(owner.id, terminalId)
      const payload = options?.enter === false ? text : `${text}\r`
      const channel = managed.attachment
      if (channel === null) throw new Error(`terminal ${terminalId} has no attachment; open it with sidebar_terminal_open`)
      let regainedControl = false
      try {
        await channel.writeText(payload)
      } catch (error) {
        if (remoteErrorCode(error) !== 'terminal/control-unavailable') throw error
        // The user (or another view) holds input control, or the attachment
        // died: re-attach to reclaim it, then deliver the write under the
        // fresh attachment.
        regainedControl = true
        await attachAttachment(surface, registry, owner, terminalId, managed, config)
        const fresh = managed.attachment
        if (fresh === null) throw new Error(`terminal ${terminalId} lost its re-attachment; retry the send`)
        await fresh.writeText(payload)
      }
      return { wrote: payload.length, regained_control: regainedControl, state: managed.info.state }
    },

    read(owner, terminalId, request) {
      const managed = registry.get(owner.id, terminalId)
      if (managed === undefined) throw unknownTerminal(owner.id, terminalId)
      const page = managed.transcript.read(request)
      return { ...page, state: managed.info.state, exitCode: managed.info.exitCode }
    },

    async waitFor(owner, terminalId, request, signal) {
      const managed = registry.get(owner.id, terminalId)
      if (managed === undefined) throw unknownTerminal(owner.id, terminalId)
      return waitForPattern({
        read: waitRead(owner.id, terminalId, registry, config),
        list: (): TerminalSessionSnapshot[] => {
          const live = registry.get(owner.id, terminalId)
          return live === undefined ? [] : [{ sessionId: terminalId, status: statusOf(live.info) }]
        },
        now: () => Date.now(),
        sleep: sleepWithAbort,
      }, {
        sessionId: terminalId,
        pattern: compilePattern(request.pattern),
        timeoutMs: resolveTimeoutMs(request.timeoutMs, config),
        pollIntervalMs: config.pollIntervalMs,
        tailLines: config.tailLines,
        maxLineTextChars: config.maxLineTextChars,
        maxTailBytes: config.maxTailBytes,
        signal,
      })
    },

    async close(owner, terminalId) {
      const managed = registry.get(owner.id, terminalId)
      if (managed === undefined) throw unknownTerminal(owner.id, terminalId)
      try {
        await surface.close(owner, terminalId)
      } catch (error) {
        // Already-closed identities are a success here (close is idempotent
        // upstream); everything else is a real failure.
        if (remoteErrorCode(error) !== 'terminal/unavailable') throw error
      }
      managed.attachment?.dispose()
      registry.remove(owner.id, terminalId)
      return { closed: true, terminalId }
    },

    list(owner) {
      return registry.list(owner.id).map((managed): TerminalSummary => {
        const control = detectControllerChange(managed.info, managed.writable)
        return {
          terminalId: managed.info.id,
          title: managed.info.title,
          shell: managed.info.shell.name,
          cwd: managed.info.cwd,
          state: managed.info.state,
          exitCode: managed.info.exitCode,
          lines: managed.transcript.totalLines,
          controller: control === 'unattached' ? 'none' : control === 'ours' ? 'plugin' : 'user',
        }
      })
    },
  }
}
