#!/usr/bin/env node
/**
 * venice-web sync — writes the `venice-web` provider into an OpenCode config
 * file, pointing it at the local proxy. Existing settings are preserved.
 *
 *   node src/sync.mjs                 # add/update the provider
 *   node src/sync.mjs --default       # also make it the default + small model
 *   node src/sync.mjs --remove        # remove provider (and default if ours)
 *   node src/sync.mjs --config <path> # target another config file
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { port, providerID } from './lib/config.mjs'
import { DEFAULT_MODEL, DEFAULT_SMALL_MODEL, MODELS } from './lib/models.mjs'
import { log, warn } from './lib/log.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const configPath = path.resolve(
  flag('config') ?? process.env.OPENCODE_CONFIG ?? path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
)

const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}

if (args.includes('--remove')) {
  delete config.provider?.[providerID]
  if (String(config.model ?? '').startsWith(`${providerID}/`)) delete config.model
  if (String(config.small_model ?? '').startsWith(`${providerID}/`)) delete config.small_model
} else {
  config.$schema ??= 'https://opencode.ai/config.json'
  config.provider ??= {}
  config.provider[providerID] = {
    name: 'Venice Web (unlimited)',
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: providerID },
    models: Object.fromEntries(
      Object.entries(MODELS).map(([id, model]) => [
        id,
        {
          name: model.name,
          tool_call: true,
          reasoning: model.reasoning,
          limit: { context: model.context, output: model.output },
        },
      ]),
    ),
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
log(`updated ${configPath} — provider "${providerID}" with ${count} models`)
if (args.includes('--default')) log(`default model: ${providerID}/${DEFAULT_MODEL}`)
if (args.includes('--remove')) warn(`provider "${providerID}" removed`)
