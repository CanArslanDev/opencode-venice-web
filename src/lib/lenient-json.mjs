/**
 * A tolerant JSON reader for the model's tool envelopes.
 *
 * `JSON.parse` rejects the whole reply over one misplaced bracket, and then the
 * tool calls are lost. The model's slips are structural and repeat (measured on
 * real sessions, see docs/PROTOCOL.md §4.6):
 *
 *   - a call object that is never closed: `"timeout":120000}]}` instead of
 *     `"timeout":120000}}]}`, or `"},\n{"name":...` between two calls;
 *   - an `arguments` object closed one key too early, so `"newString"` lands
 *     next to `"name"` instead of inside `arguments`;
 *   - literal line breaks and unescaped quotes inside string values;
 *   - trailing or doubled commas, a missing bracket at the very end.
 *
 * The reader repairs these by structure only: it never looks at what the text
 * says, so it behaves the same for every language. Rules:
 *
 *   - an object that meets `]`, the end of input, or `{` where a key should be
 *     is closed implicitly (the bracket is left for the parent);
 *   - an array that meets `}` or the end of input is closed implicitly;
 *   - a `"key": value` pair met inside an array continues the object that was
 *     closed right before it;
 *   - a `"` inside a string only ends it when the next non-blank character can
 *     follow a JSON string (`, : } ]` or the end); otherwise it is text;
 *   - raw control characters inside strings are kept as text.
 *
 * Pure, no I/O.
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const VALUE_START = new Set(['"', '{', '[', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 't', 'f', 'n'])

class Reader {
  constructor(text, start) {
    this.text = text
    this.pos = start
  }

  peek() {
    return this.text[this.pos]
  }

  skipBlank() {
    while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos])) this.pos++
  }

  /** Next non-blank character at or after `from`, without moving. */
  nextSolid(from) {
    let index = from
    while (index < this.text.length && WHITESPACE.has(this.text[index])) index++
    return { char: this.text[index], index }
  }

  value() {
    this.skipBlank()
    const char = this.peek()
    if (char === '{') return this.object({})
    if (char === '[') return this.array()
    if (char === '"') return this.string()
    if (char === '-' || (char >= '0' && char <= '9')) return this.number()
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length
        return value
      }
    }
    throw new SyntaxError(`unexpected ${char === undefined ? 'end of input' : JSON.stringify(char)} at ${this.pos}`)
  }

  number() {
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos))
    if (!match) throw new SyntaxError(`bad number at ${this.pos}`)
    this.pos += match[0].length
    return Number(match[0])
  }

  /** Does a JSON value start at `index`? (`then` is not `true`, `nothing` is not `null`.) */
  startsValue(index) {
    const char = this.text[index]
    if (!VALUE_START.has(char)) return false
    if (char !== 't' && char !== 'f' && char !== 'n') return true
    return /^(?:true|false|null)(?![\p{L}\p{N}_])/u.test(this.text.slice(index, index + 6))
  }

  /** Can a JSON string end here, judging by what follows the quote? */
  closesString(quoteIndex) {
    const { char, index } = this.nextSolid(quoteIndex + 1)
    if (char === undefined || char === '}' || char === ']' || char === ':') return true
    if (char !== ',') return false
    // `", ` closes only when a JSON value or key follows the comma(s)
    let after = this.nextSolid(index + 1)
    while (after.char === ',') after = this.nextSolid(after.index + 1)
    return after.char === undefined || after.char === '}' || after.char === ']' || this.startsValue(after.index)
  }

  string() {
    this.pos++ // opening quote
    let out = ''
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]
      if (char === '\\') {
        const next = this.text[this.pos + 1]
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (next in simple) {
          out += simple[next]
          this.pos += 2
          continue
        }
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.pos + 2, this.pos + 6))) {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16))
          this.pos += 6
          continue
        }
        // an invalid escape is kept as written
        out += char
        this.pos++
        continue
      }
      if (char === '"') {
        if (this.closesString(this.pos)) {
          this.pos++
          return out
        }
        out += char
        this.pos++
        continue
      }
      out += char
      this.pos++
    }
    return out // unterminated: the end of input closes it
  }

  /** Reads object members into `target` (which may be an object reopened by `array()`). */
  object(target) {
    if (this.peek() === '{') this.pos++
    for (;;) {
      this.skipBlank()
      const char = this.peek()
      if (char === undefined) return target
      if (char === '}') {
        this.pos++
        return target
      }
      if (char === ']') return target // the parent array closes; this object ends with it
      if (char === ',') {
        this.pos++
        continue
      }
      if (char === '{' && Object.keys(target).length > 0) return target // a sibling starts: we were never closed
      if (char !== '"') throw new SyntaxError(`expected a key at ${this.pos}`)
      const key = this.string()
      this.skipBlank()
      if (this.peek() !== ':') throw new SyntaxError(`expected ':' after key at ${this.pos}`)
      this.pos++
      target[key] = this.value()
    }
  }

  array() {
    this.pos++ // [
    const out = []
    for (;;) {
      this.skipBlank()
      const char = this.peek()
      if (char === undefined) return out
      if (char === ']') {
        this.pos++
        return out
      }
      if (char === '}') return out // the parent object closes; this array ends with it
      if (char === ',') {
        this.pos++
        continue
      }
      const last = out[out.length - 1]
      if (char === '"' && last && typeof last === 'object' && !Array.isArray(last)) {
        // `{...}, "key": value` inside an array: the object was closed too early
        const mark = this.pos
        this.string()
        const isKey = this.nextSolid(this.pos).char === ':'
        this.pos = mark
        if (isKey) {
          this.object(last)
          continue
        }
      }
      out.push(this.value())
    }
  }
}

/**
 * Reads one JSON value starting at `start` (which must be `{` or `[`).
 *
 * @returns {{ value: unknown, end: number }} `end` is the index just past what was consumed
 * @throws {SyntaxError} when the text is not JSON-shaped at all
 */
export function readLenient(text, start = 0) {
  const reader = new Reader(text, start)
  const value = reader.value()
  return { value, end: reader.pos }
}

/** Parses `text` as one lenient JSON value, or returns `undefined`. */
export function parseLenient(text) {
  const trimmed = (text ?? '').trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return readLenient(trimmed, 0).value
  } catch {
    return undefined
  }
}
