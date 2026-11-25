/**
 * Models that venice.ai serves over the web on every plan, i.e. the models the
 * web catalogue flags as `usesCredits: false`. A Pro/Max subscription is
 * unlimited for these in the web chat, and the web inference endpoint does not
 * bill them to the API balance - which is the whole point of this proxy.
 *
 * `z-ai-glm-5-3-flash` and `deepseek-v4-1-flash` (1017) are Pro-only and, like
 * every model here, `usesCredits: false` in `GET /api/app/models` (read live
 * from a Pro session on 2026-11-25; an earlier read had them `true`). Both
 * answer on the web endpoint. The `pricing` block the catalogue shows on every
 * model is the API price, not a web charge.
 *
 * Models that DO cost credits are deliberately left out: on the agent endpoint
 * Venice may silently route them to a free model anyway, so advertising them
 * would be misleading.
 *
 * `reasoning: true` marks models that emit reasoning deltas. `context`/`output`
 * are the web catalogue limits, used to build the OpenCode model config.
 * `vision: true` marks models that read an attached image themselves; OpenCode
 * only sends images to those. Measured 2026-11-25 with a photo of a red apple,
 * checking the model the stream names: on the classic route Venice answers an
 * image sent to a text-only model with Qwen 3.5 35B A3B instead (14 models) or
 * fails (Venice Role Play, HTTP 500), so those are `vision: false`. The
 * earlier "every model reads images and PDFs" result was measured on the agent
 * route, where all of them were DeepSeek V4.1 Flash Uncensored.
 *
 * `route` is the chat route (docs/PROTOCOL.md §2d). The agent route
 * (`/agents/ad-hoc`) runs only the three models marked `route: 'agent'`; for
 * every other id it silently answers with DeepSeek V4.1 Flash Uncensored (24 of the 27
 * models then listed, measured 2026-11-25 from the stream's `model_id`), so those use the
 * classic route (`/api/inference/chat`), which serves the model asked for.
 *
 * `window` is the prompt the classic route really reads, measured with markers
 * every ~5k tokens in a 355k-token prompt: past it the route drops the START of
 * the prompt silently (the system prompt survives) or, on some TEE models,
 * answers 413 `userPromptTooLong`. It is far below the catalogue's
 * `maxContextLength` for most models (about 40k tokens), so it is what OpenCode
 * gets as the context limit, and OpenCode compacts before Venice truncates.
 * Models without `window` read their whole catalogue context (checked up to
 * ~355k tokens; 473k on GLM 5.2).
 *
 * Ids are the catalogue's own `id`s. Ids the catalogue renamed live on in
 * `MODEL_ALIASES` so existing OpenCode configs keep working until the next sync.
 */
