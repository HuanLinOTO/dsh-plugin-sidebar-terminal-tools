/**
 * ANSI/control-code cleaning for terminal transcripts.
 *
 * The follow stream delivers a serialized xterm screen (`snapshot`) and raw
 * PTY deltas (`output`), both full of escape sequences. The transcript keeps
 * plain text only: CSI/OSC/DCS and nF escapes are removed, single-character
 * control codes are removed, and newlines are preserved as the sole line
 * separator (a CRLF pair therefore becomes one `\n`).
 *
 * @module @huanlin/dsh-plugin-sidebar-terminal-tools/sanitize
 */

/** One alternation per escape family, then the C0-minus-newline sweep. */
const ESCAPE_OR_CONTROL = new RegExp(
  [
    '\\x1b\\[[0-9;?]*[ -/]*[@-~]', // CSI: colors, cursor moves, erase, private modes
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC (window title, hyperlinks) via BEL or ST
    '\\x1b[P^_][^\\x1b]*(?:\\x1b\\\\)?', // DCS / SOS / PM / APC bodies
    '\\x1b[ -/]*[0-~]', // everything else ESC-prefixed: ESC 7 / ESC 8 / ESC M / ESC ( B …
    '[\\x00-\\x09\\x0b-\\x1f\\x7f]', // every other C0 control except \n (0x0A), plus DEL
  ].join('|'),
  'g',
)

/**
 * Strip ANSI escape sequences and non-newline control codes from terminal text.
 * @param text - raw screen serialization or PTY output delta.
 * @returns plain text whose only control character is `\n`.
 */
export function sanitizeTerminalText(text: string): string {
  return text.replace(ESCAPE_OR_CONTROL, '')
}
