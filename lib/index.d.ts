import z from "@deepseek-ai/schemastery";
import { ContextFormed } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
//#region src/shadow.d.ts
/** Host terminal state; process exit never creates a replacement shell. */
type WebTerminalState = 'running' | 'exited' | 'failed';
/** Terminal metadata as `create`/`list`/`state` frames carry it. */
interface WebTerminalInfoShadow {
  readonly id: string;
  readonly title: string;
  readonly shell: {
    readonly path: string;
    readonly args: readonly string[];
    readonly name: string;
  };
  /** Initial working directory; shell directory changes do not update this field. */
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly state: WebTerminalState;
  readonly exitCode: number | null;
  readonly error?: string;
  /** The attachment currently holding exclusive input control, when one exists. */
  readonly controllerId?: string;
}
/** Ordered follow frames: a bounded screen, then output deltas and metadata. */
type TerminalFrameShadow = {
  readonly type: 'snapshot';
  readonly sequence: number;
  readonly screen: string;
  readonly info: WebTerminalInfoShadow;
} | {
  readonly type: 'output';
  readonly sequence: number;
  readonly data: string;
} | {
  readonly type: 'state';
  readonly info: WebTerminalInfoShadow;
};
/** The controller's per-call agent parameter: owner identity and injection. */
interface TerminalOwnerLike {
  readonly id: string;
}
/**
 * The structural slice of `ctx.terminalController` this plugin drives.
 * `create` is idempotent per open identity; a new `follow` attachment becomes
 * the exclusive input controller; `write` from a stale attachment fails with a
 * `terminal/control-unavailable` error carrying a `code` field.
 */
interface TerminalControllerLike {
  create(agent: TerminalOwnerLike, request: {
    readonly id: string;
    readonly cols: number;
    readonly rows: number;
    readonly shellPath?: string;
  }, signal: AbortSignal): Promise<WebTerminalInfoShadow>;
  follow(agent: TerminalOwnerLike, id: string, attachmentId: string, signal: AbortSignal): AsyncIterable<TerminalFrameShadow>;
  write(agent: TerminalOwnerLike, id: string, attachmentId: string, data: string): Promise<void>;
  close(agent: TerminalOwnerLike, id: string): Promise<void>;
  list(sessionId: string): readonly WebTerminalInfoShadow[];
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Interactive user terminals owned per Session (provided by the web-app
     * root realm). Shadow-typed here; the upstream package owns the real
     * declaration and is never imported by this plugin.
     */
    terminalController: TerminalControllerLike;
  }
}
//#endregion
//#region src/endpoint.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'sidebar-terminal-tools': {
      kind: 'sidebar-terminal-tools';
    } & ContextFormed;
  }
}
/** Resolved configuration consumed by the endpoint core. */
interface EndpointCoreConfig {
  readonly transcriptLines: number;
  readonly transcriptBytes: number;
  readonly defaultTimeoutMs: number;
  readonly minTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly tailLines: number;
  readonly maxLineTextChars: number;
  readonly maxTailBytes: number;
  readonly maxMessageChars: number;
}
//#endregion
//#region src/index.d.ts
declare const name = "sidebar-terminal-tools";
declare const inject: string[];
/** Plugin configuration (all fields optional; defaults documented below). */
interface Config {
  /** Retained transcript lines per terminal (default 5000). */
  transcriptLines?: number;
  /** Retained transcript UTF-8 bytes per terminal (default 1 MiB). */
  transcriptBytes?: number;
  /** Wait bound used when the model omits `timeout_ms` (default 10000). */
  defaultTimeoutMs?: number;
  /** Smallest wait bound; smaller requests are clamped (default 100). */
  minTimeoutMs?: number;
  /** Hard cap for any single wait; larger requests are clamped (default 600000). */
  maxTimeoutMs?: number;
  /** wait_for poll interval in milliseconds (default 150). */
  pollIntervalMs?: number;
  /** Lines carried by a `timeout` outcome (default 30; 0 disables the tail). */
  tailLines?: number;
  /** Character cap for `found.lineText` (default 1000; 0 disables it). */
  maxLineTextChars?: number;
  /** UTF-8 byte cap for `timeout.tail` (default 8192; 0 disables it). */
  maxTailBytes?: number;
  /** Character cap for a user-takeover notice (default 2000). */
  maxMessageChars?: number;
}
/** Schemastery configuration schema; defaults mirror {@link resolveConfig}. */
declare const Config: z<Config>;
/** Validate configuration loudly; every field resolved. */
declare function resolveConfig(config?: Config): EndpointCoreConfig;
/**
 * Mount the endpoint core over the host's terminal controller and register
 * the six tools.
 * @param ctx - host context (requires `terminalController` and `tools`).
 * @param config - plugin configuration.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name, resolveConfig };