export const MODELS = {
  'deepseek-v4-1-flash-uncensored': { name: 'DeepSeek V4.1 Flash Uncensored (web)', route: 'agent', context: 524288, output: 131072, reasoning: true, vision: true },
  'deepseek-v4-1-flash': { name: 'DeepSeek V4.1 Flash 1017 (web)', route: 'agent', context: 1000000, output: 131072, reasoning: true, vision: true },
  'qwen-3-8-27b': { name: 'Qwen 3.8 27B (web)', context: 262144, window: 150000, output: 65536, reasoning: true, vision: true },
  'qwen3-6-27b': { name: 'Qwen 3.6 27B (web)', context: 256000, window: 40000, output: 65536, reasoning: true, vision: true },
  'qwen3-5-35b-a3b': { name: 'Qwen 3.5 35B A3B (web)', context: 256000, window: 40000, output: 16384, reasoning: true, vision: true },
  'zai-org-glm-5.2': { name: 'GLM 5.2 (web)', context: 1000000, output: 131072, reasoning: true, vision: false },
  'z-ai-glm-5-3-flash': { name: 'GLM 5.3 Flash (web)', route: 'agent', context: 1048576, output: 131072, reasoning: true, vision: true },
  'zai-org-glm-4.7-app': { name: 'GLM 4.7 (web)', context: 198000, window: 40000, output: 16384, reasoning: false, vision: false },
  'olafangensan-glm-4.7-flash-heretic': { name: 'GLM 4.7 Flash Heretic (web)', context: 200000, window: 40000, output: 24000, reasoning: true, vision: false },
  'qwen3-coder-480b-a35b-instruct-turbo': { name: 'Qwen 3 Coder 480B Turbo (web)', context: 256000, window: 40000, output: 65536, reasoning: false, vision: false },
  'qwen3-vl-235b-a22b': { name: 'Qwen3 VL 235B (web)', context: 128000, window: 40000, output: 16384, reasoning: false, vision: true },
  'nvidia-nemotron-3-ultra-550b-a55b': { name: 'NVIDIA Nemotron 3 Ultra (web)', context: 256000, window: 40000, output: 32768, reasoning: true, vision: false },
  'nvidia-nemotron-3-nano-30b-a3b': { name: 'NVIDIA Nemotron 3 Nano 30B (web)', context: 128000, window: 40000, output: 16384, reasoning: false, vision: false },
  'venice-uncensored-1-2': { name: 'Venice Uncensored 1.2 (web)', context: 128000, window: 40000, output: 8192, reasoning: false, vision: true },
  'venice-uncensored-role-play': { name: 'Venice Role Play Uncensored (web)', context: 128000, window: 40000, output: 4096, reasoning: false, vision: false },
  'google-gemma-4-31b-it': { name: 'Gemma 4 31B Instruct (web)', context: 256000, window: 40000, output: 16384, reasoning: true, vision: true },
  'google-gemma-4-26b-a4b-it': { name: 'Gemma 4 26B A4B Instruct (web)', context: 256000, window: 40000, output: 8192, reasoning: true, vision: true },
  'gemma4-uncensored': { name: 'Gemma 4 Uncensored (web)', context: 256000, window: 40000, output: 8192, reasoning: false, vision: true },
  'aion-labs-aion-3-0': { name: 'Aion 3.0 (web)', context: 128000, window: 40000, output: 32768, reasoning: true, vision: false },
  'aion-labs-aion-3-0-mini': { name: 'Aion 3.0 Mini (web)', context: 128000, window: 40000, output: 32768, reasoning: true, vision: false },
  'deepseek-ai-DeepSeek-V3.2': { name: 'DeepSeek V3.2 (web)', context: 160000, window: 40000, output: 32768, reasoning: true, vision: false },
  'e2ee-gpt-oss-120b-p': { name: 'GPT OSS 120B TEE (web)', context: 128000, window: 40000, output: 32768, reasoning: true, vision: false },
  'e2ee-qwen3-6-35b-a3b': { name: 'Qwen 3.6 35B A3B FP8 TEE (web)', context: 32000, window: 20000, output: 4096, reasoning: true, vision: false },
  'e2ee-gemma-4-26b-a4b-uncensored-p': { name: 'Gemma 4 26B A4B Uncensored TEE (web)', context: 64000, window: 40000, output: 4096, reasoning: false, vision: false },
  'e2ee-qwen-2-5-7b-p': { name: 'Qwen 2.5 7B TEE (web)', context: 32000, window: 20000, output: 4096, reasoning: false, vision: false },
  'e2ee-qwen3-vl-30b-a3b-p': { name: 'Qwen3 VL 30B A3B TEE (web)', context: 128000, window: 12000, output: 4096, reasoning: false, vision: true },
}

/**
 * The chat route for model `id`: `agent` (`/agents/ad-hoc`) or `classic`
 * (`/api/inference/chat`). `override` is `VENICE_WEB_CHAT_ROUTE` (`auto` keeps
 * the model's own). docs/PROTOCOL.md §2d.
 */
export function routeFor(id, override = 'auto') {
  if (override === 'agent' || override === 'classic') return override
  return MODELS[id]?.route === 'agent' ? 'agent' : 'classic'
}

/** Default model, used by the installer and `sync --default`. */
export const DEFAULT_MODEL = 'deepseek-v4-1-flash-uncensored'

/**
 * Old ids -> current ids. Accepted on requests and migrated by the sync, never
 * advertised. `deepseek-v4-1-flash-free` was renamed by Venice (it is still in
 * the new id's `aliasIds`, checked 2026-11-25).
 */
export const MODEL_ALIASES = {
  'deepseek-v4-1-flash-free': 'deepseek-v4-1-flash-uncensored',
  // answered HTTP 500 on the classic route every time (2026-11-25, 6 tries) and
  // was DeepSeek on the agent route; the same model without TEE works
  'e2ee-qwen3-8-27b': 'qwen-3-8-27b',
}

/** The current id for `id` (itself when it is not an old alias). */
export const resolveModelId = (id) => MODEL_ALIASES[id] ?? id

/** Cheap model for titles/summaries. */
export const DEFAULT_SMALL_MODEL = 'qwen3-5-35b-a3b'

export const modelIds = Object.keys(MODELS)

/**
 * The OpenCode config entry for a text model. Every model here reads documents
 * (measured 2026-11-25: a PDF with a code word, all 27 answered it; .txt and .md
 * too on the ones tried), so `pdf` input is advertised unless a model says
 * `documents: false`. Without it OpenCode does not send an attached PDF.
 */
