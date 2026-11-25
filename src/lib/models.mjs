/**
 * Models that venice.ai serves over the web on every plan, i.e. the models the
 * web catalogue flags as `usesCredits: false`. A Pro/Max subscription is
 * unlimited for these in the web chat, and the web inference endpoint does not
 * bill them to the API balance - which is the whole point of this proxy.
 *
 * Exception: `z-ai-glm-5-3-flash` and `deepseek-v4-1-flash` (1017). The catalogue
 * flags them `usesCredits: true`, but the web model picker shows them to a Pro
 * account with the "Pro" tag and no pay-per-use price, like the other free
 * models (checked 2026-11-25). Watch the credit balance after using them.
 *
 * Models that DO cost credits are deliberately left out: on the agent endpoint
 * Venice may silently route them to a free model anyway, so advertising them
 * would be misleading.
 *
 * `reasoning: true` marks models that emit reasoning deltas. `context`/`output`
 * are the web catalogue limits, used to build the OpenCode model config.
 * `vision: true` marks models measured to answer about an attached image
 * (docs/PROTOCOL.md §2b); OpenCode only sends images to those. Models added
 * on 2026-11-25 have not been measured yet and carry no `vision` flag.
 *
 * `deepseek-v4-1-flash-free` is kept as the id although the catalogue now calls
 * the model `deepseek-v4-1-flash-uncensored`: the old id is still listed in its
 * `aliasIds`, and keeping it leaves existing OpenCode configs working.
 */
export const MODELS = {
  'deepseek-v4-1-flash-free': { name: 'DeepSeek V4.1 Flash Uncensored (web)', context: 524288, output: 131072, reasoning: true, vision: true },
  'deepseek-v4-1-flash': { name: 'DeepSeek V4.1 Flash 1017 (web)', context: 1000000, output: 131072, reasoning: true },
  'qwen-3-8-27b': { name: 'Qwen 3.8 27B (web)', context: 262144, output: 65536, reasoning: true, vision: true },
  'qwen3-6-27b': { name: 'Qwen 3.6 27B (web)', context: 256000, output: 65536, reasoning: true, vision: true },
  'qwen3-5-35b-a3b': { name: 'Qwen 3.5 35B A3B (web)', context: 256000, output: 16384, reasoning: true, vision: true },
  'zai-org-glm-5.2': { name: 'GLM 5.2 (web)', context: 1000000, output: 131072, reasoning: true, vision: true },
  'z-ai-glm-5-3-flash': { name: 'GLM 5.3 Flash (web)', context: 1048576, output: 131072, reasoning: true },
  'zai-org-glm-4.7-app': { name: 'GLM 4.7 (web)', context: 198000, output: 16384, reasoning: false },
  'olafangensan-glm-4.7-flash-heretic': { name: 'GLM 4.7 Flash Heretic (web)', context: 200000, output: 24000, reasoning: true },
  'qwen3-coder-480b-a35b-instruct-turbo': { name: 'Qwen 3 Coder 480B Turbo (web)', context: 256000, output: 65536, reasoning: false },
  'qwen3-vl-235b-a22b': { name: 'Qwen3 VL 235B (web)', context: 128000, output: 16384, reasoning: false },
  'nvidia-nemotron-3-ultra-550b-a55b': { name: 'NVIDIA Nemotron 3 Ultra (web)', context: 256000, output: 32768, reasoning: true },
  'nvidia-nemotron-3-nano-30b-a3b': { name: 'NVIDIA Nemotron 3 Nano 30B (web)', context: 128000, output: 16384, reasoning: false },
  'venice-uncensored-1-2': { name: 'Venice Uncensored 1.2 (web)', context: 128000, output: 8192, reasoning: false, vision: true },
  'venice-uncensored-role-play': { name: 'Venice Role Play Uncensored (web)', context: 128000, output: 4096, reasoning: false },
  'google-gemma-4-31b-it': { name: 'Gemma 4 31B Instruct (web)', context: 256000, output: 16384, reasoning: true, vision: true },
  'google-gemma-4-26b-a4b-it': { name: 'Gemma 4 26B A4B Instruct (web)', context: 256000, output: 8192, reasoning: true, vision: true },
  'gemma4-uncensored': { name: 'Gemma 4 Uncensored (web)', context: 256000, output: 8192, reasoning: false, vision: true },
  'aion-labs-aion-3-0': { name: 'Aion 3.0 (web)', context: 128000, output: 32768, reasoning: true, vision: true },
  'aion-labs-aion-3-0-mini': { name: 'Aion 3.0 Mini (web)', context: 128000, output: 32768, reasoning: true, vision: true },
  'deepseek-ai-DeepSeek-V3.2': { name: 'DeepSeek V3.2 (web)', context: 160000, output: 32768, reasoning: true, vision: true },
  'e2ee-qwen3-8-27b': { name: 'Qwen 3.8 27B TEE (web)', context: 262144, output: 8192, reasoning: true, vision: true },
  'e2ee-gpt-oss-120b-p': { name: 'GPT OSS 120B TEE (web)', context: 128000, output: 32768, reasoning: true, vision: true },
  'e2ee-qwen3-6-35b-a3b': { name: 'Qwen 3.6 35B A3B FP8 TEE (web)', context: 32000, output: 4096, reasoning: true, vision: true },
  'e2ee-gemma-4-26b-a4b-uncensored-p': { name: 'Gemma 4 26B A4B Uncensored TEE (web)', context: 64000, output: 4096, reasoning: false, vision: true },
  'e2ee-qwen-2-5-7b-p': { name: 'Qwen 2.5 7B TEE (web)', context: 32000, output: 4096, reasoning: false, vision: true },
  'e2ee-qwen3-vl-30b-a3b-p': { name: 'Qwen3 VL 30B A3B TEE (web)', context: 128000, output: 4096, reasoning: false, vision: true },
}

/** Default model, used by the installer and `sync --default`. */
export const DEFAULT_MODEL = 'deepseek-v4-1-flash-free'

/** Cheap model for titles/summaries. */
export const DEFAULT_SMALL_MODEL = 'qwen3-5-35b-a3b'

export const modelIds = Object.keys(MODELS)

/**
 * Image models that are free (`GET /api/app/models`, section `image`,
 * `usesCredits: false`) *and* that Venice's agent actually runs. The catalogue
 * also lists `stable-diffusion-3.5-rev2`, `lustify-sdxl` and `lustify-v8` as
 * free, but the agent's `generate_image` tool rejects them and falls back to
 * another model ("isn't available", checked 2026-11-16), so they are left out.
 * Images run on the agent route with `paidImagesMode=block` (docs/PROTOCOL.md §5b).
 */
export const IMAGE_MODELS = {
  'z-image-turbo': { name: 'Z-Image Turbo' },
  chroma: { name: 'Chroma' },
  'wai-illu': { name: 'Anime (WAI)' },
}

export const DEFAULT_IMAGE_MODEL = 'z-image-turbo'

/** Free image *editing* models (the catalogue's `inpaint` section). */
export const EDIT_MODELS = {
  'firered-image-edit': { name: 'FireRed' },
  'qwen-edit-uncensored': { name: 'Qwen Edit Uncensored' },
}

export const DEFAULT_EDIT_MODEL = 'firered-image-edit'
