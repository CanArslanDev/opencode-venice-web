# Changelog

## Unreleased

- **Measured limits for the three agent-route models.** The agent route never
  truncates a long prompt and never answers 413: past about 77% of the
  catalogue context (by its own count, characters / 3.2) it first runs a
  `veniceai:compaction` step, and a little further the model sees only a
  ~5k-character summary of the prompt. Largest prompts read whole:
  `deepseek-v4-1-flash-uncensored` 1.24M characters (~300k tokens, catalogue
  524k), `deepseek-v4-1-flash` 2.36M (~550k, catalogue 1M),
  `z-ai-glm-5-3-flash` 2.57M (~600k, catalogue 1M). The sync now gives OpenCode
  those as the context limit (300k / 580k / 640k in the proxy's own token
  count) instead of the catalogue's, and the proxy warns when Venice compacts.
  On the classic route the same models keep the last ~36k / ~550k / ~580k
  tokens; that is `classicWindow`, used when `VENICE_WEB_CHAT_ROUTE=classic`.
  Output: 131072 tokens on both routes (classic: `maxResponseTokens`, honoured
  above it too; DeepSeek Uncensored wrote ~291k on the agent route). The
  classic route ends every stream after 900 seconds with
  `stream_over_activity_timeout`, which the proxy reports as an error.
  PROTOCOL §2d.

- **Every model now really is the model you picked.** The agent route the proxy
  used for all chat runs only `deepseek-v4-1-flash-uncensored`,
  `deepseek-v4-1-flash` and `z-ai-glm-5-3-flash`; for the other 24 models it
  answered with DeepSeek V4.1 Flash Uncensored and said so only in the stream's
  `model_id`. Those models now use the classic chat route
  (`/api/inference/chat`), which serves the model asked for. Tool emulation,
  images, documents, retries and the judge work the same on both. Each model
  has a `route` in `src/lib/models.mjs`; `VENICE_WEB_CHAT_ROUTE=agent|classic`
  forces one. The proxy warns when Venice answers with another model.
  PROTOCOL §2d.
- **Real limits per model.** The classic route reads about 40k tokens on most
  models (150k on `qwen-3-8-27b`, 20k/12k on three TEE models) and drops the
  start of longer prompts silently. The sync now gives OpenCode those limits
  (`window`), so it compacts in time. `temperature`, `top_p` and `max_tokens`
  are honoured on the classic route.
- **Image input only where the model reads it.** On the classic route Venice
  answers an image for a text-only model with Qwen 3.5 35B, so 14 models are
  now `vision: false` (the earlier "all 27 read images" result was DeepSeek on
  every row). PDFs and other documents still work on every model: on the
  classic route the proxy sends their text (extracted by Venice).
- **Judge model is now `deepseek-v4-1-flash-uncensored`**, the model the judge
  measurements really ran on (they asked for Qwen 3.5, which the agent route
  served as DeepSeek).
- **`e2ee-qwen3-8-27b` removed** (HTTP 500 on every classic request); the id
  is an alias of `qwen-3-8-27b`.

- **`deepseek-v4-1-flash-free` is now `deepseek-v4-1-flash-uncensored`**, the id
  Venice uses for it today ("free" was misleading: the model is the uncensored
  DeepSeek V4.1 Flash, not a free tier of `deepseek-v4-1-flash`). The old id is
  still accepted, and `venice-web-sync` moves `model` / `small_model` over to
  the new one. All other ids already match the web catalogue.

- **Document attachments.** OpenAI chat `file` parts (what OpenCode sends for an
  attached PDF) now reach Venice as `input_file` parts with their bytes, under
  their own file name, and Venice reads them server side. pdf, txt, md, csv,
  json, xml, rtf, office and OpenDocument formats and epub are accepted; other
  types, `file_id` references and URLs are a 400 with the reason instead of
  being dropped. Measured: a PDF on all 27 models, .txt/.md on three, and real
  `opencode run -f report.pdf`. The sync now advertises `pdf` input on every
  model; rerun `venice-web-sync`. PROTOCOL §2c.
- **Image input on the models added 2026-11-25**, measured with a test picture
  (all nine answered); they now carry `vision: true`.
