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
import { Readable } from 'node:stream'
import { apiBase, debug, delegateTools, dumpFile, host, judgeEnabled, judgeModel, judgeTimeoutMs, port, providerID } from './config.mjs'
import {
  SERVER_TOOL_DEFS,
  applyFallback,
  withImageOutput,
  buildJudgeRequest,
  countTokens,
  inspectCalls,
  judgeDecision,
  parseJudgeVerdict,
  parseToolReply,
  preferAnswer,
  serverLoopMessage,
  shouldRetry,
  sseReader,
  applyMediaIds,
  toVeniceRequest,
  withRetryReminder,
  withToolResult,
} from './emulate.mjs'
import { MODELS } from './models.mjs'
import { debugRaw, log, preview, warn } from './log.mjs'
import { deepStripNulls, repairJsonControlChars } from './sanitize.mjs'
import { AGENT_IMAGE_PATH, INFERENCE_PATH, SignInError, hydratedImageBody, loadSession, recallMedia, rememberMedia, resetSessionCache, upstreamChat, upstreamImage, upstreamMediaUpload } from './venice.mjs'
import { IMAGE_SIZES, buildEditPrompt, buildPrompt, checkEditModel, checkModel, collectImage } from './image.mjs'

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
    hydration: null,

    events: {},
  }
  const itemTypes = new Map()

  const apply = (event) => {
    if (event.type === 'error' || event.type === 'response.failed') {
      // The reason rides inside the event and was being dropped: a bare
      // "Stream error" left no way to tell a rejected upload from a real failure.
      const motivo = event.message ?? event.error?.message ?? event.response?.error?.message
      const detalle = motivo ?? JSON.stringify(event).slice(0, 300)
      throw new Error(detalle ? `Venice generation failed: ${detalle}` : 'Venice generation failed')
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
    // Venice answers an image turn with `hydrate_content` instead of text: the
    // client must send the image back in multipart before the model can look at it.
    if (event.item?.type === 'function_call' && event.item.name === 'hydrate_content') {
      try {
        state.hydration = JSON.parse(event.item.arguments ?? '{}')
      } catch {
        state.hydration = null
      }
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
 * Venice agent tools the proxy runs itself instead of forwarding to the client.
 *
 * Derived from `SERVER_TOOL_DEFS` so the filter and the announcement cannot
 * drift apart: a name renamed in one place used to leave the other behind.
 */
export const SERVER_TOOLS = new Set(SERVER_TOOL_DEFS.map((tool) => tool.function.name))

/**
 * URL the bytes of a media id are served from (see `handleMedia`). Relative on
 * purpose: the client already knows the base it called, and an absolute one
 * would pin the port of this process.
 */
export const mediaUrl = (mediaId) => `/v1/media/${encodeURIComponent(mediaId)}`

/**
 * Runs one Venice server-tool call. Only `edit_image` does real work: the
 * reference is edited on the free edit model and the bytes are kept under a new
 * media id, which the model gets in its result.
 */
async function runServerTool(call, ids, signal) {
  const name = call.function?.name
  if (name !== 'edit_image') return { output: 'ok' }
  let args
  try {
    args = JSON.parse(call.function?.arguments ?? '{}')
  } catch {
    return { output: 'edit_image: arguments are not JSON' }
  }
  const instruction = String(args.prompt ?? args.instruction ?? '').trim()
  const target = args.media_id ?? args.media_ids?.[0] ?? ids[0]
  if (!target) return { output: 'edit_image: no media_id' }
  const cached = await recallMedia(target)
  if (!cached) return { output: `edit_image: no bytes for ${target}` }
  let model
  try {
    model = checkEditModel(args.model ?? args.resource_id ?? null)
  } catch (error) {
    return { output: `edit_image: ${error.message}` }
  }
  const prompt = buildEditPrompt(instruction || 'improve this image', model, args.size ?? null)
  log(`  ~ edit_image ${target} on ${model} • ${preview(instruction, 60)}`)
  try {
    const reference = await upstreamMediaUpload(`data:${cached.mimeType};base64,${cached.data.toString('base64')}`)
    const files = [{ field: `media.${reference}`, mimeType: cached.mimeType, data: cached.data }]
    const messages = [
      {
        id: randomUUID(),
        type: 'message',
        status: 'completed',
        role: 'user',
        content: [
          { type: 'input_image', media_id: reference, detail: 'auto' },
          { type: 'output_text', text: prompt, annotations: [] },
        ],
      },
      {
        id: randomUUID(),
        type: 'function_call',
        call_id: 'hydrate_content_0',
        name: 'hydrate_content',
        status: 'completed',
        arguments: JSON.stringify({ media_ids: [reference], current_iteration: 1 }),
      },
      {
        type: 'function_call_output',
        call_id: 'hydrate_content_0',
        output: JSON.stringify({ items: { [reference]: { type: 'image', mime_type: cached.mimeType } } }),
      },
    ]
    const upstream = await upstreamChat({ input: { messages }, clientTools: [] }, AGENT_IMAGE_PATH, signal, files)
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      return { output: `edit_image: upstream HTTP ${upstream.status}: ${text.slice(0, 200)}` }
    }
    const image = await collectImage(upstream.body)
    if (!image.hasBytes) return { output: 'edit_image: the agent returned no image' }
    log(`  ~ edited ${image.mediaId} • ${image.data.length} bytes`)
    const dataUrl = `data:${image.mimeType};base64,${image.data.toString('base64')}`
    return { output: `edited image available as media_id: ${image.mediaId}`, image: { ...image, dataUrl } }
  } catch (error) {
    return { output: `edit_image failed: ${error.message}` }
  }
}

/**
 * `view_media` rounds allowed before the model is told to answer. Two is enough
 * for a look and a second one at a detail; a model that keeps asking was
 * previously resent forever and the turn ended on `(empty reply)`.
 */
const VIEW_MEDIA_ROUNDS = 2

/**
 * Ids of a `hydrate_content` call. A real event carries `media_ids` as a JSON
 * string inside its arguments; a forced hydration is built by hand, so both
 * forms are read here instead of assuming one.
 */
function idsDeHidratacion(valor) {
  if (Array.isArray(valor)) return valor
  if (typeof valor !== 'string' || !valor.trim()) return []
  try {
    const leido = JSON.parse(valor)
    return Array.isArray(leido) ? leido : []
  } catch {
    return []
  }
}

const VIEW_MEDIA_ANSWER_REMINDER =
  'the image is already in the conversation. Do not call view_media again: answer the request now with what you saw.'
/** Shown when the turn asked for an edit and the model keeps looking instead. */
const EDIT_ANSWER_REMINDER =
  'the image is already in the conversation and you have seen it. Do not call view_media again: call edit_image now with the change the user asked for.'

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
  let edited = null
  let lastRequest = null

  // An image turn comes back as `hydrate_content`, not as an answer. The web
  // client answers it with `{ items: { <media_id>: { type: 'image', mime_type } } }`
  // and sends the bytes again in a multipart field named `media.<media_id>`.
  // Without that the model keeps asking for `view_media`.
  // A turn that carries an image must be hydrated before its text means
  // anything. The model sometimes answers "no veo la imagen" without asking
  // for `hydrate_content` first (measured: 5 of 8 identical vision turns), and
  // that text was delivered as the answer. When there is something to upload
  // and nothing was hydrated, the turn is hydrated anyway.
  // `media_ids` arrives already stringified in the arguments, so a forced
  // hydration must carry it the same way or the upstream parse fails with
  // `invalid type: string ..., expected a sequence` (HTTP 500).
  let hydration = state.hydration
  let soloMirada = false
  let filesDeHidratacion = []
  const idsDeTurno = mapping.mediaIds.length ? mapping.mediaIds : []
  if (!hydration && idsDeTurno.length) {
    hydration = { media_ids: idsDeTurno, forzada: true }
    // The step was answered blind: "no veo la imagen", a guess, or a bare
    // lookup. Its text is dropped so the hydrated step's answer is the turn's.
    state.text = ''
    log(`  ~ image turn answered without hydration: hydrating anyway`)
  }
  for (let round = 0; hydration && round < 2; round++) {
    state.hydration = hydration
    const pedidas = idsDeHidratacion(hydration.media_ids)
    const ids = pedidas.length ? pedidas : mapping.mediaIds
    const files = mediaFiles(ids, mapping.images, mapping.mediaIds)
    // An id the client uploaded elsewhere arrives without bytes: take them from
    // the local cache so the hydration can still be answered.
    for (const id of ids) {
      if (files.some((file) => file.field === `media.${id}`)) continue
      const cached = await recallMedia(id)
      if (cached) files.push({ field: `media.${id}`, mimeType: cached.mimeType, data: cached.data })
    }
    if (!files.length) {
      // The client keeps an attachment by id and sends the bytes on the next
      // turn, so the first one cannot be hydrated. `hydrate_content` asks for an
      // id the model never saw and answers about its absence; `[image: <id>]` is
      // what it actually has. Past the hydration the reference is noted as
      // "already in the conversation" and the model gets on with the turn.
      warn(`  ~ hydration for ${JSON.stringify(ids)} has no bytes (id not uploaded here)`)
      state.text = state.text ? `${state.text}\n\n[image: ${ids.join(', ')}]` : `[image: ${ids.join(', ')}]`
      break
    }
    filesDeHidratacion = files
    const next = hydrationRequest(mapping.request, hydration, files, { forzada: hydration.forzada })
    log(`  ~ image turn: hydrating ${JSON.stringify(ids)} forzada=${!!hydration.forzada}`)
    // `handleEdits` proves the agent endpoint accepts this exact shape; the
    // chat endpoint answers the forced hydration with a bare `stream_error`.
    const ruta = hydration.forzada ? AGENT_IMAGE_PATH : INFERENCE_PATH
    const hydrated = await upstreamChat(next, ruta, signal, files)
    if (!hydrated.ok) {
      const cuerpoError = await hydrated.text().catch(() => '')
      warn(`  ~ hydration failed: HTTP ${hydrated.status}: ${cuerpoError.slice(0, 200)}`)
      break
    }
    state = yield* collectStream(hydrated.body, mapping, chunk, { stopServerLoop: mapping.emulatedTools })
    log(`  ~ hydrated step: text=${JSON.stringify(state.text.slice(0, 160))} hydration=${state.hydration ? 'si' : 'no'} terminal=${state.terminal}`)
    // A step that only asks to look again is not an answer: it used to leave the
    // turn on `(empty reply)`. It is not resent here (the bytes were just handed
    // over, another hydration would loop); the answer reminder goes below.
    if (soloPideMirar(state.text)) {
      log('  ~ hydrated step only asked to look again')
      soloMirada = true
      break
    }
  }
  if (hydration) {
    log(`  ~ hydrated image ${JSON.stringify(hydration.media_ids ?? [])}${state.text ? '' : ' (no answer)'}`)
  }

  if (mapping.emulatedTools) {
    log(`  ~ depuracion: emulatedTools=${mapping.emulatedTools} hydration=${hydration ? 'si' : 'no'} texto=${JSON.stringify((state.text || '').slice(0, 80))}`)
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
      // `view_media` and `edit_image` are Venice's own agent tools, not the
      // client's: the model calls them on image turns and OpenCode rejects both
      // ("No tool named view_media"/"edit_image"). They are answered locally
      // instead of being handed to the client.
      // `hydrate_content` is the agent's own call too: the model sometimes
      // repeats it on the hydration step, and left as a client call it reached
      // OpenCode as an unknown tool and the turn closed blank.
      if (parsed.tool_calls) {
        const propias = (call) => SERVER_TOOLS.has(call.function?.name) || call.function?.name === 'hydrate_content'
        const kept = parsed.tool_calls.filter((call) => !propias(call))
        if (kept.length !== parsed.tool_calls.length) {
          const asked = parsed.tool_calls.filter((call) => SERVER_TOOLS.has(call.function?.name))
          log(`  ~ ${asked.map((call) => call.function.name).join(', ')} answered locally (${asked.length} call(s))`)
          // The client has no `view_media`/`edit_image` of its own. When only server
          // calls are left they are handled here and the turn is resent with their
          // results. When client calls remain, the server calls ride along as extra
          // `tool_calls` and are run on the way back, before the resend; dropping them
          // is what made an edit vanish whenever the model also called a client tool.
          parsed.serverCalls = asked
          parsed.tool_calls = kept.length ? [...kept, ...asked] : null
          // An envelope that also carries prose is not "empty" just because the
          // only calls left are server ones: `view_media` on its own used to be
          // retried as an empty reply and the retry, with no prose, replaced a
          // description that had already been written. The prose is the answer;
          // keep it and let the lookup ride along.
          // An edit asked here must still run: prose only makes the turn
          // "not empty", it does not make the picture.
          const editAsked = asked.some((call) => call.function?.name === 'edit_image')
          if (parsed.tool_calls && (parsed.content ?? '').trim() && !editAsked) parsed.status = 'done'
        }
      }
      for (const rename of inspectCalls(parsed, mapping.toolSchemas)) log(`  ~ tool name ${rename}`)
      return parsed
    }
    message = read(state.text, state)
    log(`  ~ recien leido: serverCalls=${JSON.stringify((message.serverCalls ?? []).map((c) => c.function?.name))} toolCalls=${JSON.stringify((message.tool_calls ?? []).map((c) => c.function?.name))} status=${message.status}`)
    const last = [...(body.messages ?? [])].reverse().find((item) => item.role !== 'system' && item.role !== 'developer')
    let judged = 0
    let viewRounds = 0
    // The turn itself asks for an edit ("cambia el fondo", "ponle..."): when it
    // does, a lookup is only a step towards it. Measured: on those turns the
    // model sometimes answers `view_media` five times in a row, the round budget
    // ran out and the turn closed as `(empty reply)` with nothing edited.
    const wantsEdit = /\b(edita|edit|editar|cambia|cambiar|modifica|modificar|ponle|añade|anade|quita|reemplaza|sustituye|transforma|retoca|replace|change|modify|add|remove|remove|turn (it|the image) into)\b/i.test(
      typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''),
    )

    let formatRetries = 0
    let noToolRetries = 0

    // Up to two extra attempts while the reply is unhelpful. Every trigger is
    // structural (see shouldRetry); a reply that ends the turn right after a tool
    // result is checked by the judge instead. The two budgets are separate: when
    // they were shared, two format retries used everything up and the answer the
    // last retry produced reached the user without the judge ever seeing it
    // (a made-up "the tools all returned Tool not found", 2026-11-05).
    for (;;) {
      // The model only asked for a Venice server tool: handle it and hand the
      // result back, which is what the web client gets from the agent. Bounded,
      // since the model can ask again; past the bound it is told to answer.
      log(`  ~ estado: serverCalls=${JSON.stringify((message.serverCalls ?? []).map((c) => c.function?.name))} toolCalls=${JSON.stringify((message.tool_calls ?? []).map((c) => c.function?.name))} status=${message.status} contenido=${JSON.stringify((message.content ?? '').slice(0, 40))}`)
      if (message.serverCalls?.length) {
        const asked = message.serverCalls
        // An edit asked in this envelope is the answer in the making: a `continue`
        // status with no prose must not be read as an empty reply and retried
        // before the call runs (measured: the retry asked to look again and the
        // edit was lost).
        if (asked.some((call) => call.function?.name === 'edit_image')) message.status = 'continue'
        // Client calls still pending on this turn: they are handed to the client
        // after the server calls have run, so they are kept across the resend.
        const pendingClient = (message.tool_calls ?? []).filter((call) => !SERVER_TOOLS.has(call.function?.name))
        const asksEdit = asked.some((call) => call.function?.name === 'edit_image')
        // The budget is calls, not turns: the model often looks again after an
        // edit, and counting only lookups still ran out before it wrote anything.
        // A repeat of the same call must also not restart the count.
        // Past the bound the turn is resent with `tools: []`. That only means
        // "no tools" when tools were emulated: without them the request goes to
        // Venice as is and its own agent tools stay on, the model asks again and
        // the turn closed as `(empty reply)`.
        const toolsBound = mapping.emulatedTools
        viewRounds++
        const limit = asksEdit ? VIEW_MEDIA_ROUNDS + 2 : VIEW_MEDIA_ROUNDS + (edited ? 3 : 0)
        const ids = mapping.mediaIds.length ? mapping.mediaIds : [...(hydration?.media_ids ?? [])]
        let next = mapping.request
        lastRequest = next
        // The edit goes first when both kinds ride in the same envelope: a lookup
        // before it adds nothing (the model already has the image) and an edit
        // left for later was the one lost to the empty-reply path.
        const ordered = [...asked].sort((a, b) => Number(b.function?.name === 'edit_image') - Number(a.function?.name === 'edit_image'))
        for (const call of ordered) {
          const name = call.function?.name
          const callId = call.id ?? call.function?.id ?? `${name}_0`
          let output
          if (name === 'view_media') {
            output = ids.length ? `image(s) available as media_id: ${ids.join(', ')}` : 'the image is in the conversation'
          } else {
            log(`  ~ edit_image args ${String(call.function?.arguments ?? '').slice(0, 200)} • ids ${JSON.stringify(ids)}`)
            const result = await runServerTool(call, ids, signal)
            output = result.output
            log(`  ~ edit_image -> ${String(output).slice(0, 120)}`)
            // An edit returns bytes: keep them and tell the model the new id.
            if (result.image) {
              edited = result.image
              await rememberMedia(result.image.mediaId, result.image.mimeType, result.image.data)
              next = withImageOutput(next, result.image, result.image.mediaId)
              lastRequest = next
            }
          }
          next = withToolResult(next, callId, name, output)
        }
        // The edit is done and its bytes are cached: the turn is finished, so it
        // leaves here instead of looping again. A second pass resent the turn,
        // the model answered with another edit lookup and the retry path closed
        // the turn as `(empty reply)`.
        //
        // A turn that asked for an edit always runs it, even when a `view_media`
        // came first in the same envelope: the loop above only executes the list
        // it was given, so a lost edit left the turn with the lookup's prose and
        // nothing else.
        if (edited) {
          message.tool_calls = null
          message.serverCalls = null
          message.status = 'done'
          // `sawEnvelope` keeps `shouldRetry` from calling this an empty reply:
          // the prose is optional here, the bytes are the answer.
          message.sawEnvelope = true
          message.content ||= 'Listo, la imagen está editada.'
          log(`  ~ fin de vuelta: edited=${edited.mediaId}`)
          break
        }
        // The server calls are done: the client calls that came with them are the
        // turn now, and the resent request carries their results so the model can
        // go on once the client has answered.
        // They are kept for the rest of the loop: a `view_media` answered after
        // them used to wipe the list, and the turn closed with "no veo la imagen"
        // prose and the client's call lost.
        if (pendingClient.length) {
          message.tool_calls = pendingClient
          message.serverCalls = null
        } else if (message.tool_calls?.length) {
          message.tool_calls = null
        }
        // The server side is done with this turn: `shouldRetry` must not read the
        // leftover `continue` status as a pending step (it retried a lone
        // `view_media` as an empty reply and dropped the prose).
        message.serverCallsRan = true
        // The edit already carries its result: its bytes are the answer, so the
        // turn ends here instead of being resent for prose. Resending re-runs the
        // model over the new image, which is where the blank replies came from.
        // The calls are cleared so nothing downstream treats the turn as pending.
        if (edited) {
          message.tool_calls = null
          message.serverCalls = null
          message.status = 'done'
          message.content ||= 'Listo, la imagen está editada.'
          log(`  ~ fin de vuelta: edited=${edited.mediaId} llamadas=0`)
          break
        }
        // A lookup is not an answer: the turn would reach the client as a call to
        // a tool the client does not have, with no text at all. It is resent at
        // once so the model closes with prose, and the call is not handed on.
        message.tool_calls = null
        message.serverCalls = null
        // At the bound ask with no tools at all: the model cannot start another
        // lookup, so the reply has to be the answer.
        const forceAnswer = toolsBound && viewRounds >= limit
        // A lookup is never the answer, not even when the model wrote "voy a
        // verla" first: it was left as the whole turn (the image was never
        // looked at, and an edit asked in the same breath was lost). With prose
        // it is still resent once, to let the model go on from what it saw.
        // Past the bound there is nothing left to answer, so the prose stays.
        if ((message.content ?? '').trim() && forceAnswer) {
          // The lookup was answered: what is left is the prose, so the turn ends
          // here and no retry may replace it (a stale `continue` status used to
          // do exactly that).
          message.serverCallsRan = true
          break
        }
        // A lookup on an edit turn is not the end either: the reminder asks for
        // the `edit_image` the user wanted, not for prose about the picture.
        if (forceAnswer) {
          next = withRetryReminder({ ...next, tools: [] }, wantsEdit ? EDIT_ANSWER_REMINDER : VIEW_MEDIA_ANSWER_REMINDER)
        }
        const viewResponse = await upstreamChat(next, INFERENCE_PATH, signal)
        if (!viewResponse.ok) break
        state = yield* collectStream(viewResponse.body, mapping, chunk, { stopServerLoop: true })
        message = read(state.text, state)
        // Even with no tools the model sometimes emits the call anyway; at the
        // bound it must not be answered again. The pending client calls are kept.
        // An `edit_image` is the exception: the bound is about lookups, and the
        // edit the turn was asked for must still run. It is put back as the only
        // pending server call and the loop above executes it.
        if (message.serverCalls?.length) {
          const edits = message.serverCalls.filter((call) => call.function?.name === 'edit_image')
          const looked = message.serverCalls.filter((call) => call.function?.name !== 'edit_image')
          if (forceAnswer || !edits.length) {
            message.serverCalls = edits.length ? edits : null
            message.tool_calls = edits.length ? null : (pendingClient.length ? pendingClient : null)
            message.content ||= ''
          }
        }
        // Whatever the resend said, an edit already has its bytes: they are the
        // answer, so the turn closes here and no retry may replace it.
        if (edited) {
          message.serverCalls = null
          message.tool_calls = null
          message.content ||= 'Listo, la imagen está editada.'
          log(`  ~ fin de vuelta: edited=${edited.mediaId} llamadas=0`)
          break
        }
        continue
      }
      // The edit already ran and its bytes are cached: the turn has its result,
      // so nothing may retry it again.
      if (edited) break
      let decision = shouldRetry({ message, lastRole: last?.role, available })
      // The hydration step only asked to look again: the bytes are already in the
      // turn, so it is resent with the answer reminder instead of ending blank.
      if (soloMirada) {
        soloMirada = false
        decision = { retry: true, reason: 'asked to look again after hydrating', reminder: VIEW_MEDIA_ANSWER_REMINDER }
        // One extra chance for this case: the generic retry budget was spent by
        // earlier attempts and the turn closed blank with the image on screen.
        formatRetries = Math.min(formatRetries, 1)
      }
      if (decision.judge) {
        if (!judgeEnabled || judged >= 2) break
        judged++
        const verdict = await askJudge(body, message, signal)
        if (verdict) log(`  ~ judge: ${verdict.verdict}${verdict.reason ? ` (${preview(verdict.reason, 100)})` : ''}`)
        decision = judgeDecision(verdict?.verdict)
      }
      // The edit already ran and its bytes are cached: a retry would re-run the
      // edit on a stale request and the turn would lose its result.
      if (edited) break
      if (!decision.retry) break
      // A well-formed envelope with a real answer still gets one retry, in case
      // the model described a tool it never called. The second one never improved
      // anything and cost a full extra request per turn.
      if (decision.reason === 'envelope without tool calls' && noToolRetries++ >= 1) break
      if (!decision.reason.startsWith('judge:') && formatRetries++ >= 2) break

      log(`  ~ ${decision.reason}, retrying...`)
      // Once an edit exists the retry starts from the request that already holds
      // the edited image and the result, not from the original turn.
      const retryBase = edited ? lastRequest : mapping.request
      try {
        // A turn that already carries the image keeps its bytes: the retry is
        // resent as multipart, otherwise Venice sees a `media_id` with nothing
        // attached and the model answers "no veo la imagen" again.
        const archivosReintento = hydration ? filesDeHidratacion : []
        const retryResponse = await upstreamChat(withRetryReminder(retryBase, decision.reminder), INFERENCE_PATH, signal, archivosReintento)
        if (!retryResponse.ok) break
        // the last allowed retry runs to the end, so the turn always gets an answer
        const retryState = yield* collectStream(retryResponse.body, mapping, chunk, {
          stopServerLoop: formatRetries < 2,
        })
        const retryMessage = read(retryState.text, retryState)
        // A retry that asks for the edit again is not a better *answer*: the
        // fields compared here do not count server calls, so the edit was
        // discarded as "no improvement" and the turn closed blank. An edit asked
        // on the retry is executed by the loop instead.
        if (retryMessage.serverCalls?.some((call) => call.function?.name === 'edit_image')) {
          state = retryState
          message = retryMessage
          log('  ~ retry asked for the edit, running it')
          continue
        }
        // A retry that announces another lookup is still not an answer: it is
        // marked so the loop asks once more instead of keeping the announcement.
        if (retryMessage.serverCalls?.length) {
          state = retryState
          message = retryMessage
          log('  ~ retry asked to look again, running it')
          continue
        }
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

    // Never forward a blank assistant turn: it is invisible in the client. An
    // edit is the exception: its bytes are the answer, so the `(empty reply)`
    // marker must not stand in for them.
    if (!edited) applyFallback(message, state.text)
    // The envelope is scaffolding. A failed parse or prose before the JSON leaves
    // it in the visible text, where it enters the history and gets imitated.
    message.content = stripEnvelope(message.content ?? '')
  }

  if (!state.terminal) throw new Error('the Venice stream ended before response.completed')

  // An image turn is answered by `hydrate_content` first: the bytes are handed
  // back and the model goes on in the same request. The text of that first step
  // is the hydration call itself, so it is only forwarded once hydration is done
  // and the client is about to get the final answer.
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
    } else if (edited) {
      // The edit already ran here and its bytes are cached. The client has no
      // tool of its own for that and `view_media` is a server tool, so the call
      // is NOT handed over: the picture goes out as a markdown image of the
      // local media route, which any OpenAI client renders, and the turn keeps
      // `finish_reason: stop`.
      const url = mediaUrl(edited.mediaId)
      const prose = message.content || 'Listo, la imagen está editada.'
      log(`  <- edited image ${edited.mediaId} as ${url}`)
      yield chunk({ content: `${prose}\n\n![imagen editada](${url})` })
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

/**
 * The images to hand back for `ids`, as `{ field, mimeType, data }` where `field`
 * is the multipart field name the web client uses (`media.<media_id>`).
 *
 * `mediaIds` maps the data URLs of the turn onto the ids Venice actually sent, so
 * the order is the order of `ids`; the first image is reused when Venice asks for
 * fewer ids than there are images.
 */
function mediaFiles(ids, images, mediaIds = []) {
  return ids
    .map((id) => {
      const index = mediaIds.indexOf(id)
      const url = images[index >= 0 ? index : 0]
      const match = /^data:([^;,]+)[^,]*,(.*)$/s.exec(url ?? '')
      if (!match) return null
      return { field: `media.${id}`, mimeType: match[1], data: Buffer.from(match[2], 'base64') }
    })
    .filter(Boolean)
}

/**
 * The request with the hydration answered: `hydrate_content` gets its item map
 * and the pending calls their outputs.
 *
 * Venice sends `{ media_ids, pending_tool_calls, signature, current_iteration }`
 * and expects the pending calls back before it continues.
 */
function conMediaIds(messages, files) {
  // The turn's image parts are replaced by `input_image` + the uploaded id, the
  // shape the web client sends and `handleEdits` proves the upstream accepts.
  // The text parts stay in place, in order.
  const ids = files.map((file) => file.field.slice('media.'.length))
  let siguiente = 0
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    // `input_image` goes first, then the text: the order `handleEdits` uses and
    // the one the upstream accepts on a hydration.
    const imagenes = []
    const textos = []
    for (const part of message.content) {
      if (!part) continue
      const esImagen = part.type === 'image_url' || part.type === 'input_image' || part.type === 'image'
      if (!esImagen) {
        textos.push(part)
        continue
      }
      const id = ids[siguiente]
      siguiente++
      if (id) imagenes.push({ type: 'input_image', media_id: id, detail: part.detail ?? 'auto' })
    }
    const content = [...imagenes, ...textos]
    // The client leaves a bare `[image]` marker in the text for an inline image;
    // the `input_image` part replaces it.
    for (const part of content) {
      if (part?.type === 'output_text' && part.text) part.text = part.text.replace(/\n?\[image\]/g, '')
    }
    return { ...message, content }
  })
}

