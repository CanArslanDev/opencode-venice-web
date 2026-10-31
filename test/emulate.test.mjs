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
  isEmptyAnswer,
  parseToolReply,
  preferAnswer,
  reasoningMode,
  shouldRetry,
  textOf,
  toVeniceRequest,
  withRetryReminder,
} from '../src/lib/emulate.mjs'
import { MODELS } from '../src/lib/models.mjs'

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
  const toolMessage = mapping.request.messages[2]
  assert.equal(toolMessage.role, 'user')
  assert.match(toolMessage.content[0].text, /"tool_result"/)
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

test('withRetryReminder appends the given reminder to the system prompt', () => {
  const request = { systemPrompt: { instructions: 'base' } }
  assert.match(withRetryReminder(request, 'SPECIAL').systemPrompt.instructions, /base\n\nREMINDER: SPECIAL/)
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
