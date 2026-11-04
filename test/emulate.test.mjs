/**
 * Unit tests for the pure parts: envelope parsing, request translation,
 * reasoning mapping. Run with `npm test` (node --test).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_MARKER,
  EMPTY_RETRY_REMINDER,
  RETRY_REMINDER,
  TOOL_PROMPT,
  applyFallback,
  extractEnvelopes,
  fallbackAnswerText,
  FAILURE_RETRY_REMINDER,
  BROKEN_ENVELOPE_REMINDER,
  CONTINUE_REMINDER,
  JUDGE_PROMPT,
  buildJudgeRequest,
  inspectCalls,
  isEmptyAnswer,
  judgeDecision,
  lastToolResult,
  normalizeToolName,
  parseJudgeVerdict,
  parseNativeCalls,
  parseToolReply,
  stripToolMarkup,
  preferAnswer,
  cleanLeakedEnvelope,
  reasoningMode,
  repairArguments,
  salvageCalls,
  shouldRetry,
  textOf,
  toVeniceRequest,
  withRetryReminder,
} from '../src/lib/emulate.mjs'
import { MODELS } from '../src/lib/models.mjs'
import * as real from './fixtures/real-replies.mjs'

const tool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } })

test('extractEnvelopes: single clean envelope', () => {
  const out = extractEnvelopes('{"content":"hi","tool_calls":[]}')
  assert.equal(out.sawEnvelope, true)
  assert.equal(out.content, 'hi')
  assert.equal(out.tool_calls.length, 0)
})

test('extractEnvelopes: prose before the envelope is kept', () => {
  const out = extractEnvelopes('thinking…{"content":"answer","tool_calls":[]}')
  assert.equal(out.content, 'thinking…\nanswer')
  assert.equal(out.sawEnvelope, true)
})

test('extractEnvelopes: several concatenated envelopes are merged', () => {
  const text =
    '{"content":"","tool_calls":[{"name":"glob","arguments":{"pattern":"*.py"}}]}' +
    '{"content":"","tool_calls":[{"name":"read","arguments":{"path":"a.py"}}]}'
  const out = extractEnvelopes(text)
  assert.equal(out.tool_calls.length, 2)
  assert.deepEqual(out.tool_calls.map((call) => call.function.name), ['glob', 'read'])
  assert.equal(out.tool_calls[0].function.arguments, '{"pattern":"*.py"}')
})

test('extractEnvelopes: arguments may be at the top level', () => {
  const out = extractEnvelopes('{"tool_calls":[{"name":"shell","command":"ls"}]}')
  assert.equal(out.tool_calls.length, 1)
  assert.equal(out.tool_calls[0].function.arguments, '{"command":"ls"}')
})

test('extractEnvelopes: braces inside strings do not break scanning', () => {
  const out = extractEnvelopes('{"content":"a } b { c","tool_calls":[{"name":"shell","arguments":{"command":"echo \\"}\\" "}}]}')
  assert.equal(out.sawEnvelope, true)
  assert.equal(out.tool_calls.length, 1)
})

test('extractEnvelopes: tool_result tags are stripped', () => {
  const out = extractEnvelopes('{"content":"done <tool_result>x</tool_result> ok","tool_calls":[]}')
  assert.equal(out.content, 'done x ok')
})

test('parseToolReply: plain prose is not an envelope', () => {
  const out = parseToolReply('Tools are broken, let me explain.')
  assert.equal(out.sawEnvelope, false)
  assert.equal(out.tool_calls, null)
  assert.match(out.content, /Tools are broken/)
})

test('parseToolReply: unknown/invalid calls are skipped', () => {
  const out = parseToolReply('{"content":"x","tool_calls":[{"arguments":{}},{"name":"read","arguments":{}}]}')
  assert.equal(out.tool_calls.length, 1)
  assert.equal(out.tool_calls[0].function.name, 'read')
})

test('reasoningMode maps effort values onto the web switches', () => {
  assert.deepEqual(reasoningMode({}), { reasoningMode: 'disabled' })
  assert.deepEqual(reasoningMode({ reasoning_effort: 'none' }), { reasoningMode: 'disabled' })
  assert.deepEqual(reasoningMode({ reasoning_effort: 'medium' }), { reasoningMode: 'adaptive' })
  assert.deepEqual(reasoningMode({ reasoning_effort: 'high' }), { reasoningMode: 'enabled' })
})

test('textOf flattens content parts and marks images', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }]), 'a\n[image]\nb')
  assert.equal(textOf(null), '')
})

test('toVeniceRequest: rejects unknown models', () => {
  assert.throws(() => toVeniceRequest({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }), /unknown model/)
})

test('toVeniceRequest: hides the Code Mode wrappers when real tools exist', () => {
  const mapping = toVeniceRequest({
    model: Object.keys(MODELS)[0],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [tool('read'), tool('execute'), tool('search')],
  })
  assert.deepEqual([...mapping.toolNames], ['read'])
  assert.equal(mapping.emulatedTools, true)
})

test('toVeniceRequest: keeps wrappers when they are the only tools', () => {
  const mapping = toVeniceRequest({
    model: Object.keys(MODELS)[0],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [tool('execute')],
  })
  assert.deepEqual([...mapping.toolNames], ['execute'])
})

test('toVeniceRequest: appends the format reminder as the last user message', () => {
  const mapping = toVeniceRequest({
    model: Object.keys(MODELS)[0],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [tool('read')],
  })
  const last = mapping.request.messages.at(-1)
  assert.equal(last.role, 'user')
  assert.match(last.content[0].text, /^\(format reminder\)/)
})

test('toVeniceRequest: assistant history is re-serialised in envelope form', () => {  const mapping = toVeniceRequest({
    model: Object.keys(MODELS)[0],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file body' },
    ],
    tools: [tool('read')],
  })
  const assistant = mapping.request.messages[1]
  const parsed = JSON.parse(assistant.content[0].text)
  assert.equal(parsed.content, 'hello')
  assert.equal(parsed.tool_calls[0].name, 'read')
  assert.deepEqual(parsed.tool_calls[0].arguments, { path: 'a' })
  assert.equal(parsed.status, 'continue')
  const toolMessage = mapping.request.messages[2]
  assert.equal(toolMessage.role, 'user')
  assert.match(toolMessage.content[0].text, /"tool_result"/)
})

test('toVeniceRequest: a history turn without calls carries status done', () => {
  const mapping = toVeniceRequest({
    model: Object.keys(MODELS)[0],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ],
    tools: [tool('read')],
  })
  assert.equal(JSON.parse(mapping.request.messages[1].content[0].text).status, 'done')
})

// --------------------------------------------------------------- empty replies
//
// A blank assistant turn is stored with no parts at all and makes the session
// look frozen, so emptiness has to be detected and must never win over a real
// answer. These tests pin that behaviour.

const emptyEnvelope = () => parseToolReply('{"content":"","tool_calls":[]}')
const whitespaceEnvelope = () => parseToolReply('{"content":"   ","tool_calls":[]}')
const answerEnvelope = (text) => parseToolReply(`{"content":${JSON.stringify(text)},"tool_calls":[]}`)
const callEnvelope = () => parseToolReply('{"content":"","tool_calls":[{"name":"read","arguments":{"path":"a"}}]}')

test('isEmptyAnswer detects empty and whitespace-only answers', () => {
  assert.equal(isEmptyAnswer(emptyEnvelope()), true)
  assert.equal(isEmptyAnswer(whitespaceEnvelope()), true)
  assert.equal(isEmptyAnswer(answerEnvelope('hi')), false)
  assert.equal(isEmptyAnswer(callEnvelope()), false)
  assert.equal(isEmptyAnswer(null), true)
})

test('preferAnswer: tool calls beat everything', () => {
  assert.equal(preferAnswer(callEnvelope(), answerEnvelope('hi')), true)
  assert.equal(preferAnswer(answerEnvelope('hi'), callEnvelope()), false)
  assert.equal(preferAnswer(callEnvelope(), callEnvelope()), false)
})

test('preferAnswer: a non-empty answer beats an empty one, in both directions', () => {
  assert.equal(preferAnswer(answerEnvelope('real'), emptyEnvelope()), true)
  assert.equal(preferAnswer(emptyEnvelope(), answerEnvelope('real')), false)
})

test('preferAnswer: the compliant envelope wins over prose', () => {
  const prose = parseToolReply('some prose without json')
  assert.equal(preferAnswer(answerEnvelope('hi'), prose), true)
  assert.equal(preferAnswer(prose, answerEnvelope('hi')), false)
})

test('preferAnswer: two real answers keep the first', () => {
  assert.equal(preferAnswer(answerEnvelope('second'), answerEnvelope('first')), false)
})

test('fallbackAnswerText rescues prose but not a bare envelope', () => {
  assert.equal(fallbackAnswerText('  plain prose  '), 'plain prose')
  assert.equal(fallbackAnswerText('{"content":"inside","tool_calls":[]}'), 'inside')
  assert.equal(fallbackAnswerText('{"content":"","tool_calls":[]}'), '')
  assert.equal(fallbackAnswerText('   '), '')
})

test('the tool prompt forbids empty content and the empty reminder exists', () => {
  assert.match(TOOL_PROMPT, /Never send an empty "content"/)
  assert.match(EMPTY_RETRY_REMINDER, /empty/i)
})

test('withRetryReminder appends the reminder as a trailing user message', () => {
  const request = { systemPrompt: { instructions: 'base' }, messages: [{ id: 'x', role: 'user', content: [] }] }
  const retried = withRetryReminder(request, 'SPECIAL')
  assert.equal(retried.systemPrompt.instructions, 'base')
  assert.equal(retried.messages.length, 2)
  const last = retried.messages.at(-1)
  assert.equal(last.role, 'user')
  assert.match(last.content[0].text, /^\(act reminder\) SPECIAL$/)
})

test('shouldRetry: empty replies are always retried, with the empty reminder', () => {
  assert.deepEqual(shouldRetry({ message: emptyEnvelope(), lastRole: 'user' }), {
    retry: true,
    reason: 'empty reply',
    reminder: EMPTY_RETRY_REMINDER,
  })
  // also on a tool-result turn, where the other triggers do not apply
  assert.equal(shouldRetry({ message: emptyEnvelope(), lastRole: 'tool' }).retry, true)
})

test('shouldRetry: prose is retried, tool calls are accepted', () => {
  assert.equal(shouldRetry({ message: parseToolReply('no json here'), lastRole: 'tool' }).retry, true)
  assert.equal(shouldRetry({ message: callEnvelope(), lastRole: 'user' }).retry, false)
})

test('shouldRetry: an answer without tools is accepted on a tool-result turn only', () => {
  assert.equal(shouldRetry({ message: answerEnvelope('done'), lastRole: 'tool' }).retry, false)
  assert.deepEqual(shouldRetry({ message: answerEnvelope('done'), lastRole: 'user' }), {
    retry: true,
    reason: 'envelope without tool calls',
    reminder: RETRY_REMINDER,
  })
})

test('applyFallback never leaves a blank turn', () => {
  assert.equal(applyFallback(emptyEnvelope(), '{"content":"","tool_calls":[]}').content, EMPTY_MARKER)
  assert.equal(applyFallback(emptyEnvelope(), '  rescued prose  ').content, 'rescued prose')
  assert.equal(applyFallback(answerEnvelope('kept'), 'ignored').content, 'kept')
  assert.equal(applyFallback(callEnvelope(), '').content, '')
})

// ---------------------------------------------------- sloppy model JSON
//
// Real capture: on one turn the model dumped raw file content after
// `"arguments":` with literal line breaks, which made JSON.parse fail, dropped
// both tool calls, and leaked the envelope into the visible answer.

const BROKEN_ENVELOPE = [
  '{"content":"","tool_calls":[{"id":"call_1c0a","name":"write","arguments":',
  'blob.bin ANALIZ RAPORU',
  '=======================',
  '',
  'Dosya: blob.bin',
  'Boyut: 30 bayt',
  '',
  ',"workdir":"/tmp/t13"}},{"id":"call_1c0b","name":"shell","arguments":{"command":"cat rapor.txt","workdir":"/tmp/t13"}}]}',
].join('\n')

test('extractEnvelopes: raw argument blob is repaired, calls survive', () => {
  const out = extractEnvelopes(BROKEN_ENVELOPE)
  assert.equal(out.sawEnvelope, true)
  assert.deepEqual(out.tool_calls.map((call) => call.function.name), ['write', 'shell'])
  assert.match(out.tool_calls[0].function.arguments, /"content":"blob.bin ANALIZ RAPORU/)
  assert.deepEqual(JSON.parse(out.tool_calls[1].function.arguments), { command: 'cat rapor.txt', workdir: '/tmp/t13' })
})

test('extractEnvelopes: the leaked text becomes the visible content', () => {
  const out = extractEnvelopes(BROKEN_ENVELOPE)
  assert.match(out.content, /blob.bin ANALIZ RAPORU/)
  assert.ok(!out.content.includes('"tool_calls"'), 'envelope scaffolding leaked into content')
})

test('repairArguments quotes only the raw run', () => {
  const repaired = repairArguments('{"name":"write","arguments":\nraw line\nmore,"path":"a"}')
  assert.deepEqual(JSON.parse(repaired), { name: 'write', arguments: 'raw line\nmore', path: 'a' })
})

test('salvageCalls handles a broken object and keeps JSON arguments intact', () => {
  const calls = salvageCalls('{"name":"shell","arguments":{"command":"ls -la","workdir":"/x"},"name":"read","arguments":\nraw text,"path":"b"}')
  assert.deepEqual(calls.map((call) => call.name), ['shell', 'read'])
  assert.deepEqual(calls[0].arguments, { command: 'ls -la', workdir: '/x' })
  assert.deepEqual(calls[1].arguments, { content: 'raw text' })
})

test('extractEnvelopes: literal newlines and trailing commas are tolerated', () => {
  const out = extractEnvelopes('{"content":"line1\nline2","tool_calls":[],}')
  assert.equal(out.sawEnvelope, true)
  assert.equal(out.content, 'line1\nline2')
})

test('cleanLeakedEnvelope leaves normal prose alone', () => {
  assert.equal(cleanLeakedEnvelope('just prose'), 'just prose')
})

test('tool prompt asks for escaped arguments', () => {
  assert.match(TOOL_PROMPT, /arguments" is always a JSON object/)
})

test('normalizeToolName keeps available names and maps invented ones', () => {
  const available = new Set(['shell', 'read', 'write', 'edit', 'grep', 'glob'])
  assert.equal(normalizeToolName('read', available), 'read')
  assert.equal(normalizeToolName('bash', available), 'shell')
  assert.equal(normalizeToolName('run_command', available), 'shell')
  assert.equal(normalizeToolName('cat', available), 'read')
  assert.equal(normalizeToolName('write_file', available), 'write')
  assert.equal(normalizeToolName('str_replace', available), 'edit')
  assert.equal(normalizeToolName('rg', available), 'grep')
  assert.equal(normalizeToolName('list_files', available), 'glob')
})

test('normalizeToolName leaves unknown names and missing targets alone', () => {
  assert.equal(normalizeToolName('todowrite', new Set(['shell', 'read'])), 'todowrite')
  assert.equal(normalizeToolName('bash', new Set(['read'])), 'bash')
  assert.equal(normalizeToolName('bash', new Set()), 'bash')
})

test('lastToolResult finds the newest tool message', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'first' },
    { role: 'assistant', content: 'x' },
    { role: 'tool', content: [{ type: 'text', text: 'newest' }] },
  ]
  assert.equal(lastToolResult(messages), 'newest')
  assert.equal(lastToolResult([{ role: 'user', content: 'x' }]), '')
})


// ------------------------------------------- real broken replies (fixtures)
//
// test/fixtures/real-replies.mjs keeps the exact structure of replies the
// proxy used to lose. Each one must now become complete, executable calls.

const SCHEMAS = new Map([
  ['edit', { type: 'object', required: ['path', 'oldString', 'newString'] }],
  ['shell', { type: 'object', required: ['command'] }],
  ['read', { type: 'object', required: ['path'] }],
  ['glob', { type: 'object', required: ['pattern'] }],
])
const argsOf = (call) => JSON.parse(call.function.arguments)
const checked = (text) => {
  const message = parseToolReply(text)
  inspectCalls(message, SCHEMAS)
  return message
}

test('fixture: a call object that is never closed keeps its call', () => {
  const message = checked(real.MISSING_CALL_BRACE)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'shell')
  assert.deepEqual(Object.keys(argsOf(message.tool_calls[0])), ['command', 'workdir', 'timeout'])
  assert.match(argsOf(message.tool_calls[0]).command, /^node -e '\nconst p=/)
  assert.equal(message.content, 'Syntax and contract checks passed. Now running against the real sources.')
  assert.deepEqual(message.problems, [])
})

test('fixture: arguments closed one key early - newString is put back', () => {
  const message = checked(real.EARLY_ARGUMENTS_CLOSE)
  assert.equal(message.tool_calls.length, 2)
  const first = argsOf(message.tool_calls[0])
  assert.equal(first.path, '/home/user/project/meta/_journal.json')
  assert.match(first.oldString, /"idx": 5\n {4}}\n {2}]\n}$/)
  assert.match(first.newString, /"idx": 6/)
  assert.equal(argsOf(message.tool_calls[1]).path, '/home/user/project/src/writes.ts')
  assert.deepEqual(message.problems, [])
  assert.equal(message.content, '')
})

test('fixture: the same slip on the last call before "]"', () => {
  const message = checked(real.EARLY_ARGUMENTS_CLOSE_LAST)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(argsOf(message.tool_calls[0]).newString, 'The provider throws when every source it tried failed.')
  assert.deepEqual(message.problems, [])
})

test('fixture: a call left open before the next call keeps both calls', () => {
  const message = checked(real.OPEN_CALL_BETWEEN_CALLS)
  assert.equal(message.tool_calls.length, 2)
  assert.equal(argsOf(message.tool_calls[0]).newString, 'const KEPT = 3;\nconst MIN_SCORE = 0.6;')
  assert.match(argsOf(message.tool_calls[1]).oldString, /if \(fragment === ""\) continue;/)
  assert.equal(message.content, 'Now replacing the exact matching with word similarity.')
})

test('fixture: an envelope nested in content is unwrapped and its call runs', () => {
  const message = checked(real.NESTED_ENVELOPE)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(argsOf(message.tool_calls[0]).command, 'npx vitest run src/sources')
  assert.equal(message.content, 'Prettier reformatted the test file, so the suite runs once more.')
})

test('fixture: native DSML markup is never shown', () => {
  const tailed = checked(real.DSML_TAIL)
  assert.equal(tailed.tool_calls.length, 1)
  assert.equal(tailed.content, '')
  const wrapped = checked(real.DSML_CONTENT_WRAPPER)
  assert.equal(wrapped.content, 'Let me read the files using the shell.')
  assert.equal(wrapped.tool_calls[0].function.name, 'read')
  const invented = checked(real.INVENTED_TOOL_RESPONSE)
  assert.equal(invented.content, '')
  assert.equal(invented.tool_calls[0].function.name, 'glob')
})

test('no fixture leaks envelope JSON into the visible text', () => {
  for (const [name, text] of Object.entries(real)) {
    const { content } = parseToolReply(text)
    assert.doesNotMatch(content, /"tool_calls"|"arguments"|DSML|<\/?parameter/, name)
  }
})

// --------------------------------------------- structural envelope repairs

test('lenient reader: unescaped quotes and raw line breaks inside strings', () => {
  const message = parseToolReply('{"content":"","tool_calls":[{"name":"write","arguments":{"path":"a.md","content":"He said "hi" to me\nand left"}}]}')
  assert.equal(argsOf(message.tool_calls[0]).content, 'He said "hi" to me\nand left')
})

test('lenient reader: a missing bracket at the very end', () => {
  const message = parseToolReply('{"content":"ok","status":"continue","tool_calls":[{"name":"read","arguments":{"path":"a"}}')
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.status, 'continue')
})

test('an unreadable envelope is flagged instead of shown raw', () => {
  const message = parseToolReply('{"content":"Running the tests now.","tool_calls":[{"name":"shell","arguments":@@@}]}')
  assert.equal(message.tool_calls?.length ?? 0, 1) // salvaged: the raw blob is kept as content
  const hopeless = parseToolReply('{"content":"Running the tests now.","tool_calls":[ !!! ')
  assert.equal(hopeless.tool_calls, null)
  assert.equal(hopeless.brokenEnvelope, true)
  assert.equal(hopeless.content, 'Running the tests now.')
  assert.deepEqual(shouldRetry({ message: hopeless, lastRole: 'tool' }), {
    retry: true,
    reason: 'unreadable envelope',
    reminder: BROKEN_ENVELOPE_REMINDER,
  })
})

test('the OpenAI call shape and stray call keys are accepted', () => {
  const openai = parseToolReply('{"content":"","tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]}')
  assert.deepEqual(argsOf(openai.tool_calls[0]), { path: 'a' })
  const stray = parseToolReply('{"content":"","tool_calls":[{"name":"shell","arguments":{"command":"ls"},"timeout":5}]}')
  assert.deepEqual(argsOf(stray.tool_calls[0]), { command: 'ls', timeout: 5 })
})

test('parseNativeCalls reads complete DeepSeek invoke blocks', () => {
  const text =
    '<｜DSML｜function_calls>\n<｜DSML｜invoke name="shell">\n<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>\n' +
    '<｜DSML｜parameter name="timeout" string="false">5000</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>'
  assert.deepEqual(parseNativeCalls(text), [{ name: 'shell', arguments: { command: 'ls -la', timeout: 5000 } }])
  const message = parseToolReply(`Listing.\n${text}`)
  assert.equal(message.tool_calls[0].function.name, 'shell')
  assert.equal(message.content, 'Listing.')
})

test('stripToolMarkup keeps prose and drops markup', () => {
  assert.equal(stripToolMarkup('Hallo <tool_response>\n</tool_response> Welt'), 'Hallo \n Welt')
  assert.equal(stripToolMarkup('a < b and c > d'), 'a < b and c > d')
})

// ------------------------------------------------- executable tool calls

test('inspectCalls maps aliases and reports what the agent cannot execute', () => {
  const message = parseToolReply(
    '{"content":"","tool_calls":[{"name":"bash","arguments":{"command":"ls"}},{"name":"view_media","arguments":{"media_ids":["a.png"]}},{"name":"edit","arguments":{"path":"a","oldString":"x"}}]}',
  )
  const renames = inspectCalls(message, SCHEMAS)
  assert.deepEqual(renames, ['bash -> shell'])
  assert.equal(message.tool_calls[0].function.name, 'shell')
  assert.deepEqual(message.problems, ['there is no tool named "view_media"', 'edit: missing required argument "newString"'])
  const decision = shouldRetry({ message, lastRole: 'tool', available: ['shell', 'edit'] })
  assert.equal(decision.retry, true)
  assert.match(decision.reminder, /view_media/)
  assert.match(decision.reminder, /Available tools: shell, edit/)
})

test('inspectCalls without schemas checks nothing', () => {
  const message = parseToolReply('{"content":"","tool_calls":[{"name":"anything","arguments":{}}]}')
  assert.deepEqual(inspectCalls(message, new Map()), [])
  assert.deepEqual(message.problems, [])
})

test('preferAnswer: executable calls beat calls with problems', () => {
  const broken = { tool_calls: [{}], content: '', sawEnvelope: true, problems: ['edit: missing required argument "newString"'] }
  const fixed = { tool_calls: [{}], content: '', sawEnvelope: true, problems: [] }
  assert.equal(preferAnswer(fixed, broken), true)
  assert.equal(preferAnswer(broken, fixed), false)
})

test('toVeniceRequest keeps each tool schema for validation', () => {
  const mapping = toVeniceRequest({
    model: 'deepseek-v4-1-flash-free',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', required: ['path'] } } }],
  })
  assert.deepEqual(mapping.toolSchemas.get('read').required, ['path'])
})

// ------------------------------------------------------- status and judge
//
// Whether a turn may end is decided by structure (`status`) and, after a tool
// result, by the judge - never by matching words in the reply.

const statusReply = (status, content = 'text') => parseToolReply(JSON.stringify({ content, status, tool_calls: [] }))

test('the envelope status is read and normalised', () => {
  assert.equal(statusReply('continue').status, 'continue')
  assert.equal(parseToolReply('{"content":"x","status":" DONE ","tool_calls":[]}').status, 'done')
  assert.equal(parseToolReply('{"content":"x","status":"maybe","tool_calls":[]}').status, undefined)
})

test('shouldRetry: status continue without a tool call is retried in any language', () => {
  for (const content of ['Devam ediyorum.', 'Ich mache weiter.', '続けます。', 'I will now run the tests.']) {
    assert.deepEqual(shouldRetry({ message: statusReply('continue', content), lastRole: 'tool' }), {
      retry: true,
      reason: 'status continue without a tool call',
      reminder: CONTINUE_REMINDER,
    })
  }
})

test('shouldRetry: an answer after a tool result goes to the judge, whatever its words', () => {
  for (const status of ['done', 'ask', undefined]) {
    assert.deepEqual(shouldRetry({ message: statusReply(status, 'Devam ediyorum.'), lastRole: 'tool' }), {
      retry: false,
      judge: true,
    })
  }
})

test('shouldRetry: a question on a user turn is accepted', () => {
  assert.deepEqual(shouldRetry({ message: statusReply('ask', 'Which one?'), lastRole: 'user' }), { retry: false })
})

test('the tool prompt defines status and the multi-line script rule', () => {
  assert.match(TOOL_PROMPT, /"status" is required/)
  assert.match(TOOL_PROMPT, /"continue"/)
  assert.match(TOOL_PROMPT, /write it to a file first/)
  assert.match(TOOL_PROMPT, /Do not ask the user for permission to do what they already asked for/)
})

test('buildJudgeRequest carries the request, the newest tool outputs and the reply', () => {
  const body = {
    model: 'deepseek-v4-1-flash-free',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old request' },
      { role: 'user', content: [{ type: 'text', text: 'Hepsini tamamla, durma' }] },
      { role: 'tool', content: 'first output' },
      { role: 'tool', content: 'second output' },
      { role: 'tool', content: 'Tests 1 failed | 50 passed' },
    ],
  }
  const request = buildJudgeRequest(body, statusReply('done', 'DONE'), 'qwen3-5-35b-a3b')
  assert.equal(request.modelId, 'qwen3-5-35b-a3b')
  assert.equal(request.systemPrompt.instructions, JUDGE_PROMPT)
  assert.equal(request.reasoningMode, 'disabled')
  const text = request.messages[0].content[0].text
  assert.match(text, /USER REQUEST:\nHepsini tamamla, durma/)
  assert.doesNotMatch(text, /old request|first output/)
  assert.match(text, /\[1\] second output\n\n\[2\] Tests 1 failed/)
  assert.match(text, /AGENT REPLY \(declared status: done\):\nDONE/)
})

test('buildJudgeRequest keeps the tail of long texts', () => {
  const long = `${'x'.repeat(5000)}END`
  const body = { messages: [{ role: 'user', content: long }, { role: 'tool', content: long }] }
  const text = buildJudgeRequest(body, statusReply(undefined, long), 'm').messages[0].content[0].text
  assert.ok(text.length < 9000)
  assert.equal((text.match(/END/g) ?? []).length, 3)
})

test('parseJudgeVerdict reads the verdict and rejects anything else', () => {
  assert.deepEqual(parseJudgeVerdict('{"verdict":"stopped_early","reason":"promises to run tests"}'), {
    verdict: 'stopped_early',
    reason: 'promises to run tests',
  })
  assert.equal(parseJudgeVerdict('Sure! {"verdict": "Finished"}').verdict, 'finished')
  assert.equal(parseJudgeVerdict('{"verdict":"maybe"}'), null)
  assert.equal(parseJudgeVerdict('no json'), null)
  assert.equal(parseJudgeVerdict(''), null)
})

test('judgeDecision: only an early stop or an ignored failure is retried', () => {
  assert.equal(judgeDecision('stopped_early').reminder, CONTINUE_REMINDER)
  assert.equal(judgeDecision('ignored_failure').reminder, FAILURE_RETRY_REMINDER)
  for (const verdict of ['finished', 'needs_user', undefined, null]) assert.deepEqual(judgeDecision(verdict), { retry: false })
})
