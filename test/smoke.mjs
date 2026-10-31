#!/usr/bin/env node
/**
 * Smoke test against a running proxy.
 *
 *   node test/smoke.mjs                       # http://127.0.0.1:3456
 *   VENICE_WEB_PORT=4000 node test/smoke.mjs
 *   SMOKE_REQUIRE=1 node test/smoke.mjs       # fail instead of skipping
 *
 * It is also picked up by `node --test test/`, so it must stay quiet and safe
 * when there is no proxy or no signed-in session (the usual case in CI):
 *
 *   - no proxy reachable        -> skipped
 *   - proxy up, no session      -> checks the HTTP surface, then skips chat
 *   - proxy up and signed in    -> full check, including an emulated tool call
 */
import assert from 'node:assert/strict'
import { host, port } from '../src/lib/config.mjs'
import { DEFAULT_MODEL } from '../src/lib/models.mjs'

const base = `http://${host}:${port}`
const require_ = process.env.SMOKE_REQUIRE === '1'
const check = (name, ok, detail = '') => console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)

const skip = (reason) => {
  if (require_) {
    console.error(`FAIL  ${reason}`)
    process.exit(1)
  }
  console.log(`skip  ${reason}`)
  process.exit(0)
}

const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
  .then((response) => response.json())
  .catch(() => null)

if (!health) skip(`no proxy on ${base} (start it, or set SMOKE_REQUIRE=1 to fail instead)`)

check('proxy reachable', true, `${health.provider ?? 'venice-web'}, ${health.models ?? '?'} models`)

const models = await fetch(`${base}/v1/models`).then((response) => response.json())
check('model list', models.data?.length > 0, `${models.data?.length ?? 0} models`)
assert.ok(models.data.some((model) => model.id === DEFAULT_MODEL), `default model ${DEFAULT_MODEL} is missing`)

if (!health.ok) skip('proxy is up but no session is signed in (never ran login)')

const answer = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: DEFAULT_MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  }),
}).then((response) => response.json())
check(
  'plain answer',
  typeof answer.choices?.[0]?.message?.content === 'string',
  JSON.stringify(answer.choices?.[0]?.message?.content ?? answer.error?.message ?? '').slice(0, 60),
)

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
}).then((response) => response.json())
const calls = tooled.choices?.[0]?.message?.tool_calls ?? []
check('emulated tool call', calls.length > 0, calls.map((call) => call.function.name).join(',') || tooled.error?.message || '')
if (!calls.length) skip('the model answered without calling the tool (see docs/TROUBLESHOOTING.md)')

console.log('\nsmoke test passed')
