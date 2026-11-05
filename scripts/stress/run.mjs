#!/usr/bin/env node
/**
 * Runs the stress tasks through a real OpenCode session and the proxy.
 *
 *   node scripts/stress/run.mjs [--model venice-web/deepseek-v4-1-flash-free]
 *                            [--base-url http://127.0.0.1:3457/v1] [--only id,id] [--parallel 2]
 *
 * With --base-url, OpenCode is pointed at that proxy through a temporary config
 * (OPENCODE_CONFIG), so a new build can be measured before it replaces the
 * running service. Needs `opencode` on PATH and python3. Not part of `npm test`:
 * it talks to venice.ai and takes minutes.
 */
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TASKS } from './tasks.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const model = option('model', 'venice-web/deepseek-v4-1-flash-free')
const baseURL = option('base-url')
const only = option('only')?.split(',')
const parallel = Number(option('parallel', '2'))
const timeoutMs = Number(option('timeout', String(15 * 60 * 1000)))

const root = mkdtempSync(path.join(tmpdir(), 'venice-web-stress-'))
const env = { ...process.env }
if (baseURL) {
  const config = path.join(root, 'opencode.json')
  const provider = model.split('/')[0]
  writeFileSync(config, JSON.stringify({ provider: { [provider]: { options: { baseURL } } } }))
  env.OPENCODE_CONFIG = config
}

const sh = (command, cwd) => {
  const result = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 60_000 })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { status: result.status, out, ok: result.status === 0 }
}

function runTask(task) {
  const dir = path.join(root, task.id)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(task.files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn('opencode', ['run', '--auto', '--standalone', '-m', model, '--title', `stress-${task.id}`, task.prompt], {
      cwd: dir,
      // OpenCode takes the project directory from PWD, not from the process cwd
      env: { ...env, PWD: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      const failure = (() => {
        try {
          return task.verify(dir, sh, task.files)
        } catch (error) {
          return `verify threw: ${error.message}`
        }
      })()
      resolve({ id: task.id, ok: failure === null, failure, code, seconds: Math.round((Date.now() - started) / 1000), dir, tail: output.slice(-400) })
    })
  })
}

const queue = TASKS.filter((task) => !only || only.includes(task.id))
const results = []
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (queue.length) {
      const result = await runTask(queue.shift())
      results.push(result)
      console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id} (${result.seconds}s)${result.ok ? '' : ` - ${result.failure}`}`)
    }
  }),
)
const passed = results.filter((result) => result.ok).length
console.log(`\n${passed}/${results.length} tasks verified • work dirs in ${root}`)
process.exitCode = passed === results.length ? 0 : 1
