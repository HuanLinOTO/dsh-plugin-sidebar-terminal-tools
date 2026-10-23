/**
 * Client-half tests: the pure `pickUnopened` filter and the auto-open loop
 * wiring (fake services + fake timers, no React/DOM beyond window timers).
 *
 * The loop is ACTIVITY-SCOPED: a status event opens one Session's activity
 * window, and an idle page issues no discovery request at all. The fallback
 * path (a host without forwarded events) keeps timed polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickUnopened, STB_PREFIX } from '../src/client/pick.js'
import { formatText, CLIENT_STRINGS } from '../src/client/locales.js'
import {
  apply, MAX_ACTIVITY_WINDOW_MS, type ClientConfig, type ClientContext,
} from '../src/client/index.js'

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

type StatusListener = (sessionId: string, running: boolean) => void

interface LoopHarness {
  ctx: ClientContext
  openTabIn: ReturnType<typeof vi.fn>
  recover: ReturnType<typeof vi.fn>
  statuses: StatusListener[]
  emitStatus: (sessionId: string, running: boolean) => void
  dispose: () => void
}

interface HarnessOptions {
  /** Omit the forwarded-event service to exercise the timed-polling fallback. */
  readonly forwardedEvents?: boolean
}

function makeLoopHarness(recoveredBySession: Record<string, { id: string }[]>, options: HarnessOptions = {}): LoopHarness {
  const openTabIn = vi.fn()
  const recover = vi.fn(async (sessionId: string, _refresh?: boolean) => recoveredBySession[sessionId] ?? [])
  const statuses: StatusListener[] = []
  const disposers: Array<() => void> = []
  const unsubscribers: Array<() => void> = []
  const remote = {
    $on: vi.fn((event: string, listener: StatusListener) => {
      if (event !== 'api-session/status') throw new Error(`unexpected event ${event}`)
      statuses.push(listener)
      const unsubscribe = (): void => { statuses.splice(statuses.indexOf(listener), 1) }
      unsubscribers.push(unsubscribe)
      return unsubscribe
    }),
  }
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
    get: (name: string) => (options.forwardedEvents === false ? undefined : name === 'remote' ? remote : undefined),
    effect: vi.fn((fn: () => () => void) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    }),
  } as unknown as ClientContext
  apply(ctx, { pollIntervalMs: 3000 })
  return {
    ctx,
    openTabIn,
    recover,
    statuses,
    emitStatus: (sessionId, running) => { for (const listener of [...statuses]) listener(sessionId, running) },
    dispose: () => { for (const dispose of disposers) dispose() },
  }
}

/** Sessions the harness believes are showing this window. */
const RESTORED = ['sess-1', 'sess-2', 'sess-3']

describe('auto-open loop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens stb- terminals from every inventoried session once on activation', async () => {
    const harness = makeLoopHarness({
      'sess-1': [info('stb-1-a'), info('user-own')],
      'sess-3': [info('stb-3-a')],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.openTabIn).toHaveBeenCalledTimes(2)
    expect(harness.openTabIn).toHaveBeenCalledWith('sess-1', 'terminal', { params: { terminalId: 'stb-1-a' } })
    expect(harness.openTabIn).toHaveBeenCalledWith('sess-3', 'terminal', { params: { terminalId: 'stb-3-a' } })
    expect(harness.recover.mock.calls.map(call => call[0])).toEqual(RESTORED)
    harness.dispose()
  })

  it('asks for refreshed discovery so later terminals appear', async () => {
    const harness = makeLoopHarness({ 'sess-1': [info('stb-1-a')] })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitStatus('sess-1', true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.recover).toHaveBeenCalled()
    for (const call of harness.recover.mock.calls) expect(call[1]).toBe(true)
    harness.dispose()
  })

  it('issues no discovery request while the page is idle', async () => {
    const harness = makeLoopHarness({ 'sess-1': [info('stb-1-a')] })
    await vi.advanceTimersByTimeAsync(0)
    const initial = harness.recover.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.recover.mock.calls.length).toBe(initial)
    harness.dispose()
  })

  it('polls only the running Session, then stops when its turn ends', async () => {
    const harness = makeLoopHarness({})
    await vi.advanceTimersByTimeAsync(0)
    const initial = harness.recover.mock.calls.length

    harness.emitStatus('sess-9', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.recover.mock.calls.length).toBe(initial + 1)
    await vi.advanceTimersByTimeAsync(6000)
    const running = harness.recover.mock.calls.slice(initial)
    expect(running.map(call => call[0])).toEqual(['sess-9', 'sess-9', 'sess-9'])
    expect(running.map(call => call[1])).toEqual([true, true, true])

    harness.emitStatus('sess-9', false)
    await vi.advanceTimersByTimeAsync(0)
    const afterTurnEnd = harness.recover.mock.calls.length
    expect(harness.recover.mock.calls.at(-1)?.[0]).toBe('sess-9')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.recover.mock.calls.length).toBe(afterTurnEnd)
    harness.dispose()
  })

  it('does not reopen a terminal on later discoveries', async () => {
    const harness = makeLoopHarness({ 'sess-9': [info('stb-9-a')] })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitStatus('sess-9', true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(harness.openTabIn).toHaveBeenCalledTimes(1)
    harness.emitStatus('sess-9', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.openTabIn).toHaveBeenCalledTimes(1)
    harness.dispose()
  })

  it('closes an activity window at its bound', async () => {
    const harness = makeLoopHarness({})
    await vi.advanceTimersByTimeAsync(0)
    harness.emitStatus('sess-9', true)
    await vi.advanceTimersByTimeAsync(0)
    harness.emitStatus('sess-9', true)
    await vi.advanceTimersByTimeAsync(MAX_ACTIVITY_WINDOW_MS + 3000)
    const bounded = harness.recover.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.recover.mock.calls.length).toBe(bounded)
    harness.dispose()
  })

  it('falls back to timed polling when the host forwards no session events', async () => {
    const harness = makeLoopHarness({ 'sess-1': [info('stb-1-a')] }, { forwardedEvents: false })
    await vi.advanceTimersByTimeAsync(0)
    const initial = harness.recover.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(harness.recover.mock.calls.length).toBe(initial + 6)
    harness.dispose()
  })

  it('stops every timer after disposal', async () => {
    const harness = makeLoopHarness({ 'sess-9': [info('stb-9-a')] })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitStatus('sess-9', true)
    await vi.advanceTimersByTimeAsync(3000)
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
