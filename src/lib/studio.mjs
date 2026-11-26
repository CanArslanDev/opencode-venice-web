/**
 * Image generation on the Studio route (docs/PROTOCOL.md §5c).
 *
 * The web app's Studio page posts one JSON body to `/api/inference/image` and
 * gets the picture back as bytes, with the model that really ran in the
 * `x-venice-model-id` header. Unlike the agent route (§5b) it takes the model
 * and every setting directly: seed, negative prompt, steps, CFG scale, style
 * preset, aspect ratio, resolution, watermark, safe mode and format.
 *
 * Pure: reads the client's options and builds the request. No I/O.
 */
import { randomUUID } from 'node:crypto'
import { checkPromptLimit, ImageRequestError, parseSize } from './imagegen.mjs'

/** Path of the Studio generation route on `outerface.venice.ai`. */
export const STUDIO_IMAGE_PATH = '/api/inference/image'

/** Aspect ratios the web app offers. */
export const ASPECT_RATIOS = ['1:1', '5:4', '4:3', '3:2', '16:9', '21:9', '4:5', '3:4', '2:3', '9:16', '9:21']

/** The route refuses larger seeds ("Number must be less than or equal to 999999999", 2026-11-25). */
/** Largest seed the route takes (measured: 999999999 passes, 1000000000 is a 400). */
export const MAX_SEED = 999_999_999
export const MAX_NEGATIVE_PROMPT = 1500

/** `output_format` values; the route makes no JPEG. */
export const OUTPUT_FORMATS = ['png', 'webp']

/** Defaults of the Studio switches, as `parseStudioOptions()` applies them. */
export const STUDIO_DEFAULTS = { output_format: 'png', hide_watermark: true, safe_mode: true, embed_exif: false }

function bool(value, name, fallback) {
  if (value == null || value === '') return fallback
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  throw new ImageRequestError(`${name} must be true or false, got ${JSON.stringify(value)}`)
}

function number(value, name) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new ImageRequestError(`${name} must be a number, got ${JSON.stringify(value)}`)
  return parsed
}

/** A whole seed from 0 to 2^31-1, or null for a random one. */
export function parseSeed(value) {
  const seed = number(value, 'seed')
  if (seed == null) return null
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new ImageRequestError(`seed must be a whole number from 0 to ${MAX_SEED}, got ${JSON.stringify(value)}`)
  }
  return seed
}

/** `png` (default) or `webp`; the route makes no JPEG. */
export function parseOutputFormat(value) {
  if (value == null || value === '') return STUDIO_DEFAULTS.output_format
  if (OUTPUT_FORMATS.includes(value)) return value
  throw new ImageRequestError(`output_format must be ${OUTPUT_FORMATS.join(' or ')}, got ${JSON.stringify(value)}`)
}

const roundTo = (value, divisor) => Math.max(divisor, Math.round(value / divisor) * divisor)

/**
 * Size limits of the route's schema, for every model (2026-11-25): "Number must
 * be less than or equal to 1344" per side, and "Total pixel count (width ×
 * height) must not exceed 1,500,000".
 */
export const MAX_SIDE = 1344
export const MAX_PIXELS = 1_500_000

/** `width` x `height` scaled down (shape kept) to fit the route's limits, multiples of `divisor`. */
export function fitStudioLimits(width, height, divisor = 8) {
  const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)))
  if (scale === 1) return { width, height }
  const floorTo = (value) => Math.max(divisor, Math.floor((value * scale) / divisor) * divisor)
  return { width: floorTo(width), height: floorTo(height) }
}

/** Width and height for an aspect ratio at about one megapixel, multiples of `divisor`. */
export function sizeForAspect(aspect, divisor = 8, area = 1024 * 1024) {
  const [w, h] = aspect.split(':').map(Number)
  const height = Math.sqrt((area * h) / w)
  return { width: roundTo((height * w) / h, divisor), height: roundTo(height, divisor) }
}

/**
 * The width, height, aspect ratio and resolution for a model. Models with fixed
 * sizes (`sizes`) take an aspect ratio and a resolution; the others take any
 * `size`, or an aspect ratio, rounded to their divisor.
 */
export function resolveDimensions(info, { size, aspectRatio, resolution }) {
  if (aspectRatio != null && aspectRatio !== '' && !ASPECT_RATIOS.includes(aspectRatio)) {
    throw new ImageRequestError(`aspect_ratio must be one of ${ASPECT_RATIOS.join(', ')}, got ${JSON.stringify(aspectRatio)}`)
  }
  const divisor = info.divisor ?? 8
  if (info.sizes) {
    const resolutions = Object.keys(info.sizes)
    const res = resolution == null || resolution === '' ? info.defaultResolution ?? resolutions[0] : String(resolution).toUpperCase()
    if (!info.sizes[res]) throw new ImageRequestError(`resolution must be one of ${resolutions.join(', ')} for this model, got ${JSON.stringify(resolution)}`)
    let aspect = aspectRatio || null
    const wanted = parseSize(size)
    if (!aspect && wanted) {
      // the fixed size whose shape is closest to the one asked for
      const ratio = wanted.width / wanted.height
      aspect = Object.keys(info.sizes[res]).reduce((best, key) => {
        const [w, h] = info.sizes[res][key]
        const [bw, bh] = info.sizes[res][best]
        return Math.abs(Math.log(w / h / ratio)) < Math.abs(Math.log(bw / bh / ratio)) ? key : best
      }, '1:1')
    }
    aspect ??= '1:1'
    const [width, height] = info.sizes[res][aspect]
    return { width, height, aspectRatio: aspect, resolution: res }
  }
  if (resolution != null && resolution !== '') throw new ImageRequestError('resolution is only taken by models with fixed sizes (krea-2-turbo); use size or aspect_ratio')
  const wanted = parseSize(size)
  if (wanted) {
    const rounded = fitStudioLimits(roundTo(wanted.width, divisor), roundTo(wanted.height, divisor), divisor)
    return { ...rounded, aspectRatio: aspectRatio || null, resolution: null }
  }
  if (aspectRatio) {
    const { width, height } = sizeForAspect(aspectRatio, divisor)
    return { ...fitStudioLimits(width, height, divisor), aspectRatio, resolution: null }
  }
  return { width: 1024, height: 1024, aspectRatio: null, resolution: null }
}

