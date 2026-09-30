/**
 * The endpoint core: operations over the shadowed terminal controller and the
 * owner-scoped registry. Every operation runs against terminals this plugin
 * created; `send` regains control by re-following when the user holds it; the
 * follow consumer maintains the sanitized transcript and fires (once per
 * episode) an inject notice when the user takes over.
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
import { EndpointRegistry, mintAttachmentId, mintTerminalId, type ManagedTerminal } from './registry.js'
import { sanitizeTerminalText } from './sanitize.js'
import { remoteErrorCode, remoteErrorDetails, type TerminalControllerLike, type TerminalFrameShadow, type TerminalOwnerLike, type WebTerminalInfoShadow } from './shadow.js'
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
 * Classify who holds input control in a state frame.
 * @param info - the frame's terminal metadata.
 * @param ourAttachment - the attachment identity our consumer follows with.
 * @returns 'user' when someone else controls, 'ours' when we do, 'unattached' otherwise.
 */
export function detectControllerChange(info: WebTerminalInfoShadow, ourAttachment: string): 'user' | 'ours' | 'unattached' {
  if (info.controllerId === undefined) return 'unattached'
  return info.controllerId === ourAttachment ? 'ours' : 'user'
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
 * Start (or restart) the background follow consumer for one managed terminal.
 * Each frame is processed as it arrives — no queueing between frames — which
 * is the backpressure answer for the controller's 2 MiB per-follower cap.
 * @returns a latch that settles once the baseline snapshot was processed (or
 * the stream ended/failed before one arrived).
 */
function attachFollower(
  controller: TerminalControllerLike,
  registry: EndpointRegistry,
  owner: OwnerAgent,
  terminalId: string,
  managed: ManagedTerminal,
  config: EndpointCoreConfig,
): Promise<void> {
  managed.follow.abort()
  managed.follow = new AbortController()
  const attachmentId = mintAttachmentId()
  managed.attachmentId = attachmentId
  managed.takeoverNotified = false
  let settleStarted!: () => void
  const started = new Promise<void>(resolve => { settleStarted = resolve })
  const signal = managed.follow.signal

  void (async () => {
    let first = true
    try {
      const iterator = controller.follow(owner, terminalId, attachmentId, signal)[Symbol.asyncIterator]()
      const onAbort = (): void => { void iterator.return?.(undefined) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) break
          const frame: TerminalFrameShadow = next.value
          if (frame.type === 'snapshot') {
            managed.info = frame.info
            managed.transcript.replace(sanitizeTerminalText(frame.screen))
          } else if (frame.type === 'output') {
            managed.transcript.append(sanitizeTerminalText(frame.data))
          } else {
            managed.info = frame.info
            const control = detectControllerChange(frame.info, attachmentId)
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
 * Compose the endpoint core over one controller and registry.
 * @param controller - the shadowed `ctx.terminalController`.
 * @param registry - this plugin's owner-scoped terminal registry.
 * @param config - resolved bounds.
 */
export function createEndpoint(
  controller: TerminalControllerLike,
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
        info = await controller.create(
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
      await attachFollower(controller, registry, owner, terminalId, managed, config)
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
      let regainedControl = false
      try {
        await controller.write(owner, terminalId, managed.attachmentId, payload)
      } catch (error) {
        if (remoteErrorCode(error) !== 'terminal/control-unavailable') throw error
        // The user (or another view) holds input control: re-follow to
        // reclaim it, then deliver the write under the fresh attachment.
        regainedControl = true
        await attachFollower(controller, registry, owner, terminalId, managed, config)
        await controller.write(owner, terminalId, managed.attachmentId, payload)
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
        await controller.close(owner, terminalId)
      } catch (error) {
        // Already-closed identities are a success here (close is idempotent
        // upstream); everything else is a real failure.
        if (remoteErrorCode(error) !== 'terminal/unavailable') throw error
      }
      managed.follow.abort()
      registry.remove(owner.id, terminalId)
      return { closed: true, terminalId }
    },

    list(owner) {
      return registry.list(owner.id).map((managed): TerminalSummary => {
        const control = detectControllerChange(managed.info, managed.attachmentId)
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