function hydrationRequest(request, hydration, files, { forzada = false } = {}) {
  const items = {}
  for (const file of files) items[file.field.slice('media.'.length)] = { type: 'image', mime_type: file.mimeType }
  // The agent endpoint (`AGENT_IMAGE_PATH`, used for a forced hydration) wraps
  // the messages in `input`; the chat endpoint carries them at the top level.
  const base = forzada ? (request.input?.messages ?? request.messages) : request.messages
  const messages = [
    ...(forzada ? conMediaIds(base, files) : base),
    {
      id: randomUUID(),
      type: 'function_call',
      call_id: 'hydrate_content_0',
      name: 'hydrate_content',
      status: 'completed',
      arguments: JSON.stringify({
        // On the agent endpoint the ids go as an array (that is the shape
        // `handleEdits` sends and the one it accepts); the real chat event has
        // them already stringified inside its arguments, so they are passed on
        // untouched there.
        media_ids: hydration.forzada ? idsDeHidratacion(hydration.media_ids) : hydration.media_ids,
        signature: hydration.signature,
        pending_tool_calls: hydration.pending_tool_calls,
        current_iteration: hydration.current_iteration ?? 1,
      }),
    },
    { type: 'function_call_output', call_id: 'hydrate_content_0', output: JSON.stringify({ items }) },
  ]
  for (const call of hydration.pending_tool_calls ?? []) {
    messages.push({ type: 'function_call_output', call_id: call.id, output: 'ok' })
  }
  // The agent endpoint takes the messages inside `input`; the chat endpoint at
  // the top level. The forced hydration goes to the agent endpoint.
  if (!forzada) return { ...request, messages }
  const { messages: _descartadas, ...resto } = request
  return { ...resto, input: { ...(request.input ?? {}), messages } }
}

