/**
 * HTTP layer: an OpenAI-compatible `/v1/chat/completions` (streaming and not)
 * plus `/v1/models` and `/health`.
 *
 * Reply handling: the Venice stream is read to the end before anything is
 * emitted, because with emulated tools the whole message has to be parsed before
 * we know whether it is an answer or a tool call. Reasoning deltas are buffered
 * with it and replayed in order.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { apiBase, dumpFile, host, port, providerID } from './config.mjs'
import {
  countTokens,
  parseToolReply,
  sseReader,
  toVeniceRequest,
  withRetryReminder,
} from './emulate.mjs'
import { MODELS } from './models.mjs'
import { debugRaw, log, preview, warn } from './log.mjs'
import { deepStripNulls, repairJsonControlChars } from './sanitize.mjs'
import { INFERENCE_PATH, SignInError, loadSession, resetSessionCache, upstreamChat } from './venice.mjs'

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
const openaiError = (res, status, message, type = 'venice_web_error') =>
  json(res, status, { error: { message, type } })

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    // JSON forbids raw control characters inside strings; some clients send a
    // literal 0x00 byte anyway, which makes JSON.parse throw.
    const repaired = repairJsonControlChars(raw)
    if (repaired === raw) throw error
    return JSON.parse(repaired)
  }
}

/** Model catalog in OpenAI shape. */
function modelList() {
  return {
    object: 'list',
    data: Object.entries(MODELS).map(([id, model]) => ({
      id,
      object: 'model',
      owned_by: providerID,
      name: model.name,
      context_length: model.context,
    })),
  }
}

/**
 * Reads an upstream stream to completion.
 * @returns {Promise<{text: string, answer: string, reasoning: string, terminal: boolean, chunks: object[]}>}
 */
