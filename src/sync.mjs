#!/usr/bin/env node
/**
 * venice-web sync - writes the `venice-web` provider into an OpenCode config
 * file, pointing it at the local proxy. Existing settings are preserved.
 *
 *   node src/sync.mjs                 # add/update the provider
 *   node src/sync.mjs --default       # also make it the default + small model
 *   node src/sync.mjs --remove        # remove provider (and default if ours)
 *   node src/sync.mjs --config <path> # target another config file
 *   node src/sync.mjs --base-url <url> # proxy on another machine (kept on later syncs)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chatRoute, opencodeConfig, port, providerID } from './lib/config.mjs'
import { DEFAULT_MODEL, DEFAULT_SMALL_MODEL, MODEL_ALIASES, MODELS, openCodeModel, routeFor } from './lib/models.mjs'
import { log, warn } from './lib/log.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const configPath = path.resolve(flag('config') ?? opencodeConfig)

/**
 * `--base-url` wins; else a base URL the user pointed at another machine (the
 * proxy on a VM or server) is kept, so a sync after an update does not cut
 * OpenCode off; else the local proxy on `port`.
 */
function providerBaseURL(current, wanted) {
  if (wanted) return wanted
  try {
    const { hostname } = new URL(current)
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      log(`keeping baseURL ${current} (pass --base-url to change it)`)
      return current
    }
  } catch {
    /* no or broken base URL: write the default */
  }
  return `http://127.0.0.1:${port}/v1`
}

const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}

if (args.includes('--remove')) {
  delete config.provider?.[providerID]
  if (String(config.model ?? '').startsWith(`${providerID}/`)) delete config.model
  if (String(config.small_model ?? '').startsWith(`${providerID}/`)) delete config.small_model
} else {
  config.$schema ??= 'https://opencode.ai/config.json'
  config.provider ??= {}
  const baseURL = providerBaseURL(config.provider[providerID]?.options?.baseURL, flag('base-url'))
  config.provider[providerID] = {
    name: 'Venice Web (unlimited)',
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL, apiKey: providerID },
    models: Object.fromEntries(
      Object.entries(MODELS).map(([id, model]) => [id, openCodeModel(model, routeFor(id, chatRoute))]),
    ),
  }
  // move `model` / `small_model` off ids Venice renamed
  for (const key of ['model', 'small_model']) {
    const [provider, id] = String(config[key] ?? '').split(/\/(.*)/s)
    if (provider === providerID && MODEL_ALIASES[id]) {
      config[key] = `${providerID}/${MODEL_ALIASES[id]}`
      log(`${key}: ${providerID}/${id} -> ${config[key]}`)
    }
  }
  if (args.includes('--default')) {
    config.model = `${providerID}/${DEFAULT_MODEL}`
    config.small_model = `${providerID}/${DEFAULT_SMALL_MODEL}`
  }
}

mkdirSync(path.dirname(configPath), { recursive: true })
const tmp = `${configPath}.tmp`
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
renameSync(tmp, configPath)

const count = Object.keys(MODELS).length
log(`updated ${configPath} - provider "${providerID}" with ${count} models`)
if (args.includes('--default')) log(`default model: ${providerID}/${DEFAULT_MODEL}`)
if (args.includes('--remove')) warn(`provider "${providerID}" removed`)
