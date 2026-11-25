/**
 * HTTP layer: an OpenAI-compatible `/v1/chat/completions` (streaming and not)
 * plus `/v1/models` and `/health`.
 *
 * Reply handling: reasoning deltas stream straight through, and so does content
 * when tools are not emulated. With emulated tools the message is read to the end
 * first, because the whole text has to be parsed before we know whether it is an
 * answer or a tool call; those deltas are buffered and replayed in order. An SSE
 * keepalive comment bridges the silent stretches.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { apiBase, debug, dumpFile, host, imageRoute, judgeEnabled, judgeModel, judgeTimeoutMs, port, providerID } from './config.mjs'
import {
  applyFallback,
  buildJudgeRequest,
  countTokens,
  inspectCalls,
  judgeDecision,
  parseJudgeVerdict,
  parseToolReply,
  preferAnswer,
  serverLoopMessage,
  shouldRetry,
  MAX_IMAGES,
  imageFromBytes,
  imageFromDataUrl,
  sseReader,
  toVeniceRequest,
  withRetryReminder,
} from './emulate.mjs'
import { IMAGE_MODELS, MODELS } from './models.mjs'
import { debugRaw, log, preview, warn } from './log.mjs'
import { deepStripNulls, repairJsonControlChars } from './sanitize.mjs'
import { AGENT_IMAGE_PATH, INFERENCE_PATH, SignInError, loadSession, resetSessionCache, upstreamChat } from './venice.mjs'
import {
  ImageRequestError,
  agentRequest,
  editInstruction,
  generationInstruction,
  imageCollector,
  imagesResponse,
  parseCount,
  parseResponseFormat,
  parseSize,
  pickEditModel,
  pickImageModel,
  seedsFor,
} from './imagegen.mjs'
import { STUDIO_IMAGE_PATH, parseStudioOptions, studioImageMeta, studioImageRequest, studioSeeds } from './studio.mjs'

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
const openaiError = (res, status, message, type = 'venice_web_error') =>
  json(res, status, { error: { message, type } })

/** Largest request body the image routes accept. */
const MAX_IMAGE_BODY = 64 * 1024 * 1024

