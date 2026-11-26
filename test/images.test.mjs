/**
 * Image input: which images travel as bytes, and how the request carries them.
 * The live protocol is in docs/PROTOCOL.md §2b.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { IMAGE_NOTE, MAX_IMAGES, imageFromDataUrl, splitImages, toVeniceRequest, withImagesLast, withRetryReminder } from '../src/lib/emulate.mjs'
import { multipartBody } from '../src/lib/venice.mjs'
import { DEFAULT_MODEL, MODELS } from '../src/lib/models.mjs'

// two distinct 1x1 PNGs
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const dataUrl = (b64, type = 'image/png') => `data:${type};base64,${b64}`
const image = (url) => ({ type: 'image_url', image_url: { url } })
const text = (value) => ({ type: 'text', text: value })
const tool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } })
const user = (request) => request.messages.filter((message) => message.role === 'user')

test('imageFromDataUrl decodes a base64 image and names it after its bytes', () => {
  const a = imageFromDataUrl(dataUrl(PNG_A))
  assert.equal(a.mimeType, 'image/png')
  assert.deepEqual(a.data, Buffer.from(PNG_A, 'base64'))
  assert.match(a.mediaId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(imageFromDataUrl(dataUrl(PNG_A)).mediaId, a.mediaId)
  assert.notEqual(imageFromDataUrl(dataUrl(PNG_B)).mediaId, a.mediaId)
  // a parameter before `;base64` and an upper-case type are fine
  assert.equal(imageFromDataUrl(`data:Image/PNG;name=a.png;base64,${PNG_A}`).mediaId, a.mediaId)
})

test('imageFromDataUrl refuses what cannot travel as an image', () => {
  assert.equal(imageFromDataUrl('https://example.com/a.png'), null)
  assert.equal(imageFromDataUrl(`data:application/pdf;base64,${PNG_A}`), null)
  assert.equal(imageFromDataUrl('data:image/png,not-base64'), null)
  assert.equal(imageFromDataUrl('data:image/png;base64,'), null)
  assert.equal(imageFromDataUrl(undefined), null)
})

test('splitImages keeps remote URLs as [image] text and drops repeats', () => {
  const { images, text: rest } = splitImages([
    text('compare these'),
    image(dataUrl(PNG_A)),
    { type: 'image_url', image_url: dataUrl(PNG_A) },
    image('https://example.com/b.png'),
    image(dataUrl(PNG_B)),
  ])
  assert.equal(images.length, 2)
  assert.equal(rest, 'compare these\n[image]')
})

test('splitImages stops at MAX_IMAGES; the rest stay text', () => {
  const parts = []
  for (let index = 0; index < MAX_IMAGES + 2; index++) {
    const png = Buffer.from(PNG_A, 'base64')
    png[png.length - 1] ^= index + 1 // a different byte string each time
    parts.push(image(dataUrl(png.toString('base64'))))
  }
  const { images, text: rest } = splitImages(parts)
  assert.equal(images.length, MAX_IMAGES)
  assert.equal(rest, '[image]\n[image]')
})

test('the newest user message carries its images as input_image parts, text without the placeholder', () => {
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: [text('what is this?'), image(dataUrl(PNG_A))] }] })
  const [message] = user(mapping.request)
  assert.equal(message.content[0].type, 'input_image')
  assert.equal(message.content[0].media_id, mapping.images[0].mediaId)
  assert.equal(message.content[0].detail, 'auto')
  assert.equal('image_url' in message.content[0], false)
  assert.equal(message.content[1].text, 'what is this?')
  assert.equal(mapping.images.length, 1)
})

test('an older image stays [image] text and is not resent once the user moves on', () => {
  const mapping = toVeniceRequest({
    model: DEFAULT_MODEL,
    messages: [
      { role: 'user', content: [text('look'), image(dataUrl(PNG_A))] },
      { role: 'assistant', content: 'a red dot' },
      { role: 'user', content: 'thanks, now something else' },
    ],
  })
  assert.deepEqual(mapping.images, [])
  assert.equal(JSON.stringify(mapping.request).includes('input_image'), false)
  assert.equal(user(mapping.request)[0].content[0].text, 'look\n[image]')
})

test('in a tool loop the image rides on the last user message, so the model sees it on every step', () => {
  const mapping = toVeniceRequest({
    model: DEFAULT_MODEL,
    tools: [tool('read')],
    messages: [
      { role: 'user', content: [text('build this screen'), image(dataUrl(PNG_A))] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file a' },
    ],
  })
  assert.equal(mapping.images.length, 1)
  const [request, toolResult, reminder] = user(mapping.request)
  assert.deepEqual(request.content.map((part) => part.type), ['output_text'])
  assert.equal(request.content[0].text, 'build this screen')
  assert.match(toolResult.content[0].text, /^\{"tool_result"/)
  // the reminder after a tool result is still the one picked, and it now carries the image and says whose it is
  assert.equal(reminder.content[0].type, 'input_image')
  assert.equal(reminder.content[0].media_id, mapping.images[0].mediaId)
  assert.match(reminder.content[1].text, /^\(format reminder\) Reply with exactly one JSON object and nothing else\. If more work/)
  assert.equal(reminder.content.at(-1).text, IMAGE_NOTE)
  // a retry appends another user message, and the image moves onto it
  const retried = withRetryReminder(mapping.request).messages
  assert.equal(retried.flatMap((message) => message.content).filter((part) => part.type === 'input_image').length, 1)
  assert.equal(retried.at(-1).content[0].media_id, mapping.images[0].mediaId)
  assert.match(retried.at(-1).content[1].text, /^\(act reminder\)/)
})

test('withImagesLast leaves a request without images alone', () => {
  const messages = [{ role: 'user', content: [{ type: 'output_text', text: 'a' }] }, { role: 'user', content: [{ type: 'output_text', text: 'b' }] }]
  assert.equal(withImagesLast(messages), messages)
})

test('a turn without images has no image parts and no bytes', () => {
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hello' }] })
  assert.deepEqual(mapping.images, [])
  assert.deepEqual(user(mapping.request)[0].content.map((part) => part.type), ['output_text'])
})

test('multipartBody encodes the request and each image as the web client does', async () => {
  const form = new FormData()
  form.append('request', '{"modelId":"x"}')
  form.append('media.abc', new Blob([Buffer.from(PNG_A, 'base64')], { type: 'image/png' }), 'image')
  const { body, contentType } = await multipartBody(form)
  assert.ok(Buffer.isBuffer(body))
  assert.match(contentType, /^multipart\/form-data; boundary=/)
  const back = await new Response(body, { headers: { 'content-type': contentType } }).formData()
  assert.equal(back.get('request'), '{"modelId":"x"}')
  const file = back.get('media.abc')
  assert.equal(file.type, 'image/png')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(PNG_A, 'base64'))
})

test('vision is advertised only where the model itself read the picture', () => {
  // measured 2026-11-25 on each model's own route, checking the serving model:
  // the classic route answers images for the other models with Qwen 3.5 35B
  const vision = Object.entries(MODELS).filter(([, model]) => model.vision).map(([id]) => id)
  assert.deepEqual(vision.sort(), [
    'deepseek-v4-1-flash',
    'deepseek-v4-1-flash-classic',
    'deepseek-v4-1-flash-uncensored',
    'e2ee-qwen3-vl-30b-a3b-p',
    'gemma4-uncensored',
    'google-gemma-4-26b-a4b-it',
    'google-gemma-4-31b-it',
    'qwen-3-8-27b',
    'qwen3-5-35b-a3b',
    'qwen3-6-27b',
    'qwen3-vl-235b-a22b',
    'venice-uncensored-1-2',
    'z-ai-glm-5-3-flash',
    'z-ai-glm-5-3-flash-classic',
  ])
  for (const model of Object.values(MODELS)) assert.equal(typeof model.vision, 'boolean')
})

test('renamed model ids still resolve to the current id', async () => {
  const { MODEL_ALIASES, resolveModelId } = await import('../src/lib/models.mjs')
  assert.equal(resolveModelId('deepseek-v4-1-flash-free'), 'deepseek-v4-1-flash-uncensored')
  assert.equal(resolveModelId('z-ai-glm-5-3-flash'), 'z-ai-glm-5-3-flash')
  assert.equal(resolveModelId('e2ee-qwen3-8-27b'), 'qwen-3-8-27b')
  for (const [old, current] of Object.entries(MODEL_ALIASES)) {
    assert.ok(MODELS[current], `${old} points at a listed model`)
    assert.ok(!MODELS[old], `${old} is not advertised`)
  }
})