export function openCodeModel(model) {
  const input = ['text', ...(model.vision ? ['image'] : []), ...(model.documents === false ? [] : ['pdf'])]
  const context = model.window ?? model.context
  // OpenCode compacts at `context - output`; with a small window the full
  // output limit would leave almost no room for the conversation
  const output = model.window ? Math.min(model.output, Math.floor(model.window / 5)) : model.output
  return {
    name: model.name,
    tool_call: true,
    reasoning: model.reasoning,
    ...(input.length > 1 ? { attachment: true, modalities: { input, output: ['text'] } } : {}),
    limit: { context, output },
  }
}

/**
 * Image models that are free (`GET /api/app/models`, section `image`,
 * `usesCredits: false`, or shown without a price in the web model picker).
 *
 * They run on the Studio route (`POST /api/inference/image`, docs/PROTOCOL.md
 * §5c), which takes the model id and every setting directly. `agent: true` marks
 * the ones Venice's agent also runs (`/agents/venice?paidImagesMode=block`,
 * §5b); the agent refuses the others and swaps in another model silently
 * (checked 2026-11-16), so on `VENICE_WEB_IMAGE_ROUTE=agent` only those are
 * offered.
 *
 * Settings mirror the catalogue and were measured one model at a time
 * (2026-11-25, same seed with one setting changed, pixel difference against
 * the base picture): `promptLimit` (longer prompts are refused upstream with
 * "String must contain at most N character(s)"), `steps` default/max
 * (`fixed`: the catalogue's `supportsSteps: false`, and the picture does not
 * change with steps, negative prompt or CFG; Venice ignores them silently),
 * `cfg` scale range (absent: the model takes none), `negativePrompt`,
 * `divisor` (width and height are multiples of it), and for models that only
 * take fixed sizes, `sizes[resolution][aspect]`.
 */
const KREA_SIZES = {
  '1K': {
    '1:1': [1024, 1024], '5:4': [1120, 896], '4:3': [1152, 864], '3:2': [1248, 832], '16:9': [1352, 760], '21:9': [1552, 664],
    '4:5': [896, 1120], '3:4': [864, 1152], '2:3': [832, 1248], '9:16': [760, 1352], '9:21': [664, 1552],
  },
  '2K': {
    '1:1': [2048, 2048], '5:4': [2240, 1792], '4:3': [2240, 1680], '3:2': [2352, 1568], '16:9': [2560, 1440], '21:9': [2688, 1152],
    '4:5': [1792, 2240], '3:4': [1680, 2240], '2:3': [1568, 2352], '9:16': [1440, 2560], '9:21': [1152, 2688],
  },
}

export const IMAGE_MODELS = {
  'z-image-turbo': { name: 'Z-Image Turbo', agent: true, promptLimit: 7500, steps: { default: 8, max: 8, fixed: true }, negativePrompt: false, divisor: 8 },
  chroma: { name: 'Chroma', agent: true, promptLimit: 7500, steps: { default: 10, max: 10, fixed: true }, negativePrompt: false, divisor: 8 },
  'wai-illu': { name: 'Anime (WAI)', agent: true, promptLimit: 1500, steps: { default: 25, max: 30 }, cfg: { default: 5, min: 0, max: 10 }, negativePrompt: true, divisor: 16 },
  'krea-2-turbo': { name: 'Krea 2 Turbo', agent: false, promptLimit: 5000, steps: { default: 8, max: 8, fixed: true }, negativePrompt: false, divisor: 8, sizes: KREA_SIZES, defaultResolution: '1K' },
  'stable-diffusion-3.5-rev2': { name: 'Venice SD35', agent: false, promptLimit: 1500, steps: { default: 25, max: 30 }, cfg: { default: 3.5, min: 0, max: 20 }, negativePrompt: true, divisor: 16 },
  'lustify-sdxl': { name: 'Lustify SDXL', agent: false, promptLimit: 1500, steps: { default: 20, max: 50 }, cfg: { default: 5, min: 0, max: 10 }, negativePrompt: true, divisor: 8 },
  'lustify-v8': { name: 'Lustify v8', agent: false, promptLimit: 1500, steps: { default: 30, max: 50 }, cfg: { default: 3.5, min: 1.5, max: 10 }, negativePrompt: true, divisor: 8 },
}

export const DEFAULT_IMAGE_MODEL = 'z-image-turbo'

/** Free image *editing* models (the catalogue's `inpaint` section). */
export const EDIT_MODELS = {
  'firered-image-edit': { name: 'FireRed' },
  'qwen-edit-uncensored': { name: 'Qwen Edit Uncensored' },
}

export const DEFAULT_EDIT_MODEL = 'firered-image-edit'
