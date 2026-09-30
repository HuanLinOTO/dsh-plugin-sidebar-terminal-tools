/**
 * Endpoint-core tests against a structured fake of ctx.terminalController:
 * id minting, bounded transcripts, control handling (regain + user-takeover
 * notice), exit, close, and owner isolation.
 */
import { describe, expect, it, vi } from 'vitest'
import { EndpointRegistry, TranscriptBuffer, mintTerminalId } from '../src/registry.js'
import { buildUserNotice, createEndpoint, detectControllerChange, type EndpointCoreConfig } from '../src/endpoint.js'
import { FakeController, makeAgent } from './helpers/fake-controller.js'
import type { WebTerminalInfoShadow } from '../src/shadow.js'

const CONFIG: EndpointCoreConfig = {
  transcriptLines: 50,
  transcriptBytes: 4096,
  defaultTimeoutMs: 10000,
  minTimeoutMs: 100,
  maxTimeoutMs: 600000,
  pollIntervalMs: 5,
  tailLines: 30,
  maxLineTextChars: 1000,
  maxTailBytes: 8192,
  maxMessageChars: 2000,
}

/** Wait until the follow consumer has processed frames (all microtask scheduling). */
async function settle(): Promise<void> {
  await vi.waitFor(() => { /* at least one macrotask turn */ })
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

function makeCore() {
  const controller = new FakeController()
  const registry = new EndpointRegistry()
  const endpoint = createEndpoint(controller, registry, CONFIG)
  return { controller, registry, endpoint }
}

describe('mintTerminalId', () => {
  it('mints stb- ids accepted by the controller identity rule', () => {
    for (const seq of [1, 42, 999999]) {
      expect(mintTerminalId(seq)).toMatch(/^stb-[\w-]{1,120}$/)
    }
  })

  it('encodes the monotonic sequence and never retracts it', () => {
    const first = mintTerminalId(7)
    const second = mintTerminalId(8)
    const seqOf = (id: string): number => Number(id.split('-')[1])
    expect(seqOf(second)).toBeGreaterThan(seqOf(first))
  })

  it('is unique for the same sequence', () => {
    expect(mintTerminalId(1)).not.toBe(mintTerminalId(1))
  })
})

describe('TranscriptBuffer', () => {
  it('pages with newest-relative offsets like the terminal read contract', () => {
    const buffer = new TranscriptBuffer({ maxLines: 10, maxBytes: 4096 })
    buffer.append('l0\nl1\nl2\nl3\nl4\n')
    expect(buffer.read({ offset: 0, count: 2 })).toEqual({
      text: 'l3\nl4', totalLines: 5, lineBegin: 0, lineEnd: 2, truncated: false,
    })
    expect(buffer.read({ offset: 1, count: 10 })).toEqual({
      text: 'l0\nl1\nl2\nl3', totalLines: 5, lineBegin: 1, lineEnd: 5, truncated: false,
    })
    expect(buffer.read({ offset: 9, count: 5 })).toEqual({
      text: '', totalLines: 5, lineBegin: 9, lineEnd: 9, truncated: false,
    })
  })

  it('keeps a pending unterminated tail visible as the newest line', () => {
    const buffer = new TranscriptBuffer({ maxLines: 10, maxBytes: 4096 })
    buffer.append('$ run\nbuilding')
    expect(buffer.read({ offset: 0, count: 10 })).toEqual({
      text: '$ run\nbuilding', totalLines: 2, lineBegin: 0, lineEnd: 2, truncated: false,
    })
    buffer.append(' 42%\n')
    expect(buffer.read({ offset: 0, count: 10 }).text).toBe('$ run\nbuilding 42%')
  })

  it('enforces the line bound by dropping the oldest lines and flagging truncation', () => {
    const buffer = new TranscriptBuffer({ maxLines: 3, maxBytes: 4096 })
    buffer.append('a\nb\nc\nd\ne\n')
    const page = buffer.read({ offset: 0, count: 10 })
    expect(page.text).toBe('c\nd\ne')
    expect(page.totalLines).toBe(3)
    expect(page.truncated).toBe(true)
  })

  it('enforces the byte bound by dropping whole oldest lines first', () => {
    const buffer = new TranscriptBuffer({ maxLines: 10, maxBytes: 12 })
    buffer.append('aaaa\nbbbb\ncccc\n')
    const page = buffer.read({ offset: 0, count: 10 })
    expect(page.text).toBe('bbbb\ncccc')
    expect(page.truncated).toBe(true)
  })

  it('truncates the head of a single oversized line on a byte boundary', () => {
    const buffer = new TranscriptBuffer({ maxLines: 10, maxBytes: 8 })
    buffer.append('abcdefghijklmnop')
    const page = buffer.read({ offset: 0, count: 10 })
    expect(['ijklmnop', 'jklmnop', 'hijklmn']).toContain(page.text)
    expect(page.truncated).toBe(true)
  })

  it('replaces its content on a snapshot', () => {
    const buffer = new TranscriptBuffer({ maxLines: 10, maxBytes: 4096 })
    buffer.append('old stuff\n')
    buffer.replace('fresh\nscreen\n')
    expect(buffer.read({ offset: 0, count: 10 })).toMatchObject({ text: 'fresh\nscreen', totalLines: 2 })
  })
})

describe('detectControllerChange', () => {
  const info = (controllerId?: string): WebTerminalInfoShadow => ({
    id: 'stb-1-x', title: 't', shell: { path: '/bin/sh', args: [], name: 'sh' },
    cwd: '/w', cols: 80, rows: 24, state: 'running', exitCode: null,
    ...(controllerId === undefined ? {} : { controllerId }),
  })

  it('classifies control states', () => {
    expect(detectControllerChange(info('ours'), 'ours')).toBe('ours')
    expect(detectControllerChange(info('user'), 'ours')).toBe('user')
    expect(detectControllerChange(info(), 'ours')).toBe('unattached')
  })
})

describe('buildUserNotice', () => {
  it('creates a notice-shaped user message naming the terminal', () => {
    const message = buildUserNotice('stb-3-abcd', 2000)
    expect(message.role).toBe('user')
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(message.source).toEqual({
      kind: 'sidebar-terminal-tools',
      form: 'notice',
      summary: expect.stringContaining('stb-3-abcd'),
    })
    const text = (message.content[0] as { type: string; text: string }).text
    expect(text).toContain('stb-3-abcd')
    expect(text).toContain('took over')
  })

  it('bounds the notice text to the configured maximum', () => {
    const message = buildUserNotice('stb-3-abcd', 20)
    const text = (message.content[0] as { type: string; text: string }).text
    expect(text.length).toBeLessThanOrEqual(20)
  })
})

describe('endpoint core', () => {
  it('opens a terminal with an stb- id and follows as the input controller', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    expect(opened).toMatchObject({
      outcome: 'opened',
      state: 'running',
      shell: 'fake-sh',
      cwd: '/workspace',
      cols: 80,
      rows: 24,
    })
    expect(opened.terminalId).toMatch(/^stb-[\w-]{1,120}$/)
    await settle()
    expect(controller.attachCount.filter(entry => entry.id === opened.terminalId)).toHaveLength(1)
    const listed = endpoint.list(agent)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ terminalId: opened.terminalId, controller: 'plugin', state: 'running' })
  })

  it('maps terminal/limit-reached to a canonical value with the quota hint', async () => {
    const controller = new FakeController()
    controller.failCreate = id => Object.assign(
      new Error('Session terminal limit reached'),
      { code: 'terminal/limit-reached', details: { limit: 8 } },
    )
    const endpoint = createEndpoint(controller, new EndpointRegistry(), CONFIG)
    const result = await endpoint.open(makeAgent('sess-1'), {})
    expect(result).toEqual({
      outcome: 'limit_reached',
      limit: 8,
      message: expect.stringContaining('sidebar terminal'),
    })
  })

  it('sanitizes streamed output into the transcript and serves paged reads', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    controller.emitOutput(opened.terminalId, '\x1b[32m$ make\x1b[0m\nBUILD OK\n')
    await settle()
    const page = endpoint.read(agent, opened.terminalId, { offset: 0, count: 50 })
    expect(page.text).toBe('$ make\nBUILD OK')
    expect(page.state).toBe('running')
    expect(page.totalLines).toBe(2)
  })

  it('waits for a pattern over the transcript and reports the match', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    controller.emitOutput(opened.terminalId, 'compiling\n')
    void (async () => {
      await new Promise(resolve => { setTimeout(resolve, 10) })
      controller.emitOutput(opened.terminalId, 'BUILD OK\n')
    })()
    const outcome = await endpoint.waitFor(agent, opened.terminalId, { pattern: 'BUILD (OK|FAIL)' }, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'found', match: 'BUILD OK' })
  })

  it('regains control on send when the user holds it', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    await settle()
    controller.userTakeover(opened.terminalId)
    await settle()
    const result = await endpoint.send(agent, opened.terminalId, 'ping -n 2 127.0.0.1')
    expect(result).toMatchObject({ regained_control: true, wrote: expect.any(Number), state: 'running' })
    // exactly two attachments: initial follow + the regain re-follow
    expect(controller.attachCount.filter(entry => entry.id === opened.terminalId)).toHaveLength(2)
    // the write landed under the new attachment
    expect(controller.writes.filter(write => write.id === opened.terminalId)).toHaveLength(1)
    const listed = endpoint.list(agent)
    expect(listed[0]?.controller).toBe('plugin')
  })

  it('sends without the trailing carriage return when enter is false', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    await settle()
    await endpoint.send(agent, opened.terminalId, 'partial', { enter: false })
    expect(controller.writes[0]?.data).toBe('partial')
  })

  it('notifies the agent once per user-takeover episode and re-arms after regain', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    await settle()
    controller.userTakeover(opened.terminalId, 'user-a')
    await settle()
    controller.userTakeover(opened.terminalId, 'user-b')
    await settle()
    expect(agent.inject).toHaveBeenCalledTimes(1)
    const notice = agent.inject.mock.calls[0]?.[0] as { source?: { kind?: string; form?: string } }
    expect(notice.source).toMatchObject({ kind: 'sidebar-terminal-tools', form: 'notice' })
    // model send reclaims control; a later takeover is a new episode
    await endpoint.send(agent, opened.terminalId, 'whoami')
    await settle()
    controller.userTakeover(opened.terminalId, 'user-c')
    await settle()
    expect(agent.inject).toHaveBeenCalledTimes(2)
  })

  it('reports exited from wait_for once the process state is exited', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    controller.emitState(opened.terminalId, { state: 'exited', exitCode: 3 })
    await settle()
    const outcome = await endpoint.waitFor(agent, opened.terminalId, { pattern: 'never' }, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 3 })
    const listed = endpoint.list(agent)
    expect(listed[0]?.state).toBe('exited')
  })

  it('closes the terminal, stops the follower, and empties the registry', async () => {
    const { controller, endpoint, registry } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    await settle()
    const result = await endpoint.close(agent, opened.terminalId)
    expect(result).toEqual({ closed: true, terminalId: opened.terminalId })
    expect(controller.closes).toEqual([opened.terminalId])
    expect(endpoint.list(agent)).toEqual([])
    expect(registry.get('sess-1', opened.terminalId)).toBeUndefined()
    expect(() => endpoint.read(agent, opened.terminalId, {})).toThrow(/unknown sidebar terminal/)
    const outcome = await endpoint.waitFor(makeAgent('sess-1'), opened.terminalId, { pattern: 'x' }, new AbortController().signal).catch(error => error as Error)
    expect(String(outcome)).toMatch(/unknown sidebar terminal/)
  })

  it('isolates terminals per owner session', async () => {
    const { endpoint } = makeCore()
    const agentA = makeAgent('sess-a')
    const agentB = makeAgent('sess-b')
    const opened = await endpoint.open(agentA, {})
    expect(endpoint.list(agentB)).toEqual([])
    expect(() => endpoint.read(agentB, opened.terminalId, {})).toThrow(/unknown sidebar terminal/)
    await expect(endpoint.send(agentB, opened.terminalId, 'x')).rejects.toThrow(/unknown sidebar terminal/)
    await expect(endpoint.close(agentB, opened.terminalId)).rejects.toThrow(/unknown sidebar terminal/)
    await expect(endpoint.waitFor(agentB, opened.terminalId, { pattern: 'x' }, new AbortController().signal))
      .rejects.toThrow(/unknown sidebar terminal/)
    expect(endpoint.list(agentA)).toHaveLength(1)
  })

  it('returns gone from wait_for when the terminal is closed mid-wait', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    controller.emitOutput(opened.terminalId, 'starting\n')
    void (async () => {
      await new Promise(resolve => { setTimeout(resolve, 10) })
      await endpoint.close(agent, opened.terminalId)
    })()
    const outcome = await endpoint.waitFor(agent, opened.terminalId, { pattern: 'never-here' }, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'gone' })
  })

  it('does not notify for takeovers the plugin itself caused', async () => {
    const { controller, endpoint } = makeCore()
    const agent = makeAgent('sess-1')
    const opened = await endpoint.open(agent, {})
    await settle()
    // our own re-follow (regain) broadcasts state with our new attachment; no notice may fire
    await endpoint.send(agent, opened.terminalId, 'echo hi')
    await settle()
    expect(agent.inject).not.toHaveBeenCalled()
    // ... and the initial attach broadcast never fired one either
    controller.emitState(opened.terminalId, {})
    await settle()
    expect(agent.inject).not.toHaveBeenCalled()
  })
})
