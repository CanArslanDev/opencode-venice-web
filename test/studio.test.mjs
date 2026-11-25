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
  fitStudioLimits,
  imageSize,
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
    width: 1344,
    height: 752,
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
  assert.equal(parseSeed(999999999), 999999999)
  for (const bad of [-1, 1.5, 1_000_000_000, 2 ** 31, 'x']) assert.throws(() => parseSeed(bad), ImageRequestError)
  assert.equal(parseOutputFormat(undefined), 'png')
  assert.equal(parseOutputFormat('webp'), 'webp')
  assert.throws(() => parseOutputFormat('jpeg'), /png or webp/)
})

test('a fixed seed gives n consecutive seeds, so n pictures differ but repeat', () => {
  assert.deepEqual(studioSeeds(3, 10), [10, 11, 12])
  assert.deepEqual(studioSeeds(1, null, () => 0.5), [499999999])
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

test('random and consecutive seeds stay within the route limit', () => {
  for (const r of [0, 0.5, 0.999999999999]) {
    for (const seed of studioSeeds(4, null, () => r)) assert.ok(seed >= 0 && seed <= 999999999, String(seed))
  }
  assert.deepEqual(studioSeeds(2, 999999999), [999999999, 0])
})

test('sizes above the route limits (1344 a side, 1.5 MP) are scaled down', () => {
  assert.deepEqual(fitStudioLimits(1024, 1024), { width: 1024, height: 1024 })
  assert.deepEqual(fitStudioLimits(1344, 1088), { width: 1344, height: 1088 })
  for (const [w, h] of [[2048, 2048], [1792, 1024], [2560, 1440], [1552, 664]]) {
    const fit = fitStudioLimits(w, h)
    assert.ok(fit.width <= 1344 && fit.height <= 1344 && fit.width * fit.height <= 1_500_000, `${w}x${h} -> ${fit.width}x${fit.height}`)
    assert.ok(Math.abs(fit.width / fit.height - w / h) < 0.05)
  }
  const wide = parseStudioOptions({ aspect_ratio: '21:9' }, 'chroma', IMAGE_MODELS.chroma)
  assert.ok(wide.width <= 1344 && wide.width % 8 === 0, String(wide.width))
  const big = parseStudioOptions({ size: '1792x1024' }, 'wai-illu', IMAGE_MODELS['wai-illu'])
  assert.ok(big.width <= 1344 && big.width % 16 === 0 && big.height % 16 === 0, `${big.width}x${big.height}`)
})

test('fixed-size models: the picture size is reported, a size within the limits is sent', () => {
  const options = parseStudioOptions({ aspect_ratio: '16:9', resolution: '2K' }, 'krea-2-turbo', IMAGE_MODELS['krea-2-turbo'])
  assert.deepEqual([options.width, options.height], [2560, 1440])
  const request = studioImageRequest({ prompt: 'p', model: 'krea-2-turbo', options, seed: 1 })
  assert.equal(request.aspectRatio, '16:9')
  assert.equal(request.resolution, '2K')
  assert.ok(request.width <= 1344 && request.height <= 1344 && request.width * request.height <= 1_500_000)
})

test('imageSize reads PNG and WebP headers', () => {
  const png = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png)
  png.writeUInt32BE(1536, 16)
  png.writeUInt32BE(864, 20)
  assert.deepEqual(imageSize(png), { width: 1536, height: 864 })
  const webp = (chunk, fill) => {
    const data = Buffer.alloc(30)
    data.write('RIFF', 0, 'latin1')
    data.write('WEBP', 8, 'latin1')
    data.write(chunk, 12, 'latin1')
    fill(data)
    return data
  }
  assert.deepEqual(imageSize(webp('VP8X', (d) => { d.writeUIntLE(1023, 24, 3); d.writeUIntLE(767, 27, 3) })), { width: 1024, height: 768 })
  assert.deepEqual(imageSize(webp('VP8 ', (d) => { d.writeUInt16LE(1024, 26); d.writeUInt16LE(1024, 28) })), { width: 1024, height: 1024 })
  assert.deepEqual(imageSize(webp('VP8L', (d) => { d.writeUInt32LE((1023) | (511 << 14), 21) })), { width: 1024, height: 512 })
  assert.equal(imageSize(Buffer.from('not an image')), null)
})
