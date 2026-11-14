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
import { readLenient } from './lenient-json.mjs'
import { repairJsonControlChars } from './sanitize.mjs'

/**
 * Instruction appended to the system prompt. Small models obey a short, blunt
 * format instruction far more reliably than a long one; the wording below was
 * picked by measuring compliance, see docs/PROTOCOL.md.
 *
 * `status` is how the model tells the proxy whether its turn is over. Nothing in
 * the proxy reads the prose: whether a reply is a finished answer, a question or
 * a plan the model forgot to act on is decided from this field and, when it is
 * not enough, by a second model (the judge), so it works the same in every
 * language.
 */
export const TOOL_PROMPT = `You are connected to an external agent that executes tools on the user's computer. These tools ARE called directly by name in \`tool_calls\` (not inside \`execute\`); they are NOT Venice server tools.
Return ONLY one valid JSON object, without markdown fences and without any text outside JSON, with this exact shape:
{"content":"text for the user, or an empty string","status":"continue","tool_calls":[{"name":"exact tool name","arguments":{}}]}
"status" is required and is one of:
- "continue": the request needs more work from you. tool_calls must then contain the next tool call(s).
- "done": the whole request is finished; "content" is your final answer and tool_calls is []. The final answer states the results the user asked for (numbers, names, findings, answers, what changed); "it is done" or "see the file" alone is not an answer.
- "ask": you need a decision or information that only the user can give; "content" is the question and tool_calls is [].
To request a tool, put its name and arguments in tool_calls and STOP; the agent executes it and sends a tool result in the next user message. Never invent tool results. If a task needs the filesystem, call a tool instead of guessing. Never send an empty "content" unless you are calling a tool.
"arguments" is always a JSON object: write file content into it as a properly escaped string (escape line breaks as \\n, escape quotes as \\"). Close every object: each tool call is {"name":...,"arguments":{...}}.
Do not ask the user for permission to do what they already asked for, and do not end a turn by describing what you are about to do: do it now with tool_calls and "status":"continue".
For a script longer than one line, write it to a file first and run the file; do not pass multi-line code to a shell command.`

/** Appended as the last user message; see docs/PROTOCOL.md ("format reminder"). */
export const REMINDER_FIRST_TURN =
  'Reply with exactly one JSON object and nothing else, with "status". If the task needs files, a command or a search, call those tools in tool_calls now with "status":"continue" - do not answer yet.'
export const REMINDER_AFTER_TOOL =
  'Reply with exactly one JSON object and nothing else. If more work is needed, call the next tool now with "status":"continue". Only when the whole request is finished answer with "status":"done" and "tool_calls":[]; use "status":"ask" only for a question the user must answer.'

/** Sent on a retry when the reply was prose or did not call a tool on a user turn. */
export const RETRY_REMINDER =
  'your whole reply must be exactly one JSON object with "content", "status" and "tool_calls", nothing outside it. If the task needs the filesystem, a command or the web, put the tool call in tool_calls now instead of guessing.'

/**
 * Sent when the model answered with an empty `content` and no tool calls. A
 * blank answer is stored as an assistant turn with no parts at all, which makes
 * the session look frozen, so it always deserves another try.
 */
export const EMPTY_RETRY_REMINDER =
  'your last reply was an empty JSON object with no content. Put the actual answer text in "content" now (or call a tool in tool_calls if you still need one). Never send an empty content unless you are calling a tool.'

/** Sent when the reply looked like an envelope but could not be read. */
export const BROKEN_ENVELOPE_REMINDER =
  'your last reply was not valid JSON, so its tool calls could not be executed. Send it again as exactly one valid JSON object: {"content":"...","status":"...","tool_calls":[{"name":"...","arguments":{...}}]}, closing every object and escaping quotes and line breaks inside strings.'

/** Sent when the model said it is not finished but called no tool. */
export const CONTINUE_REMINDER =
  'your last reply did not finish the request: work is still open and you did not call a tool. ACT NOW: put the tool call(s) for the next step in tool_calls with "status":"continue". Use "status":"done" only when the whole request is finished, and "status":"ask" only for a question the user must answer.'

/** Sent when the judge saw a failed tool output that the reply skipped over. */
export const FAILURE_RETRY_REMINDER =
  'the latest tool output shows a failure (an error, a failing test, a missing file or command, or a non-zero exit) that your reply does not handle. Fix it now with tool_calls and "status":"continue", or, if it cannot be fixed, say so plainly with "status":"done".'

