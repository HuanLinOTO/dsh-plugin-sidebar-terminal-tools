/**
 * Client half — auto-open the terminals the model creates as native sidebar
 * tabs. The official stack ships no automatic path (the recovery entry point
 * in ui-sidebar-terminal is commented out upstream), so this plugin watches
 * `ctx.webTerminals.recover(sessionId)` and opens each `stb-`-prefixed
 * terminal with `ctx.sidebarRight.openTabIn`.
 *
 * Discovery is ACTIVITY-SCOPED, never idle-polled. The Host never pushes its
 * terminal list, so every discovery is an `POST /api/terminal/list` round
 * trip: polling every session on a timer cost one request per session per
 * interval while nothing was happening. The forwarded `api-session/status`
 * Remote Event (idle ⇄ running, one pair per turn) therefore drives the loop
 * instead:
 *
 * - `running: true` opens that Session's activity window, which polls at
 *   `pollIntervalMs` (default 3000) so a terminal the model opens mid-turn
 *   appears within one interval,
 * - `running: false` closes the window and takes one last look, which is what
 *   catches a terminal created in the turn's final step,
 * - an idle page issues no discovery request at all. `MAX_ACTIVITY_WINDOW_MS`
 *   bounds one window so a lost status event cannot poll forever.
 *
 * Notes on the consumed surfaces (verified against the 0.2.1-rc.1 sources):
 * - `recover(sessionId, refresh)` reads the Client's settled terminal
 *   inventory unless `refresh` is true. A cached read never discovers a
 *   terminal created after the first read settled (the Host list is not
 *   pushed), so every discovery passes `refresh: true`,
 * - `recover` already excludes terminals this window shows and terminals with
 *   unfinished closes, so a repeated discovery is naturally idempotent; the
 *   local `opened` set additionally guards the window between discovery and
 *   tab mount,
 * - `openTabIn` expands the sidebar column but does not steal keyboard focus,
 *   and silently does nothing for a session whose layout is not adopted,
 * - only the `stb-` prefix is touched; the user's manual terminals never match,
 * - a host without forwarded events (`interactions=none`) has no status
 *   signal: there the loop falls back to timed polling over the inventoried
 *   Sessions, which is the pre-0.2.2 behavior.
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

/**
 * The forwarded Remote Event face this half consumes (`ctx.remote.$on`).
 * Structural: the plugin never imports the host package.
 */
interface RemoteEventsLike {
  $on(event: string, listener: (sessionId: string, running: boolean) => void): () => void
}

/** Narrow an optional service to the forwarded-event face. */
function isRemoteEvents(value: unknown): value is RemoteEventsLike {
  if (value === null || typeof value !== 'object') return false
  return typeof Reflect.get(value, '$on') === 'function'
}

/** The structural context slice the client half consumes. */
export interface ClientContext {
  readonly webTerminals: { recover(sessionId: string, refresh?: boolean): Promise<readonly RecoveredTerminal[]> }
  readonly sidebarRight: SidebarRightLike
  readonly locale: { resolveText(text: { readonly en: string; readonly zh: string }): string }
  readonly logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
  /** Optional service lookup; without forwarded events the loop falls back to timed polling. */
  get?(name: string): unknown
  effect(fn: () => () => unknown, label?: string): unknown
}

/** Client configuration (the web client's config layer supplies it). */
export interface ClientConfig {
  /** Activity-window poll interval in milliseconds (default 3000; minimum 250). */
  pollIntervalMs?: number
}

export const DEFAULT_POLL_INTERVAL_MS = 3000
export const MIN_POLL_INTERVAL_MS = 250
/** Bounds one activity window so a lost `running: false` event cannot poll forever. */
export const MAX_ACTIVITY_WINDOW_MS = 10 * 60_000

/** Resolve the poll interval loudly rather than degrading silently. */
export function resolvePollIntervalMs(requested: number | undefined): number {
  const resolved = requested ?? DEFAULT_POLL_INTERVAL_MS
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < MIN_POLL_INTERVAL_MS) {
    throw new Error(`sidebar-terminal-tools client: pollIntervalMs must be a safe integer >= ${MIN_POLL_INTERVAL_MS}`)
  }
  return resolved
}

