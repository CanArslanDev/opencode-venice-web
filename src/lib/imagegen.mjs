/**
 * Image generation and editing on the web plan (docs/PROTOCOL.md §5b).
 *
 * The web app makes images through Venice's own agent: one user message on the
 * agent route, the agent calls its server tool `generate_image` or `edit_image`,
 * and the bytes stream back as base64 chunks. Asked plainly, the agent rewrites
 * the prompt and picks the model and size itself; told to call the tool with the
 * prompt unchanged, a named model and a size, it does exactly that (measured), so
 * the request is that instruction.
 *
 * Pure: builds the agent request and reads the image events. No I/O.
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_EDIT_MODEL, DEFAULT_IMAGE_MODEL, EDIT_MODELS, IMAGE_MODELS } from './models.mjs'

/** Images per request (OpenAI's `n`). */
export const MAX_IMAGES_PER_REQUEST = 4

/** OpenAI's own model names; a client that sends one by default gets the default free model. */
const OPENAI_MODELS = new Set(['dall-e-2', 'dall-e-3', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'])

/** A request the client has to fix (HTTP 400). */
export class ImageRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ImageRequestError'
  }
}

function pickModel(requested, models, fallback, kind) {
  if (requested == null || requested === '' || OPENAI_MODELS.has(requested)) return fallback
  if (typeof requested === 'string' && models[requested]) return requested
  if (kind === 'edit' && IMAGE_MODELS[requested]) {
    throw new ImageRequestError(`${requested} generates images but cannot edit one. Edit models: ${Object.keys(EDIT_MODELS).join(', ')}`)
  }
  throw new ImageRequestError(`unknown ${kind} model: ${requested}. Known: ${Object.keys(models).join(', ')}`)
}

/**
 * The model for a generation; missing or an OpenAI name means the default. On
 * the agent route only the models the agent runs are accepted.
 */
export function pickImageModel(requested, { route = 'studio' } = {}) {
  const model = pickModel(requested, IMAGE_MODELS, DEFAULT_IMAGE_MODEL, 'image')
  if (route === 'agent' && !IMAGE_MODELS[model].agent) {
    const agentModels = Object.keys(IMAGE_MODELS).filter((id) => IMAGE_MODELS[id].agent)
    throw new ImageRequestError(`${model} only runs on the Studio route (unset VENICE_WEB_IMAGE_ROUTE). Agent models: ${agentModels.join(', ')}`)
  }
  return model
}

/** The model for an edit; missing or an OpenAI name means the default. */
export const pickEditModel = (requested) => pickModel(requested, EDIT_MODELS, DEFAULT_EDIT_MODEL, 'edit')

/** `"1024x768"` -> `{ width, height }`; missing or `auto` -> null (the model's default). */
export function parseSize(size) {
  if (size == null || size === '' || size === 'auto') return null
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(size))
  if (!match) throw new ImageRequestError(`size must look like 1024x1024 or be auto, got ${JSON.stringify(size)}`)
  const [width, height] = [Number(match[1]), Number(match[2])]
  if (width < 256 || height < 256 || width > 2048 || height > 2048) {
    throw new ImageRequestError(`size must be between 256 and 2048 on each side, got ${size}`)
  }
  return { width, height }
}

/** OpenAI's `n`: 1 by default, at most `MAX_IMAGES_PER_REQUEST`. */
export function parseCount(n) {
  if (n == null || n === '') return 1
  const count = Number(n)
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES_PER_REQUEST) {
    throw new ImageRequestError(`n must be a whole number from 1 to ${MAX_IMAGES_PER_REQUEST}, got ${JSON.stringify(n)}`)
  }
  return count
}

/** `b64_json` (default) or `url`, which is answered as a data URL: the proxy hosts no files. */
export function parseResponseFormat(format) {
  if (format == null || format === '' || format === 'b64_json') return 'b64_json'
  if (format === 'url') return 'url'
  throw new ImageRequestError(`response_format must be b64_json or url, got ${JSON.stringify(format)}`)
}

/**
 * A seed per image when more than one is asked for, none otherwise. Several
 * requests in one tool call come back as the same picture whatever their seeds,
 * so each image is its own agent call (measured; docs/PROTOCOL.md §5b).
 */
export function seedsFor(n, random = Math.random) {
  if (n === 1) return [null]
  return Array.from({ length: n }, () => Math.floor(random() * 2 ** 31))
}

const seedText = (seed) => (seed == null ? '' : ` Seed: ${seed}.`)

/** The instruction that makes the agent call `generate_image` with exactly these values. */
export function generationInstruction({ prompt, model, size = null, seed = null }) {
  const dimensions = size ? ` Width ${size.width}, height ${size.height}.` : ''
  return (
    `Call generate_image once with 1 request. The request uses exactly this prompt, unchanged and not rewritten: ${JSON.stringify(prompt)}. ` +
    `Model (resource_id): ${model}.${dimensions}${seedText(seed)} Do not write anything else.`
  )
}

