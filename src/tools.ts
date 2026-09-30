/**
 * The six `sidebar_terminal_*` tool definitions: thin adapters that parse
 * arguments, drive the endpoint core, and project canonical values to text.
 * The canonical shapes are the contract — the schema and the execute return
 * value must stay name-for-name identical.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Endpoint, EndpointCoreConfig, OwnerAgent } from './endpoint.js'
import { renderWaitOutcome, type WaitOutcome } from './wait-for.js'

const OPEN_DESCRIPTION = 'Open a new terminal in the user\'s right sidebar and attach to it. '
  + 'The terminal runs a real interactive shell with the system user\'s permissions — no Agent sandbox, no approval gate — '
  + 'and appears in the user\'s sidebar automatically; the user can watch it and take over input at any time. '
  + 'Return its terminalId and use sidebar_terminal_send / sidebar_terminal_read / sidebar_terminal_wait_for to drive it. '
  + 'Terminals share one per-session quota with the user\'s manual sidebar terminals (8 by default); when the quota is exhausted the result is limit_reached — close unused terminals and retry.'

const SEND_DESCRIPTION = 'Write text into a sidebar terminal you opened with sidebar_terminal_open. '
  + 'A carriage return is appended unless enter is false, so the default is "run this command". '
  + 'If the user has taken over the terminal, this call silently reclaims input control (regained_control: true) before writing; '
  + 'check the transcript with sidebar_terminal_read first, since the user may have run their own commands.'

const READ_DESCRIPTION = 'Read the retained plain-text transcript of one sidebar terminal, newest page first. '
  + 'offset counts lines from the end (0 = newest page); count bounds the page size. '
  + 'Escape sequences are already stripped and the transcript is bounded (oldest lines drop out first).'

const WAIT_FOR_DESCRIPTION = 'Block until a pattern appears in a sidebar terminal\'s retained transcript, or until the timeout elapses, or until the shell exits or the terminal disappears — whichever happens first. '
  + 'Does not write input, so it is safe while a long command is still running. '
  + 'The pattern is a JavaScript regular expression (case-sensitive); a pattern that fails to compile falls back to verbatim substring matching. '
  + 'One pattern may cover several outcomes, e.g. (BUILD OK|BUILD FAIL) — the found result\'s match field tells which alternative hit. '
  + 'Returns kind=found with the matched text, line number, column and line text; kind=timeout with a bounded tail; kind=exited or kind=gone; or kind=cancelled when the call is aborted.'

const CLOSE_DESCRIPTION = 'Close one sidebar terminal you opened (kills its shell) and release its transcript. '
  + 'The per-session terminal quota is shared with the user\'s manual sidebar terminals, so close what you no longer need.'

const LIST_DESCRIPTION = 'List the sidebar terminals this session opened (ids, states, sizes, and who currently holds input control).'

/** Output schema of `sidebar_terminal_open`: the two canonical outcomes. */
const OPEN_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', required: true, const: 'opened' },
        terminalId: { type: 'string', required: true, description: 'Terminal id for the other sidebar_terminal_* tools.' },
        shell: { type: 'string', required: true, description: 'Human-readable shell name.' },
        shellPath: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Shell executable path, or null when the default shell was used.' },
        cwd: { type: 'string', required: true, description: 'Initial working directory.' },
        cols: { type: 'integer', required: true },
        rows: { type: 'integer', required: true },
        state: { type: 'string', required: true, enum: ['running', 'exited', 'failed'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', required: true, const: 'limit_reached' },
        limit: { type: 'integer', required: true, description: 'The per-session terminal quota that was exhausted.' },
        message: { type: 'string', required: true, description: 'What to do about it.' },
      },
    },
  ],
} as const

/** Output schema of `sidebar_terminal_wait_for`: the five canonical outcomes. */
const OUTCOME_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'found' },
        match: { type: 'string', required: true, description: 'The text that actually matched; for a multi-outcome pattern this tells which alternative hit.' },
        line: { type: 'integer', required: true, description: '0-based line index in the retained transcript.' },
        column: { type: 'integer', required: true, description: '0-based character index of the match within its line.' },
        lineText: { type: 'string', required: true, description: 'The full matched line, possibly truncated.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds from wait start to the match.' },
        scannedLines: { type: 'integer', required: true, description: 'Lines scanned in the matching poll.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'timeout' },
        timeoutMs: { type: 'integer', required: true, description: 'The configured timeout that elapsed.' },
        totalLines: { type: 'integer', required: true, description: 'Lines retained when the timeout fired.' },
        tail: { type: 'string', required: true, description: 'Bounded tail of the retained transcript at the timeout.' },
        scannedLines: { type: 'integer', required: true, description: 'Lines scanned in the final poll.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds actually waited.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'exited' },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Exit code of the top-level shell, if known.' },
        signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Exit signal of the top-level shell, if killed by one.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds waited before the exit was observed.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'gone' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds waited before the terminal disappeared.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'cancelled' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds waited before the call was aborted.' },
      },
    },
  ],
} as const

