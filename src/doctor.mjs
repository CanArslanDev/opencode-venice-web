#!/usr/bin/env node
/**
 * venice-web doctor - one command to answer "why doesn't it work?".
 *
 *   node src/doctor.mjs          # checks
 *   node src/doctor.mjs --fix    # also (re)generate the OpenCode provider entry
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { host, port, providerID, sessionFile } from './lib/config.mjs'
import { MODELS } from './lib/models.mjs'
import { log, warn } from './lib/log.mjs'

const args = process.argv.slice(2)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  log(`${ok ? ' ok ' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`)
}

async function main() {
  const major = Number(process.versions.node.split('.')[0])
  check(major >= 22, `node version ${process.versions.node}`, major >= 22 ? '' : 'node 22+ is required')

  const hasSession = existsSync(sessionFile)
  check(hasSession, `session file (${sessionFile})`, hasSession ? '' : 'run the login command')

  if (hasSession) {
    try {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8'))
      check(!!session.client && !!session.userAgent, 'session contents', session.email ? `account ${session.email}` : '')
      const left = session.expires ? session.expires - Date.now() : null
      const human =
        left === null ? 'unknown' : left > 86_400_000 ? `${(left / 86_400_000).toFixed(1)}d` : left > 3_600_000 ? `${Math.round(left / 3_600_000)}h` : `${Math.max(0, Math.round(left / 60_000))}m`
      log(` info  cached token has ${human} left (the proxy refreshes it; a stale value is normal)`)
    } catch (error) {
      check(false, 'session file parses', error.message)
    }
  }

  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) })
    const body = await response.json()
    check(response.ok && body.ok, `proxy on ${host}:${port}`, body.account ? `signed in as ${body.account}` : 'no account')
  } catch (error) {
    check(false, `proxy on ${host}:${port}`, `not reachable (${error.message}); start it or install the service`)
  }

  const configPath = process.env.OPENCODE_CONFIG ?? path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  const configured = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8')).provider?.[providerID]
    : undefined
  check(!!configured, `opencode provider "${providerID}" in ${configPath}`, configured ? `${Object.keys(configured.models ?? {}).length} models` : 'run the sync command')

  check(Object.keys(MODELS).length > 0, 'model catalogue')

  log('')
  const failed = results.filter((result) => !result.ok)
  log(failed.length ? `${failed.length} check(s) failed` : 'all checks passed')

  if (failed.length && args.includes('--fix')) {
    log('')
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    spawnSync(process.execPath, [fileURLToPath(new URL('./sync.mjs', import.meta.url))], { stdio: 'inherit' })
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  warn(error.stack ?? error.message)
  process.exit(1)
})
