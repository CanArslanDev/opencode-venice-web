/**
 * NUL byte handling.
 *
 * Some Venice endpoints reject a request whose JSON contains a null byte:
 *
 *   "String must not contain null bytes"   (HTTP 400)
 *
 * NUL bytes reach a session quite easily: `grep -a`, `cat` or `tail` over a
 * binary file puts them into a tool result, and from there into the stored
 * conversation. Once stored, every later request of that session carries them.
 *
 * The web inference endpoint is only strict about one place - `systemPrompt`
 * instructions - but that is enough: a leak there breaks the whole session. Two
 * layers of defence live here:
 *
 *  - `repairJsonControlChars()` runs before `JSON.parse`, because JSON forbids
 *    raw control characters inside strings and a hand-written client may send
 *    a literal 0x00 byte (the reference implementation fails with
 *    "Bad control character in string literal").
 *  - `deepStripNulls()` walks the translated payload and replaces NUL bytes in
 *    every string, so nothing NUL-shaped leaves the proxy.
 *
 * Replacing with a space (rather than deleting) keeps binary dumps readable.
 */

const NULL = '\u0000'

/** Replaces NUL bytes in one string. */
export function stripNulls(text) {
  return typeof text === 'string' && text.includes(NULL) ? text.split(NULL).join(' ') : text
}

/** Counts NUL bytes in one string. */
export function countNulls(text) {
  if (typeof text !== 'string') return 0
  let count = 0
  let index = text.indexOf(NULL)
  while (index >= 0) {
    count++
    index = text.indexOf(NULL, index + 1)
  }
  return count
}

/**
 * Replaces NUL bytes in every string inside a JSON-ish structure, in place.
 * A top-level string cannot be modified in place, so the caller handles that.
 * @returns {number} how many bytes were replaced
 */
export function deepStripNulls(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return 0
  if (seen.has(value)) return 0
  seen.add(value)

  let replaced = 0
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (typeof item === 'string') {
      const hits = countNulls(item)
      if (hits) {
        value[key] = item.split(NULL).join(' ')
        replaced += hits
      }
    } else {
      replaced += deepStripNulls(item, seen)
    }
  }
  return replaced
}

/**
 * Escapes raw control characters that sit inside JSON strings, leaving the
 * structure (and the whitespace between tokens) untouched, so `JSON.parse`
 * accepts what a lenient client sent.
 */
export function repairJsonControlChars(raw) {
  let out = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      } else if (char.charCodeAt(0) < 0x20) {
        out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        continue
      }
    } else if (char === '"') {
      inString = true
    }
    out += char
  }
  return out
}
