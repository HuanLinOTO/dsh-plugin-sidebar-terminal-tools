/**
 * One duplex terminal attachment's plugin-side channel: the numbered input
 * queue handed to `terminal/attach` as the synthesized invocation's uplink,
 * plus the per-sequence acknowledgement waiters the frame loop settles.
 *
 * Commands are numbered consecutively from one within each attachment (an
 * upstream contract — a gap fails the stream), and every `write` resolves
 * only when the host acknowledges its sequence, so `sidebar_terminal_send`
 * keeps the rc.2 meaning of "delivered" over the duplex protocol.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/attachment
 */
import type { TerminalInputShadow } from './shadow.js'

/** Build the RemoteError-shaped failure of a refused input command. */
function controlUnavailable(reason: 'read-only' | 'not-running'): Error {
  return Object.assign(
    new Error(`Terminal input is unavailable (${reason})`),
    { code: 'terminal/control-unavailable', details: { reason } },
  )
}

/**
 * The uplink half of one attachment: pushes `TerminalInput` commands and
 * settles when the host's `ack` frame for that sequence arrives.
 */
export class AttachmentChannel {
  /** Aborts the attachment (re-attach, close, plugin dispose). */
  readonly abort = new AbortController()
  private sequence = 0
  private queued: TerminalInputShadow[] = []
  private wakeInput: (() => void) | undefined
  private inputEnded = false
  private ended = false
  private endedError: Error | undefined
  private readonly ackWaiters = new Map<number, { resolve(): void; reject(error: Error): void }>()

  /**
   * The uplink iterable the synthesized invocation hands to the host. One
   * consumer (the attachment's input pump); ends on dispose or stream end.
   */
  readonly input: AsyncIterable<TerminalInputShadow> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<TerminalInputShadow>> => {
        while (this.queued.length === 0 && !this.inputEnded) {
          if (this.abort.signal.aborted) return { done: true, value: undefined }
          await new Promise<void>(resolve => { this.wakeInput = resolve })
        }
        const value = this.queued.shift()
        if (value === undefined) return { done: true, value: undefined }
        return { done: false, value }
      },
      return: async (): Promise<IteratorResult<TerminalInputShadow>> => {
        this.inputEnded = true
        this.wakeInput?.()
        return { done: true, value: undefined }
      },
    }),
  }

  /**
   * Queue one write command and settle when the host acknowledges it.
   * @param data - raw input text to deliver.
   * @returns after the host accepted the command; rejects with a
   * `terminal/control-unavailable`-shaped error on refusal, or with the
   * stream-end error when the attachment died before acknowledging.
   */
  writeText(data: string): Promise<void> {
    if (this.ended) {
      // A dead attachment mirrors the rc.2 write on an inactive follower:
      // recoverable by taking a fresh attachment.
      return Promise.reject(this.endedError ?? controlUnavailable('read-only'))
    }
    const sequence = this.sequence + 1
    this.sequence = sequence
    const settled = new Promise<void>((resolve, reject) => { this.ackWaiters.set(sequence, { resolve, reject }) })
    this.push({ type: 'write', sequence, data })
    return settled
  }

  /**
   * Settle the waiter of one acknowledgement frame (the frame loop calls
   * this for every `ack` the attachment stream yields).
   * @param frame - the acknowledgement frame.
   */
  settleAck(frame: { readonly type: 'ack'; readonly sequence: number; readonly refusal?: 'read-only' | 'not-running' }): void {
    const waiter = this.ackWaiters.get(frame.sequence)
    if (waiter === undefined) return
    this.ackWaiters.delete(frame.sequence)
    if (frame.refusal === undefined) waiter.resolve()
    else waiter.reject(controlUnavailable(frame.refusal))
  }

  /**
   * Mark the attachment dead: the input iterable ends and later writes fail
   * with the passed error (stream failures propagate as infrastructure
   * errors; disposals use the recoverable control-unavailable shape).
   * @param error - failure later writes and pending waiters receive.
   */
  end(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.endedError = error
    this.inputEnded = true
    this.wakeInput?.()
    for (const waiter of this.ackWaiters.values()) waiter.reject(error)
    this.ackWaiters.clear()
  }

  /** Abort the attachment and fail every pending write recoverably. */
  dispose(): void {
    this.end(controlUnavailable('read-only'))
    this.abort.abort()
  }

  private push(command: TerminalInputShadow): void {
    this.queued.push(command)
    this.wakeInput?.()
  }
}