/** Every session worth a first look: the inventoried layouts plus the mounted seat. */
export function sessionsToRestore(sidebarRight: SidebarRightLike): readonly string[] {
  const ids = new Set<string>()
  for (const tab of sidebarRight.openTabs.getSnapshot()) ids.add(tab.sessionId)
  const mounted = sidebarRight.mounted.getSnapshot()
  if (mounted !== undefined) ids.add(mounted)
  return [...ids]
}

/** One Session's open activity window. */
interface ActivityWindow {
  readonly timer: ReturnType<typeof setInterval>
  expiresAt: number
}

/**
 * Start the auto-open loop.
 * @param ctx - client context providing `webTerminals`, `sidebarRight`, `locale`.
 * @param config - optional client configuration.
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  const intervalMs = resolvePollIntervalMs(config.pollIntervalMs)
  const opened = new Set<string>()
  const windows = new Map<string, ActivityWindow>()
  const inflight = new Set<string>()
  let failureWarned = false
  let disposed = false

  const log = (level: 'info' | 'warn', text: { readonly en: string; readonly zh: string }, vars: Readonly<Record<string, string>>): void => {
    const sink = ctx.logger?.[level]
    if (sink === undefined) return
    sink.call(ctx.logger, formatText(ctx.locale.resolveText(text), vars))
  }

  /** One Session's discovery, deduplicated per Session. */
  const discover = async (sessionId: string): Promise<void> => {
    if (disposed || inflight.has(sessionId)) return
    inflight.add(sessionId)
    try {
      const recovered = await ctx.webTerminals.recover(sessionId, true)
      for (const entry of pickUnopened(STB_PREFIX, recovered, opened)) {
        opened.add(entry.id)
        ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId: entry.id } })
        log('info', CLIENT_STRINGS.autoOpened, { id: entry.id })
      }
      failureWarned = false
    } catch (error) {
      // Throttle the outage to one warning per failure streak; one offline
      // Session must not starve the others either.
      if (!failureWarned) {
        failureWarned = true
        log('warn', CLIENT_STRINGS.recoverFailed, { error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      inflight.delete(sessionId)
    }
  }

  const closeWindow = (sessionId: string): void => {
    const window = windows.get(sessionId)
    if (window === undefined) return
    globalThis.clearInterval(window.timer)
    windows.delete(sessionId)
  }

  const tick = (sessionId: string): void => {
    const window = windows.get(sessionId)
    if (window === undefined) return
    if (Date.now() >= window.expiresAt) { closeWindow(sessionId); return }
    void discover(sessionId)
  }

  const openWindow = (sessionId: string): void => {
    const window = windows.get(sessionId)
    if (window !== undefined) {
      window.expiresAt = Date.now() + MAX_ACTIVITY_WINDOW_MS
      return
    }
    const timer = globalThis.setInterval(() => { tick(sessionId) }, intervalMs)
    windows.set(sessionId, { timer, expiresAt: Date.now() + MAX_ACTIVITY_WINDOW_MS })
    void discover(sessionId)
  }

  /** One status event: a turn started or ended. */
  const onStatus = (sessionId: string, running: boolean): void => {
    if (running) { openWindow(sessionId); return }
    closeWindow(sessionId)
    void discover(sessionId)
  }

  const subscribe = ((): (() => void) | undefined => {
    const remote = ctx.get?.('remote')
    if (!isRemoteEvents(remote)) return undefined
    try {
      return remote.$on('api-session/status', onStatus)
    } catch {
      // `interactions=none` refuses forwarded events; timed polling covers it.
      return undefined
    }
  })()

  ctx.effect(() => () => {
    disposed = true
    for (const sessionId of [...windows.keys()]) closeWindow(sessionId)
    subscribe?.()
  }, 'sidebar-terminal-tools: auto-open loop')

  if (subscribe !== undefined) {
    // A reload restores the terminals of the Sessions this window is showing;
    // later terminals arrive on their own Session's activity window.
    for (const sessionId of sessionsToRestore(ctx.sidebarRight)) void discover(sessionId)
    return
  }

  // Fallback for a host without forwarded events: timed polling.
  let busy = false
  const poll = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      for (const sessionId of sessionsToRestore(ctx.sidebarRight)) await discover(sessionId)
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
