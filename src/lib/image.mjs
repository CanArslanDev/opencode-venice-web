/**
 * Image generation on the web plan.
 *
 * Venice's own client asks the agent endpoint (`/api/inference/chat/agents/venice`)
 * and the backend runs the image server-side: the reply carries a
 * `veniceai:image_generation` item whose bytes arrive as base64 chunks
 * (`veniceai:image_generation.image_chunk`, field `image_chunk_b64`) and ends with
 * `veniceai:image_generation.done`. `?paidImagesMode=block` keeps the agent on the
 * free models; its own choice is `chroma`.
 *
 * The agent ignores a model id unless the prompt names it, so a requested model
 * is appended to the prompt as an instruction rather than sent as a field.
 */
import { MODELS } from './models.mjs'
import { sseReader } from './emulate.mjs'

/** Image models the web catalogue marks `usesCredits: false`. */
export const IMAGE_MODELS = {
  'z-image-turbo': { name: 'Z-Image Turbo (web)' },
  chroma: { name: 'Chroma (web)' },
  'wai-illu': { name: 'WAI Illu (web, anime)' },
  'lustify-v8': { name: 'Lustify v8 (web, anime)' },
  'stable-diffusion-3.5-rev2': { name: 'Stable Diffusion 3.5 (web)' },
}

export const DEFAULT_IMAGE_MODEL = 'z-image-turbo'

export const IMAGE_SIZES = {
  '256x256': [256, 256],
  '512x512': [512, 512],
  '768x768': [768, 768],
  '1024x1024': [1024, 1024],
  '1024x1792': [1024, 1792],
  '1792x1024': [1792, 1024],
}

/** `1024x1792` -> `2:3`; a size the model list does not know stays unsent. */
function aspectOf(size) {
  const pair = IMAGE_SIZES[size]
  if (!pair) return null
  const [width, height] = pair
  const divisor = (a, b) => (b ? divisor(b, a % b) : a)
  const by = divisor(width, height)
  return `${width / by}:${height / by}`
}

/** Builds the prompt the agent reads: the request plus the model instruction. */
export function buildPrompt(prompt, model, size) {
  const parts = [String(prompt ?? '').trim()]
  const named = model && IMAGE_MODELS[model]
  if (named) parts.push(`Use the image model ${model}.`)
  const aspect = size ? aspectOf(size) : null
  if (aspect) parts.push(`Aspect ratio ${aspect}.`)
  return parts.filter(Boolean).join('\n')
}

/**
 * Reads one image out of the agent stream: the media id, the mime type and the
 * bytes. The model also answers with prose, which is dropped.
 */
export async function collectImage(body) {
  const reader = body.getReader()
  const stream = sseReader()
  const image = { mediaId: null, mimeType: null, data: null }
  let requests = null
  try {
    for (;;) {
      const { value, done } = await reader.read()
      for (const event of stream.feed(value, done)) {
        if (event.type === 'error' || event.type === 'response.failed') {
          throw new Error(event.message ?? event.response?.error?.message ?? 'Venice image generation failed')
        }
        const item = event.item
        if (item?.type === 'veniceai:image_generation') {
          if (item.id) image.mediaId = item.id
          if (item.requests) requests = item.requests
          if (item.status === 'failed') throw new Error(`image model failed: ${JSON.stringify(item.requests ?? null).slice(0, 300)}`)
        }
        if (item?.type === 'veniceai:output_image' && item.format && !image.mimeType) image.mimeType = `image/${item.format === 'jpg' ? 'jpeg' : item.format}`
        if (typeof event.image_chunk_b64 === 'string') {
          image.data = Buffer.concat([image.data ?? Buffer.alloc(0), Buffer.from(event.image_chunk_b64, 'base64')])
        }
      }
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!image.data?.length) {
    throw new Error(`the agent returned no image${requests ? `: ${JSON.stringify(requests).slice(0, 300)}` : ''}`)
  }
  image.mimeType ??= 'image/png'
  return { ...image, request: requests?.[0] ?? null }
}

/** Throws unless the model is a free image model, or `null` for the default. */
export function checkModel(model) {
  if (!model) return DEFAULT_IMAGE_MODEL
  if (!IMAGE_MODELS[model]) throw new Error(`unknown image model: ${model}. Known: ${Object.keys(IMAGE_MODELS).join(', ')}`)
  return model
}

export { MODELS }