/** Register the six tools against `ctx.tools`. */
export function registerTools(ctx: Context, deps: { endpoint: Endpoint; config: EndpointCoreConfig }): void {
  const { endpoint, config } = deps
  const requireAgent = (agent: unknown): OwnerAgent => {
    if (agent === undefined) throw new Error('sidebar_terminal_* tools require an initiating agent')
    return agent as OwnerAgent
  }
  const requireId = (terminalId: unknown): string => {
    if (typeof terminalId !== 'string' || terminalId.length === 0) {
      throw new Error('terminalId must be a non-empty string')
    }
    return terminalId
  }

  ctx.tools.register(defineTool({
    name: 'sidebar_terminal_open',
    description: OPEN_DESCRIPTION,
    parameters: {
      cols: { type: 'integer', description: 'Initial width in columns (default 80; 2–500).' },
      rows: { type: 'integer', description: 'Initial height in rows (default 24; 1–200).' },
      shell_path: { type: 'string', description: 'Executable path of a discovered shell; omit for the environment default.' },
    },
    output: {
      schema: OPEN_SCHEMA,
      render: (_args, value) => {
        const opened = value as { outcome: string; terminalId?: string; limit?: number; message?: string; shell?: string; cwd?: string; cols?: number; rows?: number }
        return [{
          type: 'text',
          text: opened.outcome === 'opened'
            ? `opened terminal ${opened.terminalId} (${opened.shell}, ${opened.cwd}, ${opened.cols}x${opened.rows})`
            : `[limit_reached] terminal quota of ${opened.limit} is exhausted — ${opened.message ?? ''}`,
        }]
      },
    },
    async execute(args, exec) {
      const owner = requireAgent(exec.agent)
      const input = args as { cols?: number; rows?: number; shell_path?: string }
      return endpoint.open(owner, {
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
        ...(input.shell_path === undefined || input.shell_path.length === 0 ? {} : { shellPath: input.shell_path }),
      })
    },
    presentCall: args => ({ card: 'generic', title: `Open sidebar terminal${typeof args.shell_path === 'string' && args.shell_path.length > 0 ? ` (${args.shell_path})` : ''}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'sidebar_terminal_send',
    description: SEND_DESCRIPTION,
    parameters: {
      terminalId: { type: 'string', required: true, description: 'Terminal id returned by sidebar_terminal_open.' },
      text: { type: 'string', required: true, description: 'Raw input to deliver; a carriage return is appended unless enter is false.' },
      enter: { type: 'boolean', description: 'Append a carriage return (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wrote: { type: 'integer', required: true, description: 'Characters delivered, the appended carriage return included.' },
          regained_control: { type: 'boolean', required: true, description: 'True when the user held input control and this call reclaimed it before writing.' },
          state: { type: 'string', required: true, enum: ['running', 'exited', 'failed'] },
        },
      },
      render: (_args, value) => {
        const sent = value as { wrote: number; regained_control: boolean; state: string }
        return [{
          type: 'text',
          text: `sent ${sent.wrote} chars (${sent.state}${sent.regained_control ? '; reclaimed control from the user' : ''})`,
        }]
      },
    },
    async execute(args, exec) {
      const owner = requireAgent(exec.agent)
      const input = args as { terminalId: string; text: string; enter?: boolean }
      const terminalId = requireId(input.terminalId)
      if (input.text.length === 0) throw new Error('text must be a non-empty string')
      return endpoint.send(owner, terminalId, input.text, input.enter === undefined ? {} : { enter: input.enter })
    },
    presentCall: args => ({ card: 'generic', title: `Send to sidebar terminal ${args.terminalId}`, kind: 'execute', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'sidebar_terminal_read',
    description: READ_DESCRIPTION,
    parameters: {
      terminalId: { type: 'string', required: true, description: 'Terminal id returned by sidebar_terminal_open.' },
      offset: { type: 'integer', description: 'Lines from the newest end to skip (default 0).' },
      count: { type: 'integer', description: 'Maximum lines to return (default 500).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The requested page of transcript lines joined by newlines.' },
          totalLines: { type: 'integer', required: true, description: 'Lines currently retained.' },
          lineBegin: { type: 'integer', required: true, description: 'Newest-relative offset of the first returned line.' },
          lineEnd: { type: 'integer', required: true, description: 'Newest-relative offset after the returned page.' },
          truncated: { type: 'boolean', required: true, description: 'Whether transcript bounds dropped older content.' },
          state: { type: 'string', required: true, enum: ['running', 'exited', 'failed'] },
          exitCode: { description: 'Exit code once the shell has exited, null while running.', required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => {
        const page = value as { text: string; totalLines: number; state: string }
        const body = page.text.length > 0 ? page.text : '(no output yet)'
        return [{ type: 'text', text: `${body}\n[${page.state}; ${page.totalLines} lines retained]` }]
      },
    },
    async execute(args, exec) {
      const owner = requireAgent(exec.agent)
      const input = args as { terminalId: string; offset?: number; count?: number }
      const terminalId = requireId(input.terminalId)
      return endpoint.read(owner, terminalId, {
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.count === undefined ? {} : { count: input.count }),
      })
    },
    presentCall: args => ({ card: 'generic', title: `Read sidebar terminal ${args.terminalId}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'sidebar_terminal_wait_for',
    description: WAIT_FOR_DESCRIPTION,
    parameters: {
      terminalId: { type: 'string', required: true, description: 'Terminal id returned by sidebar_terminal_open.' },
      pattern: { type: 'string', required: true, description: 'JavaScript regular expression to wait for (case-sensitive); an invalid pattern falls back to verbatim substring matching. Must be non-empty.' },
      timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds. Defaults to the plugin default and is clamped to the plugin bounds.' },
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderWaitOutcome(value as WaitOutcome) }],
    },
    async execute(args, exec) {
      const owner = requireAgent(exec.agent)
      const input = args as { terminalId: string; pattern: string; timeout_ms?: number }
      const terminalId = requireId(input.terminalId)
      if (input.pattern.length === 0) throw new Error('pattern must be a non-empty string')
      return endpoint.waitFor(owner, terminalId, {
        pattern: input.pattern,
        ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
      }, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `Wait on sidebar terminal ${args.terminalId}`, kind: 'read', rawInput: args.pattern }),
  }))

  ctx.tools.register(defineTool({
    name: 'sidebar_terminal_close',
    description: CLOSE_DESCRIPTION,
    parameters: {
      terminalId: { type: 'string', required: true, description: 'Terminal id returned by sidebar_terminal_open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          terminalId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `closed terminal ${(value as { terminalId: string }).terminalId}` }],
    },
    async execute(args, exec) {
      const owner = requireAgent(exec.agent)
      const input = args as { terminalId: string }
      return endpoint.close(owner, requireId(input.terminalId))
    },
    presentCall: args => ({ card: 'generic', title: `Close sidebar terminal ${args.terminalId}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'sidebar_terminal_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            terminalId: { type: 'string', required: true },
            title: { type: 'string', required: true },
            shell: { type: 'string', required: true },
            cwd: { type: 'string', required: true },
            state: { type: 'string', required: true, enum: ['running', 'exited', 'failed'] },
            exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Exit code once the shell has exited, null while running.' },
            lines: { type: 'integer', required: true, description: 'Retained transcript lines.' },
            controller: { type: 'string', required: true, enum: ['plugin', 'user', 'none'], description: 'Who currently holds input control.' },
          },
        },
      },
      render: (_args, value) => {
        const terminals = value as { terminalId: string; state: string; controller: string; lines: number }[]
        return [{
          type: 'text',
          text: terminals.length === 0
            ? '(no sidebar terminals opened by this session)'
            : terminals.map(entry => `${entry.terminalId} [${entry.state}] controller=${entry.controller} ${entry.lines} lines`).join('\n'),
        }]
      },
    },
    async execute(_args, exec) {
      const owner = requireAgent(exec.agent)
      return [...endpoint.list(owner)]
    },
    presentCall: () => ({ card: 'generic', title: 'List sidebar terminals', kind: 'read' }),
  }))
}