/** Sent when the judge saw finished work whose result the reply leaves out. */
export const RESULT_REMINDER =
  'the work is done, but your reply does not tell the user the result they asked for. Answer again with "status":"done" and put the concrete results in "content" (the numbers, names, findings or answers, and what changed); saying it is done or naming a file is not enough. Call a tool only if a value is still missing.'

/**
 * Sent when the model called tools natively and Venice's own agent loop answered
 * "Tool not found" (see server.mjs `collectStream`). The tools are fine; only
 * the way they were called was wrong.
 */
export const NATIVE_CALL_REMINDER =
  'your tools work. Do not use built-in function calling or any native tool-call syntax: the ONLY way to call a tool is the "tool_calls" array of your JSON reply. Ignore any earlier "Tool not found" message and call the tool you need now in tool_calls with "status":"continue".'

/** A reply cut off because Venice was looping on native tool calls. */
export function serverLoopMessage() {
  return { content: '', tool_calls: null, sawEnvelope: false, serverLoop: true }
}

/** Builds the reminder for tool calls the agent cannot execute. */
export const invalidCallReminder = (problems, available) =>
  `your last tool call(s) cannot be executed: ${problems.join('; ')}. Send the reply again with complete, valid tool calls. Available tools: ${available.join(', ')}.`

/** Every value the envelope's `status` may take. */
export const STATUSES = new Set(['continue', 'done', 'ask'])

/** Text of the newest tool message, for the judge. */
export function lastToolResult(messages) {
  const last = [...(messages ?? [])].reverse().find((message) => message.role === 'tool')
  if (!last) return ''
  return textOf(last.content)
}

/** Empty reply: no tool calls and nothing but whitespace in content. */
export function isEmptyAnswer(message) {
  return !message?.tool_calls && !(message?.content ?? '').trim()
}

/** Shown when every attempt came back blank, so the turn is never invisible. */
export const EMPTY_MARKER = '(empty reply)'

/**
 * Decides what happens to a parsed reply before it is forwarded.
 *
 * Every rule is structural - the envelope's shape, its `status`, its tool calls
 * - and none reads the prose. A reply that answers right after a tool result is
 * the one case structure cannot settle ("finished" and "stopped halfway" look
 * the same), so it is handed to the judge instead (`judge: true`).
 *
 * @param {{ message: {tool_calls: unknown[]|null, content: string, sawEnvelope: boolean, brokenEnvelope?: boolean, status?: string, problems?: string[]}, lastRole?: string, available?: string[] }} input
 * @returns {{ retry: boolean, reason?: string, reminder?: string, judge?: boolean }}
 */