/** The whole request body, or a 413-shaped error past `limit` bytes. */
async function readRaw(req, limit = Infinity) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new ImageRequestError(`request body is larger than ${Math.round(limit / 1024 / 1024)} MB`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseJsonText(raw) {
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

async function readJson(req) {
  return parseJsonText((await readRaw(req)).toString('utf8'))
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
 * Reads an upstream stream to completion, yielding deltas that are safe to
 * forward while it runs: reasoning always, content only when tools are not
 * emulated (in emulated mode the whole text has to be parsed first).
 *
 * The returned generator resolves to the collected state. With `stopServerLoop`
 * it stops early when Venice's own agent loop runs past `SERVER_LOOP_STEPS` and
 * sets `serverLoop` (see the comment in `apply`).
 * @returns {AsyncGenerator<object, {text: string, answer: string, reasoning: string, terminal: boolean, chunks: object[], steps: Set<string>, nativeTools: Set<string>, serverLoop: boolean}>}
 */
export async function* collectStream(upstreamBody, mapping, chunk, { stopServerLoop = false } = {}) {
  const reader = upstreamBody.getReader()
  const stream = sseReader()
  const state = {
    text: '',
    answer: '',
    reasoning: '',
    terminal: false,
    chunks: [],
    steps: new Set(),
    nativeTools: new Set(),
    serverLoop: false,
    events: {},
  }
  const itemTypes = new Map()

  const apply = (event) => {
    if (event.type === 'error' || event.type === 'response.failed') {
      throw new Error(event.message ?? event.response?.error?.message ?? 'Venice generation failed')
    }
    if (event.type === 'response.output_item.added' && event.item?.type) {
      itemTypes.set(event.output_index, event.item.type)
    }
    // Venice runs its own agent loop inside one response. When the model calls a
    // tool natively instead of through the envelope, Venice tries to run it
    // itself, answers "Tool not found" and lets the model go again - up to ten
    // steps - and none of that reaches the client. After a few rounds the model
    // is convinced its tools are broken and gives up without a result (the
    // "done, but no answer until I ask again" sessions, 2026-11-05). Each step is
    // one `veniceai:tool_call_generation` item; the names it tried are in
    // `detected_tools`.
    if (debug) {
      state.events[event.type] = (state.events[event.type] ?? 0) + 1
      if (event.type === 'response.output_item.done' && /server_function_call/.test(event.item?.type ?? '')) {
        debugRaw(`${mapping.request.modelId} server item ${event.item.type}`, JSON.stringify(event.item).slice(0, 2000))
      }
    }
    if (event.type === 'veniceai:tool_call_generation.in_progress') {
      for (const tool of event.detected_tools ?? []) if (tool?.name) state.nativeTools.add(tool.name)
    }
    if (event.item?.type === 'veniceai:tool_call_generation' && event.item.id) {
      state.steps.add(event.item.id)
      if (stopServerLoop && mapping.emulatedTools && state.steps.size > SERVER_LOOP_STEPS) {
        state.serverLoop = true
        state.terminal = true
        return STOP
      }
    }
    if (event.type === 'response.output_text.delta') {
      const delta = event.delta ?? ''
      if (itemTypes.get(event.output_index) === 'reasoning') {
        state.reasoning += delta
        return chunk({ reasoning_content: delta })
      }
      if (mapping.emulatedTools) state.text += delta
      else {
        state.answer += delta
        return chunk({ content: delta })
      }
    }
    if (/^response\.(reasoning_text|reasoning_summary_text)\.delta$/.test(event.type)) {
      state.reasoning += event.delta ?? ''
      return chunk({ reasoning_content: event.delta ?? '' })
    }
    if (event.type === 'response.completed') state.terminal = true
    if (event.type === 'response.incomplete') throw new Error('Venice generation was incomplete')
    return null
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      let stop = false
      for (const event of stream.feed(value, done)) {
        const live = apply(event)
        if (live === STOP) {
          stop = true
          break
        }
        if (live) yield live
      }
      if (done || stop) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return state
}

/** Returned by `apply()` to end the stream early. */
const STOP = Symbol('stop')

/**
 * Venice agent steps allowed in one response before the proxy stops it. One
 * step is a normal reply; a second or third is the model recovering from one
 * native call; past that it is looping on "Tool not found" (measured: every
 * 10-step response gave up without a result).
 */
const SERVER_LOOP_STEPS = 3

/**
 * Asks the judge whether a reply without tool calls may end the turn. Any
 * failure (network, timeout, an unreadable verdict) returns `null`, which keeps
 * the reply: the judge can only add a retry, never block an answer.
 */
async function askJudge(body, message, signal) {
  const model = judgeModel || body.model
  const timeout = AbortSignal.timeout(judgeTimeoutMs)
  try {
    const response = await upstreamChat(
      buildJudgeRequest(body, message, model),
      INFERENCE_PATH,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    )
    if (!response.ok) {
      await response.body?.cancel()
      warn(`  ~ judge: HTTP ${response.status}, keeping the reply`)
      return null
    }
    const collected = collectStream(response.body, { emulatedTools: true }, () => null)
    let step
    do step = await collected.next()
    while (!step.done)
    const verdict = parseJudgeVerdict(step.value.text)
    if (!verdict) warn(`  ~ judge: unreadable verdict ${preview(step.value.text, 80)}, keeping the reply`)
    return verdict
  } catch (error) {
    warn('  ~ judge failed, keeping the reply:', error.message)
    return null
  }
}

/**
 * Yields OpenAI chunks for one request.
 *
 * Reliability: an empty reply, prose instead of the envelope, an envelope that
 * cannot be read, a tool call the agent cannot execute, `status: continue`
 * without a tool call, and a turn the judge says ended too early all get another
 * upstream attempt (free on the web plan). `preferAnswer()` decides whether the
 * retry replaces the first answer, so a retry can never blank out a good reply.
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

  let state = yield* collectStream(upstreamBody, mapping, chunk, { stopServerLoop: mapping.emulatedTools })
  let message = null

  if (mapping.emulatedTools) {
    const available = [...mapping.toolNames]
    let attempt = 0
    const read = (text, collected) => {
      // every attempt, not only the one that is kept: discarded retries are where
      // the odd replies hide
      debugRaw(
        `${body.model} attempt ${++attempt} • ${collected.steps.size} venice step(s)` +
          `${collected.nativeTools.size ? ` • native calls ${[...collected.nativeTools].join(',')}` : ''}` +
          `${collected.serverLoop ? ' • stopped' : ''} • ${JSON.stringify(collected.events)}`,
        text,
      )
      if (collected.serverLoop) {
        log(`  ~ venice tool loop stopped after ${collected.steps.size} steps (native calls: ${[...collected.nativeTools].join(', ') || '?'})`)
        return serverLoopMessage()
      }
      const parsed = parseToolReply(text)
      for (const rename of inspectCalls(parsed, mapping.toolSchemas)) log(`  ~ tool name ${rename}`)
      return parsed
    }
    message = read(state.text, state)
    const last = [...(body.messages ?? [])].reverse().find((item) => item.role !== 'system' && item.role !== 'developer')
    let judged = 0
    let formatRetries = 0

    // Up to two extra attempts while the reply is unhelpful. Every trigger is
    // structural (see shouldRetry); a reply that ends the turn right after a tool
    // result is checked by the judge instead. The two budgets are separate: when
    // they were shared, two format retries used everything up and the answer the
    // last retry produced reached the user without the judge ever seeing it
    // (a made-up "the tools all returned Tool not found", 2026-11-05).
    for (;;) {
      let decision = shouldRetry({ message, lastRole: last?.role, available })
      if (decision.judge) {
        if (!judgeEnabled || judged >= 2) break
        judged++
        const verdict = await askJudge(body, message, signal)
        if (verdict) log(`  ~ judge: ${verdict.verdict}${verdict.reason ? ` (${preview(verdict.reason, 100)})` : ''}`)
        decision = judgeDecision(verdict?.verdict)
      }
      if (!decision.retry) break
      if (!decision.reason.startsWith('judge:') && formatRetries++ >= 2) break

      log(`  ~ ${decision.reason}, retrying...`)
      try {
        // the retry resends the same image parts, so their bytes go along again
        const retryResponse = await upstreamChat(withRetryReminder(mapping.request, decision.reminder), INFERENCE_PATH, signal, mapping.images)
        if (!retryResponse.ok) break
        // the last allowed retry runs to the end, so the turn always gets an answer
        const retryState = yield* collectStream(retryResponse.body, mapping, chunk, {
          stopServerLoop: formatRetries < 2,
        })
        const retryMessage = read(retryState.text, retryState)
        if (preferAnswer(retryMessage, message, { replaceAnswer: decision.replaceAnswer })) {
          state = retryState
          message = retryMessage
          log('  ~ retry improved the reply')
        } else {
          log('  ~ retry did not improve the reply, keeping the first')
          if (decision.reason.startsWith('judge:')) break
        }
      } catch (error) {
        warn('  ~ retry failed:', error.message)
        break
      }
    }

    // Never forward a blank assistant turn: it is invisible in the client.
    applyFallback(message, state.text)
  }

  if (!state.terminal) throw new Error('the Venice stream ended before response.completed')
  for (const buffered of state.chunks) yield buffered

  let finish = 'stop'
  let contentForUsage = state.answer

  if (mapping.emulatedTools) {
    contentForUsage = message.content ?? ''
    if (message.tool_calls) {
      finish = 'tool_calls'
      log(`  <- tools: ${message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 80)})`).join(' | ')}`)
      yield chunk({
        content: message.content || '',
        tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
      })
    } else {
      log(`  <- no tools${message.status ? ` • status ${message.status}` : ''} • text: ${preview(message.content ?? '', 110)}`)
      yield chunk({ content: message.content ?? '' })
    }
  }

  const prompt = countTokens(JSON.stringify(body.messages ?? []))
  const completion = countTokens(contentForUsage) + countTokens(state.reasoning)
  yield chunk({}, finish, {
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
}

/** A failed upstream image request, answered with `status`. */
class UpstreamImageError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Runs one agent image request and returns its images. */
async function imageRequest(label, body, files, requestedModel, signal) {
  let upstream
  try {
    upstream = await upstreamChat(body, AGENT_IMAGE_PATH, signal, files)
  } catch (error) {
    throw new UpstreamImageError(error instanceof SignInError || error.signIn ? 401 : 502, error.message)
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    throw new UpstreamImageError(upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 400)}`)
  }
  const collector = imageCollector()
  const reader = upstream.body.getReader()
  const stream = sseReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      for (const event of stream.feed(value, done)) collector.feed(event)
      if (done) break
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw new UpstreamImageError(502, `${label} failed: ${error.message}`)
  }
  const { images, text } = collector.result()
  if (!images.length) {
    throw new UpstreamImageError(502, `${label} failed: Venice returned no image${text.trim() ? ` (agent said: ${preview(text, 200)})` : ''}`)
  }
  for (const image of images) {
    if (image.model && image.model !== requestedModel) warn(`   ~ asked for ${requestedModel}, Venice used ${image.model}`)
    if (image.flags.is_blurred || image.flags.is_content_violation) warn(`   ~ Venice flagged an image: ${JSON.stringify(image.flags)}`)
  }
  return images
}

/**
 * Runs one agent call per image, in parallel, and answers the client. Several
 * images in one call come back identical, so `n` is `n` calls.
 */
async function answerImages(res, label, instructions, files, model, format) {
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  let batches
  try {
    batches = await Promise.all(instructions.map((text) => imageRequest(label, agentRequest(text, files), files, model, abort.signal)))
  } catch (error) {
    abort.abort()
    if (error instanceof UpstreamImageError) return openaiError(res, error.status, error.message)
    throw error
  }
  const images = batches.flat()
  log(`   <- ${images.length} image(s) • ${images.map((image) => `${image.width ?? '?'}x${image.height ?? '?'} ${image.data.length} B`).join(', ')}`)
  return json(res, 200, imagesResponse(images, format))
}

/** A JSON body, with a 400 instead of a 500 when it does not parse. */
function imageJson(raw) {
  try {
    return parseJsonText(raw.toString('utf8'))
  } catch {
    throw new ImageRequestError('the request body is not valid JSON')
  }
}

/** Runs one Studio image request (docs/PROTOCOL.md §5c) and returns its picture. */
async function studioRequest(body, signal) {
  let upstream
  try {
    upstream = await upstreamChat(body, STUDIO_IMAGE_PATH, signal)
  } catch (error) {
    throw new UpstreamImageError(error instanceof SignInError || error.signIn ? 401 : 502, error.message)
  }
  const meta = studioImageMeta(upstream.headers)
  const data = Buffer.from(await upstream.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (!upstream.ok || !String(upstream.headers.get('content-type') ?? '').startsWith('image/') || !data.length) {
    const text = data.toString('utf8')
    throw new UpstreamImageError(upstream.ok ? 502 : upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 400) || 'no image'}`)
  }
  if (meta.model && meta.model !== body.modelId) warn(`   ~ asked for ${body.modelId}, Venice used ${meta.model}`)
  if (meta.flags.is_blurred || meta.flags.is_content_violation) warn(`   ~ Venice flagged an image: ${JSON.stringify(meta.flags)}`)
  return { data, mimeType: meta.mimeType, width: body.width, height: body.height, model: meta.model, prompt: null, flags: meta.flags }
}

/** Generation on the Studio route: one request per picture, in parallel. */
async function answerStudioImages(res, prompt, model, n, body, format) {
  const options = parseStudioOptions(body, model, IMAGE_MODELS[model])
  const seeds = studioSeeds(n, options.seed)
  log(`-> image ${model} • n=${n} • ${options.width}x${options.height}${options.negativePrompt ? ' • negative' : ''} • seed ${seeds[0]} • ${preview(prompt, 80)}`)
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  let images
  try {
    images = await Promise.all(seeds.map((seed) => studioRequest(studioImageRequest({ prompt, model, options, seed }), abort.signal)))
  } catch (error) {
    abort.abort()
    if (error instanceof UpstreamImageError) return openaiError(res, error.status, error.message)
    throw error
  }
  log(`   <- ${images.length} image(s) • ${images.map((image) => `${image.width}x${image.height} ${image.data.length} B`).join(', ')}`)
  const answer = imagesResponse(images, format)
  answer.data.forEach((item, index) => {
    item.seed = seeds[index]
  })
  return json(res, 200, answer)
}

/** `POST /v1/images/generations` (OpenAI shape) on the free image models. */
async function handleImageGenerations(req, res) {
  const body = imageJson(await readRaw(req, MAX_IMAGE_BODY))
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new ImageRequestError('prompt is required')
  const model = pickImageModel(body.model, { route: imageRoute })
  const n = parseCount(body.n)
  const format = parseResponseFormat(body.response_format)
  if (imageRoute === 'studio') return answerStudioImages(res, body.prompt, model, n, body, format)
  const size = parseSize(body.size)
  log(`-> image ${model} • n=${n}${size ? ` • ${size.width}x${size.height}` : ''} • ${preview(body.prompt, 80)}`)
  const instructions = seedsFor(n).map((seed) => generationInstruction({ prompt: body.prompt, model, size, seed }))
  return answerImages(res, 'image generation', instructions, [], model, format)
}

/** The reference images of an edit request, from multipart files or JSON data URLs. */
async function editImages(values) {
  const images = []
  for (const value of values) {
    let image = null
    if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') {
      image = imageFromBytes(value.type, Buffer.from(await value.arrayBuffer()))
      if (!image) throw new ImageRequestError(`image must be PNG, JPEG, WebP or GIF, got ${value.type || 'an untyped file'}`)
    } else {
      const url = typeof value === 'string' ? value : (value?.image_url?.url ?? value?.image_url ?? value?.url)
      image = imageFromDataUrl(url)
      if (!image) {
        throw new ImageRequestError(
          typeof url === 'string' && /^https?:/i.test(url)
            ? 'image URLs are not fetched; send the image as a file or a base64 data URL'
            : 'image must be a file or a base64 data URL of a PNG, JPEG, WebP or GIF',
        )
      }
    }
    if (!images.some((known) => known.mediaId === image.mediaId)) images.push(image)
  }
  if (!images.length) throw new ImageRequestError('image is required')
  if (images.length > MAX_IMAGES) throw new ImageRequestError(`at most ${MAX_IMAGES} images per edit`)
  return images
}

/** `POST /v1/images/edits` (OpenAI shape, multipart or JSON) on the free edit models. */
async function handleImageEdits(req, res) {
  const raw = await readRaw(req, MAX_IMAGE_BODY)
  const type = String(req.headers['content-type'] ?? '')
  let fields
  let values
  if (type.toLowerCase().startsWith('multipart/form-data')) {
    let form
    try {
      form = await new Response(raw, { headers: { 'content-type': type } }).formData()
    } catch {
      throw new ImageRequestError('the multipart body could not be read')
    }
    fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'))
    values = [...form.getAll('image'), ...form.getAll('image[]')]
    if (form.has('mask')) throw new ImageRequestError('mask is not supported; describe the change in the prompt')
  } else {
    fields = imageJson(raw)
    values = [fields.image, fields.images].flat().filter((value) => value != null)
    if (fields.mask != null) throw new ImageRequestError('mask is not supported; describe the change in the prompt')
  }
  if (typeof fields.prompt !== 'string' || !fields.prompt.trim()) throw new ImageRequestError('prompt is required')
  const model = pickEditModel(fields.model)
  const n = parseCount(fields.n)
  const format = parseResponseFormat(fields.response_format)
  const images = await editImages(values)
  log(`-> edit ${model} • n=${n} • ${images.length} reference(s) • ${preview(fields.prompt, 80)}`)
  const instructions = seedsFor(n).map((seed) => editInstruction({ prompt: fields.prompt, model, seed }))
  return answerImages(res, 'image edit', instructions, images, model, format)
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
      const images = mapping.images.map(({ mediaId, mimeType, data }) => ({ mediaId, mimeType, bytes: data.length }))
      writeFileSync(dumpFile, JSON.stringify({ body, mapping: { ...mapping, images } }, null, 1))
    } catch {
      /* ignore */
    }
  }

  const names = [...mapping.toolNames]
  log(
    `-> ${body.model} • ${body.messages?.length ?? 0} msgs • ${names.length} tools${names.length ? ` [${names.join(',')}]` : ''}${mapping.images.length ? ` • ${mapping.images.length} image(s)` : ''} • stream=${body.stream !== false}`,
  )

  const abort = new AbortController()
  req.on('aborted', () => abort.abort())

  let upstream
  try {
    upstream = await upstreamChat(mapping.request, INFERENCE_PATH, abort.signal, mapping.images)
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

  // Emulated tool calls can stay silent for minutes while the reply is parsed
  // and retried; a comment line keeps the client from dropping the connection.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n')
  }, 15_000)
  const stopKeepalive = () => {
    clearInterval(keepalive)
    req.off('aborted', stopKeepalive)
  }
  req.on('aborted', stopKeepalive)

  try {
    for await (const part of chunks) res.write(`data: ${JSON.stringify(part)}\n\n`)
    res.write('data: [DONE]\n\n')
  } catch (error) {
    warn('stream error:', error.message)
    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
  } finally {
    stopKeepalive()
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

      if (req.method === 'POST' && url.pathname.endsWith('/images/generations')) {
        return await handleImageGenerations(req, res)
      }

      if (req.method === 'POST' && url.pathname.endsWith('/images/edits')) {
        return await handleImageEdits(req, res)
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
      if (error instanceof ImageRequestError) return openaiError(res, error.status ?? 400, error.message, 'invalid_request_error')
      warn('request error:', error.stack ?? error.message)
      if (!res.headersSent) openaiError(res, 500, error.message)
      else res.end()
    }
  }
}

export { host, port }
