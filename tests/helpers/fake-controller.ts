/**
 * A structured fake of the terminal-controller surface (create/attach/close/
 * list) with scriptable duplex attachments, mirroring the semantics that
 * matter to the endpoint core (real: api/terminal-controller/src/terminal.ts):
 *
 * - `attach` makes the new attachment the exclusive input controller and
 *   broadcasts a `state` frame with `writable: false` to every existing
 *   follower; the new follower first receives a `snapshot` frame with
 *   `writable: true`, then ordered `output`/`state`/`ack` frames,
 * - input commands are consumed from the attachment's uplink; a `ack`
 *   without refusal records the write, one with `refusal` reports
 *   `read-only` (another attachment controls) or `not-running`,
 * - detaching the controlling follower broadcasts `state` with the remaining
 *   followers' writability,
 * - `close` ends every follower stream.
 *
 * The `terminal/unavailable` / `terminal/limit-reached` errors carry the same
 * `code` field the real RemoteError exposes.
 */
import { vi } from 'vitest'
import type { TerminalInputShadow, TerminalOwnerLike, TerminalSurface, TerminalFrameShadow, WebTerminalInfoShadow } from '../../src/shadow.js'

interface FakeFollower {
  push(frame: TerminalFrameShadow): void
  end(): void
  active: boolean
}

export class FakeController implements TerminalSurface {
  readonly creates: { id: string; cols: number; rows: number }[] = []
  readonly writes: { id: string; data: string }[] = []
  readonly closes: string[] = []
  readonly listCalls: string[] = []
  /** Terminal ids, one entry per attach call (regains append here too). */
  readonly attachCount: string[] = []
  failCreate: ((id: string) => Error) | undefined

  private readonly terminals = new Map<string, { info: WebTerminalInfoShadow; followers: Set<FakeFollower>; controller?: FakeFollower }>()

  private terminal(id: string) {
    const terminal = this.terminals.get(id)
    if (terminal === undefined) {
      throw Object.assign(new Error('Terminal no longer exists in this Session'), { code: 'terminal/unavailable' })
    }
    return terminal
  }

  async create(agent: { id: string }, request: { id: string; cols: number; rows: number; shellPath?: string }, signal: AbortSignal): Promise<WebTerminalInfoShadow> {
    signal.throwIfAborted()
    if (this.failCreate !== undefined) throw this.failCreate(request.id)
    this.creates.push({ id: request.id, cols: request.cols, rows: request.rows })
    const info: WebTerminalInfoShadow = {
      id: request.id,
      title: `t-${request.id}`,
      shell: { path: '/bin/fake-sh', args: [], name: 'fake-sh' },
      cwd: '/workspace',
      cols: request.cols,
      rows: request.rows,
      state: 'running',
      exitCode: null,
    }
    this.terminals.set(request.id, { info, followers: new Set() })
    return info
  }

  attach(agent: { id: string }, id: string, input: AsyncIterable<TerminalInputShadow>, signal: AbortSignal): AsyncIterable<TerminalFrameShadow> {
    signal.throwIfAborted()
    const terminal = this.terminal(id)
    this.attachCount.push(id)

    const queue: TerminalFrameShadow[] = []
    let done = false
    const waiters: (() => void)[] = []
    const wake = (): void => { for (const waiter of waiters.splice(0)) waiter() }
    const follower: FakeFollower = {
      active: true,
      push(frame) { if (done) return; queue.push(frame); wake() },
      end() { if (done) return; done = true; wake() },
    }
    const writableOf = (candidate: FakeFollower): boolean =>
      terminal.info.state === 'running' && terminal.controller === candidate
    const detach = (): void => {
      terminal.followers.delete(follower)
      follower.active = false
      follower.end()
      if (terminal.controller === follower) {
        terminal.controller = undefined
        this.broadcastState(terminal)
      }
    }

    terminal.followers.add(follower)
    // The new attachment takes exclusive input control; existing followers
    // lose writability first (the real attach broadcasts before baselining).
    terminal.controller = follower
    this.broadcastState(terminal, follower)
    queue.push({ type: 'snapshot', sequence: 0, screen: '', info: terminal.info, writable: true })

    // Input pump: mirrors BrowserTerminal.consumeInput (acks per sequence).
    const commands = input[Symbol.asyncIterator]()
    void (async () => {
      let expected = 0
      try {
        for (;;) {
          const next = await commands.next()
          if (next.done === true || signal.aborted || !follower.active) return
          const command = next.value
          if (command.type !== 'write' || command.sequence !== ++expected) {
            follower.end()
            return
          }
          if (writableOf(follower)) {
            this.writes.push({ id, data: command.data })
            follower.push({ type: 'ack', sequence: command.sequence })
          } else {
            follower.push({
              type: 'ack',
              sequence: command.sequence,
              refusal: terminal.info.state === 'running' ? 'read-only' : 'not-running',
            })
          }
        }
      } catch {
        // An uplink failure ends this pump (the real stream fails with it).
        follower.end()
      }
    })()

    signal.addEventListener('abort', () => { detach(); void commands.return?.(undefined) }, { once: true })
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<TerminalFrameShadow>> {
            if (queue.length === 0 && !done) await new Promise<void>(resolve => { waiters.push(resolve) })
            const value = queue.shift()
            if (value === undefined) return { done: true, value: undefined }
            return { done: false, value }
          },
          async return(): Promise<IteratorResult<TerminalFrameShadow>> {
            detach()
            void commands.return?.(undefined)
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  private broadcastState(terminal: { info: WebTerminalInfoShadow; followers: Set<FakeFollower>; controller?: FakeFollower }, skip?: FakeFollower): void {
    for (const follower of terminal.followers) {
      if (follower === skip) continue
      follower.push({ type: 'state', info: terminal.info, writable: terminal.controller === follower && terminal.info.state === 'running' })
    }
  }

  /** Test helper: push raw output to every live follower (mirrors PTY echo). */
  emitOutput(id: string, data: string): void {
    const terminal = this.terminal(id)
    for (const follower of terminal.followers) follower.push({ type: 'output', sequence: 0, data })
  }

  /** Test helper: simulate the user's view attaching and taking input control. */
  userTakeover(id: string): void {
    const terminal = this.terminal(id)
    const userView: FakeFollower = { active: true, push() {}, end() {} }
    terminal.followers.add(userView)
    terminal.controller = userView
    this.broadcastState(terminal)
  }

  /** Test helper: publish a state change (e.g. process exit) to every follower. */
  emitState(id: string, patch: Partial<WebTerminalInfoShadow>): void {
    const terminal = this.terminal(id)
    terminal.info = { ...terminal.info, ...patch }
    this.broadcastState(terminal)
  }

  async close(agent: { id: string }, id: string): Promise<void> {
    this.closes.push(id)
    const terminal = this.terminals.get(id)
    this.terminals.delete(id)
    for (const follower of terminal?.followers ?? []) follower.end()
  }

  list(sessionId: string): WebTerminalInfoShadow[] {
    this.listCalls.push(sessionId)
    return [...this.terminals.values()].map(terminal => terminal.info)
  }
}

/** A minimal fake owner agent: identity plus a recording inject(). */
export function makeAgent(id: string): { id: string; inject: ReturnType<typeof vi.fn> } {
  const inject = vi.fn()
  return { id, inject }
}

/** Let the background attachment consumer drain queued frames (microtask + macrotask). */
export async function settle(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 0) })
  await new Promise(resolve => { setTimeout(resolve, 0) })
}
