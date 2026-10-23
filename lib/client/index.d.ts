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
import { type RecoveredTerminal } from './pick.js';
/** Services this half waits on before applying. */
export declare const inject: string[];
/** The sidebar-right slice the loop needs (structural shadow). */
interface SidebarRightLike {
    readonly openTabs: {
        getSnapshot(): readonly {
            sessionId: string;
        }[];
    };
    readonly mounted: {
        getSnapshot(): string | undefined;
    };
    openTabIn(sessionId: string, kind: string, options?: {
        params?: Record<string, string>;
    }): void;
}
/** The structural context slice the client half consumes. */
export interface ClientContext {
    readonly webTerminals: {
        recover(sessionId: string, refresh?: boolean): Promise<readonly RecoveredTerminal[]>;
    };
    readonly sidebarRight: SidebarRightLike;
    readonly locale: {
        resolveText(text: {
            readonly en: string;
            readonly zh: string;
        }): string;
    };
    readonly logger?: {
        info?(...args: unknown[]): void;
        warn?(...args: unknown[]): void;
    };
    /** Optional service lookup; without forwarded events the loop falls back to timed polling. */
    get?(name: string): unknown;
    effect(fn: () => () => unknown, label?: string): unknown;
}
/** Client configuration (the web client's config layer supplies it). */
export interface ClientConfig {
    /** Activity-window poll interval in milliseconds (default 3000; minimum 250). */
    pollIntervalMs?: number;
}
export declare const DEFAULT_POLL_INTERVAL_MS = 3000;
export declare const MIN_POLL_INTERVAL_MS = 250;
/** Bounds one activity window so a lost `running: false` event cannot poll forever. */
export declare const MAX_ACTIVITY_WINDOW_MS: number;
/** Resolve the poll interval loudly rather than degrading silently. */
export declare function resolvePollIntervalMs(requested: number | undefined): number;
/** Every session worth a first look: the inventoried layouts plus the mounted seat. */
export declare function sessionsToRestore(sidebarRight: SidebarRightLike): readonly string[];
/**
 * Start the auto-open loop.
 * @param ctx - client context providing `webTerminals`, `sidebarRight`, `locale`.
 * @param config - optional client configuration.
 */
export declare function apply(ctx: ClientContext, config?: ClientConfig): void;
export {};