export function shouldRetry({ message, lastRole, available = [] }) {
  if (message.serverLoop) return { retry: true, reason: 'venice tool loop', reminder: NATIVE_CALL_REMINDER }
  if (isEmptyAnswer(message) && !message.brokenEnvelope) {
    return { retry: true, reason: 'empty reply', reminder: EMPTY_RETRY_REMINDER }
  }
  if (message.brokenEnvelope && !message.tool_calls) {
    return { retry: true, reason: 'unreadable envelope', reminder: BROKEN_ENVELOPE_REMINDER }
  }
  if (!message.sawEnvelope) return { retry: true, reason: 'plain prose reply', reminder: RETRY_REMINDER }
  if (message.problems?.length) {
    return {
      retry: true,
      reason: `invalid tool call (${message.problems.join('; ')})`,
      reminder: invalidCallReminder(message.problems, available),
    }
  }
  if (message.tool_calls) return { retry: false }
  if (message.status === 'continue') {
    return { retry: true, reason: 'status continue without a tool call', reminder: CONTINUE_REMINDER }
  }
  if (lastRole === 'user') {
    if (message.status === 'ask') return { retry: false }
    return { retry: true, reason: 'envelope without tool calls', reminder: RETRY_REMINDER }
  }
  // After a tool result: done, ask, or no status at all. Only a reader of the
  // conversation can tell a finished answer from a stop halfway.
  return { retry: false, judge: true }
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
 * Picks between two model replies. Executable tool calls win; a non-empty
 * answer beats an empty one; between two real answers the format-compliant one
 * wins. Keeping this decision explicit is what stops a retry from replacing a
 * good answer with a blank one.
 */
export function preferAnswer(candidate, current, { replaceAnswer = false } = {}) {
  if (!candidate) return false
  const candidateOk = !!candidate.tool_calls && !candidate.problems?.length
  const currentOk = !!current?.tool_calls && !current?.problems?.length
  if (candidateOk !== currentOk) return candidateOk
  if (candidate.tool_calls && !current?.tool_calls) return true
  if (!candidate.tool_calls && current?.tool_calls) return false
  if (candidate.tool_calls && current?.tool_calls) return false
  const candidateText = (candidate.content ?? '').trim()
  const currentText = (current?.content ?? '').trim()
  if (candidateText && !currentText) return true
  if (!candidateText && currentText) return false
  if (candidate.brokenEnvelope !== current?.brokenEnvelope) return !candidate.brokenEnvelope
  if (candidateText && currentText && candidate.sawEnvelope && !current?.sawEnvelope) return true
  // asked for again because the first answer left the result out
  if (replaceAnswer && candidateText && candidate.sawEnvelope && !candidate.problems?.length) return true
  return false
}

/* ------------------------------------------------------------------------ */
/* The judge                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Instructions for the judge: a second model call that decides whether a reply
 * without tool calls may end the turn. It reads the conversation itself, so it
 * works for any language and any wording; see docs/PROTOCOL.md §4.7 for how the
 * prompt and the model were measured.
 */
export const JUDGE_PROMPT = `You review one turn of an AI coding agent. The agent works for a user and can call tools (shell, read, edit, write, ...). It has just received tool results, and its latest reply calls no tool, so the turn is about to END and control goes back to the user. Decide whether ending here is right. The conversation can be in any language.
Answer with exactly one JSON object and nothing else: {"verdict":"...","reason":"one short sentence"}
verdict is one of:
- "finished": the request is done AND the reply gives the user what they asked to be told: the numbers, names, findings, answers or summary the request asks for (an honest report that something failed or cannot be done also counts). When the request only asks for an action (create, fix, rename, delete, compute something into a file) and does not ask to be told anything, confirming it is enough.
- "missing_result": the work is done, but the reply does not state a result the user asked to be told - it only says the work is done, that tests pass, or where the results were saved, while the request asked to be told the values, names, counts, findings or answers themselves ("tell me ...", or a question such as which, how many, what).
- "needs_user": the agent asks the user a real question: a decision, information or permission that only the user can give and that the request did not already give. A reply that asks nothing is never "needs_user".
- "stopped_early": work the user asked for is still open and the agent could do it now with its tools - for example the reply announces or lists next steps, promises to run, check or fix something, says it will continue, asks permission for something the user already asked for, or claims its tools are unavailable or failing although the tool results shown here worked.
- "ignored_failure": the latest tool output shows a failure (an error, a failing test, a missing file or command, a non-zero exit) that the reply ignores or presents as success.`

const tail = (text, max) => (text.length > max ? `…${text.slice(-max)}` : text)

/**
 * Builds the judge's upstream request from the client's request and the reply.
 * The newest user message is the request; the newest tool outputs are the
 * evidence.
 */
export function buildJudgeRequest(body, message, model) {
  const messages = body.messages ?? []
  const request = [...messages].reverse().find((item) => item.role === 'user')
  const toolOutputs = messages.filter((item) => item.role === 'tool').slice(-2)
  const evidence = toolOutputs.length
    ? toolOutputs.map((item, index) => `[${index + 1}] ${tail(textOf(item.content), 1500)}`).join('\n\n')
    : '(none)'
  const text = [
    `USER REQUEST:\n${tail(textOf(request?.content).trim(), 3000) || '(none)'}`,
    `LATEST TOOL RESULTS (oldest first):\n${evidence}`,
    `AGENT REPLY (declared status: ${message.status ?? 'none'}):\n${tail((message.content ?? '').trim(), 3000) || '(empty)'}`,
  ].join('\n\n')
  return {
    modelId: model,
    systemPrompt: { instructions: JUDGE_PROMPT },
    messages: [
      {
        id: randomUUID(),
        type: 'message',
        status: 'completed',
        role: 'user',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    tools: [],
    clientTools: [],
    reasoningMode: 'disabled',
  }
}

export const VERDICTS = new Set(['finished', 'needs_user', 'stopped_early', 'ignored_failure', 'missing_result'])

/** Reads the judge's verdict, or `null` when its reply is unusable. */
export function parseJudgeVerdict(text) {
  const raw = (text ?? '').trim()
  const start = raw.indexOf('{')
  if (start < 0) return null
  let value
  try {
    value = readLenient(raw, start).value
  } catch {
    return null
  }
  const verdict = typeof value?.verdict === 'string' ? value.verdict.trim().toLowerCase() : ''
  return VERDICTS.has(verdict) ? { verdict, reason: typeof value.reason === 'string' ? value.reason : '' } : null
}

/** What a judge verdict means for the reply: keep it, or retry with which reminder. */
export function judgeDecision(verdict) {
  if (verdict === 'stopped_early') return { retry: true, reason: 'judge: stopped early', reminder: CONTINUE_REMINDER }
  if (verdict === 'ignored_failure') {
    return { retry: true, reason: 'judge: ignored a failed tool output', reminder: FAILURE_RETRY_REMINDER }
  }
  // the retry is another final answer, so it has to be allowed to replace the first
  if (verdict === 'missing_result') {
    return { retry: true, reason: 'judge: result missing', reminder: RESULT_REMINDER, replaceAnswer: true }
  }
  return { retry: false }
}

/**
 * Maps the names models invent for common tools onto the real ones. `shell`,
 * `read`, `grep` and friends are the names this proxy advertises, so an
 * invented alias is only useful when the target is actually available.
 */
const TOOL_ALIASES = {
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  terminal: 'shell',
  run: 'shell',
  run_command: 'shell',
  execute_command: 'shell',
  cat: 'read',
  read_file: 'read',
  view: 'read',
  write_file: 'write',
  create_file: 'write',
  edit_file: 'edit',
  str_replace: 'edit',
  search: 'grep',
  rg: 'grep',
  find: 'grep',
  ls: 'glob',
  list_files: 'glob',
}

/** Resolves an invented tool name to an available one, or returns it unchanged. */
export function normalizeToolName(name, available) {
  if (available?.has(name)) return name
  const target = TOOL_ALIASES[name]
  return target && available?.has(target) ? target : name
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
 * @returns {{ request: object, toolNames: Set<string>, toolSchemas: Map<string, object>, emulatedTools: boolean, images: string[], imageIds: string[] }}
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
  // data URLs of the images of the newest user turn: Venice answers an image
  // turn with `hydrate_content` and the bytes have to be handed back on the
  // multipart retry (server.mjs). The real `media_id` is filled in after the
  // upload by `toVeniceRequest` callers, see `uploads` below.
  const images = []
  const imageIds = []
  const uploads = []

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
      // The status is written back too (a turn with calls went on, one without
      // ended it), otherwise the model copies envelopes that have none.
      const calls = message.tool_calls ?? []
      content = JSON.stringify({
        content: text,
        status: calls.length ? 'continue' : 'done',
        tool_calls: calls.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: safeJson(call.function?.arguments),
        })),
      })
    }

    // Images cannot travel as text: the web endpoint takes them as `input_image`
    // parts next to the text. They are kept only on real user turns (history
    // re-serialised as envelopes is text-only).
    const parts = [{ type: 'output_text', text: content, annotations: [] }]
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const part of message.content) {
        const url = part?.image_url?.url ?? (typeof part?.image_url === 'string' ? part.image_url : part?.url)
        const known = typeof part?.media_id === 'string' && part.media_id ? part.media_id : null
        if ((part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image') && (url || known)) {
          // A `media_id` the client already holds (an upload of its own) is passed
          // through as is. Otherwise https images keep the url and data URLs are
          // uploaded by the caller, the placeholder replaced by the returned id.
          if (!url && known) {
            parts.push({ type: 'input_image', media_id: known, detail: part.detail ?? 'auto' })
            continue
          }
          const mediaId = url.startsWith('data:') ? `upload-${uploads.length}` : (known ?? randomUUID())
          parts.push({ type: 'input_image', media_id: mediaId, detail: 'auto', image_url: url })
          if (url.startsWith('data:')) {
            images.push(url)
            imageIds.push(mediaId)
            uploads.push({ placeholder: mediaId, url })
          }
        }
      }
    }

    messages.push({
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role,
      content: parts,
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
    toolSchemas: new Map(tools.map((tool) => [tool.function.name, tool.function.parameters ?? {}])),
    emulatedTools: tools.length > 0,
    images,
    imageIds,
    uploads,
  }
}

