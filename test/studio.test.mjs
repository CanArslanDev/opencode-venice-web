/**
 * Image generation on the Studio route: option parsing and the request body
 * (docs/PROTOCOL.md §5c). The field names are the ones the web app's request
 * schema for `/api/inference/image` uses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ImageRequestError } from '../src/lib/imagegen.mjs'
import { IMAGE_MODELS } from '../src/lib/models.mjs'
import {
  parseOutputFormat,
  parseSeed,
  parseStudioOptions,
  resolveDimensions,
  sizeForAspect,
  studioImageMeta,
  studioImageRequest,
  studioSeeds,
} from '../src/lib/studio.mjs'

test('defaults: model steps and CFG, 1024x1024, png, watermark hidden, safe mode on', () => {
  const options = parseStudioOptions({}, 'wai-illu', IMAGE_MODELS['wai-illu'])
  assert.equal(options.steps, 25)
  assert.equal(options.cfgScale, 5)
  assert.equal(options.width, 1024)
  assert.equal(options.height, 1024)
  assert.equal(options.format, 'png')
  assert.equal(options.hideWatermark, true)
  assert.equal(options.safeMode, true)
  assert.equal(options.seed, null)
  // z-image-turbo takes no CFG scale
  assert.equal(parseStudioOptions({}, 'z-image-turbo', IMAGE_MODELS['z-image-turbo']).cfgScale, null)
})

test('every setting reaches the request under the web app field names', () => {
  const info = IMAGE_MODELS['lustify-v8']
  const options = parseStudioOptions(
    { seed: 42, negative_prompt: 'blurry', steps: '12', cfg_scale: 7, style_preset: 'Cinematic', hide_watermark: 'false', safe_mode: false, output_format: 'webp', aspect_ratio: '16:9' },
    'lustify-v8',
    info,
  )
  const request = studioImageRequest({ prompt: 'a cat', model: 'lustify-v8', options, seed: 42 })
  assert.equal(typeof request.requestId, 'string')
  assert.deepEqual({ ...request, requestId: undefined }, {
    requestId: undefined,
    modelId: 'lustify-v8',
    prompt: 'a cat',
    width: 1368,
    height: 768,
    seed: 42,
    steps: 12,
    hideWatermark: false,
    matureFilter: false,
    embedExifMetadata: false,
    format: 'webp',
    type: 'image',
    aspectRatio: '16:9',
    negativePrompt: 'blurry',
    cfgScale: 7,
    stylePreset: 'Cinematic',
  })
})

test('settings a model does not take are refused, not dropped', () => {
  assert.throws(() => parseStudioOptions({ negative_prompt: 'x' }, 'z-image-turbo', IMAGE_MODELS['z-image-turbo']), /does not take a negative prompt/)
  assert.throws(() => parseStudioOptions({ cfg_scale: 3 }, 'chroma', IMAGE_MODELS.chroma), /does not take cfg_scale/)
  assert.throws(() => parseStudioOptions({ steps: 9 }, 'z-image-turbo', IMAGE_MODELS['z-image-turbo']), /from 1 to 8/)
  assert.throws(() => parseStudioOptions({ cfg_scale: 30 }, 'wai-illu', IMAGE_MODELS['wai-illu']), /from 0 to 10/)
  assert.throws(() => parseStudioOptions({ hide_watermark: 'maybe' }, 'chroma', IMAGE_MODELS.chroma), ImageRequestError)
  assert.throws(() => parseStudioOptions({ resolution: '2K' }, 'chroma', IMAGE_MODELS.chroma), /fixed sizes/)
})

test('seed and format validation', () => {
  assert.equal(parseSeed(undefined), null)
  assert.equal(parseSeed('7'), 7)
  for (const bad of [-1, 1.5, 2 ** 31, 'x']) assert.throws(() => parseSeed(bad), ImageRequestError)
  assert.equal(parseOutputFormat(undefined), 'png')
  assert.equal(parseOutputFormat('webp'), 'webp')
  assert.throws(() => parseOutputFormat('jpeg'), /png or webp/)
})

test('a fixed seed gives n consecutive seeds, so n pictures differ but repeat', () => {
  assert.deepEqual(studioSeeds(3, 10), [10, 11, 12])
  assert.deepEqual(studioSeeds(1, null, () => 0.5), [2 ** 30 - 1])
})

test('dimensions: size rounded to the divisor, aspect ratio at about 1 MP', () => {
  assert.deepEqual(resolveDimensions({ divisor: 16 }, { size: '1000x700' }), { width: 1008, height: 704, aspectRatio: null, resolution: null })
  assert.deepEqual(sizeForAspect('1:1', 8), { width: 1024, height: 1024 })
  const tall = sizeForAspect('9:16', 16)
  assert.equal(tall.width % 16, 0)
  assert.ok(tall.height > tall.width)
  assert.throws(() => resolveDimensions({}, { aspectRatio: '7:3' }), /aspect_ratio must be one of/)
})

test('fixed-size models: aspect ratio and resolution pick the size, a size picks the closest shape', () => {
  const info = IMAGE_MODELS['krea-2-turbo']
  assert.deepEqual(resolveDimensions(info, {}), { width: 1024, height: 1024, aspectRatio: '1:1', resolution: '1K' })
  assert.deepEqual(resolveDimensions(info, { aspectRatio: '16:9', resolution: '2k' }), { width: 2560, height: 1440, aspectRatio: '16:9', resolution: '2K' })
  assert.deepEqual(resolveDimensions(info, { size: '1792x1024' }), { width: 1352, height: 760, aspectRatio: '16:9', resolution: '1K' })
  assert.throws(() => resolveDimensions(info, { resolution: '4K' }), /1K, 2K/)
})

test('studioImageMeta reads the model and flags from the headers', () => {
  const meta = studioImageMeta(new Headers({ 'content-type': 'image/webp', 'x-venice-model-id': 'chroma', 'x-venice-is-blurred': 'true' }))
  assert.deepEqual(meta, { mimeType: 'image/webp', model: 'chroma', flags: { is_blurred: true, is_content_violation: false, is_adult_model_content_violation: false } })
})
