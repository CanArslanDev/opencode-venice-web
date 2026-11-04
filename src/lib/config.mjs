/**
 * Shared configuration: paths, endpoints, tunables.
 *
 * Everything is overridable through the environment so the tool can run from a
 * checkout, from a global install, or under a service manager.
 */
import path from 'node:path'
import os from 'node:os'

const home = os.homedir()

/** Where the session file, logs and cookie accounts live. */
export const configDir = path.resolve(
  process.env.VENICE_WEB_CONFIG_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode', 'venice-web'),
)

export const sessionFile = process.env.VENICE_WEB_SESSION ?? path.join(configDir, 'session.json')

export const host = process.env.VENICE_WEB_HOST ?? '127.0.0.1'
export const port = Number(process.env.VENICE_WEB_PORT ?? 3456)

/** Venice web backends (undocumented, used by venice.ai itself). */
export const clerkBase = 'https://clerk.venice.ai'
export const apiBase = 'https://outerface.venice.ai'

/**
 * Clerk frontend API version. Venice's own bundle sends these; a mismatching
 * version is normally still accepted, but keeping them close to the web client
 * avoids surprises.
 */
export const clerkVersion = process.env.VENICE_WEB_CLERK_VERSION ?? '?__clerk_api_version=2026-05-12&_clerk_js_version=6.39.0'

/** Version header the web client sends to the inference backend. */
export const middlefaceVersion = process.env.VENICE_WEB_MIDDLEFACE ?? '0.1.1128'

/** Hard cap for one upstream generation. */
export const requestTimeoutMs = Number(process.env.VENICE_WEB_TIMEOUT ?? 15 * 60 * 1000)

/** How long a minted Clerk JWT is reused before it is refreshed (the real JWT lives ~60s). */
export const tokenRefreshSkewMs = 15_000

/** How long a minted client attestation token is cached. */
export const attestationTtlMs = 5 * 60 * 1000

/** OpenCode provider id written by `sync.mjs`. */
export const providerID = process.env.VENICE_WEB_PROVIDER_ID ?? 'venice-web'

export const debug = !!process.env.VENICE_WEB_DEBUG
export const dumpFile = process.env.VENICE_WEB_DUMP

/**
 * HTTP client for the inference host (`outerface.venice.ai`). Cloudflare blocks
 * Node's own client there, so `auto` uses the system curl when it is installed
 * (see src/lib/curl.mjs). `fetch` forces Node's client, `curl` requires curl.
 * Clerk calls always use Node's fetch.
 */
export const transport = process.env.VENICE_WEB_TRANSPORT ?? 'auto'

/**
 * The judge: a second model call that decides whether a reply without tool
 * calls may end the turn (see emulate.mjs `buildJudgeRequest`). `VENICE_WEB_JUDGE=0`
 * turns it off; `VENICE_WEB_JUDGE_MODEL` picks the model (an empty value means the
 * request's own model). Qwen 3.5 35B A3B was the most accurate of four measured
 * candidates (docs/PROTOCOL.md §4.7). A judge that fails or times out never blocks
 * the reply.
 */
export const judgeEnabled = process.env.VENICE_WEB_JUDGE !== '0'
export const judgeModel = process.env.VENICE_WEB_JUDGE_MODEL ?? 'qwen3-5-35b-a3b'
export const judgeTimeoutMs = Number(process.env.VENICE_WEB_JUDGE_TIMEOUT ?? 45_000)