/**
 * Swaps the `upload-N` placeholders for the `media_id`s Venice returned and
 * drops the inline data URLs, which no longer need to travel in the body.
 */
export function applyMediaIds(request, mediaIds) {
  const byPlaceholder = new Map(mediaIds.map((id, index) => [`upload-${index}`, id]))
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type !== 'input_image') continue
      const mediaId = byPlaceholder.get(part.media_id)
      if (mediaId) {
        part.media_id = mediaId
        delete part.image_url
      }
    }
  }
  return [...byPlaceholder.values()]
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

/*
 * Tool-call markup that is not our envelope: DeepSeek's native format
 * (`<｜DSML｜invoke name="...">`, with a full-width or ASCII bar), the XML style
 * other models were trained on (`<invoke>`, `<parameter>`), and invented
 * `<tool_response>` / `<tool_result>` blocks. It is never meant for the user.
 */
const BAR = '[｜|]\\s*DSML\\s*[｜|]'
const MARKUP = new RegExp(
  `<\\/?\\s*(?:${BAR}\\s*)?(?:function_calls|calls|invoke|parameter|tool_calls?|tool_response|tool_result)\\b[^>]*>`,
  'giu',
)
const NATIVE_INVOKE = new RegExp(`<\\s*${BAR}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/\\s*${BAR}\\s*invoke\\s*>`, 'gu')
const NATIVE_PARAMETER = new RegExp(
  `<\\s*${BAR}\\s*parameter\\s+name="([^"]+)"((?:\\s+[\\w-]+="[^"]*")*)\\s*>([\\s\\S]*?)<\\/\\s*${BAR}\\s*parameter\\s*>`,
  'gu',
)

