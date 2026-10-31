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

/**
 * Instruction appended to the system prompt. Small models obey a short, blunt
 * format instruction far more reliably than a long one; the wording below was
 * picked by measuring compliance, see docs/PROTOCOL.md.
 */
export const TOOL_PROMPT = `You are connected to an external agent that executes tools on the user's computer. These tools ARE called directly by name in \`tool_calls\` (not inside \`execute\`); they are NOT Venice server tools.
Return ONLY one valid JSON object, without markdown fences and without any text outside JSON, with this exact shape:
{"content":"text for the user, or an empty string","tool_calls":[{"name":"exact tool name","arguments":{}}]}
Use an empty tool_calls array when answering without tools. To request a tool, put its name and arguments in tool_calls and STOP; the agent executes it and sends a tool result in the next user message. Never invent tool results. If a task needs the filesystem, call a tool instead of guessing.`

/** Appended as the last user message; see docs/PROTOCOL.md ("format reminder"). */
export const REMINDER_FIRST_TURN =
  'Reply with exactly one JSON object and nothing else. If the task needs files, a command or a search, call those tools in tool_calls now and stop — do not answer yet.'
export const REMINDER_AFTER_TOOL =
  'Answer now: reply with exactly one JSON object and nothing else, "tool_calls":[] with your answer in "content" — unless another tool is really needed.'

/** Sent as a system reminder on the single automatic retry. */
export const RETRY_REMINDER =
  'your whole reply must be exactly one JSON object, nothing outside it. If the task needs the filesystem, a command or the web, put the tool call in tool_calls now instead of guessing.'

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

/** Same request, with an extra system reminder used for the single retry. */
export function withRetryReminder(request) {
  return {
    ...request,
    systemPrompt: { instructions: `${request.systemPrompt.instructions}\n\nREMINDER: ${RETRY_REMINDER}` },
  }
}

/** Returns the index just past the balanced object starting at `start`, or -1. */
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
    let parsed = null
    if (end > 0) {
      try {
        parsed = JSON.parse(text.slice(start, end))
      } catch {
        parsed = null
      }
    }
    const isEnvelope =
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (Array.isArray(parsed.tool_calls) || typeof parsed.content === 'string')

    if (!isEnvelope) {
      // Not an envelope: keep the brace as prose and keep scanning after it.
      pending += '{'
      index = start + 1
      continue
    }

    sawEnvelope = true
    if (pending.trim()) parts.push(pending.trim())
    pending = ''

    const piece = typeof parsed.content === 'string' ? parsed.content.trim() : ''
    if (piece) parts.push(piece)

    for (const call of parsed.tool_calls ?? []) {
      if (!call || typeof call.name !== 'string') continue
      // Some models put the arguments at the call's top level instead of under
      // `arguments`; accept both shapes.
      let args = call.arguments
      if (args === undefined) {
        const { name, id, type, ...rest } = call
        args = rest
      }
      tool_calls.push({
        id: newCallId(),
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      })
    }
    index = end
  }

  if (pending.trim()) parts.push(pending.trim())

  return { content: stripToolResultTags(parts.join('\n')), tool_calls, sawEnvelope }
}

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