/**
 * True when a step's text is nothing but a `view_media` call (no prose): the
 * model asks to see the picture again instead of answering. Answered steps are
 * resent with `VIEW_MEDIA_ANSWER_REMINDER`; a hydration step is not, since the
 * bytes were just handed over and hydrating again would loop.
 */
function soloPideMirar(texto) {
  if (!texto || !texto.trim()) return false
  // The step may come wrapped in a ```json fence, so it is parsed by the same
  // reader the rest of the proxy uses instead of a bare JSON.parse.
  const leido = parseToolReply(texto)
  if (!leido.tool_calls?.length) return false
  if ((leido.content ?? '').trim()) return false
  // `hydrate_content` counts too: the model repeats it after the bytes were
  // already handed over, and left alone the turn closed blank.
  return leido.tool_calls.every((call) => ['view_media', 'hydrate_content'].includes(call?.function?.name))
}

function looksLikeEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if ('tool_calls' in value) return true
  return 'status' in value && 'content' in value
}

// Only the tail is inspected: leaked envelopes always come last, and a JSON the
// assistant is deliberately showing mid-answer stays untouched.
function stripEnvelope(text) {
  if (!text) return text
  const trimmed = text.trimEnd()

  const fenced = trimmed.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```$/)
  if (fenced) {
    try {
      if (looksLikeEnvelope(JSON.parse(fenced[1].trim()))) {
        const kept = trimmed.slice(0, fenced.index).trim()
        if (kept) return kept
      }
    } catch {}
  }

  const bare = trimmed.match(/(?:^|\n)(\{[\s\S]*\})$/)
  if (bare) {
    try {
      if (looksLikeEnvelope(JSON.parse(bare[1].trim()))) {
        const kept = trimmed.slice(0, bare.index).trim()
        if (kept) return kept
      }
    } catch {}
  }

  return trimmed
}

/**
 * OpenAI image route: `POST /v1/images/generations`. The picture is generated on
 * the agent endpoint and answered as a base64 `b64_json` (plus a `url` when the
 * caller asks for one, pointing at the copy cached under the media directory).
 */
async function handleImages(req, res) {
  const body = await readJson(req)
  if (!body.prompt || typeof body.prompt !== 'string') return openaiError(res, 400, 'prompt is required', 'invalid_request_error')
  let model
  try {
    model = checkModel(body.model)
  } catch (error) {
    return openaiError(res, 400, error.message, 'invalid_request_error')
  }
  if (body.size && !IMAGE_SIZES[body.size]) {
    return openaiError(res, 400, `unknown size: ${body.size}. Known: ${Object.keys(IMAGE_SIZES).join(', ')}`, 'invalid_request_error')
  }
  const count = Math.min(Math.max(Number(body.n) || 1, 1), 4)
  const prompt = buildPrompt(body.prompt, model, body.size)
  log(`-> image ${model} • n=${count}${body.size ? ` • ${body.size}` : ''} • ${preview(body.prompt, 90)}`)

  const abort = new AbortController()
  req.on('aborted', () => abort.abort())
  const created = Math.floor(Date.now() / 1000)
  const data = []
  try {
    for (let index = 0; index < count; index++) {
      const upstream = await upstreamImage(prompt, abort.signal)
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '')
        return openaiError(res, upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 300)}`)
      }
      const image = await collectImage(upstream.body)
      // Keep the bytes locally: the media id alone cannot be downloaded again.
      await rememberMedia(image.mediaId, image.mimeType, image.data)
      log(`   ~ image ${index + 1}/${count} • ${image.mediaId} • ${image.request?.resource_id ?? model} • ${image.data.length} bytes`)
      const item = { b64_json: image.data.toString('base64') }
      if (body.response_format === 'url') item.url = `data:${image.mimeType};base64,${item.b64_json}`
      data.push(item)
    }
  } catch (error) {
    return openaiError(res, 502, `image generation failed: ${error.message}`)
  }
  return json(res, 200, { created, data })
}

