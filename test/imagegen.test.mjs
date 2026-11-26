/**
 * Image generation and editing: request building and the event reader. The
 * event shapes are the ones the agent route sends (docs/PROTOCOL.md §5b).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ImageRequestError,
  MAX_IMAGES_PER_REQUEST,
  agentRequest,
  editInstruction,
  generationInstruction,
  imageCollector,
  imagesResponse,
  parseCount,
  parseResponseFormat,
  parseSize,
  pickEditModel,
  pickImageModel,
  seedsFor,
} from '../src/lib/imagegen.mjs'
import { DEFAULT_EDIT_MODEL, DEFAULT_IMAGE_MODEL } from '../src/lib/models.mjs'

test('pickImageModel: default for none or an OpenAI name, the id when known, 400 otherwise', () => {
  assert.equal(pickImageModel(undefined), DEFAULT_IMAGE_MODEL)
  assert.equal(pickImageModel('dall-e-3'), DEFAULT_IMAGE_MODEL)
  assert.equal(pickImageModel('gpt-image-1'), DEFAULT_IMAGE_MODEL)
  assert.equal(pickImageModel('chroma'), 'chroma')
  assert.throws(() => pickImageModel('nope'), ImageRequestError)
  // free, runs on the Studio route; the agent refuses it and swaps the model
  assert.equal(pickImageModel('lustify-sdxl'), 'lustify-sdxl')
  assert.throws(() => pickImageModel('lustify-sdxl', { route: 'agent' }), /only runs on the Studio route/)
  assert.equal(pickImageModel('chroma', { route: 'agent' }), 'chroma')
})

test('pickEditModel names the edit models when a generate model is asked to edit', () => {
  assert.equal(pickEditModel(undefined), DEFAULT_EDIT_MODEL)
  assert.equal(pickEditModel('qwen-edit-uncensored'), 'qwen-edit-uncensored')
  assert.throws(() => pickEditModel('z-image-turbo'), /generates images but cannot edit one. Edit models: firered-image-edit/)
})

test('parseSize reads WIDTHxHEIGHT, leaves auto to the model and refuses the rest', () => {
  assert.equal(parseSize(undefined), null)
  assert.equal(parseSize('auto'), null)
  assert.deepEqual(parseSize('1792x1024'), { width: 1792, height: 1024 })
  assert.throws(() => parseSize('10x10'), /between 256 and 2048/)
  assert.throws(() => parseSize('4096x4096'), /between 256 and 2048/)
  assert.throws(() => parseSize('large'), /1024x1024/)
})

test('parseCount accepts 1 to MAX_IMAGES_PER_REQUEST, as a number or a form string', () => {
  assert.equal(parseCount(undefined), 1)
  assert.equal(parseCount('2'), 2)
  assert.equal(parseCount(MAX_IMAGES_PER_REQUEST), MAX_IMAGES_PER_REQUEST)
  for (const bad of [0, MAX_IMAGES_PER_REQUEST + 1, 1.5, 'two']) assert.throws(() => parseCount(bad), ImageRequestError)
})

test('parseResponseFormat: b64_json by default, url allowed, nothing else', () => {
  assert.equal(parseResponseFormat(undefined), 'b64_json')
  assert.equal(parseResponseFormat('url'), 'url')
  assert.throws(() => parseResponseFormat('png'), ImageRequestError)
})

test('seedsFor gives no seed for one image and a distinct one per image otherwise', () => {
  assert.deepEqual(seedsFor(1), [null])
  let next = 0
  const seeds = seedsFor(3, () => [0.1, 0.2, 0.3][next++])
  assert.equal(seeds.length, 3)
  assert.equal(new Set(seeds).size, 3)
  for (const seed of seeds) assert.ok(Number.isInteger(seed) && seed >= 0)
})

test('the instructions quote the prompt verbatim and name model, size and seed', () => {
  const prompt = 'a "quoted" word\nand a second line'
  const generate = generationInstruction({ prompt, model: 'chroma', size: { width: 512, height: 768 }, seed: 42 })
  assert.ok(generate.includes(JSON.stringify(prompt)))
  assert.match(generate, /^Call generate_image once with 1 request\./)
  assert.match(generate, /Model \(resource_id\): chroma\. Width 512, height 768\. Seed: 42\. Do not write anything else\.$/)
  assert.doesNotMatch(generationInstruction({ prompt: 'x', model: 'chroma' }), /Width|Seed/)
  const edit = editInstruction({ prompt, model: 'firered-image-edit' })
  assert.match(edit, /^Call edit_image once with 1 request on the attached image\(s\)\./)
  assert.ok(edit.includes(JSON.stringify(prompt)))
})

test('agentRequest puts the reference images before the instruction', () => {
  const body = agentRequest('edit it', [{ mediaId: 'a' }, { mediaId: 'b' }])
  assert.deepEqual(body.clientTools, [])
  const [message] = body.input.messages
  assert.equal(message.role, 'user')
  assert.deepEqual(
    message.content.map((part) => part.media_id ?? part.text),
    ['a', 'b', 'edit it'],
  )
})

// Shapes copied from a real generation (ids shortened).
const generation = (item, content, chunks, { format = 'png', width = 512, height = 512 } = {}) => [
  { type: 'response.output_item.added', output_index: 3, item: { type: 'veniceai:image_generation', id: item, status: 'in_progress', requests: [{ content_index: content, model_id: 'chroma', prompt: 'a duck', dimensions: { width, height }, format }] } },
  { type: 'response.content_part.added', item_id: item, output_index: 3, content_index: content, part: { type: 'veniceai:output_image', format } },
  ...chunks.map(([index, text]) => ({ type: 'veniceai:image_generation.image_chunk', item_id: item, output_index: 3, content_index: content, chunk_index: index, format, image_chunk_b64: Buffer.from(text).toString('base64') })),
  { type: 'response.content_part.done', item_id: item, output_index: 3, content_index: content, part: { type: 'veniceai:output_image', format, is_blurred: false, is_content_violation: false, dimensions: { width, height } } },
  { type: 'veniceai:image_generation.done', item_id: item, output_index: 3, status: 'completed' },
]

test('imageCollector joins the chunks in chunk order and keeps images apart', () => {
  const collector = imageCollector()
  const events = [
    ...generation('A', 0, [[1, 'world'], [0, 'hello ']]),
    ...generation('B', 0, [[0, 'second']], { format: 'jpeg', width: 768, height: 512 }),
    { type: 'response.output_item.added', output_index: 6, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 6, delta: 'Done.' },
    { type: 'response.completed' },
  ]
  for (const event of events) collector.feed(event)
  const { images, text } = collector.result()
  assert.equal(images.length, 2)
  assert.equal(images[0].data.toString(), 'hello world')
  assert.equal(images[0].mimeType, 'image/png')
  assert.deepEqual([images[0].width, images[0].height, images[0].model, images[0].prompt], [512, 512, 'chroma', 'a duck'])
  assert.equal(images[1].data.toString(), 'second')
  assert.equal(images[1].mimeType, 'image/jpeg')
  assert.equal(images[1].width, 768)
  assert.equal(text, 'Done.')
})

test('imageCollector throws the reason of a failed image', () => {
  const failed = imageCollector()
  assert.throws(
    () => failed.feed({ type: 'veniceai:image_generation.content_failed', error: 'upstream error (status 422): unprocessable_source_image' }),
    /image model failed: upstream error \(status 422\)/,
  )
  const item = imageCollector()
  assert.throws(() => item.feed({ type: 'response.output_item.done', item: { type: 'veniceai:image_generation', id: 'A', status: 'failed', error: 'nope' } }), /image model failed/)
  assert.throws(() => imageCollector().feed({ type: 'error', message: 'Stream error' }), /Stream error/)
})

test('imageCollector without image events returns no images and the agent text', () => {
  const collector = imageCollector()
  collector.feed({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } })
  collector.feed({ type: 'response.output_text.delta', output_index: 0, delta: 'that model is not available' })
  assert.deepEqual(collector.result(), { images: [], text: 'that model is not available' })
})

test('imagesResponse answers b64_json or a data URL, with the prompt that was used', () => {
  const images = [{ data: Buffer.from('png bytes'), mimeType: 'image/png', prompt: 'a duck' }]
  const b64 = imagesResponse(images, 'b64_json', 1)
  assert.deepEqual(b64, { created: 1, data: [{ b64_json: Buffer.from('png bytes').toString('base64'), revised_prompt: 'a duck' }] })
  const url = imagesResponse(images, 'url', 1)
  assert.equal(url.data[0].url, `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`)
  assert.equal('b64_json' in url.data[0], false)
})
