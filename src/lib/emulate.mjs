/**
 * The interesting part: turning an OpenAI chat-completions request into a
 * Venice web request, and turning the reply back.
 *
 * The web inference endpoint speaks an OpenAI *Responses*-like dialect and does
 * not accept OpenAI `tools`. Two consequences:
 *
 *  1. Tool calls are emulated. The model is asked to answer with a small JSON
 *     envelope `{"content": ..., "tool_calls": [...]}`, which we translate into
 *     real `tool_calls`. `emulate.mjs` owns the prompt, the parser and the
 *     reliability tricks (see docs/PROTOCOL.md).
 *  2. The reply is newline delimited SSE (with `event:`/`data:` frames). We
 *     convert deltas into OpenAI streaming chunks.
 */
import { randomUUID } from 'node:crypto'
import { MODELS } from './models.mjs'
import { repairJsonControlChars } from './sanitize.mjs'

/**
 * Instruction appended to the system prompt. Small models obey a short, blunt
 * format instruction far more reliably than a long one; the wording below was
 * picked by measuring compliance, see docs/PROTOCOL.md.
 */
export const TOOL_PROMPT = `You are connected to an external agent that executes tools on the user's computer. These tools ARE called directly by name in \`tool_calls\` (not inside \`execute\`); they are NOT Venice server tools.
Return ONLY one valid JSON object, without markdown fences and without any text outside JSON, with this exact shape:
{"content":"text for the user, or an empty string","tool_calls":[{"name":"exact tool name","arguments":{}}]}
Use an empty tool_calls array when answering without tools. To request a tool, put its name and arguments in tool_calls and STOP; the agent executes it and sends a tool result in the next user message. Never invent tool results. If a task needs the filesystem, call a tool instead of guessing. Never send an empty "content" unless you are calling a tool.
"arguments" is always a JSON object: write file content into it as a properly escaped string (escape line breaks as \\n, escape quotes as \\").
Never end a turn by describing what you are about to do: if you say "now I will check X", call that tool in the same turn. Use "tool_calls":[] only when the whole request is answered.`

/** Appended as the last user message; see docs/PROTOCOL.md ("format reminder"). */
export const REMINDER_FIRST_TURN =
  'Reply with exactly one JSON object and nothing else. If the task needs files, a command or a search, call those tools in tool_calls now and stop - do not answer yet.'
export const REMINDER_AFTER_TOOL =
  'Answer now: reply with exactly one JSON object and nothing else, "tool_calls":[] with your answer in "content" - unless another tool is really needed.'

/** Sent as a system reminder on the single automatic retry. */
export const RETRY_REMINDER =
  'your whole reply must be exactly one JSON object, nothing outside it. If the task needs the filesystem, a command or the web, put the tool call in tool_calls now instead of guessing.'

/**
 * Sent when the model answered with an empty `content` and no tool calls. A
 * blank answer is stored as an assistant turn with no parts at all, which makes
 * the session look frozen, so it always deserves another try.
 */
export const EMPTY_RETRY_REMINDER =
  'your last reply was an empty JSON object with no content. Put the actual answer text in "content" now (or call a tool in tool_calls if you still need one). Never send an empty content unless you are calling a tool.'

/**
 * Sent when the model described the next step but did not call a tool, which is
 * how a session "stops by itself" halfway through a task.
 */
/** Sent when the last tool output looks like a failure and the model just answered. */
export const FAILURE_RETRY_REMINDER =
  'a previous tool output looks like it failed (missing file, error or non-zero exit). Finish the job: fix it and call the tool for it now in tool_calls. Repeat your answer only if the failure is already handled.'

export const PLAN_RETRY_REMINDER =
  'your last reply only described the next step. ACT NOW: put the tool call(s) for that step in tool_calls and stop. Send "tool_calls":[] only when the whole request is finished.'

/**
 * A tool output that looks like a failure ("No such file", a traceback, a
 * non-zero command). After such a result an answer is often premature: the model
 * assumed the file existed, or skipped the fix it was about to make.
 */
