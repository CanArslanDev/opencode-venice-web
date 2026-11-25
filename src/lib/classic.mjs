/**
 * The classic chat route (`POST /api/inference/chat`), the one venice.ai's
 * ordinary chat uses. Pure: request building and stream reading only.
 *
 * Why it exists: the agent route (`/agents/ad-hoc`) runs only three of the free
 * models. For every other model id it answers with DeepSeek V4.1 Flash
 * Uncensored and says so only in the finished message item's `model_id`
 * (measured 2026-11-25, 24 of 27 models; docs/PROTOCOL.md §2d). The classic
 * route serves the model that was asked for and names it (`servingModelId`).
 *
 * The proxy keeps building the agent-shaped request (`toVeniceRequest()`): tool
 * emulation, reminders and attachment placement are text and work on both
 * routes, and retries append to it. `toClassicRequest()` converts that request
 * at send time.
 */
import { randomUUID } from 'node:crypto'

export const CLASSIC_PATH = '/api/inference/chat'

/** The route's own limit for `temperature` (it answers 400 above 2). */
const MAX_TEMPERATURE = 2

/** Document types whose bytes are already the text (decoded locally, no extraction call). */
export function isTextDocument(mimeType) {
  const type = String(mimeType ?? '').toLowerCase()
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml'
}

/** UTF-8 text of a text document, without a byte order mark. */
export function decodeTextDocument(data) {
  return Buffer.from(data).toString('utf8').replace(/^﻿/, '')
}

/**
 * How a document reaches the model on the classic route: a message of its own,
 * flagged `isFile`, that says the text is the attachment. The wording and the
 * place were measured (Qwen 3.5 35B, 4 runs each): the bare file name and text
 * before the question 1/4, this note after the question 4/4; with less, the
 * model answers that it "cannot access attached files".
 */
export function documentMessage(filename, text) {
  return {
    role: 'user',
    content: `The user attached the file "${filename}". Its text was extracted for you and is shown below in full, so you can read it directly:\n\n${text}`,
    isFile: true,
  }
}

/** The proxy's own reminders, which must stay the last message (docs/PROTOCOL.md §4). */
const isReminder = (text) => /^\((format|act) reminder\)/.test(text)

