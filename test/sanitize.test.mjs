/**
 * Tests for NUL byte handling. See src/lib/sanitize.mjs for why this exists:
 * a NUL byte in the outgoing payload makes Venice answer
 * "String must not contain null bytes", which kills a whole session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { countNulls, deepStripNulls, repairJsonControlChars, stripNulls } from '../src/lib/sanitize.mjs'

const NUL = '\u0000'

test('stripNulls replaces NUL with a space', () => {
  assert.equal(stripNulls(`a${NUL}b${NUL}${NUL}c`), 'a b  c')
  assert.equal(stripNulls('plain'), 'plain')
})

test('countNulls counts without touching the string', () => {
  assert.equal(countNulls(`x${NUL}y${NUL}`), 2)
  assert.equal(countNulls('none'), 0)
  assert.equal(countNulls(undefined), 0)
})

test('deepStripNulls walks nested objects and arrays in place', () => {
  const payload = {
    modelId: 'm',
    systemPrompt: { instructions: `sys${NUL}prompt` },
    messages: [
      { role: 'user', content: [{ type: 'output_text', text: `hello${NUL}${NUL}` }] },
      { role: 'assistant', tool_calls: [{ function: { arguments: `{"p":"a${NUL}b"}` } }] },
    ],
    count: 3,
    flag: true,
    empty: null,
  }
  const replaced = deepStripNulls(payload)
  assert.equal(replaced, 4)
  assert.equal(payload.systemPrompt.instructions, 'sys prompt')
  assert.equal(payload.messages[0].content[0].text, 'hello  ')
  assert.equal(payload.messages[1].tool_calls[0].function.arguments, '{"p":"a b"}')
  assert.equal(payload.count, 3)
})

test('deepStripNulls tolerates cycles and leaves clean payloads alone', () => {
  const payload = { a: 'clean' }
  payload.self = payload
  assert.equal(deepStripNulls(payload), 0)
})

test('repairJsonControlChars escapes raw control bytes inside strings', () => {
  const raw = '{"content":"ham\u0000bayt","tab":"a\tb"}'
  const repaired = repairJsonControlChars(raw)
  assert.equal(repaired, '{"content":"ham\\u0000bayt","tab":"a\\u0009b"}')
  const parsed = JSON.parse(repaired)
  assert.equal(parsed.content, 'ham\u0000bayt')
  assert.equal(parsed.tab, 'a\tb')
})

test('repairJsonControlChars keeps structure and escapes intact', () => {
  const raw = '{\n  "a": "line\\nkept",\n  "b": 2\n}\n'
  const repaired = repairJsonControlChars(raw)
  assert.equal(repaired, raw)
  assert.equal(JSON.parse(repaired).a, 'line\nkept')
})

test('repairJsonControlChars handles a raw newline inside a string', () => {
  const raw = '{"a":"first\nsecond"}'
  const repaired = repairJsonControlChars(raw)
  assert.equal(repaired, '{"a":"first\\u000asecond"}')
  assert.equal(JSON.parse(repaired).a, 'first\nsecond')
})

test('a request body with a raw NUL byte survives the whole pipeline', () => {
  const raw = '{"messages":[{"role":"user","content":"ELF\u0000\u0000section"}]}'
  const body = JSON.parse(repairJsonControlChars(raw))
  assert.equal(countNulls(body.messages[0].content), 2)
  assert.equal(deepStripNulls(body), 2)
  assert.equal(body.messages[0].content, 'ELF  section')
})
