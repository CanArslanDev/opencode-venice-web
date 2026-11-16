import test from 'node:test'
import assert from 'node:assert/strict'
import { curlFetch, findCurl, headerLines, isCloudflareBlock, parseHead, tlsArgsFor, writeHeaderFile } from '../src/lib/curl.mjs'

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

test('writeHeaderFile writes a private file and removes it', async () => {
  const { statSync, readFileSync, existsSync } = await import('node:fs')
  const path = await import('node:path')
  const { file, remove } = writeHeaderFile({ Authorization: 'Bearer t' })
  assert.equal(readFileSync(file, 'utf8'), 'authorization: Bearer t\nExpect:\n')
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700)
  }
  remove()
  remove()
  assert.equal(existsSync(path.dirname(file)), false)
})

/**
 * End to end through the real curl binary against a local HTTPS server. This is
 * what caught the Linux failure: `-H @/dev/fd/3` works on macOS and makes curl
 * exit with code 26 on Linux. Skipped when curl or openssl is missing.
 */
test('curlFetch hands headers and body to curl and streams the answer back', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const https = await import('node:https')
  if (!findCurl()) return t.skip('curl is not installed')
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-web-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    )
  } catch {
    return t.skip('openssl cannot make a test certificate here')
  }

  const server = https.createServer(
    { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) },
    (req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })
        res.end(JSON.stringify({ method: req.method, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString() }))
      })
    },
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const before = new Set(readdirSync(tmpdir()))
  const previous = process.env.CURL_CA_BUNDLE
  process.env.CURL_CA_BUNDLE = path.join(dir, 'cert.pem')
  let response
  try {
    response = await curlFetch(`https://127.0.0.1:${server.address().port}/api`, {
      method: 'POST',
      headers: { 'user-agent': 'UA/1', authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{"hello":"world"}',
    })
  } catch (error) {
    if (/code (60|77|35)\b/.test(error.message)) return t.skip(`this curl does not trust a CA bundle from the environment: ${error.message}`)
    throw error
  } finally {
    if (previous === undefined) delete process.env.CURL_CA_BUNDLE
    else process.env.CURL_CA_BUNDLE = previous
  }

  assert.equal(response.status, 200)
  assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2'])
  const echo = await response.json()
  assert.equal(echo.method, 'POST')
  assert.equal(echo.headers.authorization, 'Bearer secret')
  assert.equal(echo.headers['user-agent'], 'UA/1')
  assert.equal(echo.headers.expect, undefined)
  assert.equal(echo.body, '{"hello":"world"}')
  // the user agent comes before the extra headers, where curl puts `-A`
  const names = echo.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase())
  assert.ok(names.indexOf('user-agent') < names.indexOf('authorization'))
  // the header file is gone once the request is over
  const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('venice-web-') && !name.startsWith('venice-web-test-') && !before.has(name))
  assert.deepEqual(leftovers, [])
})

test('tlsArgsFor asks an OpenSSL curl for TLS 1.3 only and leaves the others alone', () => {
  const ubuntu = 'curl 8.5.0 (aarch64-unknown-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0\nRelease-Date: 2023-12-06\n'
  const macos = 'curl 8.7.1 (x86_64-apple-darwin25.0) libcurl/8.7.1 (SecureTransport) LibreSSL/3.3.6 zlib/1.2.12\n'
  const gnutls = 'curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 GnuTLS/3.8.3 zlib/1.3\n'
  const optional = 'curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 GnuTLS/3.8.3 (OpenSSL/3.0.13) zlib/1.3\n'
  assert.deepEqual(tlsArgsFor(ubuntu, undefined), ['--tlsv1.3'])
  assert.deepEqual(tlsArgsFor(macos, undefined), [])
  assert.deepEqual(tlsArgsFor(gnutls, undefined), [])
  assert.deepEqual(tlsArgsFor(optional, undefined), [])
  // the environment wins, and an empty value turns the flags off
  assert.deepEqual(tlsArgsFor(ubuntu, ''), [])
  assert.deepEqual(tlsArgsFor(macos, '--tls-max 1.2'), ['--tls-max', '1.2'])
})
