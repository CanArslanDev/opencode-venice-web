/**
 * Browser cookie extraction.
 *
 * Venice web auth is a long-lived Clerk `__client` cookie. Chromium based
 * browsers encrypt cookies with a key stored in the OS keychain, so we read the
 * key, decrypt the cookie, and stop there — nothing is written back to the
 * browser and no password is stored.
 *
 * Supported automatically: Brave, Chrome, Edge, Chromium on macOS (Keychain) and
 * Linux (secret-tool / gnome-keyring, falling back to the well-known "peanuts"
 * password used when no keyring is available). Anything else can be passed with
 * `--cookie` + `--ua`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export const BROWSERS = {
  brave: { mac: 'BraveSoftware/Brave-Browser', linux: 'BraveSoftware/Brave-Browser', app: '/Applications/Brave Browser.app', keychain: 'Brave Safe Storage', secret: ['application', 'brave'], label: 'Brave' },
  chrome: { mac: 'Google/Chrome', linux: 'google-chrome', app: '/Applications/Google Chrome.app', keychain: 'Chrome Safe Storage', secret: ['application', 'chrome'], label: 'Chrome' },
  edge: { mac: 'Microsoft Edge', linux: 'microsoft-edge', app: '/Applications/Microsoft Edge.app', keychain: 'Microsoft Edge Safe Storage', secret: ['application', 'chrome'], label: 'Edge' },
  chromium: { mac: 'Chromium', linux: 'chromium', app: '/Applications/Chromium.app', keychain: 'Chromium Safe Storage', secret: ['application', 'chromium'], label: 'Chromium' },
}

const COOKIE_HOSTS = ['.clerk.venice.ai', 'clerk.venice.ai']

const profiles = (name) => (name ? [name] : ['Default', 'Profile 1', 'Profile 2', 'Profile 3'])

function candidatePaths(browser, profile) {
  const home = homedir()
  if (process.platform === 'darwin') {
    const root = path.join(home, 'Library', 'Application Support', browser.mac)
    return profiles(profile).map((dir) => path.join(root, dir, 'Cookies'))
  }
  const roots = [path.join(home, '.config'), path.join(home, '.var', 'app')]
  const dirs = []
  for (const root of roots) {
    if (browser.linux.includes('/')) dirs.push(path.join(root, browser.linux))
    else dirs.push(path.join(root, browser.linux))
  }
  const out = []
  for (const dir of dirs) for (const profile of profiles(profile === 'Default' ? undefined : profile)) {
    out.push(path.join(dir, profile, 'Cookies'))
    out.push(path.join(dir, `${profile}-Cookies`))
  }
  return out
}

function passwordFor(browser) {
  if (process.platform === 'darwin') {
    return execFileSync('security', ['find-generic-password', '-s', browser.keychain, '-w'], { encoding: 'utf8' }).trim()
  }
  // Linux: secret-tool lookup, fall back to the no-keyring default.
  try {
    const value = execFileSync('secret-tool', ['lookup', ...browser.secret], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (value) return value
  } catch {
    /* fall through */
  }
  return 'peanuts'
}

function decrypt(value, key) {
  let payload = value
  const prefix = payload.subarray(0, 3).toString()
  if (prefix === 'v10' || prefix === 'v11') payload = payload.subarray(3)
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  let out = Buffer.concat([decipher.update(payload), decipher.final()])
  const pad = out[out.length - 1]
  if (pad >= 1 && pad <= 16) out = out.subarray(0, out.length - pad)
  // Chromium >= 130 prefixes the plaintext with a SHA256 of the host key.
  if (out.length > 32) {
    try {
      new TextDecoder('utf8', { fatal: true }).decode(out)
    } catch {
      out = out.subarray(32)
    }
  }
  return out.toString('utf8')
}

function browserUserAgent(browser) {
  if (process.platform === 'darwin') {
    const plist = path.join(browser.app, 'Contents', 'Info.plist')
    if (existsSync(plist)) {
      const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
      const major = version.split('.')[0] || '131'
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    }
  }
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

function readFromBrowser(name, profile) {
  const browser = BROWSERS[name]
  const db = candidatePaths(browser, profile).find(existsSync)
  if (!db) return null

  const key = pbkdf2Sync(passwordFor(browser), 'saltysalt', 1003, 16, 'sha1')
  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'venice-cookie-')), 'Cookies')
  copyFileSync(db, copy)

  const rows = execFileSync(
    'sqlite3',
    [copy, '-json', `select host_key,name,hex(encrypted_value) as hex from cookies where host_key in (${COOKIE_HOSTS.map((h) => `'${h}'`).join(',')})`],
    { encoding: 'utf8' },
  )
  const parsed = rows.trim() ? JSON.parse(rows) : []
  let client = null
  for (const row of parsed) {
    if (row.name !== '__client') continue
    try {
      client = decrypt(Buffer.from(row.hex, 'hex'), key)
    } catch {
      /* try the next profile */
    }
  }
  if (!client) return null
  return { client, userAgent: browserUserAgent(browser), source: browser.label }
}

/** Tries the requested browsers (or all of them) in order. */
export function findCookies({ browser, profile } = {}) {
  const order = browser ? [browser] : ['brave', 'chrome', 'edge', 'chromium']
  const notes = []
  for (const name of order) {
    if (!BROWSERS[name]) throw new Error(`unknown browser: ${name} (expected ${Object.keys(BROWSERS).join(', ')})`)
    try {
      const found = readFromBrowser(name, profile)
      if (found) return found
      notes.push(`${BROWSERS[name].label}: no venice.ai cookie`)
    } catch (error) {
      notes.push(`${BROWSERS[name].label}: ${String(error.message).split('\n')[0]}`)
    }
  }
  throw new Error(
    `could not read browser cookies:\n  ${notes.join('\n  ')}\n` +
      'Sign in to venice.ai in a supported browser, or pass --cookie/--ua manually.',
  )
}

/** Parses a Cookie header or JSON export into a raw `__client` value. */
export function clientFromString(input) {
  const text = input.replace(/^cookie:\s*/i, '')
  const match = /(?:^|;\s*)__client=([^;]+)/.exec(text)
  if (match) return match[1]
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : parsed?.cookies
    const found = (list ?? []).find((cookie) => cookie?.name === '__client')
    if (found?.value) return found.value
  } catch {
    /* not JSON */
  }
  throw new Error('no __client cookie found in the given value (copy it from a clerk.venice.ai request)')
}
