/**
 * Client-half copy, owned by the locale dictionary pattern: every string the
 * client can surface is a LocalizedText pair resolved through
 * `ctx.locale.resolveText` (the DSH client locale service).
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/client/locales
 */
/** One string in the two shipped locales (English is the fallback). */
export interface LocalizedText {
    readonly en: string;
    readonly zh: string;
}
/** The client's whole dictionary. */
export declare const CLIENT_STRINGS: {
    /** Logged when a model terminal is opened as a native sidebar tab. */
    readonly autoOpened: {
        readonly en: "sidebar-terminal-tools: opened model terminal {id} as a sidebar tab";
        readonly zh: "sidebar-terminal-tools：已将模型终端 {id} 打开为侧栏标签页";
    };
    /** Logged (once per outage) when a recovery poll fails. */
    readonly recoverFailed: {
        readonly en: "sidebar-terminal-tools: terminal recovery poll failed: {error}";
        readonly zh: "sidebar-terminal-tools：终端恢复轮询失败：{error}";
    };
};
/**
 * Substitute `{name}` placeholders in a localized template.
 * @param template - the resolved template string.
 * @param vars - replacement values by name; unknown placeholders stay verbatim.
 */
export declare function formatText(template: string, vars: Readonly<Record<string, string>>): string;