const ERROR_SIGNALS = [
  /no such file/i,
  /not found/i,
  /command not found/i,
  /traceback \(most recent call last\)/i,
  /assertionerror/i,
  /syntaxerror/i,
  /\berror:/i,
  /"error"\s*:/,
  /permission denied/i,
  /is not a function/i,
  /no tool named/i,
  /exited with (code )?[1-9]/i,
  /failed\b/i,
]

export function lastToolResult(messages) {
  const last = [...(messages ?? [])].reverse().find((message) => message.role === 'tool')
  if (!last) return ''
  const content = last.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n')
  return ''
}

export function looksLikeFailure(text) {
  const value = (text ?? '').trim()
  if (!value) return false
  return ERROR_SIGNALS.some((pattern) => pattern.test(value))
}

/** Empty reply: no tool calls and nothing but whitespace in content. */
export function isEmptyAnswer(message) {
  return !message?.tool_calls && !(message?.content ?? '').trim()
}

/**
 * A reply that announces the next step instead of doing it ("now I will scan the
 * symbols", "next step: ..."). The model then stops with `tool_calls: []` and the
 * session looks finished while half the task is still open.
 */
const PLAN_MARKERS = [
  // "now I will ..." / "next up ..." - substring form, because Turkish letters
  // (ı, ş, ğ, ü) are not \w in JavaScript regexes and \b boundaries misfire.
  /(şimdi|simdi|şu an|su an|şu anda)/,
  /(sonra|ardından|sırada|sıradaki|sonraki|plan|planım|(^| )adım)/,
  /(acağım|eceğim|acağız|eceğiz|ayım\b|eyim\b)/,
  /(ıyorum|iyorum|uyorum|üyorum)/,
  /(will|let me|going to|about to|next step|now let|then)/,
]
const DONE_MARKERS = /\b(tamamland[ıi]|tamamdır|bitti|tamam|haz[ıi]r|tamamen|done|complete[d]?|finished|özet|özetle|sonuç|sonuc)\b/

export function looksLikePlan(content) {
  const text = (content ?? '').trim()
  if (!text) return false
  // A plan announces itself in the closing sentences ("... now I will resign it"),
  // so both signals are checked on the tail only: a "tamam" in the middle of a
  // long status report must not hide the plan at the end.
  if (/[:…]\s*$/.test(text)) return true
  // The closing part decides. 240 chars was too narrow for long status reports
  // that end with a numbered "next steps" list, so the window is wider; a
  // "tamam" earlier in the reply must not veto a plan announced at the end.
  const tail = text.toLowerCase().slice(-600)
  if (PLAN_MARKERS.some((pattern) => pattern.test(tail))) return true
  // a trailing enumeration of upcoming work counts as a plan too
  return /\(1\)[\s\S]{0,600}\(2\)/.test(text.slice(-700))
}

/** Shown when every attempt came back blank, so the turn is never invisible. */
export const EMPTY_MARKER = '(empty reply)'

/**
 * Decides whether a reply deserves another upstream attempt.
 * @param {{ message: {tool_calls: unknown[], content: string, sawEnvelope: boolean}, lastRole?: string }} input
 * @returns {{ retry: boolean, reason?: string, reminder?: string }}
 */
export function shouldRetry({ message, lastRole, lastToolOutput }) {
  if (isEmptyAnswer(message)) return { retry: true, reason: 'empty reply', reminder: EMPTY_RETRY_REMINDER }
  if (!message.sawEnvelope) return { retry: true, reason: 'plain prose reply', reminder: RETRY_REMINDER }
  if (!message.tool_calls && lastRole === 'user') {
    return { retry: true, reason: 'envelope without tool calls', reminder: RETRY_REMINDER }
  }
  if (!message.tool_calls && looksLikeFailure(lastToolOutput)) {
    return { retry: true, reason: 'last tool output looks failed', reminder: FAILURE_RETRY_REMINDER }
  }
  // After a tool result an answer is expected, but "let me now do X" is not an
  // answer: it is the model stopping mid-task. This is the case that made a real
  // session look frozen.
  if (!message.tool_calls && lastRole !== 'user' && looksLikePlan(message.content)) {
    return { retry: true, reason: 'reply describes the next step', reminder: PLAN_RETRY_REMINDER }
  }
  return { retry: false }
}