/** The instruction that makes the agent call `edit_image` on the attached image(s). */
export function editInstruction({ prompt, model, seed = null }) {
  return (
    `Call edit_image once with 1 request on the attached image(s). The request uses exactly this instruction, unchanged and not rewritten: ${JSON.stringify(prompt)}. ` +
    `Model (resource_id): ${model}.${seedText(seed)} Do not write anything else.`
  )
}

/**
 * The agent request: one user message, the reference images first (their bytes
 * go with the request as multipart, see `upstreamChat`), then the instruction.
 */
export function agentRequest(text, images = []) {
  return {
    input: {
      messages: [
        {
          id: randomUUID(),
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            ...images.map((image) => ({ type: 'input_image', media_id: image.mediaId, detail: 'auto' })),
            { type: 'output_text', text, annotations: [] },
          ],
        },
      ],
    },
    clientTools: [],
  }
}

const MIME_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/**
 * Reads the image events of an agent response. `feed()` takes every SSE event;
 * `result()` returns the images in the order they were started, each with its
 * bytes, type, size and the model and prompt the agent actually used.
 *
 * Throws on a failed generation, with the reason Venice gave.
 */
export function imageCollector() {
  const images = new Map()
  let text = ''
  const textItems = new Set()
  const entry = (itemId, contentIndex) => {
    const key = `${itemId}|${contentIndex ?? 0}`
    if (!images.has(key)) images.set(key, { chunks: new Map(), format: null, width: null, height: null, model: null, prompt: null, flags: {} })
    return images.get(key)
  }
  const describe = (itemId, list) => {
    for (const request of list ?? []) {
      const image = entry(itemId, request.content_index)
      image.model ??= request.model_id ?? null
      image.prompt ??= request.prompt ?? null
    }
  }

  return {
    feed(event) {
      const type = event?.type
      if (type === 'error' || type === 'response.failed') {
        throw new Error(event.message ?? event.error?.message ?? event.response?.error?.message ?? 'Venice image request failed')
      }
      if (type === 'veniceai:image_generation.content_failed') throw new Error(`image model failed: ${event.error ?? 'no reason given'}`)
      if (type === 'veniceai:image_generation.failed' || (event.item?.type === 'veniceai:image_generation' && event.item.status === 'failed')) {
        throw new Error(`image model failed: ${JSON.stringify(event.error ?? event.item?.error ?? 'no reason given').slice(0, 300)}`)
      }
      if (event.item?.type === 'veniceai:image_generation') describe(event.item.id, event.item.requests)
      if (/^veniceai:image_generation\.(in_progress|generating)$/.test(type ?? '')) describe(event.item_id, event.requests)
      if ((type === 'response.content_part.added' || type === 'response.content_part.done') && event.part?.type === 'veniceai:output_image') {
        const image = entry(event.item_id, event.content_index)
        image.format = event.part.format ?? image.format
        if (event.part.dimensions) ({ width: image.width, height: image.height } = event.part.dimensions)
        for (const flag of ['is_blurred', 'is_content_violation', 'is_adult_model_content_violation']) {
          if (flag in event.part) image.flags[flag] = event.part[flag]
        }
      }
      if (type === 'veniceai:image_generation.image_chunk' && typeof event.image_chunk_b64 === 'string') {
        const image = entry(event.item_id, event.content_index)
        image.format ??= event.format ?? null
        image.chunks.set(Number(event.chunk_index ?? image.chunks.size), Buffer.from(event.image_chunk_b64, 'base64'))
      }
      if (type === 'response.output_item.added' && event.item?.type === 'message') textItems.add(event.output_index)
      if (type === 'response.output_text.delta' && textItems.has(event.output_index)) text += event.delta ?? ''
    },
    result() {
      const out = []
      for (const image of images.values()) {
        if (!image.chunks.size) continue
        const data = Buffer.concat([...image.chunks.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk))
        out.push({
          data,
          mimeType: MIME_TYPES[image.format] ?? 'image/png',
          width: image.width,
          height: image.height,
          model: image.model,
          prompt: image.prompt,
          flags: image.flags,
        })
      }
      return { images: out, text }
    },
  }
}

/** The OpenAI images response. */
export function imagesResponse(images, format, created = Math.floor(Date.now() / 1000)) {
  return {
    created,
    data: images.map((image) => {
      const b64 = image.data.toString('base64')
      const item = format === 'url' ? { url: `data:${image.mimeType};base64,${b64}` } : { b64_json: b64 }
      if (image.prompt) item.revised_prompt = image.prompt
      return item
    }),
  }
}
