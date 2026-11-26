/**
 * Images that a tool returned (Codex's view_image, a screenshot tool): in the
 * tool message itself, or in a user message right after the tool result. Both
 * must reach the model as images, and the turn must stay a tool turn.
 * docs/PROTOCOL.md §2b ("Images from tool results").
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_NOTE,
  IMAGE_ORDER_PREFIX,
  MAX_IMAGES,
  REMINDER_AFTER_TOOL,
  TOOL_IMAGE_NOTE,
  attachmentIndexes,
  buildJudgeRequest,
  isToolOutputMessage,
  promptTokens,
  requestIndex,
  shouldRetry,
  toVeniceRequest,
  withRetryReminder,
} from '../src/lib/emulate.mjs'
import { DEFAULT_MODEL } from '../src/lib/models.mjs'

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const dataUrl = (b64) => `data:image/png;base64,${b64}`
const image = (b64) => ({ type: 'image_url', image_url: { url: dataUrl(b64) } })
const text = (value) => ({ type: 'text', text: value })
const tool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } })
const users = (request) => request.messages.filter((message) => message.role === 'user')
const call = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } })
const mediaOf = (request) => request.messages.flatMap((message) => message.content).filter((part) => part.type === 'input_image')

const TOOLS = [tool('exec_command'), tool('view_image')]
const ASK = { role: 'user', content: 'Look at ./photo.png, then run echo hi.' }
const VIEW = { role: 'assistant', content: '', tool_calls: [call('v1', 'view_image', '{"path":"./photo.png"}')] }

test('an image inside a tool message is sent as an image, with the tool note, not as [image] text', () => {
  const mapping = toVeniceRequest({
    model: DEFAULT_MODEL,
    tools: TOOLS,
    messages: [ASK, VIEW, { role: 'tool', tool_call_id: 'v1', content: [text('attached ./photo.png'), image(PNG_A)] }],
  })
  assert.equal(mapping.images.length, 1)
  const [, result, reminder] = users(mapping.request)
  const payload = JSON.parse(result.content.find((part) => part.type === 'output_text').text)
  assert.equal(payload.tool_result.tool_call_id, 'v1')
  assert.doesNotMatch(payload.tool_result.content, /\[image\]/)
  assert.match(payload.tool_result.content, /^attached \.\/photo\.png\n\[attached to the last user message as image #1 of 1\]$/)
  // the picture rides on the format reminder, which is still the after-tool one
  assert.equal(reminder.content[0].type, 'input_image')
  assert.equal(reminder.content[0].media_id, mapping.images[0].mediaId)
  assert.ok(reminder.content.some((part) => part.text === `(format reminder) ${REMINDER_AFTER_TOOL}`))
  assert.equal(reminder.content.at(-1).text, TOOL_IMAGE_NOTE)
  assert.ok(!reminder.content.some((part) => part.text === IMAGE_NOTE))
  assert.equal(mediaOf(mapping.request).length, 1)
})

test('a user message holding the image right after the tool result is the tool output, not a new request', () => {
  const messages = [
    ASK,
    VIEW,
    { role: 'tool', tool_call_id: 'v1', content: 'attached ./photo.png' },
    { role: 'user', content: [text('Image from view_image:'), image(PNG_A)] },
  ]
  assert.equal(isToolOutputMessage(messages, 3), true)
  assert.equal(isToolOutputMessage(messages, 0), false)
  assert.equal(requestIndex(messages), 0)
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  const [request, result, carrier, reminder] = users(mapping.request)
  assert.equal(request.content[0].text, 'Look at ./photo.png, then run echo hi.')
  assert.match(result.content[0].text, /^\{"tool_result"/)
  // the carrier reads as tool output, so the after-tool reminder is picked
  assert.match(carrier.content[0].text, /^\{"tool_result":\{"content":"Image from view_image:\\n\[attached to the last user message as image #1 of 1\]/)
  assert.ok(reminder.content.some((part) => part.text === `(format reminder) ${REMINDER_AFTER_TOOL}`))
  assert.equal(reminder.content.at(-1).text, TOOL_IMAGE_NOTE)
  assert.equal(mediaOf(mapping.request).length, 1)
})

test('a user message after a tool result without an image stays a user turn', () => {
  const messages = [ASK, VIEW, { role: 'tool', tool_call_id: 'v1', content: 'ok' }, { role: 'user', content: 'stop, do something else' }]
  assert.equal(isToolOutputMessage(messages, 3), false)
  assert.equal(requestIndex(messages), 3)
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  assert.equal(users(mapping.request)[2].content[0].text, 'stop, do something else')
})

test('the request keeps its own image and tool images come after it; each gets its note', () => {
  const messages = [
    { role: 'user', content: [text('compare with this'), image(PNG_A)] },
    VIEW,
    { role: 'tool', tool_call_id: 'v1', content: [image(PNG_B)] },
  ]
  assert.deepEqual([...attachmentIndexes(messages)], [0, 2])
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  assert.equal(mapping.images.length, 2)
  const last = users(mapping.request).at(-1).content
  assert.deepEqual(last.slice(0, 2).map((part) => part.media_id), mapping.images.map((item) => item.mediaId))
  const order = `${IMAGE_ORDER_PREFIX} #1 from the user's request; #2 output of tool call v1 (photo.png) - the newest.`
  assert.deepEqual(last.slice(-3).map((part) => part.text), [IMAGE_NOTE, TOOL_IMAGE_NOTE, order])
  // a retry moves the images and their notes once, onto the act reminder
  const retried = withRetryReminder(mapping.request).messages
  assert.equal(mediaOf({ messages: retried }).length, 2)
  for (const note of [TOOL_IMAGE_NOTE, order]) {
    assert.equal(retried.flatMap((message) => message.content).filter((part) => part.text === note).length, 1)
  }
  assert.deepEqual(retried.at(-1).content.slice(-2).map((part) => part.text), [TOOL_IMAGE_NOTE, order])
})

test('tool images from an earlier turn stay [image] text once the user moves on', () => {
  const messages = [
    ASK,
    VIEW,
    { role: 'tool', tool_call_id: 'v1', content: [image(PNG_A)] },
    { role: 'assistant', content: 'It is red.' },
    { role: 'user', content: 'thanks, now list the files' },
  ]
  assert.deepEqual([...attachmentIndexes(messages)], [4])
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  assert.deepEqual(mapping.images, [])
  assert.match(users(mapping.request)[1].content[0].text, /\[image\]/)
})

test('the same image from two tool results is sent once, and images past MAX_IMAGES stay [image]', () => {
  const many = Array.from({ length: MAX_IMAGES + 1 }, (_, index) => {
    const bytes = Buffer.from(PNG_A, 'base64')
    return image(Buffer.concat([bytes, Buffer.from([index])]).toString('base64'))
  })
  const messages = [
    ASK,
    { role: 'assistant', content: '', tool_calls: [call('v1', 'view_image'), call('v2', 'view_image')] },
    { role: 'tool', tool_call_id: 'v1', content: [image(PNG_A)] },
    { role: 'tool', tool_call_id: 'v2', content: [image(PNG_A), ...many] },
  ]
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  assert.equal(mapping.images.length, MAX_IMAGES)
  assert.equal(new Set(mapping.images.map((item) => item.mediaId)).size, MAX_IMAGES)
  const second = JSON.parse(users(mapping.request)[2].content.find((part) => part.type === 'output_text').text)
  // splitImages keeps 10 of the second result's 12 (two placeholders); its copy of the first image keeps #1
  assert.equal(second.tool_result.content, '[image]\n[image]\n[attached to the last user message as images #1, #2, #3, #4, #5, #6, #7, #8, #9, #10 of 10]')
})

test('after a tool-output user message a reply without tools goes to the judge, not to a user-turn retry', () => {
  const answer = { content: 'It is red.', tool_calls: null, sawEnvelope: true, status: 'done' }
  assert.equal(shouldRetry({ message: answer, lastRole: 'user' }).retry, true)
  assert.deepEqual(shouldRetry({ message: answer, lastRole: 'tool' }), { retry: false, judge: true })
  // and the judge reads the real request, not the carrier
  const body = {
    messages: [ASK, VIEW, { role: 'tool', tool_call_id: 'v1', content: 'attached' }, { role: 'user', content: [text('Image from view_image:'), image(PNG_A)] }],
  }
  const judged = buildJudgeRequest(body, answer, DEFAULT_MODEL).messages[0].content[0].text
  assert.match(judged, /^USER REQUEST:\nLook at \.\/photo\.png, then run echo hi\./)
})

test('prompt tokens count tool images by pixels, older ones by placeholder', () => {
  const withImage = [ASK, VIEW, { role: 'tool', tool_call_id: 'v1', content: [image(PNG_A)] }]
  const asText = [ASK, VIEW, { role: 'tool', tool_call_id: 'v1', content: '[image]' }]
  assert.ok(promptTokens(withImage) > promptTokens(asText))
  assert.ok(promptTokens(withImage) < 2000)
  assert.equal(promptTokens([...withImage, { role: 'assistant', content: 'red' }, { role: 'user', content: 'next' }]), promptTokens([...asText, { role: 'assistant', content: 'red' }, { role: 'user', content: 'next' }]))
})

const distinct = (index) => {
  const bytes = Buffer.from(PNG_A, 'base64')
  return image(Buffer.concat([bytes, Buffer.from([index])]).toString('base64'))
}

/** A Codex-style edit loop: generate vN, then view_image it as a user message after the (empty) tool result. */
function editLoop(steps, { withRequestImage = false } = {}) {
  const messages = [{ role: 'user', content: withRequestImage ? [text('add a red cushion and compare'), image(PNG_B)] : 'add a red cushion and compare' }]
  for (let step = 1; step <= steps; step++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [call(`g${step}`, 'exec_command', JSON.stringify({ cmd: `edit --output out/cushion-v${step}.png` }))] })
    messages.push({ role: 'tool', tool_call_id: `g${step}`, content: `out/cushion-v${step}.png` })
    messages.push({ role: 'assistant', content: '', tool_calls: [call(`v${step}`, 'view_image', JSON.stringify({ path: `out/cushion-v${step}.png` }))] })
    messages.push({ role: 'tool', tool_call_id: `v${step}`, content: '' })
    messages.push({ role: 'user', content: [text('image output from the preceding tool result(s):'), distinct(step)] })
  }
  return messages
}