/**
 * Reads the generation options of an OpenAI-shaped body for `model`. Names
 * follow OpenAI where it has one (`size`, `output_format`) and snake_case
 * otherwise. A setting the model does not take is a 400, not silently dropped.
 */
export function parseStudioOptions(body, model, info) {
  checkPromptLimit(body.prompt, info, model)
  const options = {
    seed: parseSeed(body.seed),
    format: parseOutputFormat(body.output_format),
    hideWatermark: bool(body.hide_watermark, 'hide_watermark', STUDIO_DEFAULTS.hide_watermark),
    safeMode: bool(body.safe_mode, 'safe_mode', STUDIO_DEFAULTS.safe_mode),
    embedExif: bool(body.embed_exif, 'embed_exif', STUDIO_DEFAULTS.embed_exif),
    stylePreset: body.style_preset == null || body.style_preset === '' ? null : String(body.style_preset),
    negativePrompt: null,
    steps: info.steps?.default ?? 20,
    cfgScale: null,
    ...resolveDimensions(info, { size: body.size, aspectRatio: body.aspect_ratio, resolution: body.resolution }),
  }

  if (body.negative_prompt != null && body.negative_prompt !== '') {
    if (!info.negativePrompt) throw new ImageRequestError(`${model} does not take a negative prompt`)
    if (typeof body.negative_prompt !== 'string' || body.negative_prompt.length > MAX_NEGATIVE_PROMPT) {
      throw new ImageRequestError(`negative_prompt must be text of at most ${MAX_NEGATIVE_PROMPT} characters`)
    }
    options.negativePrompt = body.negative_prompt
  }

  const steps = number(body.steps, 'steps')
  if (steps != null) {
    if (info.steps?.fixed) throw new ImageRequestError(`${model} does not take steps (it always runs ${info.steps.default})`)
    const max = info.steps?.max ?? 50
    if (!Number.isInteger(steps) || steps < 1 || steps > max) throw new ImageRequestError(`steps must be a whole number from 1 to ${max} for ${model}, got ${JSON.stringify(body.steps)}`)
    options.steps = steps
  }

  const cfg = number(body.cfg_scale, 'cfg_scale')
  if (cfg != null) {
    if (!info.cfg) throw new ImageRequestError(`${model} does not take cfg_scale`)
    if (cfg < info.cfg.min || cfg > info.cfg.max) throw new ImageRequestError(`cfg_scale must be from ${info.cfg.min} to ${info.cfg.max} for ${model}, got ${cfg}`)
    options.cfgScale = cfg
  } else if (info.cfg) {
    options.cfgScale = info.cfg.default
  }
  return options
}

/** Seeds for `n` pictures: the given seed, then the next ones; random when none. */
export function studioSeeds(n, seed, random = Math.random) {
  const first = seed ?? Math.floor(random() * MAX_SEED)
  return Array.from({ length: n }, (_, index) => (first + index) % (MAX_SEED + 1))
}

/**
 * The body of one `POST /api/inference/image`, as the Studio page sends it.
 *
 * On fixed-size models the picture's size comes from `aspectRatio` and
 * `resolution` alone (measured: 16:9 at 2K gives 2560x1440 whatever width and
 * height say), but width and height must still pass the schema's limits, so a
 * size above them goes out scaled down.
 */
export function studioImageRequest({ prompt, model, options, seed }) {
  const request = {
    requestId: randomUUID(),
    modelId: model,
    prompt,
    ...fitStudioLimits(options.width, options.height),
    seed,
    steps: options.steps,
    hideWatermark: options.hideWatermark,
    matureFilter: options.safeMode,
    embedExifMetadata: options.embedExif,
    format: options.format,
    type: 'image',
  }
  if (options.aspectRatio) request.aspectRatio = options.aspectRatio
  if (options.resolution) request.resolution = options.resolution
  if (options.negativePrompt) request.negativePrompt = options.negativePrompt
  if (options.cfgScale != null) request.cfgScale = options.cfgScale
  if (options.stylePreset) request.stylePreset = options.stylePreset
  return request
}

const header = (headers, name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]) ?? null

/** Reads the picture's metadata from the response headers. */
export function studioImageMeta(headers) {
  const flag = (name) => header(headers, name) === 'true'
  const type = String(header(headers, 'content-type') ?? 'image/png').split(';')[0].trim()
  return {
    mimeType: type.startsWith('image/') ? type : 'image/png',
    model: header(headers, 'x-venice-model-id'),
    flags: {
      is_blurred: flag('x-venice-is-blurred'),
      is_content_violation: flag('x-venice-is-content-violation'),
      is_adult_model_content_violation: flag('x-venice-is-adult-model-content-violation'),
    },
  }
}

/** Width and height from an image's header (`imageDimensions()` in emulate.mjs). */
export { imageDimensions as imageSize } from './emulate.mjs'
