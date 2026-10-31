#!/usr/bin/env node
/**
 * venice-web proxy — exposes the venice.ai web session as a local
 * OpenAI-compatible endpoint.
 *
 *   node src/proxy.mjs            # listens on 127.0.0.1:3456
 *
 * Environment: see src/lib/config.mjs (VENICE_WEB_PORT, VENICE_WEB_CONFIG_DIR, …)
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer } from './lib/server.mjs'
import { configDir, host, port, requestTimeoutMs, sessionFile } from './lib/config.mjs'
import { log, warn } from './lib/log.mjs'
import { loadSession, mintToken } from './lib/venice.mjs'
import { modelIds } from './lib/models.mjs'

const http = createHttpServer({ requestTimeout: 0, headersTimeout: 0 })
const handler = createServer()

http.on('request', (req, res) => {
  handler(req, res).catch((error) => {
    warn('unhandled error:', error.stack ?? error.message)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    } else res.end()
  })
})

http.listen(port, host, async () => {
  log(`venice-web proxy on http://${host}:${port}/v1 — ${modelIds.length} free web models`)
  log(`session: ${sessionFile}`)
  const session = await loadSession().catch((error) => {
    warn('could not read the session:', error.message)
    return null
  })
  if (!session) {
    warn(`no usable session yet — sign in with: node ${configDir}/login.mjs  (or run the login command)`)
    return
  }
  log(`account: ${session.email ?? session.uid ?? 'unknown'} (UA: ${session.userAgent.slice(0, 40)}…)`)
  mintToken()
    .then(() => log('Clerk session token ready'))
    .catch((error) => warn('token mint failed:', error.message))
})

http.keepAliveTimeout = 65_000
http.requestTimeout = 0
http.setTimeout?.(Math.max(requestTimeoutMs, 0))

const shutdown = () => http.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