test('a series of tool images is numbered, and the order note names each result and the newest', () => {
  const messages = editLoop(3, { withRequestImage: true })
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  assert.equal(mapping.images.length, 4)
  const carriers = users(mapping.request).filter((message) => /image output from the preceding/.test(message.content.find((part) => part.type === 'output_text')?.text ?? ''))
  assert.deepEqual(
    carriers.map((message) => JSON.parse(message.content.find((part) => part.type === 'output_text').text).tool_result.content.split('\n').at(-1)),
    ['[attached to the last user message as image #2 of 4]', '[attached to the last user message as image #3 of 4]', '[attached to the last user message as image #4 of 4]'],
  )
  const last = users(mapping.request).at(-1).content
  // the parts sit in the same order as the numbers
  assert.deepEqual(last.filter((part) => part.type === 'input_image').map((part) => part.media_id), mapping.images.map((item) => item.mediaId))
  assert.equal(
    last.at(-1).text,
    `${IMAGE_ORDER_PREFIX} #1 from the user's request; #2 output of tool call v1 (cushion-v1.png); #3 output of tool call v2 (cushion-v2.png); #4 output of tool call v3 (cushion-v3.png) - the newest.`,
  )
})

test('past MAX_IMAGES the newest tool images are kept, the oldest become [image]', () => {
  const steps = MAX_IMAGES + 2
  const messages = editLoop(steps, { withRequestImage: true })
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages })
  assert.equal(mapping.images.length, MAX_IMAGES)
  const sent = new Set(mapping.images.map((item) => item.mediaId))
  const request = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages: messages.slice(0, 1) })
  // the request's own image always stays
  assert.ok(sent.has(request.images[0].mediaId))
  const newest = toVeniceRequest({ model: DEFAULT_MODEL, tools: TOOLS, messages: [messages[0], ...messages.slice(-5)] })
  assert.ok(newest.images.every((item) => sent.has(item.mediaId)))
  // the three oldest results (12 + 1 request > 10) are placeholders
  const texts = users(mapping.request).map((message) => message.content.find((part) => part.type === 'output_text')?.text ?? '')
  const carriers = texts.filter((value) => value.includes('image output from the preceding'))
  assert.equal(carriers.length, steps)
  assert.deepEqual(carriers.slice(0, 3).map((value) => JSON.parse(value).tool_result.content.split('\n').at(-1)), ['[image]', '[image]', '[image]'])
  assert.match(carriers.at(-1), /as image #10 of 10\]/)
  const order = users(mapping.request).at(-1).content.at(-1).text
  assert.match(order, /#1 from the user's request; #2 output of tool call v4 \(cushion-v4\.png\)/)
  assert.match(order, /#10 output of tool call v12 \(cushion-v12\.png\) - the newest\.$/)
  // the token estimate counts what is sent: placeholders for the dropped ones
  const all = promptTokens(messages)
  const fewer = promptTokens(editLoop(steps - 3, { withRequestImage: true }))
  assert.ok(all - fewer < 300, `${all - fewer}`)
})
