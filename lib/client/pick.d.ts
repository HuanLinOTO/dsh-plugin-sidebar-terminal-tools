/**
 * The pure half of the client's auto-open decision: which recovered terminals
 * deserve a tab. The prefix (`stb-`) is the same one the host half mints ids
 * with (src/registry.ts TERMINAL_ID_PREFIX) — keep them in sync.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/client/pick
 */
/** Terminal id prefix identifying terminals this plugin created. */
export declare const STB_PREFIX = "stb-";
/** A recovered terminal as `ctx.webTerminals.recover` reports it. */
export interface RecoveredTerminal {
    readonly id: string;
}
/**
 * Select the recovered terminals to open as tabs: only the model prefix, none
 * already opened (or still in flight) in this window, deduplicated, order kept.
 * @param prefix - the model-terminal id prefix.
 * @param recovered - one session's recover() result.
 * @param openedIds - ids this window already opened or is opening.
 */
export declare function pickUnopened(prefix: string, recovered: readonly RecoveredTerminal[], openedIds: ReadonlySet<string>): readonly RecoveredTerminal[];