const dataUrl = (image) => `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * Sampling settings the classic route honours (the agent route ignores them):
 * `temperature` (0-2), `top_p` and `max_tokens` / `max_completion_tokens`,
 * capped at the model's output limit.
 */
export function samplingOptions(body = {}, model = {}) {
  const out = {}
  const temperature = finite(body.temperature)
  if (temperature !== undefined) out.temperature = clamp(temperature, 0, MAX_TEMPERATURE)
  const topP = finite(body.top_p)
  if (topP !== undefined) out.topP = clamp(topP, 0, 1)
  const max = finite(body.max_completion_tokens) ?? finite(body.max_tokens)
  if (max !== undefined && max > 0) out.maxResponseTokens = Math.floor(model.output ? Math.min(max, model.output) : max)
  return out
}

/**
 * Joins consecutive messages of the same role into one. The classic route keeps
 * only the LAST of several user messages in a row and drops the others
 * silently (measured 2026-11-25: "code word two" followed by the question was
 * forgotten, 2/2 models; joined, both answered). The proxy's own requests are
 * full of such runs (the request, then the format reminder; a tool result, then
 * the reminder). `isFile` messages are kept as they are and end a run: a
 * message before a document survived on both models.
 */
export function mergeRuns(prompt) {
  const out = []
  for (const message of prompt) {
    const last = out.at(-1)
    if (last && !last.isFile && !message.isFile && last.role === message.role) {
      const imagePath = [...(last.imagePath ?? []), ...(message.imagePath ?? [])]
      out[out.length - 1] = {
        role: last.role,
        content: [last.content, message.content].filter(Boolean).join('\n\n'),
        ...(imagePath.length ? { imagePath } : {}),
      }
      continue
    }
    out.push(message)
  }
  return out
}

/**
 * Converts the agent-shaped request into the classic body.
 *
 * - `systemPrompt.instructions` becomes the `systemPrompt` string (the route
 *   rejects an object), and Venice's own system prompt is turned off.
 * - Each message becomes `{ role, content }` with its text parts joined;
 *   `input_image` parts become data URLs in `imagePath` on the same message.
 * - `input_file` parts become `isFile` messages with the document's text
 *   (`documents`: media id -> text), placed right after the message that
 *   carried them (before it when that is a reminder, which stays last). The route takes no file bytes (multipart is a 400).
 * - Consecutive messages of one role are joined (`mergeRuns()`): the route
 *   would keep only the last of them.
 * - `enableLargeContextChat` is always on: without it the route keeps only the
 *   tail of a long prompt and drops the start silently (§2d).
 *
 * @param {object} request agent-shaped request (`toVeniceRequest().request`)
 * @param {{ images?: object[], documents?: Map<string, {filename: string, text: string}>, sampling?: object }} extra
 */
export function toClassicRequest(request, { images = [], documents = new Map(), sampling = {} } = {}) {
  const byId = new Map(images.map((image) => [image.mediaId, image]))
  const prompt = []
  for (const message of request.messages ?? []) {
    const parts = Array.isArray(message.content) ? message.content : []
    const text = parts
      .filter((part) => part?.type === 'output_text' || part?.type === 'input_text')
      .map((part) => part.text ?? '')
      .join('\n')
    const imagePath = []
    const docs = []
    for (const part of parts) {
      if (part?.type === 'input_image' && byId.has(part.media_id)) imagePath.push(dataUrl(byId.get(part.media_id)))
      if (part?.type === 'input_file') {
        const doc = documents.get(part.media_id)
        docs.push(documentMessage(doc?.filename ?? part.filename ?? 'attachment', doc?.text ?? '(the document could not be read)'))
      }
    }
    const role = ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'user'
    const own = { role, content: text, ...(imagePath.length ? { imagePath } : {}) }
    // documents follow the message that carried them, but never displace a
    // reminder from the end
    if (isReminder(text)) prompt.push(...docs, own)
    else prompt.push(own, ...docs)
  }
  const instructions = request.systemPrompt?.instructions
  return {
    requestId: randomUUID().replaceAll('-', '').slice(0, 7),
    modelId: request.modelId,
    prompt: mergeRuns(prompt),
    ...(instructions ? { systemPrompt: instructions } : {}),
    includeVeniceSystemPrompt: false,
    reasoning: request.reasoningMode !== undefined && request.reasoningMode !== 'disabled',
    enableLargeContextChat: true,
    webEnabled: false,
    webScrapeEnabled: false,
    xSearchEnabled: false,
    conversationType: 'text',
    isCharacter: false,
    ...sampling,
  }
}

/**
 * Reads the classic stream: one JSON object per line (not SSE), e.g.
 *
 *   {"kind":"meta","servingModelId":"qwen3-5-35b-a3b","servingModelName":"Qwen 3.5 35B A3B","references":[]}
 *   {"kind":"meta","completion_id":"chatcmpl-…"}  {"kind":"meta","thinking":true}
 *   {"kind":"content","content":"","reasoning_content":"…"}   reasoning delta
 *   {"kind":"content","content":"PONG"}                         answer delta
 *   {"kind":"status","content":"processing"}                    keepalive on long prompts
 *
 * and translates each line into the agent route's event names, so
 * `collectStream()` reads both routes the same way. The route sends no
 * terminal event: a stream that ends cleanly yields `response.completed`.
 */
export function classicReader() {
  const decoder = new TextDecoder()
  let buffer = ''
  let failed = false

  const translate = (line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (value?.error) {
      failed = true
      const message = typeof value.error === 'string' ? value.error : (value.error.message ?? JSON.stringify(value.error))
      return [{ type: 'error', message: `Venice: ${message}` }]
    }
    if (value?.kind === 'content') {
      const out = []
      if (value.reasoning_content) out.push({ type: 'response.reasoning_text.delta', delta: value.reasoning_content })
      if (value.content) out.push({ type: 'response.output_text.delta', output_index: 0, delta: value.content })
      return out
    }
    if (value?.kind === 'meta' && value.servingModelId) {
      return [{ type: 'veniceai:serving_model', model: value.servingModelId, name: value.servingModelName }]
    }
    return []
  }

  return {
    feed(chunk, done) {
      buffer += decoder.decode(chunk ?? new Uint8Array(), { stream: !done })
      const out = []
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        out.push(...translate(buffer.slice(0, index)))
        buffer = buffer.slice(index + 1)
      }
      if (done) {
        if (buffer) out.push(...translate(buffer))
        buffer = ''
        if (!failed) out.push({ type: 'response.completed' })
      }
      return out
    },
  }
}

/**
 * The document text from an agent-route event, or null: the agent route parses
 * documents server side and reports the text in a finished
 * `veniceai:document_parsing` item (§2c). Used to read documents for the
 * classic route, which takes text only.
 */
export function parsedDocument(event) {
  if (event?.type !== 'response.output_item.done') return null
  const item = event.item
  if (item?.type !== 'veniceai:document_parsing' || !item.source_media_id) return null
  return { mediaId: item.source_media_id, filename: item.filename, status: item.status, text: item.extracted_text ?? '' }
}

/** True once the agent route has started its answer: every document was parsed before it. */
export function answerStarted(event) {
  return event?.type === 'response.output_item.added' && ['message', 'reasoning'].includes(event.item?.type)
}

/**
 * The agent request that only reads documents: their parts and a one-word
 * prompt. The proxy stops reading the stream as soon as the parsing items are
 * done, so the model's answer is never waited for.
 */
export function documentExtractionRequest(files, modelId) {
  return {
    modelId,
    systemPrompt: { instructions: '' },
    messages: [
      {
        id: randomUUID(),
        type: 'message',
        status: 'completed',
        role: 'user',
        content: [
          ...files.map((file) => ({ type: 'input_file', media_id: file.mediaId, filename: file.filename })),
          { type: 'output_text', text: 'Reply with OK.', annotations: [] },
        ],
      },
    ],
    tools: [],
    clientTools: [],
    reasoningMode: 'disabled',
  }
}