/** A whole `parameter` block, native or XML style (the bar is optional on either tag). */
const PARAMETER_BLOCK = new RegExp(
  `<\\s*(?:${BAR}\\s*)?parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/\\s*(?:${BAR}\\s*)?parameter\\s*>`,
  'giu',
)

/**
 * Removes tool-call markup and invented tool blocks from visible text. A
 * parameter block keeps its text only when it is the turn's `content`; any
 * other parameter is a tool argument and never meant to be read.
 */
export function stripToolMarkup(text) {
  return (text ?? '')
    .replace(PARAMETER_BLOCK, (_, name, inner) => (name === 'content' ? inner : ''))
    .replace(MARKUP, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Tool calls written in DeepSeek's native markup instead of the envelope. Only
 * complete `invoke` blocks count; a half-written tail is just stripped.
 */
export function parseNativeCalls(text) {
  const calls = []
  for (const [, name, body] of (text ?? '').matchAll(NATIVE_INVOKE)) {
    const args = {}
    for (const [, key, attributes, raw] of body.matchAll(NATIVE_PARAMETER)) {
      const literal = /\bstring="false"/.test(attributes)
      let value = raw
      if (literal) {
        try {
          value = JSON.parse(raw)
        } catch {
          value = raw
        }
      }
      args[key] = value
    }
    calls.push({ name, arguments: args })
  }
  return calls
}

const newCallId = () => `call_${randomUUID().replaceAll('-', '')}`.slice(0, 29)

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
 * Structural slips (brackets) are left to `readLenient()`.
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
  // the visible text, when the model wrote one
  const content = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed)
  if (content) {
    try {
      const text = JSON.parse(`"${content[1]}"`).trim()
      if (text) return stripToolMarkup(text)
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.search(/"arguments"\s*:\s*/)
  if (start < 0) return trimmed
  const valueStart = trimmed.slice(start).search(/:\s*/) + start + 1
  let body = trimmed.slice(valueStart).replace(/^\s+/, '')
  // the tool call tail lives after the raw blob: strip it when present
  body = body.replace(/\}?\s*\}?\s*,?\s*$/, '')
  body = body.replace(/\}\s*\]\s*\}?\s*$/, '')
  return stripToolMarkup(body).trim() || trimmed
}

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

const isValidArgString = (value) => {
  try {
    return isPlainObject(JSON.parse(value))
  } catch {
    return false
  }
}

/** An object shaped like our envelope (as opposed to, say, a bare arguments object). */
const isEnvelope = (value) =>
  isPlainObject(value) && (Array.isArray(value.tool_calls) || typeof value.content === 'string')

