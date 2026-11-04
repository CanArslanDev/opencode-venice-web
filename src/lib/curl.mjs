/**
 * curl transport for the inference backend.
 *
 * Cloudflare in front of `outerface.venice.ai` blocks Node's own HTTP client on
 * the inference route ("Attention Required!", HTTP 403 text/html) no matter which
 * headers, cookies or TLS options are set, while the same request from the
 * system `curl` goes through. Measured on 2026-11-04:
 *
 *   Node fetch / node:https (any cipher, sigalg or TLS version)   403 html
 *   curl --http2                                                   403 html
 *   curl --http1.1 + `accept: text/event-stream`                   403 html
 *   curl --http1.1, default accept                                 200 SSE
 *
 * So requests to the API host go through one short-lived `curl` process each:
 * HTTP/1.1, no redirects, headers handed over on fd 3 (never on the command line,
 * where `ps` would show the bearer token), the body on stdin, and the response
 * streamed back from stdout. No browser, no npm dependency, a few MB per request.
 */
import { spawn, execFileSync } from 'node:child_process'

let curlPath

/** The curl binary (VENICE_WEB_CURL overrides), or null when none is installed. */
export function findCurl() {
  if (curlPath !== undefined) return curlPath
  const candidates = [process.env.VENICE_WEB_CURL, 'curl'].filter(Boolean)
  curlPath = null
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      curlPath = candidate
      break
    } catch {
      /* try the next one */
    }
  }
  return curlPath
}

/** A Cloudflare block or challenge page instead of an API answer. */
export function isCloudflareBlock(status, headers) {
  if (status !== 403) return false
  return headers.get('cf-mitigated') === 'challenge' || !!headers.get('content-type')?.includes('text/html')
}

/** Header lines for `curl -H @file`. `Headers` rejects CR/LF, the replace is a second guard. */
export function headerLines(headers) {
  const lines = []
  for (const [key, value] of new Headers(headers)) {
    // the user agent goes through `-A` so curl keeps it in its usual place
    if (key === 'user-agent') continue
    lines.push(`${key}: ${String(value).replace(/[\r\n]+/g, ' ')}`)
  }
  // curl would otherwise send `Expect: 100-continue` for larger bodies
  lines.push('Expect:')
  return `${lines.join('\n')}\n`
}

/**
 * Parses the head that `curl -D -` writes before the body. Returns null until
 * the blank line arrives. Interim `1xx` heads are skipped.
 */
export function parseHead(buffer) {
  let rest = buffer
  for (;;) {
    const end = rest.indexOf('\r\n\r\n')
    if (end < 0) return null
    const lines = rest.subarray(0, end).toString('latin1').split('\r\n')
    rest = rest.subarray(end + 4)
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0])?.[1])
    if (!status) throw new Error(`curl: unexpected response head: ${lines[0]}`)
    if (status >= 100 && status < 200) continue
    const headers = new Headers()
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }
    return { status, headers, rest }
  }
}

/** `fetch()` lookalike backed by curl; resolves to a Response with a streaming body. */
export function curlFetch(url, { method = 'GET', headers, body, signal } = {}) {
  const bin = findCurl()
  if (!bin) return Promise.reject(new Error('curl is not installed (needed for the Venice inference route)'))
  if (!url.startsWith('https://')) return Promise.reject(new Error('curl transport only speaks https'))

  // Header order is part of what Cloudflare looks at: a user agent passed as a
  // plain `-H` line lands after `Accept` and gets the request blocked, so it goes
  // through `-A`, where curl puts it in its usual place.
  const userAgent = new Headers(headers).get('user-agent')
  const args = ['-sS', '--http1.1', '--no-buffer', '--proto', '=https', '-D', '-', '-X', method, '-H', '@/dev/fd/3']
  if (userAgent) args.push('-A', userAgent)
  if (body != null) args.push('--data-binary', '@-')
  args.push(url)

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    let head = Buffer.alloc(0)
    let controller = null
    let settled = false
    let done = false
    const push = (data) => {
      if (done || !controller) return
      try {
        controller.enqueue(new Uint8Array(data))
      } catch {
        done = true
      }
    }
    let stderr = ''

    const fail = (error) => {
      if (!settled) {
        settled = true
        reject(error)
      } else if (!done) {
        done = true
        try {
          controller?.error(error)
        } catch {
          /* already closed */
        }
      }
    }
    const onAbort = () => {
      child.kill()
      fail(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdio[3].end(headerLines(headers))
    child.stdin.on('error', () => {})
    child.stdio[3].on('error', () => {})
    if (body != null) child.stdin.end(typeof body === 'string' ? body : Buffer.from(body))
    else child.stdin.end()

    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', fail)

    child.stdout.on('data', (data) => {
      if (settled) return push(data)
      head = Buffer.concat([head, data])
      let parsed
      try {
        parsed = parseHead(head)
      } catch (error) {
        child.kill()
        return fail(error)
      }
      if (!parsed) return
      settled = true
      const nullBody = [101, 204, 205, 304].includes(parsed.status)
      const readable = new ReadableStream({
        start(c) {
          controller = c
          if (parsed.rest.length) c.enqueue(new Uint8Array(parsed.rest))
        },
        cancel() {
          done = true
          child.kill()
        },
      })
      resolve(new Response(nullBody ? null : readable, { status: parsed.status, headers: parsed.headers }))
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0 || code === null) {
        if (!settled) return fail(new Error('curl: no response'))
        if (done) return
        done = true
        try {
          controller?.close()
        } catch {
          /* already closed or errored */
        }
      } else fail(new Error(`curl exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}
