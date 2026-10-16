/**
 * Structural shadow declarations for the official terminal controller stack
 * (`@deepseek-ai/dsh-api-terminal-controller`), which this plugin consumes by
 * the cordis service name `terminalController` and deliberately does NOT
 * import — the package is a host-internal peer, and a structural mirror keeps
 * this plugin buildable and installable anywhere the service exists.
 *
 * Shapes verified against the vendored sources:
 * packages/api/terminal-controller/src/{index,types,terminal}.ts @ 0.2.1-alpha.5
 * (terminal `follow`/`write` were replaced by the duplex `attach` Remote).
 * If the upstream service drifts, this file is the single place to update.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/shadow
 */
import type { Context } from '@deepseek-ai/cordis'

/** Host terminal state; process exit never creates a replacement shell. */
export type WebTerminalState = 'running' | 'exited' | 'failed'

/** Terminal metadata as `create`/`list`/`state` frames carry it. */
export interface WebTerminalInfoShadow {
  readonly id: string
  readonly title: string
  readonly shell: { readonly path: string; readonly args: readonly string[]; readonly name: string }
  /** Initial working directory; shell directory changes do not update this field. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: WebTerminalState
  readonly exitCode: number | null
  readonly error?: string
}

/** Carrier frame capacity the snapshot of an attachment may publish. */
export interface RemoteUplinkWindowShadow {
  readonly maxBytes: number
  readonly frameOverheadBytes: number
}

/**
 * Ordered attachment frames: a bounded screen baseline, then output deltas,
 * per-follower state (with input writability), and input acknowledgements.
 */
export type TerminalFrameShadow =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfoShadow; readonly writable: boolean; readonly inputWindow?: RemoteUplinkWindowShadow }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: WebTerminalInfoShadow; readonly writable: boolean }
  | { readonly type: 'ack'; readonly sequence: number; readonly refusal?: 'read-only' | 'not-running' }

/**
 * Client-to-host commands of one attachment, numbered consecutively from one
 * within each attachment; the plugin only ever writes `write` commands.
 */
export type TerminalInputShadow =
  | { readonly type: 'write'; readonly sequence: number; readonly data: string }
  | { readonly type: 'resize'; readonly sequence: number; readonly cols: number; readonly rows: number }

/** The controller's per-call agent parameter: owner identity and injection. */
export interface TerminalOwnerLike {
  readonly id: string
}

/**
 * The structural slice of `ctx.terminalController` this plugin can reach.
 * `create` is idempotent per open identity; `attach` opens the single duplex
 * Remote stream (screen baseline, output, state and acks down; numbered
 * `TerminalInput` commands up through the invocation's uplink); each new
 * attachment becomes the exclusive input controller and older attachments
 * keep receiving output.
 */
export interface TerminalControllerLike {
  create(
    agent: TerminalOwnerLike,
    request: { readonly id: string; readonly cols: number; readonly rows: number; readonly shellPath?: string },
    signal: AbortSignal,
  ): Promise<WebTerminalInfoShadow>
  attach(agent: TerminalOwnerLike, id: string, signal: AbortSignal): AsyncIterable<TerminalFrameShadow>
  close(agent: TerminalOwnerLike, id: string): Promise<void>
  list(sessionId: string): readonly WebTerminalInfoShadow[]
}

/**
 * The endpoint-facing controller surface: identical to
 * {@link TerminalControllerLike} except that `attach` carries the uplink
 * directly — the invocation synthesis that the gateway performs for client
 * calls is folded into the adapter ({@link terminalSurfaceOf}).
 */
export interface TerminalSurface {
  create(
    agent: TerminalOwnerLike,
    request: { readonly id: string; readonly cols: number; readonly rows: number; readonly shellPath?: string },
    signal: AbortSignal,
  ): Promise<WebTerminalInfoShadow>
  attach(agent: TerminalOwnerLike, id: string, input: AsyncIterable<TerminalInputShadow>, signal: AbortSignal): AsyncIterable<TerminalFrameShadow>
  close(agent: TerminalOwnerLike, id: string): Promise<void>
  list(sessionId: string): readonly WebTerminalInfoShadow[]
}

/** Structural slice of the Remote invocation `terminal/attach` reads. */
export interface RemoteInvocationShadow {
  readonly request: { readonly namespace: string; readonly method: string; readonly args: Readonly<Record<string, unknown>> }
  /** Cordis service key of the receiving Service. */
  readonly service: string
  /** The peer the call speaks for; host-side attachments synthesize an owner peer. */
  readonly peer: {
    readonly id: string
    readonly ctx: Context
    readonly principal: { readonly kind: 'owner' }
    readonly interactions: 'answer'
    readonly signal: AbortSignal
    dispose(): Promise<void>
  }
  /** Carrier cancellation; mirrors the attachment's own signal. */
  readonly signal: AbortSignal
  readonly uplinkWindow?: RemoteUplinkWindowShadow
  /** The attachment's numbered input commands; single consumer, single call. */
  uplink(): AsyncIterable<TerminalInputShadow>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Interactive user terminals owned per Session (provided by the web-app
     * root realm). Shadow-typed here; the upstream package owns the real
     * declaration and is never imported by this plugin.
     */
    terminalController: TerminalControllerLike
  }
}

/** Counter for synthetic attachment peer identities. */
let peerCounter = 0

/**
 * Adapt `ctx.terminalController` to the endpoint-facing {@link TerminalSurface}.
 * `attach` rides the same mechanism the gateway dispatches Remote calls with:
 * the context is extended with a synthetic invocation and the service is
 * accessed through it, so cordis rebinds the service's context and
 * `terminal/attach` reads our uplink as its input source (in-process carriers
 * impose no frame-window limit, so `uplinkWindow` stays absent).
 * @param ctx - host context carrying the `terminalController` service.
 * @returns the surface the endpoint core drives.
 */
export function terminalSurfaceOf(ctx: Context): TerminalSurface {
  const controller = ctx.terminalController
  return {
    create: (owner, request, signal) => controller.create(owner, request, signal),
    attach: (owner, id, input, signal) => {
      peerCounter += 1
      const invocation: RemoteInvocationShadow = {
        request: { namespace: 'terminal', method: 'attach', args: {} },
        service: 'terminalController',
        peer: {
          id: `stb-peer-${peerCounter}-${Math.random().toString(36).slice(2, 10)}`,
          ctx,
          principal: { kind: 'owner' },
          interactions: 'answer',
          signal,
          dispose: async () => {},
        },
        signal,
        uplink: () => input,
      }
      return ctx.extend({ invocation }).terminalController.attach(owner, id, signal)
    },
    close: (owner, id) => controller.close(owner, id),
    list: sessionId => controller.list(sessionId),
  }
}

/** Narrow an unknown thrown value to its RemoteError-style `code`, if any. */
export function remoteErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Read the `details` payload of a RemoteError-shaped value, when present. */
export function remoteErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const details = (error as { details?: unknown }).details
  return typeof details === 'object' && details !== null ? details as Record<string, unknown> : undefined
}