- **Image settings.** `/v1/images/generations` now uses the web app's Studio
  route (`/api/inference/image`), which takes the model and its settings
  directly: `seed`, `negative_prompt`, `aspect_ratio`, `resolution`, `steps`,
  `cfg_scale`, `style_preset`, `hide_watermark` (on by default), `safe_mode`,
  `output_format`, `embed_exif`. Settings a model does not take are a 400. New
  free image models on this route: `krea-2-turbo`, `stable-diffusion-3.5-rev2`,
  `lustify-sdxl`, `lustify-v8`. `VENICE_WEB_IMAGE_ROUTE=agent` keeps the old
  agent route. PROTOCOL §5c.
- **Image settings measured per model (2026-11-25).** Seeds go up to
  999999999 (larger ones were refused, so random seeds failed about half the
  time). Sizes are scaled to Venice's limit of 1344 per side and 1.5 MP, which
  makes `krea-2-turbo` at `2K` and wide aspect ratios work. The reported size is
  read from the picture (`chroma` and `lustify-v8` return 1.5x). `steps` is
  refused on `z-image-turbo`, `chroma` and `krea-2-turbo`, which ignore it, and
  prompts longer than the model's limit (1500 to 7500 characters) are a 400.
  README has the per-model table.

- **Catalogue refreshed against the web catalogue (2026-11-25).** Added the free
  (`usesCredits: false`) models that were missing: `zai-org-glm-4.7-app`, `olafangensan-glm-4.7-flash-heretic`,
  `qwen3-coder-480b-a35b-instruct-turbo`, `qwen3-vl-235b-a22b`,
  `nvidia-nemotron-3-ultra-550b-a55b`, `nvidia-nemotron-3-nano-30b-a3b` and
  `venice-uncensored-role-play` (text only until measured with a picture).
  `zai-org-glm-4.6` is gone from the web catalogue and was removed. Output limits
  follow the catalogue (`deepseek-v4-1-flash-uncensored` 131072, Gemma 4 31B 16384).
  Also added `z-ai-glm-5-3-flash` (GLM 5.3 Flash) and `deepseek-v4-1-flash`
  (DeepSeek V4.1 Flash 1017): Pro-only, `usesCredits: false` in the live
  catalogue (re-read from a Pro session on 2026-11-25), and both answer on the
  web endpoint.
  GLM 5.3 (full) stays out, it is pay-per-use in the picker. GLM 5.1 and GLM 5
  are free but marked as being discontinued soon, so they were not added.
  Rerun `venice-web-sync`.

- **Image generation and editing**: `POST /v1/images/generations` and
  `POST /v1/images/edits` in OpenAI's shape, on the free web models
  (`z-image-turbo`, `chroma`, `wai-illu`; edits on `firered-image-edit`,
  `qwen-edit-uncensored`). The prompt is used verbatim, size and model are
  honoured, `n` runs in parallel, edits take multipart or JSON. Nothing is
  uploaded or stored. Verified on macOS and Linux. PROTOCOL §5b; the agent route
  and its events were first mapped by @crisazas in #4.

- **`kimi-k2-5` is gone from the catalogue.** The web catalogue bills it now
  (`usesCredits: true`), and this proxy only lists free models. Rerun
  `venice-web-sync` (or the installer); if OpenCode used it as the default model,
  pick another one.

- **Images.** Attach a screenshot in OpenCode and the model sees it, also on every
  tool step of the task it starts (an OpenCode run read `4719` off a test picture
  and wrote it to a file, on macOS and Linux). The bytes travel with the request
  as multipart; nothing is uploaded or stored. The image has to sit in the last
  user message or the model reaches for Venice's `view_media`, which the client
  cannot run (0/5 before, 5/5 after). The sync marks the 19 measured models with
  image input so OpenCode sends pictures to them. Protocol notes: PROTOCOL §2b;
  the multipart field names come from @crisazas's work in #4.