async function collectStream(upstreamBody, mapping, chunk) {
  const reader = upstreamBody.getReader()
  const stream = sseReader()
  const state = { text: '', answer: '', reasoning: '', terminal: false, chunks: [] }
  const itemTypes = new Map()

  const apply = (event) => {
    if (event.type === 'error' || event.type === 'response.failed') {
      throw new Error(event.message ?? event.response?.error?.message ?? 'Venice generation failed')
    }
    if (event.type === 'response.output_item.added' && event.item?.type) {
      itemTypes.set(event.output_index, event.item.type)
    }
    if (event.type === 'response.output_text.delta') {
      const delta = event.delta ?? ''
      if (itemTypes.get(event.output_index) === 'reasoning') {
        state.reasoning += delta
        state.chunks.push(chunk({ reasoning_content: delta }))
        return
      }
      if (mapping.emulatedTools) state.text += delta
      else {
        state.answer += delta
        state.chunks.push(chunk({ content: delta }))
      }
    }
    if (/^response\.(reasoning_text|reasoning_summary_text)\.delta$/.test(event.type)) {
      state.reasoning += event.delta ?? ''
      state.chunks.push(chunk({ reasoning_content: event.delta ?? '' }))
    }
    if (event.type === 'response.completed') state.terminal = true
    if (event.type === 'response.incomplete') throw new Error('Venice generation was incomplete')
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      for (const event of stream.feed(value, done)) apply(event)
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return state
}

/**
 * Yields OpenAI chunks for one request.
 *
 * Reliability: when the model answers with plain prose instead of the envelope
 * (or with an envelope that has no tool calls on the first turn), the request is
 * retried once with a harder reminder. Retries are free on the web plan, and
 * they turned "tools look broken" into a 100% hit rate in testing.
 */
async function* openaiChunks(body, mapping, upstreamBody, signal) {
  const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null, extra = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })

  yield chunk({ role: 'assistant', content: '' })

  let state = await collectStream(upstreamBody, mapping, chunk)
  let message = null

  if (mapping.emulatedTools) {
    message = parseToolReply(state.text)

    const last = [...(body.messages ?? [])].reverse().find((item) => item.role !== 'system' && item.role !== 'developer')
    const needsRetry = !message.sawEnvelope || (message.sawEnvelope && !message.tool_calls && last?.role === 'user')

    if (needsRetry) {
      log(`  ~ ${message.sawEnvelope ? 'envelope without tool calls' : 'plain prose reply'}, retrying once…`)
      try {
        const retry = await upstreamChat(withRetryReminder(mapping.request), INFERENCE_PATH, signal)
        if (retry.ok) {
          const retryState = await collectStream(retry.body, mapping, chunk)
          const retryMessage = parseToolReply(retryState.text)
          if (retryMessage.tool_calls) {
            state = retryState
            message = retryMessage
            log('  ~ retry produced tool calls')
          } else if (!message.sawEnvelope && retryMessage.sawEnvelope) {
            // First attempt ignored the format; prefer the compliant retry.
            state = retryState
            message = retryMessage
            state.chunks = []
            log('  ~ retry produced a plain answer envelope')
          } else {
            log('  ~ retry produced no tool calls, keeping the first answer')
          }
        }
      } catch (error) {
        warn('  ~ retry failed:', error.message)
      }
    }
  }

  if (!state.terminal) throw new Error('the Venice stream ended before response.completed')
  for (const buffered of state.chunks) yield buffered

  let finish = 'stop'
  let contentForUsage = state.answer

  if (mapping.emulatedTools) {
    debugRaw(body.model, state.text)
    contentForUsage = message.content ?? ''
    if (message.tool_calls) {
      finish = 'tool_calls'
      log(`  <- tools: ${message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 80)})`).join(' | ')}`)
      yield chunk({
        content: message.content || '',
        tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
      })
    } else {
      log(`  <- no tools • text: ${preview(state.text, 110)}`)
      yield chunk({ content: message.content ?? '' })
    }
  }

  const prompt = countTokens(JSON.stringify(body.messages ?? []))
  const completion = countTokens(contentForUsage) + countTokens(state.reasoning)
  yield chunk({}, finish, {
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
}

async function handleChat(req, res) {
  const body = await readJson(req)
  const mapping = toVeniceRequest(body)

  // Venice rejects null bytes ("String must not contain null bytes", HTTP 400)
  // and a nested leak in the system prompt breaks the whole session, so scrub
  // the outgoing payload. Tool results are the usual source (grep/cat/tail over
  // a binary file).
  const scrubbed = deepStripNulls(mapping.request)
  const scrubbedBody = deepStripNulls(body)
  const nulls = scrubbed + scrubbedBody
  if (nulls) log(`   ~ scrubbed ${nulls} NUL byte(s) before sending upstream`)

  if (dumpFile) {
    try {
      writeFileSync(dumpFile, JSON.stringify({ body, mapping }, null, 1))
    } catch {
      /* ignore */
    }
  }

  const names = [...mapping.toolNames]
  log(
    `-> ${body.model} • ${body.messages?.length ?? 0} msgs • ${names.length} tools${names.length ? ` [${names.join(',')}]` : ''} • stream=${body.stream !== false}`,
  )

  const abort = new AbortController()
  req.on('aborted', () => abort.abort())

  let upstream
  try {
    upstream = await upstreamChat(mapping.request, INFERENCE_PATH, abort.signal)
  } catch (error) {
    return openaiError(res, error instanceof SignInError || error.signIn ? 401 : 502, error.message)
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    return openaiError(res, upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 400)}`)
  }

  const chunks = openaiChunks(body, mapping, upstream.body, abort.signal)

  if (body.stream === false) {
    const message = { role: 'assistant', content: '' }
    let finish = 'stop'
    let usage = null
    for await (const part of chunks) {
      if (part.usage) usage = part.usage
      const choice = part.choices?.[0]
      if (!choice) continue
      if (choice.delta.content) message.content += choice.delta.content
      if (choice.delta.reasoning_content) message.reasoning = (message.reasoning ?? '') + choice.delta.reasoning_content
      if (choice.delta.tool_calls) message.tool_calls = choice.delta.tool_calls.map(({ index, ...call }) => call)
      if (choice.finish_reason) finish = choice.finish_reason
    }
    if (message.tool_calls && !message.content) message.content = null
    if (!message.content && !message.tool_calls) message.content = ''
    return json(res, 200, {
      id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    })
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  try {
    for await (const part of chunks) res.write(`data: ${JSON.stringify(part)}\n\n`)
    res.write('data: [DONE]\n\n')
  } catch (error) {
    warn('stream error:', error.message)
    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
  }
  res.end()
}

export function createServer() {
  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        const session = await loadSession().catch(() => null)
        return json(res, 200, {
          ok: !!session,
          account: session?.email ?? null,
          provider: providerID,
          models: Object.keys(MODELS).length,
        })
      }

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        return json(res, 200, modelList())
      }

      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        return await handleChat(req, res)
      }

      if (req.method === 'POST' && url.pathname === '/reload') {
        resetSessionCache()
        const session = await loadSession({ force: true })
        return json(res, 200, { ok: true, account: session.email ?? null })
      }

      openaiError(res, 404, `unknown endpoint: ${req.method} ${url.pathname}`, 'not_found')
    } catch (error) {
      if (error instanceof SignInError) return openaiError(res, 401, error.message)
      warn('request error:', error.stack ?? error.message)
      if (!res.headersSent) openaiError(res, 500, error.message)
      else res.end()
    }
  }
}

export { host, port }