/**
 * The model sometimes writes a whole envelope *into* the `content` string of
 * another one. The inner one is the real reply.
 */
function unwrapNested(envelope, depth = 0) {
  const hasCalls = Array.isArray(envelope.tool_calls) && envelope.tool_calls.length > 0
  const inner = typeof envelope.content === 'string' ? envelope.content.trim() : ''
  if (depth > 2 || hasCalls || !inner.startsWith('{') || !inner.includes('"tool_calls"')) return envelope
  let value
  try {
    value = JSON.parse(inner)
  } catch {
    try {
      value = readLenient(inner, 0).value
    } catch {
      value = undefined
    }
  }
  if (!isEnvelope(value)) return envelope
  return unwrapNested({ ...value, status: value.status ?? envelope.status }, depth + 1)
}

/** Keys of a call object itself; anything else on it belongs in `arguments`. */
const CALL_KEYS = new Set(['name', 'id', 'type', 'arguments', 'function'])

/** Builds an OpenAI tool call from a parsed envelope entry. */
function buildCall(call) {
  if (!isPlainObject(call)) return null
  let name = call.name
  let args = call.arguments
  // the OpenAI shape, `{"function": {"name", "arguments"}}`, is accepted too
  if (typeof name !== 'string' && isPlainObject(call.function) && typeof call.function.name === 'string') {
    name = call.function.name
    args = call.function.arguments
  }
  if (typeof name !== 'string') return null

  const stray = Object.fromEntries(Object.entries(call).filter(([key]) => !CALL_KEYS.has(key)))
  if (args === undefined) {
    // some models put the arguments at the call's top level
    args = stray
  } else {
    if (typeof args === 'string' && isValidArgString(args)) args = JSON.parse(args)
    if (isPlainObject(args) && Object.keys(stray).length) {
      // `arguments` closed one key too early and the rest landed on the call
      for (const [key, value] of Object.entries(stray)) if (!(key in args)) args[key] = value
    }
  }
  if (typeof args === 'string') {
    // A plain string that is not JSON (raw file content) is passed on as-is,
    // wrapped so the tool sees an object.
    args = { content: args }
  }
  return {
    id: newCallId(),
    type: 'function',
    function: { name, arguments: JSON.stringify(args ?? {}) },
  }
}

/**
 * Collects every envelope in a model reply.
 *
 * Models frequently emit *several* envelopes in one message, or prose followed
 * by an envelope. A plain `JSON.parse` of the whole text loses the tool calls,
 * which is what made the first version of this proxy look like "tools are
 * broken". Content pieces are joined; tool calls are concatenated; the last
 * `status` wins.
 *
 * Each envelope goes through a ladder: strict JSON, the text repairs of
 * `parseLoose()`, the structural repairs of `readLenient()`, and as the very
 * last resort `salvageCalls()`. A reply that looks like an envelope but defeats
 * all of them is flagged `brokenEnvelope`, so it is retried instead of shown.
 */
