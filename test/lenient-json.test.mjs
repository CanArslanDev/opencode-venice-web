/** Unit tests for the tolerant JSON reader (src/lib/lenient-json.mjs). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLenient, readLenient } from '../src/lib/lenient-json.mjs'

test('valid JSON reads exactly like JSON.parse', () => {
  for (const text of ['{"a":1,"b":[true,false,null],"c":"x\\ny\\u00e7"}', '[1,-2.5e3,{"k":"v"}]', '{}', '[]']) {
    assert.deepEqual(parseLenient(text), JSON.parse(text))
  }
})

test('the end of input closes every open value', () => {
  assert.deepEqual(parseLenient('{"a":[1,2,{"b":"c'), { a: [1, 2, { b: 'c' }] })
})

test('an object meeting "]" is closed implicitly', () => {
  assert.deepEqual(parseLenient('{"list":[{"x":{"y":1}]}'), { list: [{ x: { y: 1 } }] })
})

test('an array meeting "}" is closed implicitly', () => {
  assert.deepEqual(parseLenient('{"list":[1,2}'), { list: [1, 2] })
})

test('"{" where a key should be closes the object (a sibling starts)', () => {
  assert.deepEqual(parseLenient('[{"a":1},{"b":{"c":2},{"d":3}]'), [{ a: 1 }, { b: { c: 2 } }, { d: 3 }])
})

test('a key/value pair inside an array continues the object before it', () => {
  assert.deepEqual(parseLenient('[{"a":1},"b":2}]'), [{ a: 1, b: 2 }])
})

test('a quote only ends a string when JSON can follow it', () => {
  assert.deepEqual(parseLenient('{"t":"say "hi" now","u":1}'), { t: 'say "hi" now', u: 1 })
  assert.deepEqual(parseLenient('{"t":"He said "hi", then left","u":1}'), { t: 'He said "hi", then left', u: 1 })
})

test('raw control characters, trailing and doubled commas are tolerated', () => {
  assert.deepEqual(parseLenient('{"t":"line1\nline2\ttab",,"u":[1,,2,],}'), { t: 'line1\nline2\ttab', u: [1, 2] })
})

test('readLenient reports where the value ended', () => {
  const text = 'prose {"a":1} more'
  assert.deepEqual(readLenient(text, 6), { value: { a: 1 }, end: 13 })
})

test('text that is not JSON-shaped is rejected', () => {
  assert.equal(parseLenient('hello'), undefined)
  assert.equal(parseLenient('{"a": @}'), undefined)
  assert.equal(parseLenient('{a:1}'), undefined)
})
