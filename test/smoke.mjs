#!/usr/bin/env node
/**
 * Smoke test against a running proxy. Requires a signed-in session file.
 *
 *   node test/smoke.mjs                     # uses http://127.0.0.1:3456
 *   VENICE_WEB_PORT=4000 node test/smoke.mjs
 *
 * Exits non-zero on the first failure; prints what it checked.
 */
import assert from 'node:assert/strict'
import { host, port } from '../src/lib/config.mjs'
import { DEFAULT_MODEL } from '../src/lib/models.mjs'

const base = `http://${host}:${port}`
const check = (name, ok, detail = '') => console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)

const health = await fetch(`${base}/health`).then((r) => r.json())
check('health', health.ok === true, health.account ?? '')
assert.equal(health.ok, true, 'proxy is not signed in — run the login command')

const models = await fetch(`${base}/v1/models`).then((r) => r.json())
check('model list', models.data.length > 0, `${models.data.length} models`)
assert.ok(models.data.some((model) => model.id === DEFAULT_MODEL))

const answer = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: DEFAULT_MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  }),
}).then((r) => r.json())
check('plain answer', typeof answer.choices?.[0]?.message?.content === 'string', JSON.stringify(answer.choices?.[0]?.message?.content).slice(0, 60))

const tooled = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: DEFAULT_MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Use the bash tool to list /tmp. Do not answer before calling it.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      },
    ],
  }),
}).then((r) => r.json())
const calls = tooled.choices?.[0]?.message?.tool_calls ?? []
check('emulated tool call', calls.length > 0, calls.map((call) => call.function.name).join(','))
assert.ok(calls.length > 0, 'model did not call the tool (see docs/TROUBLESHOOTING.md)')

console.log('\nsmoke test passed')
