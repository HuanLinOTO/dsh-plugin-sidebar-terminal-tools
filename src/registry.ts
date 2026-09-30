/**
 * Owner-scoped registry of the terminals this plugin created, plus the
 * bounded transcript each terminal keeps. Only `(ownerId, terminalId)` pairs
 * present here are reachable through the tools — a user's manual terminal is
 * never registered and therefore never touched.
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/registry
 */
import type { TerminalOwnerLike, WebTerminalInfoShadow } from './shadow.js'
import type { TerminalReadResult } from './wait-for.js'

/** Plugin-wide terminal identity prefix (the client half matches the same prefix). */
export const TERMINAL_ID_PREFIX = 'stb-'

/** Terminal identity rule of the controller, mirrored (`/^[\w-]{1,128}$/`). */
const CONTROLLER_ID_RE = /^[\w-]{1,128}$/

let attachmentCounter = 0

/**
 * Mint one attachment identity for a follow subscription. Re-following with a
 * fresh identity is what reclaims exclusive input control.
 */
export function mintAttachmentId(): string {
  attachmentCounter += 1
  return `stb-att-${attachmentCounter}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Mint the model-facing terminal id for registry sequence `seq`
 * (`stb-<seq>-<rand>`): controller-legal, monotonic in `seq`, unique per call.
 */
export function mintTerminalId(seq: number): string {
  const id = `${TERMINAL_ID_PREFIX}${seq}-${Math.random().toString(36).slice(2, 10)}`
  if (!CONTROLLER_ID_RE.test(id) || !/^stb-[\w-]{1,120}$/.test(id)) {
    throw new Error(`sidebar-terminal-tools: minted an invalid terminal id ${id}`)
  }
  return id
}

/** Byte length in UTF-8 without allocating when the text is plain ASCII. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Keep the trailing `maxBytes` of `text`, dropping a damaged leading surrogate. */
function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= maxBytes) return text
  return bytes.subarray(bytes.byteLength - maxBytes).toString('utf8').replace(/^\uFFFD/, '')
}

/** Bounds of one terminal transcript. */
export interface TranscriptLimits {
  readonly maxLines: number
  readonly maxBytes: number
}

/**
 * A line/byte-bounded plain-text transcript fed by the follow consumer.
 * `read` pages with newest-relative offsets (the contract `scanPage` in
 * wait-for.ts expects); an unterminated pending tail counts as the newest
 * line so live prompts stay matchable.
 */
export class TranscriptBuffer {
  private lines: string[] = []
  private pending = ''
  private bytes = 0
  private truncated = false

  constructor(private readonly limits: TranscriptLimits) {}

  /** Total effective lines, pending tail included. */
  get totalLines(): number {
    return this.lines.length + (this.pending.length > 0 ? 1 : 0)
  }

  /** Whether any content was ever dropped or shortened by the bounds. */
  get wasTruncated(): boolean {
    return this.truncated
  }

  /** Append an output delta; complete lines commit, the tail stays pending. */
  append(text: string): void {
    this.pending += text
    const parts = this.pending.split('\n')
    this.pending = parts.pop() ?? ''
    for (const line of parts) this.commitLine(line)
    this.boundPending()
  }

  /** Replace the whole transcript with a serialized screen (re-attach snapshot). */
  replace(text: string): void {
    this.lines = []
    this.pending = ''
    this.bytes = 0
    const parts = text.split('\n')
    this.pending = parts.pop() ?? ''
    for (const line of parts) this.commitLine(line)
    this.boundPending()
  }

  /** Newest-relative paged read over the effective (complete + pending) lines. */
  read(request: { offset?: number; count?: number } = {}): TerminalReadResult {
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const count = Math.max(1, Math.floor(request.count ?? 500))
    const total = this.totalLines
    if (offset >= total) {
      return { text: '', totalLines: total, lineBegin: offset, lineEnd: offset, truncated: this.truncated }
    }
    const end = total - offset
    const start = Math.max(0, end - count)
    const effective = this.pending.length > 0 ? [...this.lines, this.pending] : this.lines
    const text = effective.slice(start, end).join('\n')
    const returned = text.length === 0 ? 0 : text.split('\n').length
    return { text, totalLines: total, lineBegin: offset, lineEnd: offset + returned, truncated: this.truncated }
  }

  private commitLine(line: string): void {
    this.lines.push(line)
    this.bytes += byteLength(line) + 1
    this.trim()
  }

  /** Keep the newest bytes of a runaway pending tail (no-newline firehoses). */
  private boundPending(): void {
    if (byteLength(this.pending) <= this.limits.maxBytes) return
    this.pending = tailBytes(this.pending, this.limits.maxBytes)
    this.truncated = true
  }

  private trim(): void {
    while (this.lines.length > this.limits.maxLines) this.dropOldest()
    while (this.bytes > this.limits.maxBytes) {
      if (this.lines.length <= 1) {
        const only = this.lines[0] ?? ''
        const kept = tailBytes(only, this.limits.maxBytes)
        this.bytes = byteLength(kept)
        this.lines = kept.length > 0 ? [kept] : []
        this.truncated = true
        return
      }
      this.dropOldest()
    }
  }

  private dropOldest(): void {
    const oldest = this.lines.shift()
    if (oldest === undefined) return
    this.bytes -= byteLength(oldest) + 1
    if (this.bytes < 0) this.bytes = 0
    this.truncated = true
  }
}

/** Everything the registry tracks for one model-created terminal. */
export interface ManagedTerminal {
  /** Latest metadata, updated by every snapshot/state frame. */
  info: WebTerminalInfoShadow
  /** The attachment identity our current follow consumer uses. */
  attachmentId: string
  /** Sanitized, bounded transcript; the wait_for matching space. */
  readonly transcript: TranscriptBuffer
  /** Aborts the follow consumer (close, regain, plugin dispose); replaced on re-follow. */
  follow: AbortController
  /** True while a takeover notice for the current episode was already sent. */
  takeoverNotified: boolean
}

/** The registry's per-owner slice. */
interface OwnerRecord {
  readonly agent: TerminalOwnerLike & { inject(message: unknown): void }
  readonly terminals: Map<string, ManagedTerminal>
}

/**
 * Terminals this plugin created, keyed by owner session id, with a process-wide
 * monotonic id sequence. Nothing here ever lists a user's manual terminal.
 */
export class EndpointRegistry {
  private readonly owners = new Map<string, OwnerRecord>()
  private sequence = 0

  /** Advance and read the terminal id sequence (monotonic, never reissued). */
  nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  /** The largest issued sequence (diagnostics). */
  get issuedSequences(): number {
    return this.sequence
  }

  /** Look up one managed terminal for an owner. */
  get(ownerId: string, terminalId: string): ManagedTerminal | undefined {
    return this.owners.get(ownerId)?.terminals.get(terminalId)
  }

  /** All managed terminals of one owner, in creation order. */
  list(ownerId: string): readonly ManagedTerminal[] {
    const owner = this.owners.get(ownerId)
    return owner === undefined ? [] : [...owner.terminals.values()]
  }

  /** Register a freshly created terminal (idempotent per owner+id). */
  register(
    agent: TerminalOwnerLike & { inject(message: unknown): void },
    terminalId: string,
    info: WebTerminalInfoShadow,
    limits: TranscriptLimits,
  ): ManagedTerminal {
    let owner = this.owners.get(agent.id)
    if (owner === undefined) {
      owner = { agent, terminals: new Map() }
      this.owners.set(agent.id, owner)
    }
    const existing = owner.terminals.get(terminalId)
    if (existing !== undefined) return existing
    const managed: ManagedTerminal = {
      info,
      attachmentId: '',
      transcript: new TranscriptBuffer(limits),
      follow: new AbortController(),
      takeoverNotified: false,
    }
    owner.terminals.set(terminalId, managed)
    return managed
  }

  /** Drop one terminal record (returns the removed record, if present). */
  remove(ownerId: string, terminalId: string): ManagedTerminal | undefined {
    const owner = this.owners.get(ownerId)
    const removed = owner?.terminals.get(terminalId)
    owner?.terminals.delete(terminalId)
    if (owner !== undefined && owner.terminals.size === 0) this.owners.delete(ownerId)
    return removed
  }

  /** Abort every follow consumer and clear all records (plugin dispose). */
  dispose(): void {
    for (const owner of this.owners.values()) {
      for (const managed of owner.terminals.values()) managed.follow.abort()
    }
    this.owners.clear()
  }
}