- **Linux works end to end.** Measured on Ubuntu 24.04 (Brave 157, curl 8.5.0 /
  OpenSSL 3.0.13) next to macOS, with the same account:
  - Sign-in read the cookie with the macOS key derivation (1003 PBKDF2 rounds;
    Chromium uses 1 on Linux) and, before that, died on a variable shadowing bug
    (`Cannot access 'profile' before initialization`). Both v10 (no keyring) and
    v11 (GNOME keyring) cookies now sign in. A cookie that is found but cannot be
    decrypted is reported as such instead of "no venice.ai cookie".
  - curl got its headers from `/dev/fd/3`, which Linux cannot open for Node's
    socket pipes (curl exit 26). They now go through a `0600` file that is
    removed as soon as curl has read it.
  - Cloudflare rejects the stock OpenSSL ClientHello (0/5); with `--tlsv1.3` the
    same request passes (10/10). OpenSSL builds of curl get that flag,
    `VENICE_WEB_CURL_TLS_ARGS` overrides it, and macOS is unchanged.
  - The systemd unit template now has the name `install.sh` looks for.
  Thanks to @crisazas for reporting and diagnosing these (#1, #2, #3).

- `skills/opencode-orchestrator/`: a Claude Code skill that lets Claude plan work,
  hand small tasks to `opencode run` workers and verify every result itself. The
  scripts close stdin (an open pipe made workers hang before the model was called),
  put a hard time limit on every run, check that the installed `opencode` accepts
  every flag used (an unknown flag exits 0 without running), and nudge the same
  session when a promised file did not change. See the README section.
- **Long tasks no longer give up on "Tool not found".** The web endpoint runs
  Venice's own agent loop inside one response: when the model called a tool with
  native function calling, Venice answered "Tool not found" and re-ran it, up to 10
  times, out of sight. The model then reported that its tools were broken and
  stopped without the result; asking again worked because the new turn started
  clean. The proxy now counts those internal steps, stops a response past 3 and
  retries with a reminder that the tools work and go in `tool_calls`. On the two
  tasks that triggered it, 4 of 20 runs ended that way before and 0 of 12 after.
  Format retries and judge checks have separate budgets now, so the last retry is
  always judged. `VENICE_WEB_DEBUG=1` logs every attempt with its step count.
- **A finished task now reports its result.** Long tasks could end with "done, the
  results are in report.md" or "all tests pass" without the numbers or answers the
  user asked for, and the user had to ask "sonucu söyle". The judge had no verdict for
  that and let 9 of 10 such replies through. It now has `missing_result`, which
  retries with a reminder to state the results, and that retry may replace the
  first answer. The tool prompt asks a `done` answer to carry the results. Probe:
  15/15 caught, 3/18 needless retries (all on "compute it into a file" requests).
- Inference requests go through the system `curl`. Cloudflare started blocking
  Node's own HTTP client on the inference route (403 "Attention Required!"), so
  every request failed with "refresh the cookies". curl over HTTP/1.1 with the
  user agent passed via `-A` gets through; `accept: text/event-stream` is no
  longer sent because it triggers the same block. One short-lived curl process
  per request, no browser, still no npm dependency. `VENICE_WEB_TRANSPORT`
  overrides the choice.
- Reasoning deltas now stream live instead of being buffered to the end of the
  reply, and an SSE keepalive comment goes out every 15 s. The client no longer
  sits through minutes of silence while a tool reply is parsed and retried.
- **No more word lists.** The plan detector (`looksLikePlan`) and the failure
  detector (`looksLikeFailure`) matched Turkish and English words; on 29 labelled
  turn endings from real sessions they caught 0 of 13 early stops and could never
  work in other languages. They are gone. Whether a turn may end is now decided by
  structure: the envelope has a required `status` (`continue`/`done`/`ask`), and
  `continue` without a tool call is retried. Every other answer after a tool
  result goes to a judge, a second model call (`qwen3-5-35b-a3b` by default) that
  reads the request, the last tool outputs and the reply. It caught ~87% of the
  real stops, also in German, Japanese and Spanish. Replaying the real stop points,
  the session went on at 18 of 18 (previous build: 15 of 18). Re-serialised
  history keeps its `status`, which took compliance from 8/15 to 15/15.
  `VENICE_WEB_JUDGE`, `VENICE_WEB_JUDGE_MODEL`, `VENICE_WEB_JUDGE_TIMEOUT`.
- **Structural JSON repair.** A new tolerant reader (`src/lib/lenient-json.mjs`)
  closes unclosed call objects, puts keys back into an `arguments` object that
  was closed too early, and tolerates unescaped quotes. All 8 broken shapes seen
  on 2026-11-04 (13 replies, 4 of them lost a tool call) now parse into complete
  calls; they are kept as fixtures in `test/fixtures/real-replies.mjs`. An
  envelope nested inside `content` is unwrapped. A reply that still cannot be
  read is retried instead of shown as raw JSON.
- **Calls are checked before they reach the agent.** Each call is validated
  against the tool's own JSON schema; an unknown tool (`view_media`) or a missing
  required argument (`edit` without `newString`) is sent back to the model with
  the exact problem and the list of available tools.
- DeepSeek's native `｜DSML｜` tool markup and invented `<tool_response>` blocks
  are stripped from answers; complete native `invoke` blocks become tool calls.
- The tool prompt asks for multi-line scripts to be written to a file first
  (OpenCode's shell scanner rejects multi-line quoted commands) and not to ask for
  permission the user already gave.
- `scripts/stress/`: eight self-verifying OpenCode tasks in five languages.
- Invented tool names (`bash`, `cat`, `ls`, ...) are mapped onto the available
  tools instead of failing as unknown.

## 0.1.4 - 2026-10-31

- Stop the session from pausing on a plan. Real session (a long
  multi-step task): after a tool result the model wrote "Şimdi ... arayacağım" with
  `tool_calls:[]` and the session went idle halfway through the task. The proxy now
  detects a reply that only announces the next step (`looksLikePlan`: closing
  sentences, a trailing colon, a numbered next-steps list) and retries it with an
  ACT NOW reminder.
- The retry reminder moved from the system prompt to a trailing **user** message,
  which the model obeys far more reliably (27 of 28 retries turned into tool calls
  in the real session, versus 1 of 5 before).
- New trigger: when the last tool output looks like a failure ("No such file",
  traceback, non-zero exit) and the model answers anyway, it is retried too. This
  came from a stress task where the model assumed a file existed and reported
  success without ever writing it.
- Tool prompt says not to end a turn with a plan.
- Stress suite result after these fixes: 16/16 verified tasks, twice in a row.

## 0.1.3 - 2026-10-31

- Survive the model's sloppy JSON. A real capture showed file content dumped
  straight after `"arguments":` with literal line breaks, which made
  `JSON.parse` fail: the tool calls were dropped and the envelope leaked into the
  visible answer. `extractEnvelopes()` now runs a repair ladder (control
  characters, trailing commas, raw argument blobs), a tolerant `salvageCalls()`
  fallback, and `cleanLeakedEnvelope()` so the leaked text becomes the answer.
  A tool call is no longer lost to invalid JSON.
- Raw argument blobs that are not JSON are wrapped as `{"content": ...}` instead
  of being passed through as an unparseable string.
- The tool prompt asks for escaped arguments (newlines as `\n`, quotes as `\"`).

## 0.1.2 - 2026-10-31

- Never forward a blank assistant turn. The model occasionally answers
  `{"content":"","tool_calls":[]}`; an empty reply is stored as an assistant
  message with no parts at all, so the turn shows nothing and the session looks
  frozen (`finish: stop`, no output, no error).
- An empty reply now triggers its own retry with a targeted reminder, a retry can
  no longer replace a real answer with a blank one (`preferAnswer`), and a last
  resort falls back to the raw text and then to an `(empty reply)` marker so the
  turn is always visible.
- The tool prompt states that `content` must not be empty unless a tool is called.

## 0.1.1 - 2026-10-31

- Scrub NUL bytes out of outgoing requests. The web endpoint answers
  `400 String must not contain null bytes` when one reaches `systemPrompt`, which
  breaks a session permanently; NUL bytes routinely arrive from `grep -a` /
  `cat` / `tail` over binary files. A raw control byte in a request body is now
  repaired before parsing too.
- Optional `--with-nul-plugin`: installs an OpenCode plugin that does the same
  for other providers (the official API has the same limit).

## 0.1.0 - 2026-10-31

Initial release.

- Local OpenAI-compatible proxy for the venice.ai web session (Clerk cookie auth, no password, no API key).
- 20 free web models, exposed as an OpenCode provider.
- Tool-call emulation with reliability safeguards: format reminder, single automatic retry, multi-envelope parsing, history normalisation, Code Mode wrapper filtering.
- `login`, `sync`, `doctor` CLIs, launchd/systemd install, unit + smoke tests.
