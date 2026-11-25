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

Then **restart OpenCode** and pick a model such as `venice-web/deepseek-v4-1-flash-free`.

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
| Inference | `POST outerface.venice.ai/api/inference/chat/agents/ad-hoc` | newline-delimited SSE |
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
| DeepSeek | `deepseek-v4-1-flash-free`, `deepseek-v4-1-flash` (1017), `deepseek-ai-DeepSeek-V3.2` |
| Qwen | `qwen-3-8-27b`, `qwen3-6-27b`, `qwen3-5-35b-a3b`, `qwen3-coder-480b-a35b-instruct-turbo`, `qwen3-vl-235b-a22b` |
| GLM | `z-ai-glm-5-3-flash`, `zai-org-glm-5.2`, `zai-org-glm-4.7-app`, `olafangensan-glm-4.7-flash-heretic` |
| NVIDIA | `nvidia-nemotron-3-ultra-550b-a55b`, `nvidia-nemotron-3-nano-30b-a3b` |
| Gemma | `google-gemma-4-31b-it`, `google-gemma-4-26b-a4b-it`, `gemma4-uncensored` |
| Venice | `venice-uncensored-1-2`, `venice-uncensored-role-play` |
| Aion | `aion-labs-aion-3-0`, `aion-labs-aion-3-0-mini` |
| TEE / E2EE hosted | `e2ee-qwen3-8-27b`, `e2ee-gpt-oss-120b-p`, `e2ee-qwen3-6-35b-a3b`, `e2ee-gemma-4-26b-a4b-uncensored-p`, `e2ee-qwen-2-5-7b-p`, `e2ee-qwen3-vl-30b-a3b-p` |

The 18 models that were measured take images: each one read a test picture correctly through this proxy, so the sync marks them with image input and OpenCode lets you attach pictures. The models added on 2026-11-25 (GLM 5.3 Flash, DeepSeek V4.1 Flash 1017, GLM 4.7, GLM 4.7 Flash Heretic, Qwen 3 Coder, Qwen3 VL 235B, both Nemotrons, Venice Role Play) are not measured yet and are text-only until they are. Rerun `venice-web-sync` after updating if OpenCode says a model does not support images.

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
| `steps` | sampling steps, up to the model's maximum (8 for `z-image-turbo`/`krea-2-turbo`, 10 for `chroma`, 30-50 for the others) |
| `cfg_scale` | prompt adherence, for the models that have it (`wai-illu`, SD35, Lustify) |
| `style_preset` | a style name from the web app's style list, e.g. `Cinematic` |
| `hide_watermark` | `true` by default |
| `safe_mode` | Venice's mature filter, `true` by default (adult content is blurred); `false` turns it off |
| `output_format` | `png` (default) or `webp` |
| `embed_exif` | `false` by default |

A setting the model does not take is answered with a 400 instead of being dropped. `VENICE_WEB_IMAGE_ROUTE=agent` switches back to Venice's agent route (only `z-image-turbo`, `chroma`, `wai-illu`, and none of the settings above).

- The prompt is used as written.
- Sizes from 256 to 2048 per side are accepted and rounded to the model's step (8 or 16 pixels).
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
| `VENICE_WEB_JUDGE_MODEL` | `qwen3-5-35b-a3b` | model for the judge (empty: the request's own model) |
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
- **No sampling controls.** `temperature`, `top_p` and `max_tokens` are not applied by this endpoint.
- **Unlimited, not infinite.** Venice's fair-use and Cloudflare bot checks apply. A Cloudflare challenge surfaces as HTTP 401 with a "refresh the cookies" message.
- **Images: what is sent.** The images of your latest message go to the model as images, on every step of the work they start. Images from earlier messages stay in the history as `[image]` and are not sent again. Only pictures inside the request (data URLs, which is what OpenCode sends) are used, up to 10 per message; the proxy never downloads an image from a URL.
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
node src/sync.mjs                        # provider missing from /models
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

Without a task it continues the backlog in `.orchestrator/STATUS.md` (or asks what to do). Claude asks for the worker model at the start of the session; set it yourself with `export ORCH_MODEL=venice-web/deepseek-v4-1-flash-free`.

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
