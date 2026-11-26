# opencode-venice-web

**Use your venice.ai *web* subscription - the unlimited one - from OpenCode (or any OpenAI-compatible agent), without spending a cent of API credits.**

Venice's API is metered: a Pro account includes only **$1/month** of API spend and the docs are explicit that "a paid subscription does not include free or unlimited API usage". The venice.ai **web app** is the opposite: text chat on the web models is unlimited on Pro and above.

This project runs a tiny local proxy that talks to the *web app's own* endpoints (`clerk.venice.ai` for the session, `outerface.venice.ai` for inference) using the cookie your browser already has, and exposes the result as a normal OpenAI-compatible endpoint on `127.0.0.1`. Point OpenCode at it and the free web models become the backend.

```
OpenCode ──HTTP──> 127.0.0.1:3456  ──HTTPS + your session cookie──>  outerface.venice.ai
   │                 (this proxy)                                            │
   └── tools ────────────/v1/chat/completions ────────────────────────────────┘
                     venice.ai web models, unlimited
```

- No API key, no credits, no password stored: only the browser's long-lived Clerk `__client` cookie.
- 27 web models included in Pro (DeepSeek, Qwen, GLM, Gemma, NVIDIA Nemotron, Aion, TEE-hosted variants).
- Tool calling works: OpenCode's `read`/`write`/`edit`/`shell`/`glob`/`grep` tools are emulated through a JSON envelope (see [docs/PROTOCOL.md](docs/PROTOCOL.md)).
- Images work: attach a screenshot in OpenCode and the model sees it, also while it works through tool calls.
- Documents work: attach a PDF (`opencode run -f report.pdf`, or drag it in) and Venice reads it server side; .txt, .md, .csv, .json, .docx, .xlsx and the other formats the web app takes go the same way.
- Zero runtime dependencies. Node 22+ and the system `curl` (preinstalled on macOS and most Linux distributions).

---

## Quick start

```sh
git clone https://github.com/CanArslanDev/opencode-venice-web.git
cd opencode-venice-web
./install.sh --default
```

That installs the code to `~/.local/share/opencode-venice-web`, adds the `venice-web` provider to `~/.config/opencode/opencode.json`, starts a background service (launchd or systemd), and signs in by reading the `venice.ai` cookie from Brave/Chrome/Edge/Chromium.

