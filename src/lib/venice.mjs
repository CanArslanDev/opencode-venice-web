/**
 * Venice web client: session file handling, Clerk JWT minting, Cloudflare-safe
 * request headers, client attestation and the upstream inference call.
 *
 * The web app authenticates with a long lived Clerk `__client` cookie, which is
 * exchanged for a ~60 second session JWT. This module owns that exchange and
 * keeps the cookie rotation that Clerk performs while it happens.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  apiBase,
  attestationTtlMs,
  clerkBase,
  clerkVersion,
  middlefaceVersion,
  requestTimeoutMs,
  sessionFile,
  tokenRefreshSkewMs,
} from './config.mjs'

const INFERENCE_PATH = '/api/inference/chat/agents/ad-hoc'

let state = null
let tokenFlight = null
let attestation = null

/** An upstream error that means "the user must sign in again". */
export class SignInError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SignInError'
    this.signIn = 'expired'
  }
}

export async function readSession() {
  const raw = await readFile(sessionFile, 'utf8')
  const data = JSON.parse(raw)
  if (!data.client || !data.userAgent) {
    throw new SignInError(`session file is incomplete (${sessionFile}); run the login command again`)
  }
  return data
}

export async function loadSession({ force = false } = {}) {
  if (state && !force) return state
  state = await readSession()
  return state
}

export async function saveSession() {
  const tmp = `${sessionFile}.${randomUUID()}.tmp`
  await mkdir(path.dirname(sessionFile), { recursive: true })
  await writeFile(tmp, JSON.stringify(state, null, 1), { mode: 0o600 })
  await rename(tmp, sessionFile)
}

export function resetSessionCache() {
  state = null
  tokenFlight = null
  attestation = null
}

/** Only venice.ai and its Clerk backend are ever contacted. */
function assertDestination(url) {
  const origin = new URL(url).origin
  if (origin !== clerkBase && origin !== apiBase) throw new Error(`unexpected upstream: ${origin}`)
}

/**
 * Fetch with the headers the Venice web app sends. Only the `__client` cookie is
 * sent, so Cloudflare's `cf_clearance` (which is bound to the browser) cannot
 * invalidate the session.
 */
export async function veneziaFetch(url, init = {}) {
  assertDestination(url)
  const session = await loadSession()
  const headers = new Headers(init.headers)
  headers.set('user-agent', session.userAgent)
  headers.set('origin', 'https://venice.ai')
  headers.set('referer', 'https://venice.ai/')
  headers.set('cookie', `__client=${session.client}`)

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
  })

  // Clerk rotates __client while it is used; keep the newer value.
  const rotated = response.headers.getSetCookie().find((cookie) => cookie.startsWith('__client='))
  if (rotated) {
    const value = rotated.slice('__client='.length).split(';')[0]
    if (value && value !== session.client) {
      session.client = value
      await saveSession()
    }
  }

  if (
    response.status === 403 &&
    (response.headers.get('cf-mitigated') === 'challenge' || response.headers.get('content-type')?.includes('text/html'))
  ) {
    throw new SignInError('Venice asked for a Cloudflare challenge; refresh the cookies (login command)')
  }

  return response
}

/** Reads the active session id and account from Clerk. */
async function ensureSessionIdentity(session) {
  const response = await veneziaFetch(`${clerkBase}/v1/client${clerkVersion}`)
  if (!response.ok) throw new SignInError(`Clerk rejected the stored session (HTTP ${response.status})`)
  const data = await response.json()
  const sessions = (data.response?.sessions ?? data.client?.sessions ?? []).filter((item) => item.status === 'active')
  const chosen = (session.uid && sessions.find((item) => item.user?.id === session.uid)) || sessions[0]
  if (!chosen) throw new SignInError('no active Venice session in the stored cookies')
  session.sessionId = chosen.id
  session.uid = chosen.user?.id ?? session.uid
  session.email =
    chosen.user?.email_addresses?.find((item) => item.id === chosen.user?.primary_email_address_id)?.email_address ??
    session.email
  return session
}

/**
 * Mints (or reuses) a Clerk session JWT. Single-flight: concurrent requests wait
 * for the same token instead of minting several.
 */
export async function mintToken({ force = false } = {}) {
  const session = await loadSession()
  if (!force && session.access && session.expires > Date.now() + tokenRefreshSkewMs) return session.access
  if (tokenFlight) return tokenFlight

  tokenFlight = (async () => {
    try {
      if (!session.sessionId) await ensureSessionIdentity(session)
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await veneziaFetch(
          `${clerkBase}/v1/client/sessions/${encodeURIComponent(session.sessionId)}/tokens${clerkVersion}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'organization_id=&tab_state=focused&force_origin=true',
          },
        )
        if (response.status === 401 && attempt === 0) {
          await ensureSessionIdentity(session)
          continue
        }
        if (!response.ok) throw new SignInError(`could not mint a Venice session token (HTTP ${response.status})`)
        const { jwt } = await response.json()
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
        if (claims.sub && session.uid && claims.sub !== session.uid) {
          throw new SignInError('the signed-in account changed; sign in again')
        }
        session.access = jwt
        session.expires = claims.exp * 1000
        await saveSession()
        return jwt
      }
      throw new Error('could not mint a Venice session token')
    } finally {
      tokenFlight = null
    }
  })()

  return tokenFlight
}

/** Some inference requests carry a short-lived client attestation token. */
async function attestationToken(headers) {
  if (attestation && attestation.expires > Date.now()) return attestation.value
  const response = await fetch(`${apiBase}/api/app/user/client_attestation/mint`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ env: {} }),
    redirect: 'error',
  })
  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  if (!data?.token) return null
  attestation = { value: data.token, expires: Date.now() + attestationTtlMs }
  return data.token
}

/**
 * Calls the web inference endpoint, retrying once with a freshly minted token on
 * 401 (a rotated or revoked session).
 */
export async function upstreamChat(body, route = INFERENCE_PATH, signal) {
  const session = await loadSession()
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs)

  for (let attempt = 0; attempt < 2; attempt++) {
    const access = await mintToken({ force: attempt > 0 })
    const headers = {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-venice-middleface-version': middlefaceVersion,
      'x-venice-request-timestamp-ms': String(Date.now()),
    }
    if (route.startsWith('/api/inference/')) {
      const token = await attestationToken(headers)
      if (token) headers['x-venice-client-attestation'] = token
    }
    const response = await veneziaFetch(apiBase + route, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeout,
    })
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel()
      continue
    }
    return response
  }
  throw new Error('Venice request failed')
}

/** Small health probe used by `doctor` and `/health`. */
export async function probeAccount() {
  const session = await loadSession()
  await ensureSessionIdentity(session)
  return { email: session.email, uid: session.uid, sessionId: session.sessionId }
}

export { INFERENCE_PATH }
