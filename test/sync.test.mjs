import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODELS, configDrift, describeDrift, openCodeModel, routeFor, staleConfigHint } from '../src/lib/models.mjs'

const syncScript = fileURLToPath(new URL('../src/sync.mjs', import.meta.url))
const current = () => Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, openCodeModel(model, routeFor(id))]))

test('configDrift: a config the sync just wrote is current', () => {
  const drift = configDrift(current())
  assert.deepEqual(drift, { missing: [], removed: [], changed: [] })
  assert.equal(describeDrift(drift), null)
})

test('configDrift: a config from the original version is reported', () => {
  // the shape the original project wrote: old ids, catalogue context, image input everywhere
  const old = current()
  delete old['z-ai-glm-5-3-flash']
  old['deepseek-v4-1-flash-free'] = { name: 'DeepSeek V4.1 Flash Uncensored (web)', limit: { context: 524288, output: 32768 } }
  old['zai-org-glm-4.6'] = { name: 'GLM 4.6 (web)', limit: { context: 198000, output: 16384 } }
  old['deepseek-v4-1-flash'].limit = { context: 1000000, output: 131072 }
  old['qwen3-coder-480b-a35b-instruct-turbo'].modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }
  const drift = configDrift(old)
  assert.deepEqual(drift.missing, ['z-ai-glm-5-3-flash'])
  assert.deepEqual(drift.removed, ['deepseek-v4-1-flash-free', 'zai-org-glm-4.6'])
  assert.deepEqual(drift.changed.sort(), ['deepseek-v4-1-flash', 'qwen3-coder-480b-a35b-instruct-turbo'])
  assert.match(describeDrift(drift), /1 new model\(s\) missing; 2 old id\(s\) still listed \(deepseek-v4-1-flash-free, zai-org-glm-4.6\); 2 model\(s\) with outdated limits/)
})

test('configDrift follows the forced chat route', () => {
  const agent = current()
  assert.deepEqual(configDrift(agent, () => 'classic').changed.sort(), ['deepseek-v4-1-flash', 'deepseek-v4-1-flash-uncensored', 'z-ai-glm-5-3-flash'])
})

test('staleConfigHint: old ids and prompts past the window, nothing for a normal request', () => {
  assert.match(staleConfigHint('deepseek-v4-1-flash-free', 100, 'agent'), /old id deepseek-v4-1-flash-free \(now deepseek-v4-1-flash-uncensored\)/)
  assert.match(staleConfigHint('qwen3-5-35b-a3b', 45000, 'classic'), /~45000-token prompt for qwen3-5-35b-a3b, which reads about 40000/)
  assert.equal(staleConfigHint('qwen3-5-35b-a3b', 30000, 'classic'), null)
  assert.equal(staleConfigHint('zai-org-glm-5.2', 900000, 'classic'), null)
  assert.equal(staleConfigHint('deepseek-v4-1-flash-uncensored', 100000, 'agent'), null)
  assert.match(staleConfigHint('deepseek-v4-1-flash-uncensored', 100000, 'classic'), /reads about 35000/)
})

function runSync(config, ...args) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'venice-sync-'))
  const file = path.join(dir, 'opencode.json')
  try {
    if (config) writeFileSync(file, JSON.stringify(config))
    const env = { ...process.env }
    delete env.VENICE_WEB_PORT
    delete env.VENICE_WEB_CHAT_ROUTE
    const run = spawnSync(process.execPath, [syncScript, '--config', file, ...args], { encoding: 'utf8', env })
    assert.equal(run.status, 0, run.stderr)
    return { written: JSON.parse(readFileSync(file, 'utf8')), output: run.stdout + run.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('sync: writes the current models and migrates an old config', () => {
  const { written } = runSync({
    model: 'venice-web/deepseek-v4-1-flash-free',
    provider: { 'venice-web': { options: { baseURL: 'http://127.0.0.1:3456/v1' }, models: { 'zai-org-glm-4.6': {} } }, other: { keep: true } },
  })
  const provider = written.provider['venice-web']
  assert.deepEqual(configDrift(provider.models), { missing: [], removed: [], changed: [] })
  assert.equal(provider.options.baseURL, 'http://127.0.0.1:3456/v1')
  assert.equal(written.model, 'venice-web/deepseek-v4-1-flash-uncensored')
  assert.deepEqual(written.provider.other, { keep: true })
})

test('sync: keeps a base URL pointing at another machine, --base-url replaces it', () => {
  const remote = { provider: { 'venice-web': { options: { baseURL: 'http://192.168.1.20:3456/v1' }, models: {} } } }
  const kept = runSync(remote)
  assert.equal(kept.written.provider['venice-web'].options.baseURL, 'http://192.168.1.20:3456/v1')
  assert.match(kept.output, /keeping baseURL http:\/\/192\.168\.1\.20:3456\/v1/)
  const replaced = runSync(remote, '--base-url', 'http://10.0.0.5:4000/v1')
  assert.equal(replaced.written.provider['venice-web'].options.baseURL, 'http://10.0.0.5:4000/v1')
  assert.equal(runSync(null).written.provider['venice-web'].options.baseURL, 'http://127.0.0.1:3456/v1')
})
