# CLAUDE.md

Project notes for agents (and humans) working in this repository.

## What this is

A dependency-free Node proxy that turns a venice.ai **web** session into a local OpenAI-compatible endpoint, so OpenCode can use the unlimited web models instead of the metered API. `docs/PROTOCOL.md` documents the reverse-engineered upstream; read it before touching `src/lib/venice.mjs` or `src/lib/emulate.mjs`.

## Layout

```
install.sh                    installer (macOS launchd + Linux systemd), --uninstall/--purge
src/proxy.mjs                 HTTP server entry point
src/login.mjs                 browser-cookie login CLI
src/sync.mjs                  writes the OpenCode provider into opencode.json
src/doctor.mjs                diagnostics
src/lib/config.mjs            paths, endpoints, tunables (all env-overridable)
src/lib/models.mjs            free web model catalogue
src/lib/venice.mjs            session file, Clerk JWT, attestation, upstream fetch
src/lib/classic.mjs           classic chat route: request conversion, line-stream reader, document helpers (pure)
src/lib/curl.mjs              curl transport for the inference host (Cloudflare blocks Node's fetch there)
src/lib/imagegen.mjs          image generation/editing: agent instructions, image event reader (pure)
src/lib/studio.mjs            image generation on the Studio route: options, request body, response headers (pure)
src/lib/emulate.mjs           tool-call emulation: prompt, envelope parser, SSE reader, translation, retry heuristics
src/lib/server.mjs            routing + live chunk translation (reasoning, keepalive) + retry logic
src/lib/cookies.mjs           Chromium cookie decryption (macOS Keychain / Linux secret-tool)
src/lib/lenient-json.mjs      structural JSON reader for broken envelopes (pure)
src/lib/sanitize.mjs          NUL byte scrubbing + lenient JSON control character repair
test/emulate.test.mjs         unit tests (node --test)
test/lenient-json.test.mjs    unit tests for the structural JSON reader
test/fixtures/real-replies.mjs  real broken model replies (anonymised); every shape must keep parsing
test/curl.test.mjs            curl transport: helpers, TLS flags, and real curl against a local HTTPS server
test/imagegen.test.mjs        image generation/editing: validation, instructions, event reader
test/studio.test.mjs          Studio image route: option parsing, request body, headers
test/images.test.mjs          image input: data URLs, which images are sent, placement, multipart encoding
test/classic.test.mjs         classic route: routes per model, request conversion, stream reader, merged runs, limits
test/files.test.mjs           document input: file parts -> input_file, accepted types, 400s, OpenCode pdf modality
test/server-loop.test.mjs     Venice tool-loop detection in collectStream (fake SSE)
test/sync.test.mjs            OpenCode config drift, stale-config hints, sync output and base URL
test/smoke.mjs                end-to-end check against a running proxy
scripts/stress/               multilingual OpenCode stress tasks with their own verification (not in npm test)
docs/PROTOCOL.md              upstream protocol + why tools are emulated + measurements
docs/TROUBLESHOOTING.md       user-facing problem solving
skills/opencode-orchestrator/ Claude Code skill: Claude orchestrates `opencode run` workers (generic, no machine-specific data)
packaging/                    launchd plist / systemd unit templates (__NODE__ __PROXY__ __LOG__)
```

## Commands

```sh
npm test                       # unit tests, no network
node test/smoke.mjs            # needs a running, signed-in proxy
node src/login.mjs             # refresh cookies (browser must be signed in)
VENICE_WEB_PORT=4000 node src/proxy.mjs
VENICE_WEB_DEBUG=1 node src/proxy.mjs   # writes debug.log with raw model replies
VENICE_WEB_DUMP=/tmp/req.json node src/proxy.mjs
```

## Invariants

1. **Zero runtime dependencies.** `node_modules` must stay empty; `package.json` has no `dependencies`. The system `curl` binary is the transport for the inference host; that is a system tool, not a package. No headless browser.
2. **Only two hosts** may be contacted: `clerk.venice.ai` and `outerface.venice.ai` (`assertDestination`).
3. **Only the `__client` cookie** is sent upstream, never `cf_clearance`.
4. **English** everywhere in code, logs, docs, commit messages.
5. **Node 22+**, ESM, no build step, no TypeScript.
6. Session file stays mode `600`; never commit it.
7. `src/lib/emulate.mjs` stays pure (no I/O) so it is unit-testable.

## Gotchas that cost real debugging time

