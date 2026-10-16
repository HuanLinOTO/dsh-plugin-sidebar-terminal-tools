/**
 * sanitizeTerminalText unit tests: ANSI stripping (CSI/OSC/other escapes,
 * single-character control codes) with newline preservation.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText } from '../src/sanitize.js'

describe('sanitizeTerminalText', () => {
  it('keeps plain text and newlines intact', () => {
    expect(sanitizeTerminalText('$ echo hi\nhi\n')).toBe('$ echo hi\nhi\n')
  })

  it('strips SGR color and bold sequences', () => {
    expect(sanitizeTerminalText('\x1b[32mOK\x1b[0m\n\x1b[1;31mFAIL\x1b[m')).toBe('OK\nFAIL')
  })

  it('strips CSI cursor-movement and erase sequences with parameters', () => {
    expect(sanitizeTerminalText('a\x1b[2Kb\nc\x1b[10Gd\x1b[?25le')).toBe('ab\ncde')
  })

  it('strips OSC sequences terminated by BEL and by ST', () => {
    expect(sanitizeTerminalText('\x1b]0;title\x07after\n')).toBe('after\n')
    expect(sanitizeTerminalText('\x1b]2;title\x1b\\x')).toBe('x')
  })

  it('strips other two-character escape sequences', () => {
    expect(sanitizeTerminalText('a\x1b(Bb')).toBe('ab')
    expect(sanitizeTerminalText('a\x1b7b\x1b8')).toBe('ab')
  })

  it('strips single-character control codes except newline', () => {
    expect(sanitizeTerminalText('a\rb\nc\x00d\x07e\tx\x7fy')).toBe('ab\ncdexy')
  })

  it('leaves the newline of a CRLF pair as the line break', () => {
    expect(sanitizeTerminalText('one\r\ntwo\r\n')).toBe('one\ntwo\n')
  })

  it('handles empty input', () => {
    expect(sanitizeTerminalText('')).toBe('')
  })
})