/**
 * A blank assistant turn is stored with no parts at all and looks frozen in the
 * client, so the last resort is the raw text and then a marker. Mutates and
 * returns the message.
 */
export function applyFallback(message, rawText) {
  if (!isEmptyAnswer(message)) return message
  message.content = fallbackAnswerText(rawText) || EMPTY_MARKER
  return message
}

/**
 * Picks between two model replies. Tool calls win; a non-empty answer beats an
 * empty one; between two real answers the format-compliant one wins. Keeping
 * this decision explicit is what stops a retry from replacing a good answer with
 * a blank one.
 */
export function preferAnswer(candidate, current) {
  if (!candidate) return false
  if (candidate.tool_calls && !current?.tool_calls) return true
  if (!candidate.tool_calls && current?.tool_calls) return false
  if (candidate.tool_calls && current?.tool_calls) return false
  const candidateText = (candidate.content ?? '').trim()
  const currentText = (current?.content ?? '').trim()
  if (candidateText && !currentText) return true
  if (!candidateText && currentText) return false
  if (candidateText && currentText && candidate.sawEnvelope && !current?.sawEnvelope) return true
  return false
}

/**
 * Code Mode wrappers. OpenCode advertises `execute`/`search` alongside real
 * tools and their description ("cannot be called directly") confuses models
 * that are being asked to call tools by name, so they are hidden when other
 * tools exist.
 */
const WRAPPER_TOOLS = new Set(['execute', 'search'])

export function textOf(content) {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) return String(content)
  return content
    .map((part) => (part?.type === 'text' ? (part.text ?? '') : part?.type === 'image_url' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** OpenAI reasoning_effort -> the web endpoint's three-valued switch. */
export function reasoningMode(body) {
  const effort = body?.reasoning_effort ?? body?.reasoningEffort ?? body?.reasoning?.effort
  if (!effort || ['none', 'minimal', 'disabled', 'off'].includes(effort)) return { reasoningMode: 'disabled' }
  if (['adaptive', 'auto', 'medium'].includes(effort)) return { reasoningMode: 'adaptive' }
  return { reasoningMode: 'enabled' }
}

function safeJson(value) {
  try {
    return JSON.parse(value ?? '{}')
  } catch {
    return value ?? {}
  }
}

/**
 * Builds the upstream request.
 *
 * @returns {{ request: object, toolNames: Set<string>, emulatedTools: boolean }}
 */
export function toVeniceRequest(body) {
  if (!MODELS[body.model]) {
    throw new Error(`unknown model: ${body.model}. Known: ${Object.keys(MODELS).join(', ')}`)
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('messages must not be empty')

  let tools = body.tool_choice === 'none' ? [] : (body.tools ?? [])
  const direct = tools.filter((tool) => tool?.function?.name && !WRAPPER_TOOLS.has(tool.function.name))
  if (direct.length) tools = direct

  const names = new Set()
  for (const tool of tools) {
    if (tool?.type !== 'function' || !tool.function?.name) throw new Error('only function tools are supported')
    names.add(tool.function.name)
  }

  const instructions = []
  const messages = []

  for (const message of body.messages) {
    const text = textOf(message.content)
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(text)
      continue
    }
    if (!['user', 'assistant', 'tool'].includes(message.role)) continue

    let role = message.role
    let content = text

    if (message.role === 'tool') {
      // Tool results travel as a user message in the agent's own envelope shape.
      role = 'user'
      content = JSON.stringify({ tool_result: { tool_call_id: message.tool_call_id, content: text } })
    }

    if (message.role === 'assistant') {
      // History is re-serialised in envelope form: the model imitates its own
      // previous turns, so a plain-text assistant turn makes it drop the format.
      content = JSON.stringify({
        content: text,
        tool_calls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: safeJson(call.function?.arguments),
        })),
      })
    }

    messages.push({
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role,
      content: [{ type: 'output_text', text: content, annotations: [] }],
    })
  }

  if (!messages.some((message) => message.role === 'user')) {
    messages.unshift({
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{ type: 'output_text', text: '(continue)', annotations: [] }],
    })
  }

  let choice = body.tool_choice ?? 'auto'
  if (typeof choice === 'object') choice = choice.function?.name ?? 'auto'

  if (tools.length) {
    instructions.push(
      `${TOOL_PROMPT}\nTool choice: ${JSON.stringify(choice)}.\nAvailable tools:\n${JSON.stringify(tools.map((tool) => tool.function))}`,
    )
    const last = messages[messages.length - 1]
    const afterToolResult = typeof last?.content?.[0]?.text === 'string' && last.content[0].text.startsWith('{"tool_result"')
    const reminder = last?.role === 'user' && afterToolResult ? REMINDER_AFTER_TOOL : REMINDER_FIRST_TURN
    messages.push({
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{ type: 'output_text', text: `(format reminder) ${reminder}`, annotations: [] }],
    })
  }

  return {
    request: {
      modelId: body.model,
      systemPrompt: { instructions: instructions.filter(Boolean).join('\n\n') },
      messages,
      tools: [],
      clientTools: [],
      ...reasoningMode(body),
    },
    toolNames: names,
    emulatedTools: tools.length > 0,
  }
}