export function extractEnvelopes(text) {
  const parts = []
  const tool_calls = []
  let sawEnvelope = false
  let brokenEnvelope = false
  let status
  let pending = ''
  let index = 0

  while (index < text.length) {
    const start = text.indexOf('{', index)
    if (start < 0) {
      pending += text.slice(index)
      break
    }
    if (start > index) pending += text.slice(index, start)
    let end = scanObject(text, start)
    let slice = end > 0 ? text.slice(start, end) : ''
    let parsed = slice ? parseLoose(slice) : null

    if (!isEnvelope(parsed)) {
      // unclosed or misplaced brackets: read it structurally
      try {
        const lenient = readLenient(text, start)
        if (isEnvelope(lenient.value)) {
          parsed = lenient.value
          end = lenient.end
          slice = text.slice(start, end)
        }
      } catch {
        /* not JSON-shaped from here */
      }
    }

    let calls = null
    if (isEnvelope(parsed)) parsed = unwrapNested(parsed)
    let piece = typeof parsed?.content === 'string' ? parsed.content.trim() : ''
    const region = slice || text.slice(start)
    const looksLikeEnvelope = parsed !== null || region.includes('"tool_calls"')

    if (looksLikeEnvelope && !Array.isArray(parsed?.tool_calls) && !piece) {
      // Broken JSON: salvage the tool calls and the leaked text next to them.
      const salvaged = salvageCalls(region)
      if (salvaged.length) {
        calls = salvaged
        piece = cleanLeakedEnvelope(region)
      }
    }

    const isEnvelopeHere =
      looksLikeEnvelope &&
      (Array.isArray(parsed?.tool_calls) || typeof parsed?.content === 'string' || (calls?.length ?? 0) > 0)

    if (!isEnvelopeHere) {
      if (region.trimStart().startsWith('{"content"') || /^\{\s*"(?:content|tool_calls|status)"\s*:/.test(region)) {
        // an envelope we could not read at all: do not show its raw JSON
        brokenEnvelope = true
        if (pending.trim()) parts.push(pending.trim())
        pending = ''
        const leaked = cleanLeakedEnvelope(region)
        if (leaked && !leaked.startsWith('{')) parts.push(leaked)
        break
      }
      // Not an envelope: keep the brace as prose and keep scanning after it.
      pending += '{'
      index = start + 1
      continue
    }

    sawEnvelope = true
    if (typeof parsed?.status === 'string' && STATUSES.has(parsed.status.trim().toLowerCase())) {
      status = parsed.status.trim().toLowerCase()
    }
    if (pending.trim()) parts.push(pending.trim())
    pending = ''
    if (piece) parts.push(piece)

    const rawCalls = calls ?? parsed.tool_calls ?? []
    for (const call of rawCalls) {
      const built = buildCall(call)
      if (built) tool_calls.push(built)
    }
    index = end > 0 ? end : text.length
  }

  if (pending.trim()) parts.push(pending.trim())

  if (!tool_calls.length) {
    // DeepSeek's native markup, when the model used it instead of the envelope
    for (const call of parseNativeCalls(text)) {
      const built = buildCall(call)
      if (built) tool_calls.push(built)
    }
    if (tool_calls.length) sawEnvelope = true
  }

  return { content: stripToolMarkup(parts.join('\n')), tool_calls, sawEnvelope, brokenEnvelope, status }
}

/**
 * Turns a raw model reply into `{ content, tool_calls, sawEnvelope, brokenEnvelope, status }`.
 * `sawEnvelope: false` means the model ignored the format entirely.
 */
export function parseToolReply(text) {
  const envelope = extractEnvelopes(text)
  if (!envelope.sawEnvelope) {
    return {
      content: envelope.brokenEnvelope ? envelope.content : stripToolMarkup(text.trim()),
      tool_calls: null,
      sawEnvelope: false,
      brokenEnvelope: envelope.brokenEnvelope,
      status: undefined,
    }
  }
  return {
    content: envelope.content,
    tool_calls: envelope.tool_calls.length ? envelope.tool_calls : null,
    sawEnvelope: true,
    brokenEnvelope: envelope.brokenEnvelope && !envelope.tool_calls.length,
    status: envelope.status,
  }
}

/**
 * Maps invented tool names onto available ones and lists what makes a call
 * impossible to execute: an unknown tool, arguments that are not an object, or
 * a missing required argument (from the tool's own JSON schema, as OpenCode
 * sent it). Sets `message.problems`; returns the renames for logging.
 *
 * @param {{ tool_calls: object[]|null, problems?: string[] }} message
 * @param {Map<string, object>} schemas tool name -> JSON schema of its parameters
 */
export function inspectCalls(message, schemas) {
  message.problems = []
  const renames = []
  if (!message.tool_calls || !schemas?.size) return renames
  const available = new Set(schemas.keys())
  for (const call of message.tool_calls) {
    const original = call.function.name
    const name = normalizeToolName(original, available)
    if (name !== original) {
      call.function.name = name
      renames.push(`${original} -> ${name}`)
    }
    if (!available.has(name)) {
      message.problems.push(`there is no tool named "${name}"`)
      continue
    }
    let args
    try {
      args = JSON.parse(call.function.arguments)
    } catch {
      args = undefined
    }
    if (!isPlainObject(args)) {
      message.problems.push(`${name}: "arguments" must be a JSON object`)
      continue
    }
    const required = Array.isArray(schemas.get(name)?.required) ? schemas.get(name).required : []
    const missing = required.filter((key) => !(key in args))
    if (missing.length) message.problems.push(`${name}: missing required argument ${missing.map((key) => `"${key}"`).join(', ')}`)
  }
  return renames
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
  return raw.startsWith('{') ? '' : stripToolMarkup(raw)
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