/**
 * Reads an edit request body whatever shape the client sent it in: JSON, a plain
 * form (what `curl -d` sends), or multipart (`curl -F`, `FormData`). The route
 * used `readJson` alone, so every non-JSON body died in the parser.
 */
async function readFormOrJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  if (debug) log(`  ~ cuerpo edicion: ${raw.length} bytes, tipo ${String(req.headers['content-type'] ?? '')}`)
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  if (type.includes('multipart/form-data')) {
    const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData()
    const body = {}
    for (const [key, value] of form.entries()) body[key] = value
    return body
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
  // The stream is already drained above, so `readJson(req)` read zero chunks and
  // every JSON edit body died as "prompt is required". It is parsed from `raw`.
  if (!raw.length) return {}
  return readJson(Readable.from([raw]))
}

/** Reads the `image` field of an edit request as a data URL. */
async function fileAsDataUrl(file) {
  const mimeType = file.type || 'image/png'
  return `data:${mimeType};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`
}

function readImageField(value) {
  const url = typeof value === 'string' ? value : (value?.url ?? (typeof value?.b64_json === 'string' ? `data:image/png;base64,${value.b64_json}` : null))
  if (!url) throw new Error('image is required, as a data URL (or a { b64_json } object)')
  if (!/^data:[^;,]+[^,]*;base64,/i.test(url)) throw new Error('image must be a base64 data URL; https URLs are not fetched')
  return url
}

