/**
 * Client-half tests: the pure `pickUnopened` filter and the auto-open loop
 * wiring (fake services + fake timers, no React/DOM beyond window timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickUnopened, STB_PREFIX } from '../src/client/pick.js'
import { formatText, CLIENT_STRINGS } from '../src/client/locales.js'
import { apply, type ClientConfig, type ClientContext } from '../src/client/index.js'

const info = (id: string): { id: string } => ({ id })

describe('pickUnopened', () => {
  it('keeps only terminals carrying the model prefix', () => {
    const picked = pickUnopened(STB_PREFIX, [info('stb-1-a'), info('user-own'), info('stb-2-b')], new Set())
    expect(picked.map(entry => entry.id)).toEqual(['stb-1-a', 'stb-2-b'])
  })

  it('skips ids already opened or in flight', () => {
    const picked = pickUnopened(STB_PREFIX, [info('stb-1-a'), info('stb-2-b')], new Set(['stb-1-a']))
    expect(picked.map(entry => entry.id)).toEqual(['stb-2-b'])
  })

  it('deduplicates repeated ids within one recovery batch', () => {
    const picked = pickUnopened(STB_PREFIX, [info('stb-1-a'), info('stb-1-a')], new Set())
    expect(picked.map(entry => entry.id)).toEqual(['stb-1-a'])
  })

  it('returns nothing for empty inputs', () => {
    expect(pickUnopened(STB_PREFIX, [], new Set())).toEqual([])
    expect(pickUnopened(STB_PREFIX, [info('stb-1-a')], new Set(['stb-1-a']))).toEqual([])
  })

  it('preserves recovery order', () => {
    const picked = pickUnopened(STB_PREFIX, [info('stb-9-z'), info('stb-1-a')], new Set())
    expect(picked.map(entry => entry.id)).toEqual(['stb-9-z', 'stb-1-a'])
  })
})

describe('formatText', () => {
  it('substitutes placeholders into the localized template', () => {
    expect(formatText(CLIENT_STRINGS.autoOpened.en, { id: 'stb-1-a' })).toContain('stb-1-a')
    expect(formatText(CLIENT_STRINGS.autoOpened.zh, { id: 'stb-1-a' })).toContain('stb-1-a')
  })
})

interface LoopHarness {
  ctx: ClientContext
  openTabIn: ReturnType<typeof vi.fn>
  recover: ReturnType<typeof vi.fn>
  dispose: () => void
}

function makeLoopHarness(recoveredBySession: Record<string, { id: string }[]>): LoopHarness {
  const openTabIn = vi.fn()
  const recover = vi.fn(async (sessionId: string) => recoveredBySession[sessionId] ?? [])
  const disposers: Array<() => void> = []
  const ctx = {
    webTerminals: { recover },
    sidebarRight: {
      openTabs: { getSnapshot: () => [
        { sessionId: 'sess-1', tabId: 't1', kind: 'terminal', contentId: 'c1' },
        { sessionId: 'sess-2', tabId: 't2', kind: 'guide', contentId: 'c2' },
      ] },
      mounted: { getSnapshot: () => 'sess-3' as string | undefined },
      openTabIn,
    },
    locale: { resolveText: (text: { en: string }) => text.en },
    logger: { info: vi.fn(), warn: vi.fn() },
    effect: vi.fn((fn: () => () => void) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    }),
  } as unknown as ClientContext
  apply(ctx, { pollIntervalMs: 3000 })
  return { ctx, openTabIn, recover, dispose: () => { for (const dispose of disposers) dispose() } }
}

describe('auto-open loop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens stb- terminals from every inventoried session on the first poll', async () => {
    const harness = makeLoopHarness({
      'sess-1': [info('stb-1-a'), info('user-own')],
      'sess-3': [info('stb-3-a')],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.openTabIn).toHaveBeenCalledTimes(2)
    expect(harness.openTabIn).toHaveBeenCalledWith('sess-1', 'terminal', { params: { terminalId: 'stb-1-a' } })
    expect(harness.openTabIn).toHaveBeenCalledWith('sess-3', 'terminal', { params: { terminalId: 'stb-3-a' } })
    harness.dispose()
  })

  it('does not reopen a terminal on later polls', async () => {
    const harness = makeLoopHarness({ 'sess-1': [info('stb-1-a')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.openTabIn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.openTabIn).toHaveBeenCalledTimes(1)
    expect(harness.recover).toHaveBeenCalledTimes(9)
    harness.dispose()
  })

  it('stops polling after disposal', async () => {
    const harness = makeLoopHarness({ 'sess-1': [info('stb-1-a')] })
    await vi.advanceTimersByTimeAsync(0)
    harness.dispose()
    const calls = harness.recover.mock.calls.length
    await vi.advanceTimersByTimeAsync(9000)
    expect(harness.recover.mock.calls.length).toBe(calls)
  })

  it('rejects an out-of-range poll interval loudly', () => {
    const config: ClientConfig = { pollIntervalMs: 10 }
    expect(() => apply({} as ClientContext, config)).toThrow(/pollIntervalMs/)
  })
})