/**
 * Same request, with the retry reminder appended as a **user** message.
 *
 * The channel matters: a trailing user message is obeyed far more reliably than
 * the same text appended to the system prompt (measured 4/4 vs 1/4 when the
 * format reminder was tuned the same way).
 */
export function withRetryReminder(request, reminder = RETRY_REMINDER) {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        id: randomUUID(),
        type: 'message',
        status: 'completed',
        role: 'user',
        content: [{ type: 'output_text', text: `(act reminder) ${reminder}`, annotations: [] }],
      },
    ],
  }
}

/** Returns the index just past the balanced object starting at `start`, or -1. */
/** Balanced end of a value that starts with `{` or `[`. */
function scanObjectByKind(text) {
  const open = text[0]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

export function scanObject(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

const stripToolResultTags = (text) => text.replace(/<\/?tool_result[^>]*>/g, '').trim()

const newCallId = () => `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`

/**
 * Collects every envelope in a model reply.
 *
 * Models frequently emit *several* envelopes in one message, or prose followed
 * by an envelope. A plain `JSON.parse` of the whole text loses the tool calls,
 * which is what made the first version of this proxy look like "tools are
 * broken". Content pieces are joined; tool calls are concatenated.
 */
/**
 * Quotes a raw (non-JSON) run that follows `"arguments":`.
 *
 * The model sometimes dumps file content straight after the key, with literal
 * line breaks and unescaped quotes:
 *
 *   "arguments":
 *   blob.bin ANALIZ RAPORU
 *   ...
 *   ,"workdir":"/tmp"
 *
 * `JSON.stringify()` escapes the run, so the object becomes parseable again.
 */
export function repairArguments(text) {
  const marker = /"arguments"\s*:\s*/g
  let out = ''
  let last = 0
  let match
  while ((match = marker.exec(text))) {
    const start = match.index + match[0].length
    out += text.slice(last, start)
    last = start
    const first = text[start]
    // already looks like a JSON value? leave it alone
    if (first !== undefined && '{["-0123456789tfn'.includes(first)) continue
    const rest = text.slice(start)
    const boundary = /,[\s\r\n]*"[\w$]+"\s*:/.exec(rest)
    const end = boundary ? start + boundary.index : text.length
    const raw = text.slice(start, end).replace(/\s+$/, '')
    out += JSON.stringify(raw)
    last = start + raw.length
  }
  out += text.slice(last)
  return out
}

/**
 * Parses an envelope slice, repairing the model's JSON slips step by step:
 * literal control characters, trailing commas, and raw argument blobs.
 */
function parseLoose(slice) {
  const steps = [
    (text) => text,
    repairJsonControlChars,
    (text) => repairJsonControlChars(text).replace(/,\s*([}\]])/g, '$1'),
    (text) => repairArguments(repairJsonControlChars(text)),
    (text) => repairArguments(repairJsonControlChars(text)).replace(/,\s*([}\]])/g, '$1'),
  ]
  for (const step of steps) {
    try {
      const parsed = JSON.parse(step(slice))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try the next repair */
    }
  }
  return null
}

