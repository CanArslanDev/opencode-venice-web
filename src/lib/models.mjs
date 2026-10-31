/**
 * Models that venice.ai serves over the web on every plan, i.e. the models the
 * web catalogue flags as `usesCredits: false`. A Pro/Max subscription is
 * unlimited for these in the web chat, and the web inference endpoint does not
 * bill them to the API balance — which is the whole point of this proxy.
 *
 * Models that DO cost credits are deliberately left out: on the agent endpoint
 * Venice may silently route them to a free model anyway, so advertising them
 * would be misleading.
 *
 * `reasoning: true` marks models that emit reasoning deltas. `context`/`output`
 * are the web catalogue limits, used to build the OpenCode model config.
 */
export const MODELS = {
  'deepseek-v4-1-flash-free': { name: 'DeepSeek V4.1 Flash Uncensored (web)', context: 524288, output: 32768, reasoning: true },
  'qwen-3-8-27b': { name: 'Qwen 3.8 27B (web)', context: 262144, output: 65536, reasoning: true },
  'qwen3-6-27b': { name: 'Qwen 3.6 27B (web)', context: 256000, output: 65536, reasoning: true },
  'qwen3-5-35b-a3b': { name: 'Qwen 3.5 35B A3B (web)', context: 256000, output: 16384, reasoning: true },
  'zai-org-glm-5.2': { name: 'GLM 5.2 (web)', context: 1000000, output: 131072, reasoning: true },
  'zai-org-glm-4.6': { name: 'GLM 4.6 (web)', context: 198000, output: 16384, reasoning: false },
  'kimi-k2-5': { name: 'Kimi K2.5 (web)', context: 524288, output: 32768, reasoning: true },
  'venice-uncensored-1-2': { name: 'Venice Uncensored 1.2 (web)', context: 128000, output: 8192, reasoning: false },
  'google-gemma-4-31b-it': { name: 'Gemma 4 31B Instruct (web)', context: 256000, output: 8192, reasoning: true },
  'google-gemma-4-26b-a4b-it': { name: 'Gemma 4 26B A4B Instruct (web)', context: 256000, output: 8192, reasoning: true },
  'gemma4-uncensored': { name: 'Gemma 4 Uncensored (web)', context: 256000, output: 8192, reasoning: false },
  'aion-labs-aion-3-0': { name: 'Aion 3.0 (web)', context: 128000, output: 32768, reasoning: true },
  'aion-labs-aion-3-0-mini': { name: 'Aion 3.0 Mini (web)', context: 128000, output: 32768, reasoning: true },
  'deepseek-ai-DeepSeek-V3.2': { name: 'DeepSeek V3.2 (web)', context: 160000, output: 32768, reasoning: true },
  'e2ee-qwen3-8-27b': { name: 'Qwen 3.8 27B TEE (web)', context: 262144, output: 8192, reasoning: true },
  'e2ee-gpt-oss-120b-p': { name: 'GPT OSS 120B TEE (web)', context: 128000, output: 32768, reasoning: true },
  'e2ee-qwen3-6-35b-a3b': { name: 'Qwen 3.6 35B A3B FP8 TEE (web)', context: 32000, output: 4096, reasoning: true },
  'e2ee-gemma-4-26b-a4b-uncensored-p': { name: 'Gemma 4 26B A4B Uncensored TEE (web)', context: 64000, output: 4096, reasoning: false },
  'e2ee-qwen-2-5-7b-p': { name: 'Qwen 2.5 7B TEE (web)', context: 32000, output: 4096, reasoning: false },
  'e2ee-qwen3-vl-30b-a3b-p': { name: 'Qwen3 VL 30B A3B TEE (web)', context: 128000, output: 4096, reasoning: false },
}

/** Default model, used by the installer and `sync --default`. */
export const DEFAULT_MODEL = 'deepseek-v4-1-flash-free'

/** Cheap model for titles/summaries. */
export const DEFAULT_SMALL_MODEL = 'qwen3-5-35b-a3b'

export const modelIds = Object.keys(MODELS)
