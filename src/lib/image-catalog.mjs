/**
 * `GET /v1/images/models`: the image models of this instance and the controls
 * each one really takes on the active route, so a client can build its options
 * without guessing.
 *
 * Built from `IMAGE_MODELS` / `EDIT_MODELS` and the same constants the request
 * validation uses (`imagegen.mjs`, `studio.mjs`), so the catalogue cannot drift
 * from what `/v1/images/generations` and `/v1/images/edits` accept. Pure.
 */
import { MAX_IMAGES } from './emulate.mjs'
import { MAX_IMAGES_PER_REQUEST, MAX_REQUEST_SIDE, MIN_SIDE, RESPONSE_FORMATS } from './imagegen.mjs'
import { DEFAULT_EDIT_MODEL, DEFAULT_IMAGE_MODEL, EDIT_MODELS, IMAGE_MODELS } from './models.mjs'
import { ASPECT_RATIOS, MAX_NEGATIVE_PROMPT, MAX_PIXELS, MAX_SEED, MAX_SIDE, OUTPUT_FORMATS, STUDIO_DEFAULTS } from './studio.mjs'

const prompt = (info) => ({ type: 'string', required: true, ...(info.promptLimit ? { max_length: info.promptLimit } : {}) })
const count = () => ({ type: 'integer', default: 1, min: 1, max: MAX_IMAGES_PER_REQUEST })
const responseFormat = () => ({ type: 'enum', options: [...RESPONSE_FORMATS], default: RESPONSE_FORMATS[0] })
const flag = (value) => ({ type: 'boolean', default: value })

/** Controls of one generation model on the Studio route (`parseStudioOptions()`). */
function studioControls(info) {
  const controls = { prompt: prompt(info), n: count(), response_format: responseFormat() }
  if (info.sizes) {
    const resolutions = Object.keys(info.sizes)
    const resolution = info.defaultResolution ?? resolutions[0]
    controls.aspect_ratio = { type: 'enum', options: Object.keys(info.sizes[resolution]), default: '1:1' }
    controls.resolution = { type: 'enum', options: resolutions, default: resolution }
    controls.size = {
      type: 'size',
      min: MIN_SIDE,
      max: MAX_REQUEST_SIDE,
      default: null,
      note: 'picks the closest aspect ratio; the picture size comes from aspect_ratio and resolution',
    }
    controls.sizes = Object.fromEntries(resolutions.map((res) => [res, Object.fromEntries(Object.entries(info.sizes[res]).map(([aspect, [w, h]]) => [aspect, `${w}x${h}`]))]))
  } else {
    controls.size = {
      type: 'size',
      min: MIN_SIDE,
      max: MAX_REQUEST_SIDE,
      multiple_of: info.divisor ?? 8,
      max_side: MAX_SIDE,
      max_pixels: MAX_PIXELS,
      default: '1024x1024',
      note: 'rounded to multiple_of, then scaled down to max_side and max_pixels',
    }
    controls.aspect_ratio = { type: 'enum', options: [...ASPECT_RATIOS], default: null, note: 'about one megapixel; size wins when both are given' }
  }
  controls.seed = { type: 'integer', min: 0, max: MAX_SEED, default: null, note: 'random when omitted; n pictures get seed, seed+1, …' }
  controls.output_format = { type: 'enum', options: [...OUTPUT_FORMATS], default: STUDIO_DEFAULTS.output_format }
  controls.hide_watermark = flag(STUDIO_DEFAULTS.hide_watermark)
  controls.safe_mode = { ...flag(STUDIO_DEFAULTS.safe_mode), note: 'true blurs adult pictures; set false for NSFW on nsfw models' }
  controls.embed_exif = flag(STUDIO_DEFAULTS.embed_exif)
  controls.style_preset = { type: 'string', default: null }
  if (info.negativePrompt) controls.negative_prompt = { type: 'string', max_length: MAX_NEGATIVE_PROMPT, default: null }
  if (!info.steps?.fixed) controls.steps = { type: 'integer', min: 1, max: info.steps?.max ?? 50, default: info.steps?.default ?? 20 }
  if (info.cfg) controls.cfg_scale = { type: 'number', min: info.cfg.min, max: info.cfg.max, default: info.cfg.default }
  return controls
}

/** Controls of one generation model on the agent route (`generationInstruction()`). */
function agentControls(info) {
  return {
    prompt: prompt(info),
    n: count(),
    response_format: responseFormat(),
    size: { type: 'size', min: MIN_SIDE, max: MAX_REQUEST_SIDE, default: null, note: "passed to Venice's agent as asked; the model's default when omitted" },
  }
}

/** Controls of one edit model (always the agent route, `editInstruction()`). */
function editControls(info) {
  return {
    prompt: prompt(info),
    image: { type: 'images', required: true, min: 1, max: MAX_IMAGES, formats: ['png', 'jpeg', 'webp', 'gif'], note: 'multipart files or base64 data URLs; URLs are not fetched' },
    n: count(),
    response_format: responseFormat(),
  }
}

/**
 * The catalogue for `route` (`studio` or `agent`, the active
 * `VENICE_WEB_IMAGE_ROUTE`). On the agent route only the models the agent runs
 * (`agent: true`) are listed, with the controls that route takes.
 */
export function imageModelCatalog(route = 'studio') {
  const generation = Object.entries(IMAGE_MODELS)
    .filter(([, info]) => route !== 'agent' || info.agent)
    .map(([id, info]) => ({
      id,
      object: 'image_model',
      name: info.name,
      default: id === DEFAULT_IMAGE_MODEL,
      nsfw: !!info.nsfw,
      controls: route === 'agent' ? agentControls(info) : studioControls(info),
      ...(route !== 'agent' && info.steps?.fixed ? { fixed: { steps: info.steps.default } } : {}),
    }))
  const edit = Object.entries(EDIT_MODELS).map(([id, info]) => ({
    id,
    object: 'image_edit_model',
    name: info.name,
    default: id === DEFAULT_EDIT_MODEL,
    nsfw: !!info.nsfw,
    controls: editControls(info),
  }))
  return {
    object: 'list',
    route,
    generation: { route, endpoint: '/v1/images/generations', default: DEFAULT_IMAGE_MODEL, data: generation },
    edit: { route: 'agent', endpoint: '/v1/images/edits', default: DEFAULT_EDIT_MODEL, data: edit },
  }
}
