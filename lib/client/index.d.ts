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
        recover(sessionId: string): Promise<readonly RecoveredTerminal[]>;
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
    effect(fn: () => () => unknown, label?: string): unknown;
}
/** Client configuration (the web client's config layer supplies it). */
export interface ClientConfig {
    /** Poll interval in milliseconds (default 3000; minimum 250). */
    pollIntervalMs?: number;
}
export declare const DEFAULT_POLL_INTERVAL_MS = 3000;
export declare const MIN_POLL_INTERVAL_MS = 250;
/** Resolve the poll interval loudly rather than degrading silently. */
export declare function resolvePollIntervalMs(requested: number | undefined): number;
/**
 * Start the auto-open polling.
 * @param ctx - client context providing `webTerminals`, `sidebarRight`, `locale`.
 * @param config - optional client configuration.
 */
export declare function apply(ctx: ClientContext, config?: ClientConfig): void;
export {};