/**
 * OpenAI edit route: `POST /v1/images/edits`. The reference is uploaded to the
 * web media endpoint, handed to the agent as an `input_image` part, and the
 * agent's `hydrate_content` is answered with the bytes before it calls its own
 * `edit_image` tool. Generate models are rejected: only the edit list works here.
 */
async function handleEdits(req, res) {
  const body = await readFormOrJson(req)
  if (!body.prompt || typeof body.prompt !== 'string') return openaiError(res, 400, 'prompt is required', 'invalid_request_error')
  let model
  try {
    model = checkEditModel(body.model)
  } catch (error) {
    return openaiError(res, 400, error.message, 'invalid_request_error')
  }
  let dataUrl
  try {
    // A multipart upload arrives as a file part, so it is read as bytes first.
    dataUrl = readImageField(typeof body.image === 'object' && typeof body.image?.arrayBuffer === 'function' ? await fileAsDataUrl(body.image) : body.image)
  } catch (error) {
    return openaiError(res, 400, error.message, 'invalid_request_error')
  }
  if (body.size && !IMAGE_SIZES[body.size]) {
    return openaiError(res, 400, `unknown size: ${body.size}. Known: ${Object.keys(IMAGE_SIZES).join(', ')}`, 'invalid_request_error')
  }
  const mimeType = /^data:([^;,]+)/i.exec(dataUrl)[1]
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  const prompt = buildEditPrompt(body.prompt, model, body.size)
  log(`-> edit ${model} • ${mimeType} ${bytes.length} bytes • ${preview(body.prompt, 90)}`)

  const abort = new AbortController()
  req.on('aborted', () => abort.abort())
  try {
    const reference = await upstreamMediaUpload(dataUrl)
    log(`   ~ reference ${reference}`)
    const files = [{ field: `media.${reference}`, mimeType, data: bytes }]
    // One turn: the hydration is pre-answered so the agent does not have to ask
    // for it, which saves a whole round trip (and the ~25k tokens it costs).
    const messages = [
      {
        id: randomUUID(),
        type: 'message',
        status: 'completed',
        role: 'user',
        content: [
          { type: 'input_image', media_id: reference, detail: 'auto' },
          { type: 'output_text', text: prompt, annotations: [] },
        ],
      },
      {
        id: randomUUID(),
        type: 'function_call',
        call_id: 'hydrate_content_0',
        name: 'hydrate_content',
        status: 'completed',
        arguments: JSON.stringify({ media_ids: [reference], current_iteration: 1 }),
      },
      {
        type: 'function_call_output',
        call_id: 'hydrate_content_0',
        output: JSON.stringify({ items: { [reference]: { type: 'image', mime_type: mimeType } } }),
      },
    ]
    let upstream = await upstreamChat({ input: { messages }, clientTools: [] }, AGENT_IMAGE_PATH, abort.signal, files)
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      return openaiError(res, upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 300)}`)
    }
    let image = await collectImage(upstream.body)

    // The agent still asks for the hydration now and then: answer it once more
    // with the same shape rather than failing the request.
    if (!image.hasBytes && image.hydration) {
      log(`  ~ edit: hydrating again ${JSON.stringify(image.hydration.media_ids ?? [reference])}`)
      const items = { [reference]: { type: 'image', mime_type: mimeType } }
      const next = hydratedImageBody({ input: { messages } }, image.hydration, items)
      upstream = await upstreamChat(next, AGENT_IMAGE_PATH, abort.signal, files)
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '')
        return openaiError(res, upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 300)}`)
      }
      image = await collectImage(upstream.body)
    }
    if (!image.hasBytes) return openaiError(res, 502, 'the agent returned no image')

    await rememberMedia(image.mediaId, image.mimeType, image.data)
    log(`   ~ edit ${image.mediaId} • ${image.request?.resource_id ?? model} • ${image.data.length} bytes`)
    const item = { b64_json: image.data.toString('base64') }
    if (body.response_format === 'url') item.url = `data:${image.mimeType};base64,${item.b64_json}`
    return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [item] })
  } catch (error) {
    return openaiError(res, 502, `image edit failed: ${error.message}`)
  }
}