* OpenCode v2 plugins must `export default { id, setup|effect }` - the v1 "function returning hooks" shape (as used by `magpie-venice-web`) is **not** loaded. Hence this is a proxy, not a plugin.
* The web endpoint ignores OpenAI `tools`; `clientTools` exists (`{name, description, inputSchema}`) but the model prefers Venice's own server tools. Tool calling is therefore emulated through a JSON envelope. Details and measured trade-offs: `docs/PROTOCOL.md` §4.
* OpenCode's Code Mode system prompt says "the tools listed below cannot be called directly" - models read this as "tools are broken" and stop calling them. The proxy therefore filters `execute`/`search` out of the advertised tools and states plainly that the tools *are* called directly.
* Models imitate their own history: if an assistant turn is plain text, the next turn is plain text too. Assistant history is re-serialised into envelope form for that reason.
* Models emit **several** envelopes per message, or prose plus an envelope. `JSON.parse` of the whole text loses the calls - `extractEnvelopes()` exists for this.
* The format reminder appended as the *last user message* is the single biggest reliability lever (`1/4 → 4/4` in testing). A system reminder in the same place is much weaker.
* `response.output_text.delta` carries reasoning too; distinguish via `item.type` of the `output_index`.
* The model also emits *invalid* JSON: raw file content after `"arguments":` with literal line breaks, trailing commas, arguments as a bare string. `parseLoose()` / `repairArguments()` / `salvageCalls()` handle it; keep the repair ladder when touching `extractEnvelopes()`, and keep `test/emulate.test.mjs`'s real capture fixture passing.
* The model also *stops mid-task*: it writes what it is about to do with `tool_calls:[]` after a tool result and the session looks finished. **Never detect this by matching words** (an earlier Turkish/English word list caught 0 of 13 real stops and cannot work in other languages). The envelope's `status` (`continue`/`done`/`ask`) and the judge (`buildJudgeRequest()` / `parseJudgeVerdict()` in emulate.mjs, `askJudge()` in server.mjs) decide; reminders still go as a **user** message (system prompt reminders are ~4x weaker). Re-serialised history must keep its `status`, or the model stops writing it. The judge also catches finished work reported without its result (`missing_result`); that retry is allowed to replace the first answer (`replaceAnswer`), every other retry is not. Measurements: `docs/PROTOCOL.md` §4.7.
* Broken envelopes are repaired by structure (`readLenient()`), never by guessing at the text; calls are checked against the tool's JSON schema (`inspectCalls()`) and sent back to the model when they cannot run. Add every new broken shape to `test/fixtures/real-replies.mjs`.
* The model sometimes answers `{"content":"","tool_calls":[]}`. That becomes an assistant turn with **no parts**, `finish: stop`, no error: the client shows nothing and the session looks frozen. `isEmptyAnswer()` / `shouldRetry()` / `preferAnswer()` / `applyFallback()` in `src/lib/emulate.mjs` exist for exactly this; never forward empty content.
* NUL bytes in the payload make Venice answer `400 String must not contain null bytes` (only when they land in `systemPrompt`, but that is enough to kill a session). `src/lib/sanitize.mjs` scrubs them; do not remove that step, and keep the body-repair before `JSON.parse` (JSON forbids raw control characters in strings).
* Clerk rotates `__client` on use - always read `set-cookie` and persist.
* `/agents/ad-hoc` runs **Venice's own agent loop** inside one response. A native tool call (instead of the envelope) makes Venice answer "Tool not found" and re-run the model, up to 10 times, invisibly; the model then claims its tools are broken and stops without a result. `collectStream()` counts `veniceai:tool_call_generation` steps and stops past `SERVER_LOOP_STEPS`, then retries with `NATIVE_CALL_REMINDER`. Keep the last retry unstopped so a turn always ends with an answer. `docs/PROTOCOL.md` §4.7.
* Images travel as **bytes in the request**, multipart (`request` + `media.<id>`), with an `input_image` part naming the id; nothing is uploaded and no id has to exist upstream. The image parts must sit in the **last** user message (`withImagesLast()`): earlier, the model calls Venice's `view_media` into the envelope and never sees the picture (0/5 vs 5/5). Only the latest user message's images are sent. `docs/PROTOCOL.md` §2b.
* Documents travel like images: an OpenAI `file` part becomes `{type:"input_file", media_id, filename}` plus the bytes as `media.<id>`, in the last user message. Venice names the document after the **multipart file name**, so keep sending each file under its own name. Unsupported attachments are an `AttachmentError` (400), never silently dropped. `docs/PROTOCOL.md` §2c.
* Image generation goes through the Studio route (`POST /api/inference/image`, JSON in, bytes out) by default; `src/lib/studio.mjs` builds the body and the per-model limits live in `IMAGE_MODELS`. The agent route below stays as `VENICE_WEB_IMAGE_ROUTE=agent` and for edits. `docs/PROTOCOL.md` §5c.
* On the agent route, image generation goes through Venice's own agent (`/agents/venice?paidImagesMode=block`), which rewrites prompts and picks models unless told exactly what to call (`generationInstruction()`). Several requests in one tool call come back identical, so `n` is `n` parallel calls. The agent only runs `z-image-turbo`, `chroma` and `wai-illu` of the free image models; it swaps the others silently, so only `IMAGE_MODELS` entries with `agent: true` (checked by a run showing `requests[].model_id` matching) are accepted there. `docs/PROTOCOL.md` §5b.
* Cloudflare blocks Node's own HTTP client on `outerface.venice.ai/api/inference/*` (403 "Attention Required!" HTML). The system curl gets through, but only over HTTP/1.1, with the user agent passed via `-A` (header order matters) and **without** `accept: text/event-stream`. `src/lib/curl.mjs` encodes all three; read `docs/PROTOCOL.md` §1 before changing any of them.
* On Linux the same rule also rejects the stock **OpenSSL** ClientHello (Ubuntu curl: 0/5), while `--tlsv1.3` passes (10/10); macOS curl passes as is and rejects `--tlsv1.3`. `tlsArgsFor()` picks the flag from `curl --version`. Headers go through a `0600` temp file (`writeHeaderFile()`), never `/dev/fd/3`: Node's extra stdio pipes are sockets and Linux cannot reopen them by path (curl exit 26). `test/curl.test.mjs` runs real curl against a local HTTPS server to keep this covered on CI's Ubuntu.