Add `--with-nul-plugin` if you also use other providers from OpenCode (see [NUL bytes](#nul-bytes-and-400-invalid-request)).

Then **restart OpenCode** and pick a model such as `venice-web/deepseek-v4-1-flash-uncensored`.

### Updating

Pull the new version and run `./install.sh` again (it reruns the sync). Updating by hand (`git pull`, `npm install -g .`), run the sync **on the machine where OpenCode runs** and restart OpenCode:

```sh
git pull
venice-web-sync          # or: node src/sync.mjs
```

OpenCode reads the model list, the context limits and the input types from its own `opencode.json`, not from the proxy, so until the sync runs it keeps the old ones (old ids, limits larger than the models really read). The proxy says so: at start-up it checks the `opencode.json` on its own machine, and on each request it warns once about an old model id or a prompt past the model's real limit, which also covers OpenCode on another machine. `venice-web-doctor` reports it too.

If the proxy runs on another machine (a VM, a server) and OpenCode reaches it at `http://<that-host>:3456/v1`, set the address once with `venice-web-sync --base-url http://<that-host>:3456/v1`; later syncs keep a base URL that does not point at this machine. The proxy then needs `VENICE_WEB_HOST=0.0.0.0` (or that host's address) to accept the connection.

Or without cloning:

```sh
curl -fsSL https://raw.githubusercontent.com/CanArslanDev/opencode-venice-web/main/install.sh | sh -s -- --default
```

> The `raw.githubusercontent.com` shortcut only works while the repository is **public**. For a private repo, use the `git clone` flow above (or any mirror you control).

Prefer doing it by hand? Three commands:

```sh
npm install -g .        # or run everything from the checkout with `node src/...`
venice-web-login        # reads the cookie from your browser
venice-web-sync --default   # writes the OpenCode provider
venice-web             # starts the proxy on 127.0.0.1:3456
```

Check everything is wired up:

```sh
node src/doctor.mjs      # or venice-web-doctor
curl -s 127.0.0.1:3456/health
```

---

## How it works

| Step | Endpoint | Notes |
| --- | --- | --- |
| Session cookie | `venice.ai` cookie jar | long-lived Clerk `__client`, read straight out of the browser |
| Session JWT | `POST clerk.venice.ai/v1/client/sessions/<id>/tokens` | ~60 s lifetime, refreshed by the proxy, single-flight |
| Client attestation | `POST outerface.venice.ai/api/app/user/client_attestation/mint` | short-lived token, cached 5 minutes |
| Inference | `POST outerface.venice.ai/api/inference/chat/agents/ad-hoc` (agent route) or `/api/inference/chat` (classic route) | per model, see [Models](#models) |
| Tool calls | emulated | the web endpoint does not accept OpenAI `tools` |

The proxy exposes:

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness + signed-in account |
| `GET /v1/models` | the free web catalogue |
| `POST /v1/chat/completions` | streaming and non-streaming chat, with tool emulation |
| `POST /reload` | drop cached token/attestation (after re-login) |

Full details, including the exact request/response shapes and the tool-emulation protocol, are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

---

## Models

Only models the web catalogue marks as free (`usesCredits: false`) are exposed - picking a credit-billed model through this proxy would silently spend your API balance, so they are left out on purpose. Two exceptions, `z-ai-glm-5-3-flash` and `deepseek-v4-1-flash`: the catalogue flags them as billed, but the web model picker shows them to Pro accounts with no pay-per-use price (checked 2026-11-25). Keep an eye on your credit balance the first time you use them.

| Family | Model ids |
| --- | --- |
| DeepSeek | `deepseek-v4-1-flash-uncensored`, `deepseek-v4-1-flash` (1017), `deepseek-ai-DeepSeek-V3.2` |
| Qwen | `qwen-3-8-27b`, `qwen3-6-27b`, `qwen3-5-35b-a3b`, `qwen3-coder-480b-a35b-instruct-turbo`, `qwen3-vl-235b-a22b` |
| GLM | `z-ai-glm-5-3-flash`, `zai-org-glm-5.2`, `zai-org-glm-4.7-app`, `olafangensan-glm-4.7-flash-heretic` |
| NVIDIA | `nvidia-nemotron-3-ultra-550b-a55b`, `nvidia-nemotron-3-nano-30b-a3b` |
| Gemma | `google-gemma-4-31b-it`, `google-gemma-4-26b-a4b-it`, `gemma4-uncensored` |
| Venice | `venice-uncensored-1-2`, `venice-uncensored-role-play` |
| Aion | `aion-labs-aion-3-0`, `aion-labs-aion-3-0-mini` |
| TEE / E2EE hosted | `e2ee-gpt-oss-120b-p`, `e2ee-qwen3-6-35b-a3b`, `e2ee-gemma-4-26b-a4b-uncensored-p`, `e2ee-qwen-2-5-7b-p`, `e2ee-qwen3-vl-30b-a3b-p` |

### Which model to pick

Picked by what was measured through this proxy (2026-11-25/26): the context each model really reads, whether it reads images itself, and how it did with tool calls. This is not a quality benchmark; try two or three on your own work.

| Use | Model | Context it really reads | Output | Reasoning | Images | Route |
| --- | --- | --- | --- | --- | --- | --- |
| Long coding sessions (best overall) | `deepseek-v4-1-flash` (DeepSeek V4.1 Flash 1017) | ~580k | 131k | yes | yes | agent |
| Long sessions, the largest context | `z-ai-glm-5-3-flash` (GLM 5.3 Flash) | ~640k | 131k | yes | yes | agent |
| Default, fewest refusals | `deepseek-v4-1-flash-uncensored` | ~300k | 131k | yes | yes | agent |
| Large context with `temperature` / `max_tokens` | `zai-org-glm-5.2` (GLM 5.2) | ~470k | 131k | yes | no | classic |
| Medium sessions with images | `qwen-3-8-27b` (Qwen 3.8 27B) | ~150k | 65k | yes | yes | classic |
| Short coding tasks | `qwen3-coder-480b-a35b-instruct-turbo` (Qwen 3 Coder 480B) | ~40k | 65k | no | no | classic |
| Reading screenshots and pictures | `qwen3-vl-235b-a22b` (Qwen3 VL 235B) | ~40k | 16k | no | yes | classic |
| Titles and summaries (`small_model`) | `qwen3-5-35b-a3b` (Qwen 3.5 35B) | ~40k | 16k | yes | yes | classic |

All 26 models take tool calls and documents (PDF, .md, office files). The three agent-route models passed 27/27 tool-call checks; the classic-route models passed the basic checks, but the stress suite has not been run on them yet. Less suited for OpenCode: the Aion models (they sometimes answer with nothing, the proxy retries), the small-context TEE models (`e2ee-qwen3-6-35b-a3b` and `e2ee-qwen-2-5-7b-p` ~20k, `e2ee-qwen3-vl-30b-a3b-p` ~12k) and `venice-uncensored-role-play` (4k output). Every other model reads about 40k tokens; the table in [docs/PROTOCOL.md §2d](docs/PROTOCOL.md) lists them all.

**Which route a model uses.** Venice has two chat routes. The agent route (the web app's agentic chat) really runs only `deepseek-v4-1-flash-uncensored`, `deepseek-v4-1-flash` and `z-ai-glm-5-3-flash`; asked for any other model it quietly answers with DeepSeek V4.1 Flash Uncensored. Every other model therefore goes through the classic route (the web app's ordinary chat), which serves the model you picked. The proxy logs a warning whenever Venice says it answered with a different model. `VENICE_WEB_CHAT_ROUTE=agent` or `classic` forces one route for all models. Measurements: [docs/PROTOCOL.md §2d](docs/PROTOCOL.md).

What that means for each model:

- **Context.** The classic route reads far less than the catalogue says: about 40k tokens for most models (about 150k for `qwen-3-8-27b`, 20k or 12k for some TEE models), and it drops the start of a longer prompt without saying so. The agent route does not truncate but **compacts**: past about 77% of the catalogue context (Venice counts characters / 3.2) it replaces the prompt with a ~5k-character summary, again without an error. Measured limits of the three agent models: `deepseek-v4-1-flash-uncensored` ~300k (catalogue 524k), `deepseek-v4-1-flash` ~580k (1M), `z-ai-glm-5-3-flash` ~640k (1M). The sync gives OpenCode these real limits, so OpenCode compacts the conversation in time, and the proxy logs a warning if Venice compacts anyway. `zai-org-glm-5.2` reads its full context; for long coding sessions use it or one of the three agent models.
- **Output.** The three agent models write up to 131072 tokens (DeepSeek Uncensored even past that on the agent route); the catalogue limit is what OpenCode gets, capped at a fifth of the context window.
- **Images.** Only models that read a picture themselves are marked with `image` input: the three DeepSeek/GLM agent models, `qwen-3-8-27b`, `qwen3-6-27b`, `qwen3-5-35b-a3b`, `qwen3-vl-235b-a22b`, `venice-uncensored-1-2`, the three Gemma models and `e2ee-qwen3-vl-30b-a3b-p`. Venice answers an image sent to any other model with Qwen 3.5 35B instead.
- **Documents.** Every model takes PDFs and the other document types. On the classic route the proxy sends the document's text (Venice extracts it from the PDF first).
- **Sampling.** `temperature`, `top_p` and `max_tokens` work on classic-route models; the agent route ignores them.

`e2ee-qwen3-8-27b` is gone: it failed on every request on the classic route. The old id now points at `qwen-3-8-27b`. Rerun `venice-web-sync` after updating so OpenCode gets the new limits and input types (see [Updating](#updating)).

The catalogue lives in [`src/lib/models.mjs`](src/lib/models.mjs); edit it and rerun `venice-web-sync` if Venice adds models. If the web catalogue ships a model you want, run `GET /v1/models` (or `venice-web-doctor`) after adding it to verify it is reachable.

---

## Image generation and editing

The proxy also answers OpenAI's image routes with the free web image models:

```sh
# generate (default model z-image-turbo; size and n are optional)
curl -s 127.0.0.1:3456/v1/images/generations -H 'content-type: application/json' \
  -d '{"prompt":"a red bicycle against a blue wall","size":"1024x1024"}' \
  | python3 -c 'import sys,json,base64; open("out.png","wb").write(base64.b64decode(json.load(sys.stdin)["data"][0]["b64_json"]))'

# edit (multipart, like the OpenAI SDK sends it)
curl -s 127.0.0.1:3456/v1/images/edits -F image=@photo.png -F 'prompt=make the sky stormy'
```

| | models |
| --- | --- |
| generate | `z-image-turbo` (default), `chroma`, `wai-illu` (anime), `krea-2-turbo`, `stable-diffusion-3.5-rev2`, `lustify-sdxl`, `lustify-v8` |
| edit | `firered-image-edit` (default), `qwen-edit-uncensored` |

Generation goes through the web app's Studio route, which takes the model and its settings directly. Extra fields on `/v1/images/generations`, all optional:

| field | what it does |
| --- | --- |
| `seed` | fixed seed (0 to 999999999); with `n` > 1 the pictures get `seed`, `seed+1`, … The seed used comes back on each `data[]` item |
| `negative_prompt` | what to keep out of the picture (`wai-illu`, `stable-diffusion-3.5-rev2`, `lustify-*`) |
| `aspect_ratio` | `1:1`, `5:4`, `4:3`, `3:2`, `16:9`, `21:9`, `4:5`, `3:4`, `2:3`, `9:16`, `9:21`; instead of `size` |
| `resolution` | `1K` or `2K`, for `krea-2-turbo` (fixed sizes) |
| `steps` | sampling steps, up to the model's maximum (30 for `wai-illu`/SD35, 50 for `lustify-*`); `z-image-turbo`, `chroma` and `krea-2-turbo` run a fixed number and refuse it |
| `cfg_scale` | prompt adherence, for the models that have it (`wai-illu`, SD35, Lustify) |
| `style_preset` | a style name from the web app's style list, e.g. `Cinematic` |
| `hide_watermark` | `true` by default |
| `safe_mode` | Venice's mature filter, `true` by default (adult content is blurred); `false` turns it off |
| `output_format` | `png` (default) or `webp` |
| `embed_exif` | `false` by default |

A setting the model does not take is answered with a 400 instead of being dropped (Venice itself ignores it silently).

What each model takes, measured one setting at a time against the same seed (2026-11-25):

| model | seed | steps | negative_prompt | cfg_scale | style_preset | watermark | webp | prompt limit | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `z-image-turbo` | yes | no | no | no | yes | yes | yes | 7500 | |
| `chroma` | yes | no | no | no | yes | yes | yes | 7500 | output 1.5x the size asked for |
| `wai-illu` | yes | yes | yes | yes | yes | yes | yes | 1500 | |
| `krea-2-turbo` | yes | no | no | no | yes | yes | yes | 5000 | size from `aspect_ratio` + `resolution` |
| `stable-diffusion-3.5-rev2` | yes | yes | yes | yes | yes | yes | yes | 1500 | |
| `lustify-sdxl` | yes | yes | yes | yes | yes | yes | yes | 1500 | |
| `lustify-v8` | yes | yes | yes | yes | yes | yes | yes | 1500 | output 1.5x the size asked for |

The same seed gives the same picture (byte for byte on most models; `wai-illu` and `lustify-sdxl` vary slightly from run to run). `VENICE_WEB_IMAGE_ROUTE=agent` switches back to Venice's agent route (only `z-image-turbo`, `chroma`, `wai-illu`, and none of the settings above).

- The prompt is used as written.
- Sizes from 256 to 2048 per side are accepted, rounded to the model's step (8 or 16 pixels) and scaled down to Venice's limit of 1344 per side and 1.5 MP (`krea-2-turbo` at `2K` still returns up to 2688 pixels: there the size comes from `aspect_ratio` + `resolution`). The size reported back is the picture's own.
- `n` up to 4 runs that many generations in parallel.
- Edits take PNG, JPEG, WebP or GIF as a file or a base64 data URL; image URLs are not downloaded. `mask` is not supported: describe the change in the prompt. Edits still go through the agent route, so the settings above do not apply to them.
- `response_format: "url"` returns a `data:` URL, because the proxy stores nothing.
- OpenAI model names (`dall-e-3`, `gpt-image-1`) get the default model.

## Commands

| Command | What it does |
| --- | --- |
| `node src/proxy.mjs` | run the proxy in the foreground |
| `node src/login.mjs` | (re)read the browser cookie and store the session |
| `node src/login.mjs --browser brave` | pick a browser explicitly |
| `node src/login.mjs --cookie "__client=…" --ua "Mozilla/5.0 …"` | manual mode for unsupported browsers |
| `node src/sync.mjs` | add/update the OpenCode provider |
| `node src/sync.mjs --default` | also set `model` and `small_model` |
| `node src/sync.mjs --remove` | remove the provider again |
| `node src/sync.mjs --base-url <url>` | point OpenCode at a proxy on another machine (kept by later syncs) |
| `node src/doctor.mjs` | diagnose node/session/proxy/config |
| `npm test` | unit tests for the parser and translator |
| `node test/smoke.mjs` | end-to-end smoke test against a running proxy |

`install.sh` also understands `--uninstall` (`--purge` deletes the stored session too).

---

## Configuration

All environment variables are optional; the defaults are what the installer uses.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VENICE_WEB_CONFIG_DIR` | `~/.config/opencode/venice-web` | session file and logs |
| `VENICE_WEB_SESSION` | `<config dir>/session.json` | session file path |
| `VENICE_WEB_PORT` | `3456` | proxy port |
| `VENICE_WEB_HOST` | `127.0.0.1` | proxy bind address |
| `VENICE_WEB_DEBUG` | off | write every raw model reply to `<config dir>/debug.log` |
| `VENICE_WEB_DUMP` | off | dump the last translated upstream request |
| `VENICE_WEB_TRANSPORT` | `auto` | client for the inference host: `auto` (curl when installed), `curl`, `fetch` |
| `VENICE_WEB_CURL` | `curl` | curl binary to use |
| `VENICE_WEB_CURL_TLS_ARGS` | auto | extra TLS flags for curl, space separated; auto is `--tlsv1.3` for an OpenSSL build (Linux) and nothing otherwise, empty sends none |
| `VENICE_WEB_TIMEOUT` | `900000` | per-request upstream timeout (ms) |
| `VENICE_WEB_JUDGE` | on | `0` turns off the judge that checks whether a turn may end |
| `VENICE_WEB_JUDGE_MODEL` | `deepseek-v4-1-flash-uncensored` | model for the judge (empty: the request's own model) |
| `VENICE_WEB_CHAT_ROUTE` | `auto` | chat route: `auto` (each model's own), `classic`, `agent` |
| `VENICE_WEB_JUDGE_TIMEOUT` | `45000` | judge timeout (ms); a late judge keeps the reply |
| `VENICE_WEB_MIDDLEFACE` | `0.1.1128` | `x-venice-middleface-version` header |
| `VENICE_WEB_CLERK_VERSION` | pinned | Clerk frontend API version query |
| `OPENCODE_CONFIG` | `~/.config/opencode/opencode.json` | config file `sync.mjs` patches |

---

## Security and privacy

- The session file (`~/.config/opencode/venice-web/session.json`, mode `600`) holds your Clerk cookie - treat it like a login token, keep it out of git.
- Only `clerk.venice.ai` and `outerface.venice.ai` are contacted (inference through the system `curl`; its headers go through a private `0600` file that is deleted as soon as curl has read it, so the token never appears in the process list); the proxy is bound to loopback by default. Anything that can reach it can use your Venice account, so do not expose the port publicly without thinking about it.
- No password is stored (unlike password-based proxies). Logging out of venice.ai in the browser invalidates the cookie; `/out` from the browser plus a fresh login fixes it.
- Requests leave your machine exactly as the web app would send them: same user agent, same headers, no extra telemetry.

---

## Limitations (read these)

- **Not the official API.** The web endpoints are undocumented and may change. `middleface` version headers are pinned to what the current web client sends.
- **Tool calls are emulated.** The web endpoint ignores OpenAI `tools`, so the model answers with a JSON envelope that the proxy turns into `tool_calls`. This is reliable in practice (see [docs/PROTOCOL.md](docs/PROTOCOL.md) for the measured technique) but it is a prompt contract, not a native feature: `tool_choice: required` is advisory, and with tools in the request the answer arrives buffered rather than token-by-token (reasoning still streams live).
- **Sampling controls only on the classic route.** `temperature`, `top_p` and `max_tokens` are applied for classic-route models and ignored on the agent route (`deepseek-v4-1-flash-uncensored`, `deepseek-v4-1-flash`, `z-ai-glm-5-3-flash`).
- **Small context on most models.** The classic route reads about 40k tokens on most models and cuts longer prompts from the start silently; the agent route summarises prompts past ~300k (DeepSeek Uncensored) or ~600k tokens (the other two). See [Models](#models).
- **Unlimited, not infinite.** Venice's fair-use and Cloudflare bot checks apply. A Cloudflare challenge surfaces as HTTP 401 with a "refresh the cookies" message.
- **Images: what is sent.** The images of your latest message go to the model as images, on every step of the work they start. Images from earlier messages stay in the history as `[image]` and are not sent again. Only pictures inside the request (data URLs, which is what OpenCode sends) are used, up to 10 per message; the proxy never downloads an image from a URL.
- **Documents: what is sent.** OpenAI `file` parts (`{"type":"file","file":{"filename","file_data"}}`, what OpenCode sends for a PDF) of your latest message go to Venice with their bytes, up to 10 per message and 100 MB each, and Venice extracts the text. Accepted: pdf, txt, md, csv, json, xml, rtf, doc, docx, xls, xlsx, ppt, pptx, odt, ods, odp, epub and any `text/*`. Anything else (a zip, a `file_id` reference, a URL) is answered with a 400 that says why, instead of being dropped silently. Files from earlier messages stay in the history as `[file: name]`.
- **Web session, not API route.** Anything that needs the official API surface (embeddings, video, `/responses`) still has to use `api.venice.ai` with an API key. Both can coexist in OpenCode - the installer only *adds* a provider.

### NUL bytes and `400 Invalid request parameters`

Reading a binary file with `grep -a`, `cat` or `tail` puts NUL bytes into a tool result, from there into the stored conversation, and from there into every later request. The web inference endpoint tolerates NUL bytes in most places but rejects them inside `systemPrompt` with `String must not contain null bytes`, which breaks that session for good.

The proxy handles this on its own, so `venice-web` needs no plugin:

* a request body with a raw control byte is repaired before parsing,
* every string in the outgoing payload is scrubbed (NUL becomes a space) and logged.

Installing `--with-nul-plugin` adds a small OpenCode plugin (`packaging/opencode-nul-sanitizer.ts`, copied to `~/.config/opencode/plugins/`) that does the same for **every other provider** you use from OpenCode. It is redundant for `venice-web` but the official Venice API has the same limit, so it is worth having if you switch providers per session. Use `/fix-nuls` style history cleanups as usual.

---

## Troubleshooting

Start with `node src/doctor.mjs`. The full list - Cloudflare challenges, expired sessions, "tools do not work", a turn with no output, port conflicts, service logs - is in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

Common ones:

```sh
node src/login.mjs                       # everything auth related
node src/sync.mjs                        # provider missing from /models, or after an update
tail -f ~/.config/opencode/venice-web/proxy.log   # see each request and tool call
launchctl kickstart -k gui/$(id -u)/ai.opencode.venice-web   # macOS: restart the service
systemctl --user restart ai.opencode.venice-web               # Linux
```

## Claude Code skill: orchestrate OpenCode workers

`skills/opencode-orchestrator/` is a [Claude Code](https://claude.com/claude-code) skill that turns Claude into the **orchestrator** of OpenCode workers. Claude plans and splits the work into small tasks, hands each one to an `opencode run` worker (for example a free `venice-web/*` model through this proxy), and then verifies every result itself (tests, type checks, diffs) before it reports. A worker's "DONE" is treated as a claim, not a fact.

Install it once for your user, then start a new Claude Code session:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/opencode-orchestrator" ~/.claude/skills/opencode-orchestrator   # updates with git pull
# or copy it: cp -R skills/opencode-orchestrator ~/.claude/skills/
```

Use it from any git repository:

```
/opencode-orchestrator add input validation to the signup form and test it
```

Without a task it continues the backlog in `.orchestrator/STATUS.md` (or asks what to do). Claude asks for the worker model at the start of the session; set it yourself with `export ORCH_MODEL=venice-web/deepseek-v4-1-flash-uncensored`.

What the scripts guard against (each of these cost hours in real sessions):

| Script | What it does |
| --- | --- |
| `preflight.sh` | checks that `opencode`, `perl`, `node` and `git` exist, that the installed `opencode run` accepts every flag the scripts use (an unknown flag makes it print its help and **exit 0 without running**), and that the model is listed |
| `oc-run.sh` | one worker run: stdin closed (an open stdin pipe makes `opencode run` hang before the model is called), hard time limit, `--dir <repo>`, JSON event log; prints the session id, the number of real tool calls, tool errors and the final text |
| `code.sh` | a coding task that must change a list of files; compares content hashes before and after and nudges the **same session** when a promised file did not change |
| `ask.sh` | a research task that must end with a report file; nudges the same session until the file exists |
| `gate.sh` | after every group: running workers, the repository's own checks (`.orchestrator/gate.local.sh`, else `npm test`), changed files, leftover `zz-*` temp files |

Per repository, two optional files live in `.orchestrator/`: `gate.local.sh` (what proves the work there: tests, type checks, build) and `STATUS.md` (state and backlog between sessions, from `templates/STATUS.md`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORCH_MODEL` | - (required) | worker model, `provider/model` |
| `ORCH_ROOT` | git top level | repository the workers run in |
| `ORCH_LIMIT` | `1500` | seconds per worker run before it is killed |
| `ORCH_RUNS` | `$TMPDIR/opencode-orchestrator/<repo>` | prompt files and JSON run logs |
| `ORCH_AUTO` | `0` | `1` passes `--auto` (approve everything not explicitly denied); off by default, so workers stay inside the repository |

The skill never commits or pushes, never reads credentials, and tells every worker the same. It needs `opencode`, `perl`, `node` and `git` on `PATH`.

---

## Related work

- [`despin/venice-ai-chat-proxy`](https://github.com/despin/venice-ai-chat-proxy) - password login, requires `wreq-js` for Chrome TLS fingerprints.
- [`weizsw/magpie-venice-web`](https://github.com/weizsw/magpie-venice-web) - the same idea as a Magpie plugin. Note that OpenCode v2 no longer loads the v1 plugin hook shape, so it does not drop into OpenCode unchanged.
- [`Parsa-Nasiri/venice-free-ai-chat`](https://github.com/Parsa-Nasiri/venice-free-ai-chat) - anonymous access with per-IP daily caps instead of an account session.

This project differs by: no runtime dependencies, cookie-only auth, an explicit tool-emulation protocol with reliability safeguards, and an OpenCode installer.

---

## License

[MIT](LICENSE). Not affiliated with Venice.ai.
