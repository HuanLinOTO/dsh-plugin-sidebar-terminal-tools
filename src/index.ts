/**
 * index.ts — @huanlin/dsh-plugin-sidebar-terminal-tools entry (host half).
 *
 * Bridges the official sidebar terminal stack (`ctx.terminalController`,
 * consumed by service name through structural shadow types — the upstream
 * package is never imported) to the model as six `sidebar_terminal_*` tools.
 * Every tool only reaches terminals this plugin registered, so the user's
 * manual sidebar terminals are never touched.
 *
 * Security: these terminals run with the system user's permissions, outside
 * the Agent sandbox and the approval pipeline (an upstream property of
 * `terminalController` that this plugin deliberately exposes to the model).
 * Gate the `sidebar_terminal_*` tool names in permission rules if that is not
 * what you want; see the README before enabling.
 *
 * Conventions (plugin-development-guide.md §3): C4 canonical values, C5
 * business outcomes as values, C6 signal honored at every await.
 *
 * Tool registration is effect-based: disposing the plugin fiber (config
 * change, unload) unregisters the tools, aborts every follow consumer, and
 * the next apply() rebuilds from the fresh config.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createEndpoint, type EndpointCoreConfig } from './endpoint.js'
import { EndpointRegistry } from './registry.js'
import { registerTools } from './tools.js'

export const name = 'sidebar-terminal-tools'
export const inject = ['terminalController', 'tools']

/** Plugin configuration (all fields optional; defaults documented below). */
export interface Config {
  /** Retained transcript lines per terminal (default 5000). */
  transcriptLines?: number
  /** Retained transcript UTF-8 bytes per terminal (default 1 MiB). */
  transcriptBytes?: number
  /** Wait bound used when the model omits `timeout_ms` (default 10000). */
  defaultTimeoutMs?: number
  /** Smallest wait bound; smaller requests are clamped (default 100). */
  minTimeoutMs?: number
  /** Hard cap for any single wait; larger requests are clamped (default 600000). */
  maxTimeoutMs?: number
  /** wait_for poll interval in milliseconds (default 150). */
  pollIntervalMs?: number
  /** Lines carried by a `timeout` outcome (default 30; 0 disables the tail). */
  tailLines?: number
  /** Character cap for `found.lineText` (default 1000; 0 disables it). */
  maxLineTextChars?: number
  /** UTF-8 byte cap for `timeout.tail` (default 8192; 0 disables it). */
  maxTailBytes?: number
  /** Character cap for a user-takeover notice (default 2000). */
  maxMessageChars?: number
}

/** Schemastery configuration schema; defaults mirror {@link resolveConfig}. */
export const Config: z<Config> = z.object({
  transcriptLines: z.number().default(5000).description('Retained transcript lines per terminal.'),
  transcriptBytes: z.number().default(1048576).description('Retained transcript bytes per terminal.'),
  defaultTimeoutMs: z.number().default(10000).description('Wait bound used when the model omits timeout_ms.'),
  minTimeoutMs: z.number().default(100).description('Smallest wait bound; smaller requests are clamped.'),
  maxTimeoutMs: z.number().default(600000).description('Hard cap for any single wait; larger requests are clamped.'),
  pollIntervalMs: z.number().default(150).description('wait_for poll interval in milliseconds.'),
  tailLines: z.number().default(30).description('Lines carried by a timeout outcome.'),
  maxLineTextChars: z.number().default(1000).description('Character cap for found.lineText.'),
  maxTailBytes: z.number().default(8192).description('UTF-8 byte cap for timeout.tail.'),
  maxMessageChars: z.number().default(2000).description('Character cap for a user-takeover notice.'),
})

/** Resolve one optional count with a loud failure instead of silent degradation. */
function resolveCount(label: string, value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`sidebar-terminal-tools: ${label} must be a safe integer >= ${minimum}`)
  }
  return resolved
}

/** Validate configuration loudly; every field resolved. */
export function resolveConfig(config: Config = {}): EndpointCoreConfig {
  const minTimeoutMs = resolveCount('minTimeoutMs', config.minTimeoutMs, 100, 1)
  const maxTimeoutMs = resolveCount('maxTimeoutMs', config.maxTimeoutMs, 600000, 1)
  if (maxTimeoutMs < minTimeoutMs) {
    throw new Error('sidebar-terminal-tools: maxTimeoutMs must be >= minTimeoutMs')
  }
  const defaultTimeoutMs = resolveCount('defaultTimeoutMs', config.defaultTimeoutMs, 10000, 1)
  if (defaultTimeoutMs < minTimeoutMs || defaultTimeoutMs > maxTimeoutMs) {
    throw new Error('sidebar-terminal-tools: defaultTimeoutMs must be within [minTimeoutMs, maxTimeoutMs]')
  }
  return {
    transcriptLines: resolveCount('transcriptLines', config.transcriptLines, 5000, 1),
    transcriptBytes: resolveCount('transcriptBytes', config.transcriptBytes, 1048576, 1),
    defaultTimeoutMs,
    minTimeoutMs,
    maxTimeoutMs,
    pollIntervalMs: resolveCount('pollIntervalMs', config.pollIntervalMs, 150, 1),
    tailLines: resolveCount('tailLines', config.tailLines, 30, 0),
    maxLineTextChars: resolveCount('maxLineTextChars', config.maxLineTextChars, 1000, 0),
    maxTailBytes: resolveCount('maxTailBytes', config.maxTailBytes, 8192, 0),
    maxMessageChars: resolveCount('maxMessageChars', config.maxMessageChars, 2000, 1),
  }
}

/**
 * Mount the endpoint core over the host's terminal controller and register
 * the six tools.
 * @param ctx - host context (requires `terminalController` and `tools`).
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const registry = new EndpointRegistry()
  const endpoint = createEndpoint(ctx.terminalController, registry, resolved)
  // Plugin fiber disposal (config change, unload) aborts every follow
  // consumer; the controller then reclaims its terminals per Session owner.
  ctx.effect(() => () => { registry.dispose() }, 'sidebar-terminal-tools: registry disposal')
  registerTools(ctx, { endpoint, config: resolved })
}
