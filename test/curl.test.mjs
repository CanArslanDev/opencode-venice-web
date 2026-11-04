import test from 'node:test'
import assert from 'node:assert/strict'
import { headerLines, isCloudflareBlock, parseHead } from '../src/lib/curl.mjs'

test('headerLines leaves the user agent to -A and disables Expect', () => {
  const lines = headerLines({ 'User-Agent': 'UA', Authorization: 'Bearer t', 'content-type': 'application/json' })
  assert.equal(lines, 'authorization: Bearer t\ncontent-type: application/json\nExpect:\n')
})

test('headerLines refuses a value with a line break', () => {
  // Headers already rejects CR/LF, so no value can smuggle in an extra header line
  assert.throws(() => headerLines({ 'x-test': 'a\r\nx-evil: 1' }), TypeError)
})

test('parseHead waits for the blank line', () => {
  assert.equal(parseHead(Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n')), null)
})

test('parseHead returns status, headers and the start of the body', () => {
  const head = parseHead(
    Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\nevent: x\n'),
  )
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'text/event-stream')
  assert.deepEqual(head.headers.getSetCookie(), ['a=1', 'b=2'])
  assert.equal(head.rest.toString(), 'event: x\n')
})

test('parseHead skips an interim 100 Continue head', () => {
  const head = parseHead(Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 400 Bad Request\r\nx: y\r\n\r\n{}'))
  assert.equal(head.status, 400)
  assert.equal(head.rest.toString(), '{}')
})

test('parseHead rejects something that is not HTTP', () => {
  assert.throws(() => parseHead(Buffer.from('garbage\r\n\r\n')), /unexpected response head/)
})

test('isCloudflareBlock spots the html block page and the challenge header only on 403', () => {
  assert.equal(isCloudflareBlock(403, new Headers({ 'content-type': 'text/html; charset=UTF-8' })), true)
  assert.equal(isCloudflareBlock(403, new Headers({ 'cf-mitigated': 'challenge' })), true)
  assert.equal(isCloudflareBlock(403, new Headers({ 'content-type': 'application/json' })), false)
  assert.equal(isCloudflareBlock(200, new Headers({ 'content-type': 'text/html' })), false)
})