/**
 * Last resort: pull `name`/`arguments` pairs out of a broken object with a
 * tolerant scan, so a tool call is not lost just because the JSON is invalid.
 */
export function salvageCalls(slice) {
  const calls = []
  const nameRe = /"name"\s*:\s*"([^"]+)"/g
  const argRe = /"arguments"\s*:\s*/g
  let match
  while ((match = nameRe.exec(slice))) {
    const name = match[1]
    argRe.lastIndex = match.index + match[0].length
    const argMatch = argRe.exec(slice)
    if (!argMatch || argMatch.index - (match.index + match[0].length) > 40) {
      calls.push({ name, arguments: {} })
      continue
    }
    const start = argMatch.index + argMatch[0].length
    const rest = slice.slice(start)
    let end
    const trimmed = rest.replace(/^\s+/, '')
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // a real JSON value: take the balanced slice, not the next `,"key":`
      const offset = rest.length - trimmed.length
      const balanced = scanObjectByKind(trimmed)
      end = start + (balanced > 0 ? offset + balanced : rest.length)
    } else {
      const boundary = /,[\s\r\n]*"[\w$]+"\s*:/.exec(rest)
      end = boundary ? start + boundary.index : slice.length
    }
    const raw = slice.slice(start, end).replace(/[\s,]+$/, '')
    let args = null
    try {
      args = JSON.parse(repairJsonControlChars(raw))
    } catch {
      args = null
    }
    if (args && typeof args === 'object' && !Array.isArray(args)) calls.push({ name, arguments: args })
    else calls.push({ name, arguments: { content: raw } })
  }
  return calls
}

/** Removes the envelope scaffolding from text that failed to parse. */
export function cleanLeakedEnvelope(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('"tool_calls"')) return trimmed
  const start = trimmed.search(/"arguments"\s*:\s*/)
  if (start < 0) return trimmed
  const valueStart = trimmed.slice(start).search(/:\s*/) + start + 1
  let body = trimmed.slice(valueStart).replace(/^\s+/, '')
  // the tool call tail lives after the raw blob: strip it when present
  body = body.replace(/\}?\s*\}?\s*,?\s*$/, '')
  body = body.replace(/\}\s*\]\s*\}?\s*$/, '')
  return stripToolResultTags(body).trim() || trimmed
}

