/**
 * Structural shadow declarations for the official terminal controller stack
 * (`@deepseek-ai/dsh-api-terminal-controller`), which this plugin consumes by
 * the cordis service name `terminalController` and deliberately does NOT
 * import — the package is a host-internal peer, and a structural mirror keeps
 * this plugin buildable and installable anywhere the service exists.
 *
 * Shapes verified against the vendored sources:
 * packages/api/terminal-controller/src/{index,types,terminal}.ts @ 0.2.0-rc.1.
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
  /** The attachment currently holding exclusive input control, when one exists. */
  readonly controllerId?: string
}

/** Ordered follow frames: a bounded screen, then output deltas and metadata. */
export type TerminalFrameShadow =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfoShadow }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: WebTerminalInfoShadow }

/** The controller's per-call agent parameter: owner identity and injection. */
export interface TerminalOwnerLike {
  readonly id: string
}

/**
 * The structural slice of `ctx.terminalController` this plugin drives.
 * `create` is idempotent per open identity; a new `follow` attachment becomes
 * the exclusive input controller; `write` from a stale attachment fails with a
 * `terminal/control-unavailable` error carrying a `code` field.
 */
export interface TerminalControllerLike {
  create(
    agent: TerminalOwnerLike,
    request: { readonly id: string; readonly cols: number; readonly rows: number; readonly shellPath?: string },
    signal: AbortSignal,
  ): Promise<WebTerminalInfoShadow>
  follow(agent: TerminalOwnerLike, id: string, attachmentId: string, signal: AbortSignal): AsyncIterable<TerminalFrameShadow>
  write(agent: TerminalOwnerLike, id: string, attachmentId: string, data: string): Promise<void>
  close(agent: TerminalOwnerLike, id: string): Promise<void>
  list(sessionId: string): readonly WebTerminalInfoShadow[]
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
