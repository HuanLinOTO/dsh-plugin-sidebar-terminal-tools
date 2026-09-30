/**
 * Client half — auto-open the terminals the model creates as native sidebar
 * tabs. The official stack ships no automatic path (the recovery entry point
 * in ui-sidebar-terminal is commented out upstream), so this plugin polls
 * `ctx.webTerminals.recover(sessionId)` for every inventoried session and
 * opens each `stb-`-prefixed terminal with `ctx.sidebarRight.openTabIn`.
 *
 * Notes on the consumed surfaces (verified against the 0.2.0-rc.1 sources):
 * - `recover` already excludes terminals this window shows and terminals with
 *   unfinished closes, so the poll is naturally idempotent; the local `opened`
 *   set additionally guards the window between poll and tab mount,
 * - `openTabIn` expands the sidebar column but does not steal keyboard focus,
 *   and silently does nothing for a session whose layout is not adopted,
 * - only the `stb-` prefix is touched; the user's manual terminals never match.
 *
 * The bundle registers through `window.__ModuleLoader__.load({ id: <package
 * name>, factory })` (see tsdown.client.config.ts) and consumes services only
 * through the context — there are zero runtime imports.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/client
 */
import { pickUnopened, STB_PREFIX, type RecoveredTerminal } from './pick.js'
import { CLIENT_STRINGS, formatText } from './locales.js'

/** Services this half waits on before applying. */
export const inject = ['webTerminals', 'sidebarRight', 'locale']

/** The sidebar-right slice the loop needs (structural shadow). */
interface SidebarRightLike {
  readonly openTabs: { getSnapshot(): readonly { sessionId: string }[] }
  readonly mounted: { getSnapshot(): string | undefined }
  openTabIn(sessionId: string, kind: string, options?: { params?: Record<string, string> }): void
}

/** The structural context slice the client half consumes. */
export interface ClientContext {
  readonly webTerminals: { recover(sessionId: string): Promise<readonly RecoveredTerminal[]> }
  readonly sidebarRight: SidebarRightLike
  readonly locale: { resolveText(text: { readonly en: string; readonly zh: string }): string }
  readonly logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
  effect(fn: () => () => unknown, label?: string): unknown
}

/** Client configuration (the web client's config layer supplies it). */
export interface ClientConfig {
  /** Poll interval in milliseconds (default 3000; minimum 250). */
  pollIntervalMs?: number
}

export const DEFAULT_POLL_INTERVAL_MS = 3000
export const MIN_POLL_INTERVAL_MS = 250

/** Resolve the poll interval loudly rather than degrading silently. */
export function resolvePollIntervalMs(requested: number | undefined): number {
  const resolved = requested ?? DEFAULT_POLL_INTERVAL_MS
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < MIN_POLL_INTERVAL_MS) {
    throw new Error(`sidebar-terminal-tools client: pollIntervalMs must be a safe integer >= ${MIN_POLL_INTERVAL_MS}`)
  }
  return resolved
}

/** Every session worth polling: the inventoried layouts plus the mounted seat. */
function sessionsToPoll(sidebarRight: SidebarRightLike): readonly string[] {
  const ids = new Set<string>()
  for (const tab of sidebarRight.openTabs.getSnapshot()) ids.add(tab.sessionId)
  const mounted = sidebarRight.mounted.getSnapshot()
  if (mounted !== undefined) ids.add(mounted)
  return [...ids]
}

/**
 * Start the auto-open polling.
 * @param ctx - client context providing `webTerminals`, `sidebarRight`, `locale`.
 * @param config - optional client configuration.
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  const intervalMs = resolvePollIntervalMs(config.pollIntervalMs)
  const opened = new Set<string>()
  let busy = false
  let failureWarned = false

  const log = (level: 'info' | 'warn', text: { readonly en: string; readonly zh: string }, vars: Readonly<Record<string, string>>): void => {
    const sink = ctx.logger?.[level]
    if (sink === undefined) return
    sink.call(ctx.logger, formatText(ctx.locale.resolveText(text), vars))
  }

  const poll = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      for (const sessionId of sessionsToPoll(ctx.sidebarRight)) {
        let recovered: readonly RecoveredTerminal[]
        try {
          recovered = await ctx.webTerminals.recover(sessionId)
        } catch {
          // One offline session must not starve the others.
          continue
        }
        for (const entry of pickUnopened(STB_PREFIX, recovered, opened)) {
          opened.add(entry.id)
          ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId: entry.id } })
          log('info', CLIENT_STRINGS.autoOpened, { id: entry.id })
        }
      }
      failureWarned = false
    } catch (error) {
      // Throttle the outage to one warning per failure streak.
      if (!failureWarned) {
        failureWarned = true
        log('warn', CLIENT_STRINGS.recoverFailed, { error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      busy = false
    }
  }

  ctx.effect(() => {
    // globalThis timers: the browser window and the unit-test runtime agree.
    const timer = globalThis.setInterval(() => { void poll() }, intervalMs)
    void poll()
    return () => { globalThis.clearInterval(timer) }
  }, 'sidebar-terminal-tools: auto-open polling')
}