/**
 * Serves the bytes of a media id. The chat turn hands an edited image over as
 * this URL instead of a `view_media` call, which the client has no tool for.
 * Only ids this process cached are served, so the path cannot walk anywhere.
 */
async function handleMedia(mediaId, res) {
  const cached = await recallMedia(mediaId)
  if (!cached) return openaiError(res, 404, `no media ${mediaId}`, 'not_found')
  res.writeHead(200, {
    'content-type': cached.mimeType,
    'content-length': cached.data.length,
    'cache-control': 'private, max-age=3600',
  })
  res.end(cached.data)
}

/**
 * Whether the newest user turn carries an image part (data URL, remote URL or a
 * bare `media_id`). Only that turn decides it: the model must not be offered the
 * server tools on turns that merely talk about an image.
 */
function carriesImage(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = [...messages].reverse().find((message) => message?.role === 'user')
  if (!Array.isArray(last?.content)) return false
  return last.content.some((part) => {
    if (!part) return false
    if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return true
    if (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url) return true
    return typeof part.media_id === 'string' && part.media_id.length > 0
  })
}

async function handleChat(req, res) {
  const body = await readJson(req)
  // A turn with an image gets `view_media`/`edit_image` announced by the proxy
  // and answered here, so the client's own copies are left out (see
  // `skipServer`). They are only known after the request is built.
  //
  // The test is a real image part in the newest user turn, not the substring
  // "image" anywhere in the history: once the agent had written the word, every
  // later turn counted as an image turn, its own tools were stripped (leaving
  // only `view_media`/`edit_image`) and the model looped on lookups until the
  // turn closed as `(empty reply)`.
  const mapping = toVeniceRequest(body, { skipServer: carriesImage(body), delegate: delegateTools })

  // Venice only resolves an image by its own `media_id`, so every inline data
  // URL is uploaded first and the placeholder is replaced with the returned id.
  // (The hydration turn is answered from the bytes in the request itself; the
  // cache below covers a later turn that only carries the id.)
  mapping.mediaIds = []
  if (mapping.uploads.length) {
    try {
      for (const upload of mapping.uploads) mapping.mediaIds.push(await upstreamMediaUpload(upload.url))
      applyMediaIds(mapping.request, mapping.mediaIds)
      // The cache keeps the bytes under the upstream id, so a later turn that
      // only carries the id can hydrate it again (see `recallMedia`).
      for (const [index, upload] of mapping.uploads.entries()) {
        const match = /^data:([^;,]+)[^,]*,(.*)$/s.exec(upload.url ?? '')
        if (match && mapping.mediaIds[index]) {
          await rememberMedia(mapping.mediaIds[index], match[1], Buffer.from(match[2], 'base64'))
        }
      }
      log(`   ~ uploaded ${mapping.mediaIds.length} image(s)`)
    } catch (error) {
      warn(`   ~ image upload failed: ${error.message}`)
      return openaiError(res, 502, `image upload failed: ${error.message}`)
    }
  }

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

  // `handleChat` recibe el cuerpo ya subido: las imagenes viajan como
  // `media_id` de Venice y sus bytes quedan en la cache para hidratar.
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

      if (req.method === 'GET' && url.pathname.startsWith('/v1/media/')) {
        return await handleMedia(decodeURIComponent(url.pathname.slice('/v1/media/'.length)), res)
      }

      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        return await handleChat(req, res)
      }

      if (req.method === 'POST' && url.pathname.endsWith('/images/generations')) {
        return await handleImages(req, res)
      }

      if (req.method === 'POST' && url.pathname.endsWith('/images/edits')) {
        return await handleEdits(req, res)
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
