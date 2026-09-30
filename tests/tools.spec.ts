/**
 * Tool-registration tests: `defineTool` is mocked so the raw definitions are
 * inspectable (the previous plugin's approach). Executes run end-to-end over
 * a FakeController through the real endpoint core.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: vi.fn((options: unknown) => options),
}))

import { Config, apply, inject, name, resolveConfig } from '../src/index.js'
import type { Config as PluginConfig } from '../src/index.js'
import { FakeController, makeAgent, settle } from './helpers/fake-controller.js'

interface CapturedTool {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: true; description?: string }>
  output: {
    schema: { oneOf?: readonly { properties: Record<string, unknown> }[] }
    render: (args: unknown, value: unknown) => { type: string; text: string }[]
  }
  execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<unknown>
}

interface Harness {
  ctx: Context
  registered: CapturedTool[]
  controller: FakeController
}

function makeHarness(config: PluginConfig = {}): Harness {
  const registered: CapturedTool[] = []
  const controller = new FakeController()
  const ctx = {
    tools: {
      register(definition: unknown) {
        registered.push(definition as CapturedTool)
        return () => {}
      },
    },
    effect: vi.fn((fn: () => unknown) => { return () => { void fn } }),
    terminalController: controller,
  } as unknown as Context
  apply(ctx, config)
  return { ctx, registered, controller }
}

function toolOf(harness: Harness, toolName: string): CapturedTool {
  const tool = harness.registered.find(entry => entry.name === toolName)
  expect(tool, `tool ${toolName} must be registered`).toBeDefined()
  return tool as CapturedTool
}

function execFor(agent: unknown): { signal: AbortSignal; agent: unknown } {
  return { signal: new AbortController().signal, agent }
}

describe('plugin metadata', () => {
  it('exposes the fixed plugin name and required services', () => {
    expect(name).toBe('sidebar-terminal-tools')
    expect(inject).toEqual(['terminalController', 'tools'])
  })

  it('ships a Schemastery Config schema', () => {
    expect(Config).toBeDefined()
    expect(typeof Config).toBe('function')
  })
})

describe('resolveConfig', () => {
  it('fills the documented defaults', () => {
    expect(resolveConfig({})).toEqual({
      transcriptLines: 5000,
      transcriptBytes: 1048576,
      defaultTimeoutMs: 10000,
      minTimeoutMs: 100,
      maxTimeoutMs: 600000,
      pollIntervalMs: 150,
      tailLines: 30,
      maxLineTextChars: 1000,
      maxTailBytes: 8192,
      maxMessageChars: 2000,
    })
  })

  it('accepts explicit overrides', () => {
    const resolved = resolveConfig({ transcriptLines: 100, pollIntervalMs: 50, maxMessageChars: 300 })
    expect(resolved.transcriptLines).toBe(100)
    expect(resolved.pollIntervalMs).toBe(50)
    expect(resolved.maxMessageChars).toBe(300)
  })

  it('rejects invalid or inverted values loudly', () => {
    expect(() => resolveConfig({ transcriptLines: 0 })).toThrow(/transcriptLines/)
    expect(() => resolveConfig({ pollIntervalMs: 0 })).toThrow(/pollIntervalMs/)
    expect(() => resolveConfig({ minTimeoutMs: 5000, maxTimeoutMs: 1000 })).toThrow(/maxTimeoutMs/)
    expect(() => resolveConfig({ defaultTimeoutMs: 999999 })).toThrow(/defaultTimeoutMs/)
  })
})

describe('tool registration', () => {
  it('registers exactly the six sidebar_terminal_* tools', () => {
    const { registered } = makeHarness()
    expect(registered.map(tool => tool.name)).toEqual([
      'sidebar_terminal_open',
      'sidebar_terminal_send',
      'sidebar_terminal_read',
      'sidebar_terminal_wait_for',
      'sidebar_terminal_close',
      'sidebar_terminal_list',
    ])
  })

  it('declares the required terminalId parameters and optional paging/enter fields', () => {
    const harness = makeHarness()
    expect(Object.keys(toolOf(harness, 'sidebar_terminal_open').parameters)).toEqual(['cols', 'rows', 'shell_path'])
    expect(Object.keys(toolOf(harness, 'sidebar_terminal_send').parameters)).toEqual(['terminalId', 'text', 'enter'])
    expect(Object.keys(toolOf(harness, 'sidebar_terminal_read').parameters)).toEqual(['terminalId', 'offset', 'count'])
    expect(Object.keys(toolOf(harness, 'sidebar_terminal_wait_for').parameters)).toEqual(['terminalId', 'pattern', 'timeout_ms'])
    expect(Object.keys(toolOf(harness, 'sidebar_terminal_close').parameters)).toEqual(['terminalId'])
    expect(toolOf(harness, 'sidebar_terminal_list').parameters).toEqual({})
    for (const toolName of ['sidebar_terminal_send', 'sidebar_terminal_read', 'sidebar_terminal_wait_for', 'sidebar_terminal_close']) {
      expect(toolOf(harness, toolName).parameters.terminalId?.required).toBe(true)
    }
  })

  it('declares the five wait_for outcome kinds and the two open outcomes', () => {
    const harness = makeHarness()
    const waitKinds = (toolOf(harness, 'sidebar_terminal_wait_for').output.schema.oneOf ?? []).map(
      variant => (variant.properties.kind as { const?: string }).const,
    )
    expect(waitKinds).toEqual(['found', 'timeout', 'exited', 'gone', 'cancelled'])
    const openKinds = (toolOf(harness, 'sidebar_terminal_open').output.schema.oneOf ?? []).map(
      variant => (variant.properties.kind as { const?: string })?.const
        ?? (variant.properties.outcome as { const?: string })?.const,
    )
    expect(openKinds).toEqual(['opened', 'limit_reached'])
  })
})

describe('tool execute (end-to-end over the fake controller)', () => {
  it('runs open → send → read → wait_for → list → close', async () => {
    const harness = makeHarness()
    const agent = makeAgent('sess-1')
    const opened = await toolOf(harness, 'sidebar_terminal_open').execute({ cols: 100, rows: 30 }, execFor(agent))
    const terminalId = (opened as { terminalId: string }).terminalId
    expect(opened).toMatchObject({ outcome: 'opened', cols: 100, rows: 30 })
    expect(terminalId).toMatch(/^stb-/)

    await toolOf(harness, 'sidebar_terminal_send').execute({ terminalId, text: 'echo done' }, execFor(agent))
    expect(harness.controller.writes.filter(write => write.id === terminalId)).toHaveLength(1)
    expect(harness.controller.writes[0]?.data).toBe('echo done\r')

    harness.controller.emitOutput(terminalId, '$ echo done\r\ndone\r\n')
    await settle()
    const page = await toolOf(harness, 'sidebar_terminal_read').execute({ terminalId }, execFor(agent)) as {
      text: string; totalLines: number; state: string
    }
    expect(page.text).toContain('echo done')
    expect(page.text).toContain('done')
    expect(page.state).toBe('running')

    const waited = await toolOf(harness, 'sidebar_terminal_wait_for').execute({ terminalId, pattern: 'done' }, execFor(agent))
    expect(waited).toMatchObject({ kind: 'found', match: 'done' })

    const listed = await toolOf(harness, 'sidebar_terminal_list').execute({}, execFor(agent)) as unknown as {
      terminalId: string; controller: string
    }[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ terminalId, controller: 'plugin' })

    const closed = await toolOf(harness, 'sidebar_terminal_close').execute({ terminalId }, execFor(agent))
    expect(closed).toEqual({ closed: true, terminalId })
    expect(await toolOf(harness, 'sidebar_terminal_list').execute({}, execFor(agent))).toEqual([])
  })

  it('maps a quota failure to the canonical limit_reached value', async () => {
    const harness = makeHarness()
    harness.controller.failCreate = id => Object.assign(
      new Error('Session terminal limit reached'),
      { code: 'terminal/limit-reached', details: { limit: 8 } },
    )
    const result = await toolOf(harness, 'sidebar_terminal_open').execute({}, execFor(makeAgent('sess-1')))
    expect(result).toMatchObject({ outcome: 'limit_reached', limit: 8 })
  })

  it('isolates one agent from another agent\'s terminals', async () => {
    const harness = makeHarness()
    const agentA = makeAgent('sess-a')
    const agentB = makeAgent('sess-b')
    const opened = await toolOf(harness, 'sidebar_terminal_open').execute({}, execFor(agentA)) as { terminalId: string }
    await expect(
      toolOf(harness, 'sidebar_terminal_read').execute({ terminalId: opened.terminalId }, execFor(agentB)),
    ).rejects.toThrow(/unknown sidebar terminal/)
    expect(await toolOf(harness, 'sidebar_terminal_list').execute({}, execFor(agentB))).toEqual([])
  })

  it('rejects executions without an initiating agent', async () => {
    const harness = makeHarness()
    await expect(
      toolOf(harness, 'sidebar_terminal_open').execute({}, { signal: new AbortController().signal }),
    ).rejects.toThrow(/initiating agent/)
  })

  it('rejects empty terminal ids and patterns', async () => {
    const harness = makeHarness()
    const agent = makeAgent('sess-1')
    await expect(
      toolOf(harness, 'sidebar_terminal_send').execute({ terminalId: '', text: 'x' }, execFor(agent)),
    ).rejects.toThrow(/terminalId/)
    await expect(
      toolOf(harness, 'sidebar_terminal_wait_for').execute({ terminalId: 'stb-1-x', pattern: '' }, execFor(agent)),
    ).rejects.toThrow(/pattern/)
  })
})

describe('render projections', () => {
  it('renders open, send, and wait_for values as text', async () => {
    const harness = makeHarness()
    const agent = makeAgent('sess-1')
    const opened = await toolOf(harness, 'sidebar_terminal_open').execute({}, execFor(agent)) as { terminalId: string }
    const openRender = toolOf(harness, 'sidebar_terminal_open').output.render({}, opened)
    expect(openRender[0]?.text).toContain(opened.terminalId)

    const sendRender = toolOf(harness, 'sidebar_terminal_send').output.render({}, {
      wrote: 10, regained_control: false, state: 'running',
    })
    expect(sendRender[0]?.text).toContain('running')

    const waitRender = toolOf(harness, 'sidebar_terminal_wait_for').output.render({}, {
      kind: 'found', match: 'OK', line: 1, column: 0, lineText: 'OK', elapsedMs: 5, scannedLines: 2,
    })
    expect(waitRender[0]?.text).toContain('[found]')
  })
})