* **The agent route serves only three models.** `/agents/ad-hoc` answers any `modelId`, but for all but `deepseek-v4-1-flash-uncensored`, `deepseek-v4-1-flash` and `z-ai-glm-5-3-flash` it runs DeepSeek V4.1 Flash Uncensored; only the finished message item's `model_id` tells. Other models use the classic route (`/api/inference/chat`, `src/lib/classic.mjs`), chosen per model by `route` / `routeFor()`. The request is still built agent-shaped and converted at send time (`toClassicRequest()`), so retries and tool emulation stay in one place. Never judge a model by an agent-route run without checking `model_id` / `servingModelId`. `docs/PROTOCOL.md` §2d.
* The agent route **compacts** instead of truncating: once Venice's estimate (characters / 3.2) passes ~77% of the model's context, a `veniceai:compaction` item comes first and, a little further, the model sees only its ~5k-character summary (`context_metadata.total_tokens` drops to ~4.3k). No error, no 413, even past the catalogue context. `window` on the agent models stops OpenCode before that; `collectStream()` sets `state.compacted` and the proxy warns. `classicWindow` is the same model's classic-route limit. `docs/PROTOCOL.md` §2d.
* The classic route keeps only the **last** of several user messages in a row; `mergeRuns()` joins them (the request + format reminder would otherwise be just the reminder). It reads ~40k tokens on most models and silently drops the start of longer prompts; `window` in models.mjs is what OpenCode gets as the context limit. It answers images for text-only models with Qwen 3.5 35B (`vision: false` there) and takes documents only as `isFile` text messages (PDFs are extracted through one agent-route call that is dropped once the `veniceai:document_parsing` items are done).

## Changing the model catalogue

`src/lib/models.mjs` is curated to `usesCredits: false` web models only. Credit-billed models are excluded because the agent endpoint may silently serve a different (free) model for them. Route variants (`*-classic`) carry `upstream`, the id Venice gets (`upstreamId()`), and a fixed `route`. A new model needs a `route` (agent only if an agent-route run shows its own `model_id`), a measured `window` on the classic route, and `vision` only if `servingModelId` stays the same with an image attached. After editing, rerun `node src/sync.mjs` so the OpenCode config picks up the new list. Users' configs drift the same way after an update; `configDrift()` / `staleConfigHint()` in models.mjs make the proxy and the doctor say so, so a change to `openCodeModel()` output shows up there without further work.

## Version pins

`middlefaceVersion` and `clerkVersion` are pinned in `src/lib/config.mjs` to what the current web client sends, and are env-overridable. A sudden run of `400 Invalid request body` normally means Venice changed the schema: capture the real web-app traffic, update the pin, and update `docs/PROTOCOL.md`.

## Testing checklist before a release

1. `npm test`
2. `node src/login.mjs` then `node test/smoke.mjs`
3. `VENICE_WEB_PORT=3457 node src/proxy.mjs` and `node scripts/stress/run.mjs --base-url http://127.0.0.1:3457/v1` (runs real OpenCode sessions with auto-approved permissions in temp dirs)
4. One real OpenCode session: list a directory, read a file, edit it, run a command.
5. Re-run the failing-session scenario from `docs/PROTOCOL.md` §4 (prose-only model first turn) to confirm the retry still rescues it.
6. `./install.sh` on a clean `$HOME` (or `$VENICE_WEB_INSTALL_DIR`) to confirm install/uninstall.
