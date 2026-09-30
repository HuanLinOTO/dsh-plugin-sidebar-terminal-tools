/**
 * A structured fake of `ctx.terminalController` (create/follow/write/close/list)
 * with scriptable follow streams, mirroring the semantics that matter to the
 * endpoint core:
 *
 * - `follow` makes the new attachment the exclusive input controller and
 *   broadcasts a `state` frame to every existing follower (real:
 *   api/terminal-controller/src/terminal.ts follow()),
 * - the new follower first receives a `snapshot` frame, then ordered
 *   `output`/`state` frames,
 * - `write` throws a `terminal/control-unavailable` RemoteError-shaped error
 *   when the attachment is not the current controller,
 * - `close` ends every follower stream.
 *
 * The `terminal/unavailable` / `terminal/limit-reached` errors carry the same
 * `code` field the real RemoteError exposes.
 */
import { vi } from 'vitest'
import type { TerminalControllerLike, TerminalFrameShadow, WebTerminalInfoShadow } from '../../src/shadow.js'

interface FakeFollower {
  push(frame: TerminalFrameShadow): void
  end(): void
}

export class FakeController implements TerminalControllerLike {
  readonly creates: { id: string; cols: number; rows: number }[] = []
  readonly writes: { id: string; attachmentId: string; data: string }[] = []
  readonly closes: string[] = []
  readonly listCalls: string[] = []
  readonly attachCount: { id: string; attachmentId: string }[] = []
  failCreate: ((id: string) => Error) | undefined

  private readonly terminals = new Map<string, { info: WebTerminalInfoShadow; followers: Set<FakeFollower> }>()
  private readonly controlOf = new Map<string, string>()

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

  follow(agent: { id: string }, id: string, attachmentId: string, signal: AbortSignal): AsyncIterable<TerminalFrameShadow> {
    signal.throwIfAborted()
    return this.attach(id, attachmentId)
  }

  private attach(id: string, attachmentId: string): AsyncIterable<TerminalFrameShadow> {
    const terminal = this.terminal(id)
    this.attachCount.push({ id, attachmentId })
    this.controlOf.set(id, attachmentId)
    terminal.info = { ...terminal.info, controllerId: attachmentId }
    this.broadcast(id, { type: 'state', info: terminal.info })

    const queue: TerminalFrameShadow[] = [
      { type: 'snapshot', sequence: 0, screen: '', info: terminal.info },
    ]
    let done = false
    const waiters: (() => void)[] = []
    const wake = (): void => { for (const waiter of waiters.splice(0)) waiter() }
    const follower: FakeFollower = {
      push(frame) { if (done) return; queue.push(frame); wake() },
      end() { if (done) return; done = true; wake() },
    }
    terminal.followers.add(follower)
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
            terminal.followers.delete(follower)
            done = true
            wake()
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  private broadcast(id: string, frame: TerminalFrameShadow): void {
    for (const follower of this.terminal(id).followers) follower.push(frame)
  }

  /** Test helper: push raw output to every live follower (mirrors PTY echo). */
  emitOutput(id: string, data: string): void {
    this.broadcast(id, { type: 'output', sequence: 0, data })
  }

  /** Test helper: simulate the user's view attaching and taking input control. */
  userTakeover(id: string, attachment = 'user-att-1'): void {
    const terminal = this.terminal(id)
    this.controlOf.set(id, attachment)
    terminal.info = { ...terminal.info, controllerId: attachment }
    this.broadcast(id, { type: 'state', info: terminal.info })
  }

  /** Test helper: publish a state change (e.g. process exit) to every follower. */
  emitState(id: string, patch: Partial<WebTerminalInfoShadow>): void {
    const terminal = this.terminal(id)
    terminal.info = { ...terminal.info, ...patch }
    this.broadcast(id, { type: 'state', info: terminal.info })
  }

  async write(agent: { id: string }, id: string, attachmentId: string, data: string): Promise<void> {
    const current = this.controlOf.get(id)
    if (current !== attachmentId) {
      throw Object.assign(
        new Error(`Terminal ${id} is controlled by attachment ${String(current)}`),
        { code: 'terminal/control-unavailable' },
      )
    }
    this.writes.push({ id, attachmentId, data })
  }

  async close(agent: { id: string }, id: string): Promise<void> {
    this.closes.push(id)
    const terminal = this.terminals.get(id)
    this.terminals.delete(id)
    this.controlOf.delete(id)
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
