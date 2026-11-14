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
import { apiBase, debug, dumpFile, host, judgeEnabled, judgeModel, judgeTimeoutMs, port, providerID } from './config.mjs'
import {
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

/** Venice agent tools the proxy runs itself instead of forwarding to the client. */
export const SERVER_TOOLS = new Set(['view_media', 'edit_image'])

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
const VIEW_MEDIA_ANSWER_REMINDER =
  'the image is already in the conversation. Do not call view_media again: answer the request now with what you saw.'

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
  let hydration = null
  for (let round = 0; state.hydration && round < 2; round++) {
    hydration = state.hydration
    const ids = hydration.media_ids?.length ? hydration.media_ids : mapping.mediaIds
    const files = mediaFiles(ids, mapping.images, mapping.mediaIds)
    // An id the client uploaded elsewhere arrives without bytes: take them from
    // the local cache so the hydration can still be answered.
    for (const id of ids) {
      if (files.some((file) => file.field === `media.${id}`)) continue
      const cached = await recallMedia(id)
      if (cached) files.push({ field: `media.${id}`, mimeType: cached.mimeType, data: cached.data })
    }
    if (!files.length) {
      warn(`  ~ hydration for ${JSON.stringify(ids)} has no bytes (id not uploaded here)`)
      break
    }
    const next = hydrationRequest(mapping.request, hydration, files)
    log(`  ~ image turn: hydrating ${JSON.stringify(ids)}`)
    const hydrated = await upstreamChat(next, INFERENCE_PATH, signal, files)
    if (!hydrated.ok) {
      warn(`  ~ hydration failed: HTTP ${hydrated.status}`)
      break
    }
    state = yield* collectStream(hydrated.body, mapping, chunk, { stopServerLoop: mapping.emulatedTools })
  }
  if (hydration) {
    log(`  ~ hydrated image ${JSON.stringify(hydration.media_ids ?? [])}${state.text ? '' : ' (no answer)'}`)
  }

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
      // `view_media` and `edit_image` are Venice's own agent tools, not the
      // client's: the model calls them on image turns and OpenCode rejects both
      // ("No tool named view_media"/"edit_image"). They are answered locally
      // instead of being handed to the client.
      if (parsed.tool_calls) {
        const kept = parsed.tool_calls.filter((call) => !SERVER_TOOLS.has(call.function?.name))
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
          if (parsed.tool_calls && (parsed.content ?? '').trim()) parsed.status = 'done'
        }
      }
      for (const rename of inspectCalls(parsed, mapping.toolSchemas)) log(`  ~ tool name ${rename}`)
      return parsed
    }
    message = read(state.text, state)
    const last = [...(body.messages ?? [])].reverse().find((item) => item.role !== 'system' && item.role !== 'developer')
    let judged = 0
    let viewRounds = 0

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
      if (message.serverCalls?.length) {
        const asked = message.serverCalls
        // Client calls still pending on this turn: they are handed to the client
        // after the server calls have run, so they are kept across the resend.
        const pendingClient = (message.tool_calls ?? []).filter((call) => !SERVER_TOOLS.has(call.function?.name))
        const asksEdit = asked.some((call) => call.function?.name === 'edit_image')
        // The budget is calls, not turns: the model often looks again after an
        // edit, and counting only lookups still ran out before it wrote anything.
        // A repeat of the same call must also not restart the count.
        viewRounds++
        const limit = asksEdit ? VIEW_MEDIA_ROUNDS + 2 : VIEW_MEDIA_ROUNDS + (edited ? 3 : 0)
        const ids = mapping.mediaIds.length ? mapping.mediaIds : [...(hydration?.media_ids ?? [])]
        let next = mapping.request
        lastRequest = next
        for (const call of asked) {
          const name = call.function?.name
          const callId = call.id ?? call.function?.id ?? `${name}_0`
          let output
          if (name === 'view_media') {
            output = ids.length ? `image(s) available as media_id: ${ids.join(', ')}` : 'the image is in the conversation'
          } else {
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
        // The server calls are done: the client calls that came with them are the
        // turn now, and the resent request carries their results so the model can
        // go on once the client has answered.
        if (pendingClient.length) {
          message.tool_calls = pendingClient
          message.serverCalls = null
        }
        // The edit already carries its result: its bytes are the answer, so the
        // turn ends here instead of being resent for prose. Resending re-runs the
        // model over the new image, which is where the blank replies came from.
        if (edited) {
          message.content ||= 'Listo, la imagen está editada.'
          log(`  ~ fin de vuelta: edited=${edited.mediaId} llamadas=0`)
          break
        }
        // At the bound ask with no tools at all: the model cannot start another
        // lookup, so the reply has to be the answer.
        const forceAnswer = viewRounds >= limit
        if (forceAnswer) {
          next = withRetryReminder({ ...next, tools: [] }, VIEW_MEDIA_ANSWER_REMINDER)
        }
        const viewResponse = await upstreamChat(next, INFERENCE_PATH, signal)
        if (!viewResponse.ok) break
        state = yield* collectStream(viewResponse.body, mapping, chunk, { stopServerLoop: true })
        message = read(state.text, state)
        // Even with no tools the model sometimes emits the call anyway; at the
        // bound it must not be answered again. The pending client calls are kept.
        if (forceAnswer && message.serverCalls?.length) {
          message.serverCalls = null
          message.tool_calls = pendingClient.length ? pendingClient : null
          message.content ||= ''
        }
        // The edit already ran: its bytes are the answer, so a further lookup
        // must not swallow the turn. This is the usual ending after edit_image.
        if (edited && message.serverCalls?.length) {
          message.serverCalls = null
          message.tool_calls = null
          message.content ||= 'Listo, la imagen está editada.'
        }
        // The edit already ran and its bytes are cached: whatever prose came
        // back, the turn has its result, so no retry may replace it with an
        // empty reply.
        log(`  ~ fin de vuelta: edited=${edited ? edited.mediaId : "no"} llamadas=${message.serverCalls?.length ?? 0}`)
        // The edit is the answer: end the turn here, before any retry path.
        if (edited) break
        continue
      }
      // The edit already ran and its bytes are cached: the turn has its result,
      // so nothing may retry it again.
      if (edited) break
      let decision = shouldRetry({ message, lastRole: last?.role, available })
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
        const retryResponse = await upstreamChat(withRetryReminder(retryBase, decision.reminder), INFERENCE_PATH, signal)
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
    // The envelope is scaffolding. A failed parse or prose before the JSON leaves
    // it in the visible text, where it enters the history and gets imitated.
    message.content = stripEnvelope(message.content ?? '')
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
    } else if (edited) {
      // The edit already ran here and its bytes are cached. The client has no
      // tool of its own for that, so the result is handed over as a `view_media`
      // call: OpenCode resolves the media id and renders the image. Without it
      // the turn ended as text only and the picture never arrived.
      //
      // Every tool call ends the turn for an OpenAI client, and a client that
      // does not know `view_media` sees an unknown tool. The envelope therefore
      // carries `status: done` and the prose the model wrote for the user, so
      // whoever runs the call (OpenCode, a plain bot) still has the answer even
      // if it cannot resolve the id.
      finish = 'tool_calls'
      const editedEnvelope = `{"content":${JSON.stringify(message.content || 'Listo, la imagen está editada.')},"status":"done","tool_calls":[{"name":"view_media","arguments":{"media_ids":[${JSON.stringify(edited.mediaId)}]}}]}`
      log(`  <- tools: view_media(${edited.mediaId}) (edit result)`)
      yield chunk({
        content: editedEnvelope,
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID().replaceAll('-', '')}`,
            type: 'function',
            function: { name: 'view_media', arguments: JSON.stringify({ media_ids: [edited.mediaId] }) },
          },
        ],
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
function hydrationRequest(request, hydration, files) {
  const items = {}
  for (const file of files) items[file.field.slice('media.'.length)] = { type: 'image', mime_type: file.mimeType }
  const messages = [
    ...request.messages,
    {
      id: randomUUID(),
      type: 'function_call',
      call_id: 'hydrate_content_0',
      name: 'hydrate_content',
      status: 'completed',
      arguments: JSON.stringify({
        media_ids: hydration.media_ids ?? [],
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
  return { ...request, messages }
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

/** Reads the `image` field of an edit request as a data URL. */
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
  const body = await readJson(req)
  if (!body.prompt || typeof body.prompt !== 'string') return openaiError(res, 400, 'prompt is required', 'invalid_request_error')
  let model
  try {
    model = checkEditModel(body.model)
  } catch (error) {
    return openaiError(res, 400, error.message, 'invalid_request_error')
  }
  let dataUrl
  try {
    dataUrl = readImageField(body.image)
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

async function handleChat(req, res) {
  const body = await readJson(req)
  const mapping = toVeniceRequest(body)

  // `edit_image` is a Venice agent tool the proxy runs itself. The model only
  // reaches for it when the turn carries an image, so it is announced as an
  // extra available tool instead of being left to guess.
  if (mapping.mediaIds === undefined) mapping.mediaIds = []

  // Venice only resolves an image by its own `media_id`, so every inline data
  // URL is uploaded first and the placeholder is replaced with the returned id.
  if (mapping.uploads.length) {
    try {
      mapping.mediaIds = []
      for (const upload of mapping.uploads) mapping.mediaIds.push(await upstreamMediaUpload(upload.url))
      applyMediaIds(mapping.request, mapping.mediaIds)
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
