/**
 * Tiny logger. Requests are logged in a compact, greppable form so users can
 * see exactly which tools the model asked for, and when a retry kicked in.
 */
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { configDir, debug } from './config.mjs'

const stamp = () => new Date().toISOString()

export function log(...parts) {
  console.log(stamp(), ...parts)
}

export function warn(...parts) {
  console.warn(stamp(), ...parts)
}

export function fail(...parts) {
  console.error(stamp(), ...parts)
}

/** Full raw model output, only when VENICE_WEB_DEBUG=1. */
export function debugRaw(label, text) {
  if (!debug) return
  try {
    appendFileSync(path.join(configDir, 'debug.log'), `\n===== ${stamp()} ${label}\n${text}\n`)
  } catch {
    /* logging must never break a request */
  }
}

export const preview = (value, length = 140) => JSON.stringify(String(value ?? '').slice(0, length))