const isValidArgString = (value) => {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** Builds an OpenAI tool call from a parsed envelope entry. */
function buildCall(call) {
  if (!call || typeof call.name !== 'string') return null
  // Some models put the arguments at the call's top level instead of under
  // `arguments`; accept both shapes.
  let args = call.arguments
  if (args === undefined) {
    const { name, id, type, ...rest } = call
    args = rest
  }
  if (typeof args === 'string') {
    // A plain string that is not JSON (raw file content) is passed on as-is,
    // wrapped so the tool sees an object.
    args = isValidArgString(args) ? args : JSON.stringify({ content: args })
  }
  return {
    id: newCallId(),
    type: 'function',
    function: { name: call.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
  }
}

export function extractEnvelopes(text) {
  const parts = []
  const tool_calls = []
  let sawEnvelope = false
  let pending = ''
  let index = 0

  while (index < text.length) {
    const start = text.indexOf('{', index)
    if (start < 0) {
      pending += text.slice(index)
      break
    }
    if (start > index) pending += text.slice(index, start)
    const end = scanObject(text, start)
    const slice = end > 0 ? text.slice(start, end) : ''
    const parsed = slice ? parseLoose(slice) : null

    let calls = null
    let piece = typeof parsed?.content === 'string' ? parsed.content.trim() : ''
    const looksLikeEnvelope = parsed !== null || slice.includes('"tool_calls"')

    if (looksLikeEnvelope && !Array.isArray(parsed?.tool_calls) && !piece) {
      // Broken JSON: salvage the tool calls and the leaked text next to them.
      const salvaged = salvageCalls(slice)
      if (salvaged.length) {
        calls = salvaged
        piece = cleanLeakedEnvelope(slice)
      }
    }

    const isEnvelope =
      looksLikeEnvelope &&
      (Array.isArray(parsed?.tool_calls) || typeof parsed?.content === 'string' || (calls?.length ?? 0) > 0)

    if (!isEnvelope) {
      // Not an envelope: keep the brace as prose and keep scanning after it.
      pending += '{'
      index = start + 1
      continue
    }

    sawEnvelope = true
    if (pending.trim()) parts.push(pending.trim())
    pending = ''
    if (piece) parts.push(piece)

    const rawCalls = calls ?? parsed.tool_calls ?? []
    for (const call of rawCalls) {
      const built = buildCall(call)
      if (built) tool_calls.push(built)
    }
    index = end > 0 ? end : start + 1
  }

  if (pending.trim()) parts.push(pending.trim())

  return { content: stripToolResultTags(parts.join('\n')), tool_calls, sawEnvelope }
}

/**
 * Turns a raw model reply into `{ content, tool_calls, sawEnvelope }`.
 * `sawEnvelope: false` means the model ignored the format entirely.
 */
export function parseToolReply(text) {
  const envelope = extractEnvelopes(text)
  if (!envelope.sawEnvelope) {
    return { content: stripToolResultTags(text.trim()), tool_calls: null, sawEnvelope: false }
  }
  return {
    content: envelope.content,
    tool_calls: envelope.tool_calls.length ? envelope.tool_calls : null,
    sawEnvelope: true,
  }
}

/**
 * Best-effort text when a reply parsed to nothing: prose is returned as is, a
 * bare envelope returns nothing (so the caller can show a marker instead).
 */
export function fallbackAnswerText(text) {
  const raw = (text ?? '').trim()
  if (!raw) return ''
  const plain = extractEnvelopes(raw).content.trim()
  if (plain) return plain
  return raw.startsWith('{') ? '' : raw
}

/** Rough token estimate; the web endpoint reports none. */
export function countTokens(text) {
  if (!text) return 0
  return Math.max(1, Math.ceil(String(text).length / 4))
}

/**
 * Incremental SSE frame reader for the Venice stream: `event:`/`data:` lines,
 * `:` comments as keepalives, `[DONE]` terminator.
 */
export function sseReader() {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data = []

  const flushLine = (line) => {
    if (line === '') {
      if (data.length === 0) {
        event = ''
        return null
      }
      const raw = data.join('\n')
      data = []
      const type = event
      event = ''
      if (raw === '[DONE]') return { type: 'done' }
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        return null
      }
      return { ...value, type: type || value.type }
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
    return null
  }

  return {
    feed(chunk, done) {
      buffer += decoder.decode(chunk ?? new Uint8Array(), { stream: !done })
      const out = []
      let match
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // Keep a trailing CR until the next chunk so CRLF stays distinguishable.
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const event = flushLine(line)
        if (event) out.push(event)
      }
      if (done && buffer) {
        const event = flushLine(buffer)
        buffer = ''
        if (event) out.push(event)
      }
      return out
    },
  }
}
