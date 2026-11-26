# Protocol notes

Everything here was reverse engineered from live venice.ai web traffic. These endpoints are undocumented and can change; treat this file as the map of what the code depends on.

> Keep this file in sync with `src/lib/venice.mjs`, `src/lib/emulate.mjs` and `src/lib/server.mjs`. If Venice changes something, the fix belongs in those files and the finding belongs here.

---

## 1. Authentication

```
browser cookie jar                     your machine                Venice
──────────────────                     ────────────                ──────
.clerk.venice.ai  __client  ──read──>  session.json
                                       │
                                       ├── POST clerk.venice.ai/v1/client/sessions/<sid>/tokens ──> JWT (~60 s)
                                       ├── POST outerface.venice.ai/api/app/user/client_attestation/mint ──> token (~5 min)
                                       └── POST outerface.venice.ai/api/inference/chat/agents/ad-hoc
```

* **`__client`** is a Clerk JWT on the `.clerk.venice.ai` host. It is long lived (months) and is the *only* credential needed. The proxy stores it in `session.json` (mode `600`).
* Clerk **rotates** `__client` while it is used. `veneziaFetch()` reads `set-cookie` from every response and rewrites the session file when it changes.
* The session JWT that actually authorises inference lives ~60 seconds. `mintToken()` caches it and refreshes it 15 s before expiry, single-flight so parallel requests share one mint.
* **Only `__client` is sent back - never `cf_clearance`.** `cf_clearance` is bound to the browser's TLS/IP and expires; `__client` alone passes Cloudflare. `user-agent` must look like a real browser (picked from the browser that owns the cookie), otherwise Cloudflare replies `403` with `cf-mitigated: challenge`.
* **The inference host is reached through the system `curl`, not Node's fetch** (`src/lib/curl.mjs`, since 2026-11-04). Cloudflare blocks Node's HTTP client on `/api/inference/*` with an "Attention Required!" `403 text/html` whatever the headers, cookies or TLS options. Measured:

  | client | result |
  | --- | --- |
  | Node `fetch` / `node:https` (default, Chrome cipher list, TLS 1.2 only) | 403 html |
  | `curl --http2` | 403 html |
  | `curl --http1.1` with `accept: text/event-stream` | 403 html |
  | `curl --http1.1` with the user agent as a plain `-H` line (lands after `Accept`) | 403 html |
  | `curl --http1.1 -A <browser UA>`, default `Accept: */*` | **200 SSE** |

  So: HTTP/1.1, the user agent via `-A`, no `accept: text/event-stream` (the backend streams SSE without it), one short-lived curl process per request. Clerk calls still use Node's fetch. `VENICE_WEB_TRANSPORT=fetch|curl` overrides the default `auto` (curl when installed).

  **Linux** (measured 2026-11-16, Ubuntu 24.04 in a VM that shares the public IP of a Mac whose curl passes, same session):

  | client | result |
  | --- | --- |
  | macOS curl 8.7.1 (LibreSSL / SecureTransport) | 5/5 **200 SSE** |
  | Ubuntu curl 8.5.0 / OpenSSL 3.0.13, defaults | 0/5 403 html |
  | same, `--curves X25519:prime256v1:secp384r1` | 0/5 403 html |
  | same, `--tlsv1.3` | 5/5, then 10/10 **200 SSE** |
  | same, `--tls-max 1.2` / Chrome cipher list / `--no-alpn` | 5/5 200 SSE each |
  | macOS curl with `--tlsv1.3` | exit 4 (not built in) |

  Cloudflare rejects the stock OpenSSL ClientHello and nothing else about the request, so `tlsArgsFor()` adds `--tlsv1.3` when `curl --version` names OpenSSL as the backend in use and adds nothing otherwise. `VENICE_WEB_CURL_TLS_ARGS` replaces that choice (space separated, empty for none) in case the rule moves. A TLS-impersonating npm client (`wreq-js`) was proposed for this and is not needed.

  Headers never go on the command line, where `ps` would show the bearer token: they are written to a `0600` file in a fresh `0700` directory just before curl starts (`-H @file`) and removed once the response head arrives. The file holds nothing `session.json` does not already store with the same mode. They used to go over `/dev/fd/3`, which works on macOS only: Node's extra stdio pipes are sockets, Linux cannot reopen a socket through `/proc/self/fd/N`, and curl exited with code 26 before sending anything.
* If a request still gets challenged, the proxy raises a `SignInError` which surfaces as **HTTP 401** with a "refresh the cookies" message.

Session discovery (`GET /v1/client`) yields the active session id and account. It picks the session matching the stored `uid` when several exist.

## 2. Inference request

```
POST https://outerface.venice.ai/api/inference/chat/agents/ad-hoc
authorization: Bearer <session JWT>
x-venice-middleface-version: 0.1.1128
x-venice-request-timestamp-ms: <now>
x-venice-client-attestation: <minted token>
content-type: application/json
accept: text/event-stream
user-agent / origin / referer / cookie(__client)
```

Body (responses-API flavoured, not chat-completions):

```jsonc
{
  "modelId": "deepseek-v4-1-flash-uncensored",
  "systemPrompt": { "instructions": "…all system messages joined…" },
  "messages": [
    { "id": "<uuid>", "type": "message", "status": "completed", "role": "user",
      "content": [{ "type": "output_text", "text": "…", "annotations": [] }] }
  ],
  "tools": [],        // Venice *server* tools (web_search, view_media, …). Requires a `type` discriminator.
  "clientTools": [],  // client-side tools; needs `inputSchema`. See §4.
  "reasoningMode": "disabled" | "adaptive" | "enabled"
}
```

Notes:

* `modelId` uses the web catalogue's dotted ids (`zai-org-glm-5.2`), not the API's dashed ids.
* `tools` and `clientTools` are what the web *agent* uses. Sending `tools: []` does not disable Venice's built-in server tools - the model may still call `view_media`/`get_attachment`.
* The endpoint ignores `temperature`, `top_p` and `max_tokens` (the classic route, §2d, honours them).
* This route runs only three models; any other `modelId` is answered by DeepSeek V4.1 Flash Uncensored. See §2d.
* Requests with `attestationToken` minted are required for `/api/inference/*`; the mint call needs the same headers (sans attestation).

## 2b. Images

Measured 2026-11-16 on the ad-hoc route with a 768x512 test picture (a red circle and the number `4719`).

A user message part `{ "type": "input_image", "media_id": "<id>", "detail": "auto" }` refers to an image. What the web client does: upload the file to `POST /api/v2/agents/media` (multipart `file`, answers `{ mediaId }`), send the turn with the id, and when Venice answers with a `function_call` named `hydrate_content` (`media_ids`, `signature`, `pending_tool_calls`, `current_iteration`), send the turn again as **multipart**: the JSON body in a `request` field and each image in a `media.<media_id>` field, plus the `hydrate_content` call, its `function_call_output` (`{ "items": { "<id>": { "type": "image", "mime_type": … } } }`) and `ok` for every pending call. (Field names and the hydration flow were worked out by @crisazas in #4.)

Measured shortcuts:

| request | result |
| --- | --- |
| JSON body, uploaded id | `hydrate_content` with a pending `view_media`; answered once, then "4719, red" |
| multipart with the bytes, uploaded id, no hydration messages | answer in one round trip |
| multipart with the bytes, **an id that was never uploaded** | answer in one round trip (2/2) |

So the proxy uploads nothing. Each image of the user's latest message gets an id derived from its bytes, the request goes out as multipart with the bytes in `media.<id>`, and Venice reads them straight from the request: no upload endpoint (which rate-limits with `429`), no id cache, nothing stored on disk. `upstreamChat(…, files)` builds the multipart body with `multipartBody()` (the encoder `fetch()` uses), so it travels through curl like any other body.

Every model in `src/lib/models.mjs` answered "4719" and "red", including the ones the catalogue does not flag `supportsMultiModal` - but on this route all of them except three were DeepSeek V4.1 Flash Uncensored (§2d); vision per model on the classic route is measured there. PNG, a 2.5 MB 3000x2000 PNG, and two images in one message (both read) work too.

**The image has to be in the last user message.** Venice shows the model an image directly only when it sits in the last user message; anywhere earlier the model calls Venice's own `view_media` to look at it (2/2, both answered after that server call). With emulated tools that call is written into the envelope, where nothing runs it: 5 of 5 image questions ended in an invalid `view_media` call and then an unrelated `bash`. The format and retry reminders are user messages that come after the user's own, so `withImagesLast()` moves the image parts onto the last user message with a line saying whose they are. After that: 5/5 answered with tools on, 0 `view_media` calls, and in a tool loop the model still sees the picture (`write code.txt "4719"` after a tool result), on macOS and Linux, through the proxy and through real `opencode run -f`.

Only the request's images (the latest user message that is not a tool output, below) and those of the tool outputs after it are sent. In a tool loop the request is the message that started the work, so the picture stays visible on every step; after the user's next message it is history and stays `[image]`.

**Images from tool results.** Measured 2026-11-26 (Windows, through the proxy, `stream: false`, tools `exec_command` + `view_image`, a solid red 64x64 PNG, 5 runs per model on `deepseek-v4-1-flash-uncensored`, `deepseek-v4-1-flash` and `z-ai-glm-5-3-flash`). A tool that returns a picture (Codex's `view_image`, screenshot tools) reaches the proxy in one of two shapes: inside the `role: "tool"` message as `image_url` parts, or as a user message holding the image right after the tool result (Codex on chat completions). Before, the first became `[image]` text inside the tool result, and the model, asked for the colour, described a picture it had never seen ("dark blue boats", "deep navy"): 1 of 15 said red. The second was treated as a new user request: the model's answer without a tool call was retried twice as "envelope without tool calls" (30 of 30 replies, 2 wasted retries each) and the format reminder told it "call those tools now - do not answer yet".

Now `attachmentIndexes()` sends the images of the request and of every tool output after it; `isToolOutputMessage()` marks a user message with an image that comes straight after a tool result (or after another such message) as tool output, so it is written as a `tool_result`, the after-tool reminder is picked, the judge path is used and the judge reads the real request. A user message after a tool result *without* an image stays a user turn. The tool result says `[N attachment(s) from this tool output are attached to the last user message]`, and the parts get `TOOL_IMAGE_NOTE` ("the output of the tool call(s) above, not part of the user's request") instead of `IMAGE_NOTE`. Notes now move with the parts on a retry. `IMAGE_NOTE` / `FILE_NOTE` no longer say "there is no tool for viewing images": the client may have one.

| shape (15 runs each, 3 models) | before | after |
| --- | --- | --- |
| image in the tool message, "dominant colour?" | 1/15 red (the rest invented a picture) | 15/15 red |
| image in a user message after the tool result, "dominant colour?" | 15/15 red, 30 wasted retries | 15/15 red, no wasted retry |
| two images that way, "colour of each?" | 15/15 red+blue, 30 wasted retries | 15/15 red+blue, no wasted retry |
| same three shapes, "say the colour and run `echo hi`" | 45/45 `exec_command` | 44/45 (the 45th: no answer from upstream within 300 s) |

## 2c. Documents

Measured 2026-11-25 (Windows, through this proxy and through real `opencode run -f`).

A user message part `{ "type": "input_file", "media_id": "<id>", "filename": "<name>" }` refers to a document; the bytes travel exactly like an image's, as the multipart field `media.<media_id>`. **Venice takes the file name from the multipart field's file name**, not from the part: with the old fixed name `image` the parsing item said `"filename":"image"`, so `upstreamChat()` now sends each file under its own name. The stream then carries one extra output item before the answer:

```
response.output_item.added   { "type": "veniceai:document_parsing", "source_media_id", "status": "in_progress", "filename", "mime_type", "extracted_text": "" }
veniceai:document_parsing.in_progress / .done
response.output_item.done    { …, "status": "completed", "extracted_text": "<the document's text>" }
```

then the usual `message` item. The extracted text is not an `output_text` delta and the item is not a `veniceai:tool_call_generation`, so `collectStream()` neither forwards it nor counts it as a server tool step.

The web client accepts csv, doc, docx, epub, json, md, odp, ods, odt, pdf, ppt, pptx, rtf, txt, xls, xlsx, xml (and `text/*`, the matching office types), up to 100 MB. OpenCode (`@ai-sdk/openai-compatible`) sends an attached PDF as `{ "type": "file", "file": { "filename": "report.pdf", "file_data": "data:application/pdf;base64,…" } }` (captured from `opencode run -f report.pdf`); it inlines .md/.txt itself as text. Before this the proxy turned that part into empty text, and the model only got the answer by shelling out to `pdftotext`.

Measured with a PDF, a .txt and a .md each holding a unique code word ("What is the secret code word in the attached file?"):

| request | result |
| --- | --- |
| PDF, all 27 models | 27/27 answered the code word (24 of them were DeepSeek V4.1 Flash Uncensored, §2d) |
| .txt and .md, `deepseek-v4-1-flash-uncensored`, `z-ai-glm-5-3-flash`, `qwen3-coder-480b-a35b-instruct-turbo` | 6/6 |
| `opencode run -f report.pdf` on `deepseek-v4-1-flash-uncensored`, `z-ai-glm-5-3-flash`, `deepseek-v4-1-flash` (sync config, `pdf` input) | 3/3, no tool call |
| a zip | 400 from the proxy, with the list of accepted types |

`attachmentFromFilePart()` reads the part (image types go the image way), `withImagesLast()` moves `input_file` parts to the last user message like images (with `FILE_NOTE` instead of `IMAGE_NOTE` when the reminder receives them), and the OpenCode config advertises `modalities.input` `pdf` on every model (`openCodeModel()`).

## 2d. Two chat routes: agent and classic

Measured 2026-11-25 (Windows, Pro session) with every model in `src/lib/models.mjs`, straight against upstream and then through the proxy.

**The agent route runs only three models.** `/agents/ad-hoc` takes any `modelId` and answers, but the finished message item names the model that really ran:

```
response.output_item.done  { "item": { "type": "message", "id": "agent-node:llm:0", "status": "completed", "model_id": "deepseek-v4-1-flash-uncensored", … } }
response.output_text.done  { …, "context_metadata": { "total_tokens": 2989, "max_context_length": 524288 } }
```

`response.created` / `response.completed` carry no model. For 24 of the 27 models then listed, `model_id` was `deepseek-v4-1-flash-uncensored` and `max_context_length` was that model's 524288; only `deepseek-v4-1-flash-uncensored`, `deepseek-v4-1-flash` (1000000) and `z-ai-glm-5-3-flash` (1048576) ran as themselves. These are the models of the web app's agentic model picker (its fourth entry is "Auto"). The fingerprint agrees: asked "What model are you, and which company made you?", the agent route answered "Claude, made by Anthropic" (or "an undisclosed model") for almost every id, while the classic route answered with each model's own maker (Alibaba/Tongyi for Qwen, Z.ai for GLM, NVIDIA for Nemotron, Google for Gemma, Mistral for the Venice models, OpenAI for GPT OSS, DeepSeek for DeepSeek). `total_tokens` 2989 for a one-word prompt also shows that the agent route adds about 3k tokens of its own system prompt.

So every measurement in this file that was taken on the agent route with another model id (vision and documents on "all 27 models" in §2b/§2c, the judge candidates in §4.7) was in fact DeepSeek V4.1 Flash Uncensored.

**The classic route** is what the web app's ordinary chat uses:

```
POST https://outerface.venice.ai/api/inference/chat
(same auth, attestation, middleface and timestamp headers; no accept: text/event-stream, as on the agent route)
```

```jsonc
{
  "requestId": "a1b2c3d",            // any short id
  "modelId": "qwen3-5-35b-a3b",
  "prompt": [
    { "role": "system" | "user" | "assistant", "content": "…",
      "imagePath": ["data:image/png;base64,…"],   // optional, must be an array
      "isFile": true }                             // optional: this message is a document's text
  ],
  "systemPrompt": "…",               // a string; an object is a 400
  "includeVeniceSystemPrompt": false,
  "reasoning": false,                // true: reasoning deltas (models that have them)
  "enableLargeContextChat": true,    // see "Context" below
  "maxResponseTokens": 2048,         // honoured
  "temperature": 0.7,                // honoured, 0-2 (above 2: 400)
  "topP": 0.9,
  "webEnabled": false, "webScrapeEnabled": false, "xSearchEnabled": false,
  "conversationType": "text",
  "isCharacter": false
}
```

The answer is **not SSE**: one JSON object per line (the response even says `content-type: text/html`), streamed as it is generated (267 chunks over 6 s for a 400-word story):

```
{"kind":"meta","references":[],"servingModelId":"qwen3-5-35b-a3b","servingModelName":"Qwen 3.5 35B A3B"}
{"kind":"meta","augmented":false,"references":[],"completion_id":"chatcmpl-…"}
{"kind":"meta","augmented":false,"references":[],"thinking":true}
{"kind":"content","content":"","reasoning_content":"…"}     reasoning delta (reasoning: true)
{"content":"P","kind":"content"}                             answer delta
{"kind":"status","content":"processing"}                     on long prompts, before the first token
{"kind":"meta","references":[],"servingModelId":"qwen3-5-35b-a3b","servingModelName":"Qwen 3.5 35B A3B"}
```

There is no terminal event: the stream simply ends. Errors are an HTTP status with a JSON body (`{"error":"Invalid request","details":…}` 400, `{"error":"modelOverloaded"}` 429, `{"error":"userPromptTooLong"}` 413, `{"error":"Internal server error"}` 500). No `x-venice-tee-model-pub-key` header came back for the TEE models; their answers were plain text like the others.

Measured on the classic route:

| check | result |
| --- | --- |
| "Reply with exactly: PONG", every model | 26/27 `PONG`, `servingModelId` = the model asked for every time; `e2ee-qwen3-8-27b` HTTP 500 on 6 of 6 tries (now an alias of `qwen-3-8-27b`) |
| fingerprint question | each model named its own maker (see above) |
| `temperature` | 0: the same invented name 3/3; 2: unreadable token soup; 9: 400 "less than or equal to 2" |
| `maxResponseTokens: 20` | 88 characters instead of 1761 |
| `systemPrompt` string, `role: "system"` message, multi-turn history | all followed |
| several user messages in a row | **only the last one is read**: "code word two: LIME-77" followed by the question was forgotten (2/2 models), joined into one message both were named. An `isFile` message is not dropped and keeps the message before it |
| `imagePath: [dataURL]` | read (a red apple). A string instead of an array is a 400 |
| image sent to a text-only model | answered by **`qwen3-5-35b-a3b`** (`servingModelId` says so) on 14 models; HTTP 500 on `venice-uncensored-role-play`; read by the model itself on `qwen-3-8-27b`, `qwen3-6-27b`, `qwen3-5-35b-a3b`, `qwen3-vl-235b-a22b`, `venice-uncensored-1-2`, the three Gemma models and `e2ee-qwen3-vl-30b-a3b-p` |
| document bytes (multipart, or a PDF data URL in `imagePath`) | 400 "Required" / not read. The route takes documents only as text, in a message with `isFile: true` |
| median time to first byte, short prompt | 0.87 s (agent route 0.49 s); total time about the same as the agent route |

**Context.** Without `enableLargeContextChat` the route keeps only the end of a long prompt and drops the start silently (GLM 5.2: a code word at the start of 120k characters found, of 200k characters not; with the flag, found at 1.6M characters, ~470k tokens). Even with the flag most models read far less than their catalogue `maxContextLength`. Measured with a marker line every ~5k tokens in a ~355k-token prompt, asking for the first marker the model sees, then confirmed with a code word at the start of prompts of known size:

| models | prompt read on the classic route |
| --- | --- |
| `zai-org-glm-5.2` | all of it (470k tokens) |
| `deepseek-v4-1-flash`, `z-ai-glm-5-3-flash` | ~550k / ~580k, far below the catalogue's 1M (see below) |
| `qwen-3-8-27b` | ~150k (118k found, 177k not) |
| 18 others (`qwen3-5-35b-a3b`: 38k found, 47k not) | ~40k |
| `e2ee-qwen3-6-35b-a3b`, `e2ee-qwen-2-5-7b-p` | ~20k |
| `e2ee-qwen3-vl-30b-a3b-p` | ~12k; above that HTTP 413 `userPromptTooLong` instead of truncation |
| `deepseek-v4-1-flash-uncensored` | ~36k (36k read, 38k not; the agent route reads ~300k, see below) |

The system prompt survives the truncation (a `systemPrompt` saying "reply ZEBRA" was obeyed under a 400k-character prompt). The cut is silent, so these numbers are the models' `window` in `src/lib/models.mjs` and what the sync gives OpenCode as the context limit (with the output limit capped at a fifth of it, since OpenCode compacts at context minus output); OpenCode compacts before Venice drops anything. `nvidia-nemotron-3-nano-30b-a3b` once answered the marker question by reciting a "CONTENT MODERATION RULES" system prompt, so some models get a Venice prompt even with `includeVeniceSystemPrompt: false`.

**Limits of the three agent-route models, on both routes.** Measured 2026-11-25 with the same prompt shape (a code word at the very start, a marker line every ~5k tokens, and a question asking for the code word, the first and last marker seen, and one record about 3% in copied word for word, which no summary keeps), at increasing sizes up to and past the catalogue context. Token sizes are this English filler's tokens (4.29 characters each, from the agent route's `context_metadata.total_tokens`); `servingModelId` / `model_id` was the model asked for in every run.

The agent route never truncates and never answers an HTTP error, even past the catalogue context. Instead it **compacts**: the stream starts with

```
veniceai:context_compaction.in_progress   { "message_count": 1 }
response.output_item.done  { "item": { "type": "veniceai:compaction", "summary": "## Summary …", "original_token_count": 469383, "message_count": 1 } }
veniceai:context_compaction.done          { "messages_compacted": 1, "media_count": 0 }
```

`original_token_count` is the prompt's characters / 3.2 (1502024 characters gave 469383), not the model's tokenizer. Compaction starts once that estimate passes about 77% of `max_context_length`. Just past that the "summary" is still the whole prompt (1.29M characters long on DeepSeek Uncensored at 300k tokens) and the model reads everything; a little further it is a ~5k-character summary, `total_tokens` drops to ~4.3k, the code word survives sometimes and the details never do.

Agent route (`/api/inference/chat/agents/ad-hoc`):

| model (catalogue context) | read whole, no compaction | compaction, prompt still whole | summary only (start and details lost) |
| --- | --- | --- | --- |
| `deepseek-v4-1-flash-uncensored` (524288) | up to 290k tokens, 1.24M characters (estimate 389k) | 300k (estimate 402k) | from 350k (estimate 469k); at 420k the code word was gone too; 530k (past the catalogue) the same, HTTP 200 |
| `deepseek-v4-1-flash` (1000000) | up to 550k, 2.36M characters (estimate 737k) | 600k-650k (estimate 805k-872k) | from 700k (estimate 939k); 1010k the same, HTTP 200 |
| `z-ai-glm-5-3-flash` (1048576) | up to 600k, 2.57M characters (estimate 805k) | 650k-700k (estimate 872k-939k) | from 750k (estimate 1006k); 1060k the same, HTTP 200 |

Classic route (`/api/inference/chat`, `enableLargeContextChat: true`); the route reports no token counts, so sizes are the same prompts' sizes:

| model | read whole | longer prompts |
| --- | --- | --- |
| `deepseek-v4-1-flash-uncensored` | up to 36k | the start dropped silently, the last ~30-36k tokens kept (first marker seen at 518k: 98) |
| `deepseek-v4-1-flash` | up to 540k | the last ~550k kept (first marker seen: 41 at 750k, 81 at 950k, 89 at 990k) |
| `z-ai-glm-5-3-flash` | up to 570k | the last ~580k kept (34 at 750k, 75 at 950k, 91 at 1030k) |

No HTTP error on either route at any size (up to 4.4M characters). The record copied word for word was sometimes wrong even when everything was read (DeepSeek 1017 at 550k on the agent route, both models at 540k-570k on the classic route): that is recall at that length, not a limit. So every limit here was **reached**: on the classic route by truncation, on the agent route by compaction; none of the three reads its catalogue context on either route.

`window` in `src/lib/models.mjs` is the agent-route limit in the proxy's own token count (characters / 4, `countTokens()`, what OpenCode compacts on), rounded down: 300000, 580000 and 640000. The compaction trigger counts characters, as the proxy does, so this holds for code as well as prose. `classicWindow` (35000, 540000, 570000) applies when `VENICE_WEB_CHAT_ROUTE=classic`. `collectStream()` records a `veniceai:compaction` item in `state.compacted` and the proxy logs `Venice compacted the prompt of …`.

Output length, asked for a numbered list of 30000 lines (or 60000 bare numbers, with a system prompt saying long output is supported, for models that refused the first one); token counts from the agent route's `total_tokens`, with the output sent back as a prompt:

| model | agent route | classic route |
| --- | --- | --- |
| `deepseek-v4-1-flash-uncensored` | ~291k tokens, all 30000 lines, `response.completed`: no 131072 cap | 131072 exactly, with `maxResponseTokens: 131072` and without it (cut mid-line); 200001 with `maxResponseTokens: 200000` |
| `deepseek-v4-1-flash` | refused the list ("exceeds the maximum output length"); the bare numbers stopped at 131076 tokens mid-number, `response.completed` | 131072 exactly (`maxResponseTokens: 131072`) |
| `z-ai-glm-5-3-flash` | refused the list; the bare numbers stopped at ~131.1k tokens (`total_tokens` 133989), `response.completed`; one earlier run ended at 47k with `response.failed` `workflow_failed` "LLM stream failed > Request error" | refused the list; bare numbers 131060 tokens (`maxResponseTokens: 131072`); with `maxResponseTokens: 200000` 193836 tokens, then the stream ended with `{"kind":"error","code":"stream_over_activity_timeout","error":"Streaming request exceeded the 900 second wall-clock limit."}` |

No finish reason marks the cut on either route (the agent route says `completed`, the classic stream just ends). `maxResponseTokens` up to 1000000 is accepted (no 400) and honoured past the catalogue's 131072, but **the classic route stops every stream after 900 seconds** with the error line above (`classicReader()` turns it into an error, so the turn fails visibly); GLM writes ~215 tokens/s there, DeepSeek ~570. The agent route ran 476 s for DeepSeek Uncensored's 291k tokens without such a limit.

Other differences on the same model (direct, then through the proxy):

| check | agent route | classic route |
| --- | --- | --- |
| emulated tool calls through the proxy (one call, two parallel calls, answer after a tool result; 3 runs each) | 27/27 on the three models | 27/27 |
| PDF (code word) | 3/3, Venice parses it (`veniceai:document_parsing`) | 3/3 through the proxy (text extracted by one agent-route call) |
| image (red circle, "4719") | 3/3, `model_id` unchanged | 3/3, `servingModelId` unchanged |
| reasoning | a `reasoning` item on all three | `reasoning_content` on all three |
| `temperature: 0` (same prompt 4x) | ignored: 4 different sentences (DeepSeek Uncensored, GLM) | honoured: 4/4 identical on GLM, 3/4 on DeepSeek Uncensored |
| `temperature: 2` | ignored (coherent text) | token soup on DeepSeek Uncensored (289k characters); DeepSeek 1017 and GLM stayed readable |
| max tokens 20 | ignored (`max_output_tokens`, `maxOutputTokens`, `maxResponseTokens` in the body; ~1.5k characters) | honoured (75-106 characters) |
| median time to first token, "Reply with exactly: PONG", 5 runs | 1.18 s / 1.34 s / 0.87 s | 0.72 s / 0.84 s / 0.60 s |
| hidden prompt (`total_tokens` for a one-word prompt) | 2989 / 2989 / 2835 tokens | not reported (`includeVeniceSystemPrompt: false`) |
| lock-picking how-to | answered by all three | refused by `deepseek-v4-1-flash` ("I can't provide instructions for picking locks"), answered by the other two |
| profane pirate rant | written by all three | written by all three |

(Times and token counts: DeepSeek Uncensored / DeepSeek 1017 / GLM 5.3 Flash.) Every response named the model asked for; none mentioned credits.

The three models stay on the agent route: its usable context is as large as or larger than the classic route's (much larger on DeepSeek Uncensored), PDFs need no extra call, and it keeps the tool-emulation measurements of §4. The classic route answers faster and honours sampling settings; `VENICE_WEB_CHAT_ROUTE=classic` switches to it, with `classicWindow` as the limit. `deepseek-v4-1-flash-classic` and `z-ai-glm-5-3-flash-classic` are the classic route for one model each (`upstream` is the id sent, `window` its `classicWindow`), so both routes can be picked per session; DeepSeek Uncensored has none, at ~36k tokens it is not worth one.

**What the proxy does.** Each model has a `route` (`routeFor()` in `src/lib/models.mjs`): `agent` for the three models the agent route runs (on DeepSeek Uncensored it reads more context than the classic route, and it keeps the measured behaviour of §4), `classic` for the rest. `VENICE_WEB_CHAT_ROUTE=classic|agent` forces one route for every model. The request is still built in the agent shape by `toVeniceRequest()` (tool emulation is text, so it is the same on both routes), and `toClassicRequest()` in `src/lib/classic.mjs` converts it at send time, retries included: text parts joined, consecutive messages of one role joined into one (`mergeRuns()`; the request and the format reminder, or a tool result and the reminder, would otherwise lose everything but the reminder), `input_image` parts as data URLs in `imagePath`, `systemPrompt` as a string, `reasoning` from `reasoningMode`, `enableLargeContextChat: true`, and the OpenAI `temperature` / `top_p` / `max_tokens` (clamped to 0-2, 0-1 and the model's output limit). `classicReader()` turns the lines into the agent route's event names, so `collectStream()` reads both. The proxy logs `asked for X, Venice answered with Y` whenever `servingModelId` or `model_id` differs from the model asked for. There is no Venice agent loop on the classic route, so the tool-loop guard (§4.7) never triggers there.

Documents on the classic route: text types (`text/*`, JSON, XML) are decoded locally; other types (PDF, office, epub) are sent once to the agent route with a one-line prompt, and the proxy stops reading that stream as soon as the `veniceai:document_parsing` items are done (§2c), before any answer is generated. The text then goes as an `isFile` message right after the message that carried the file (before it when that is the format reminder, which stays last). The wording matters: with only the file name and text, before the question, Qwen 3.5 found the code word 1/4 times and otherwise said it "cannot access attached files"; with "The user attached the file "report.pdf". Its text was extracted for you …" after the question, 4/4 (Qwen 3 Coder 4/4 either way).

## 3. Inference response

Newline-delimited SSE (`\n\n` separated `event:`/`data:` frames, `: keepalive` comments, `data: [DONE]` terminator) with `content-type: text/event-stream`. Event names seen:

| Event | Meaning |
| --- | --- |
| `response.created`, `response.in_progress` | lifecycle |
| `response.output_item.added` / `.done` | item boundaries; `item.type` is `message`, `reasoning`, `veniceai:tool_call_generation`, `veniceai:server_function_call`, `veniceai:server_function_call_output` |
| `response.content_part.added` / `.done` | content part boundaries |
| `response.output_text.delta` / `.done` | text deltas (also used for reasoning - disambiguate via the `item.type` of the `output_index`) |
| `response.reasoning_text.delta`, `response.reasoning_summary_text.delta` | reasoning deltas |
| `response.completed` / `response.incomplete` | terminal |
| `veniceai:tool_call_generation.in_progress` / `.done` | the server-side step that parses tool calls out of the model's text (`detected_tools`) |
| `error`, `response.failed` | failures |

The multi-item stream (`agent-node:llm:0`, `llm:1`, …) is the *server's own* agent loop. With `clientTools` set, the server tries to detect and execute tools itself, which is why `§4` matters.

## 4. Why tools are emulated

Two facts make this necessary:

1. `POST …/agents/ad-hoc` rejects OpenAI `tools`:
   ```
   invalid_union_discriminator at ["tools",0,"type"]: expected one of calculator, web_search, …
   ```
2. `clientTools` must be shaped `{ name, description, inputSchema }`, and handing them over did **not** make the model call them: it kept calling Venice's own server tools (`view_media`) and then concluded `read_file` did not exist. Making that path work would mean teaching the model Venice's own call syntax *and* handling `veniceai:client_function_call` items - more moving parts than the envelope below.

So the proxy hides the tool machinery from Venice entirely and asks the model for an envelope:

```json
{"content": "text for the user", "status": "continue", "tool_calls": [{"name": "read", "arguments": {"path": "a.txt"}}]}
```

`status` is `continue` (more work, a tool call follows), `done` (the request is finished) or `ask` (a question only the user can answer). It is how the proxy learns whether a turn may end without reading the prose (§4.7).

The proxy then emits real OpenAI `tool_calls` and, on the next turn, sends results back as a user message containing `{"tool_result": {"tool_call_id": …, "content": …}}`.

### Reliability measures

A small model asked for a custom format is *usually* compliant, but not always. Four measures, each measured on ~6-12 runs of a real OpenCode session:

| Measure | Effect |
| --- | --- |
| **Format reminder as the last user message** (`(format reminder) …`, two variants depending on whether the last real message is a tool result) | the strongest single lever: `1/4 → 4/4` tool use on a task that needs files |
| **System prompt rewritten to envelope form + "these ARE called directly, not inside `execute`"** | the OpenCode Code Mode paragraph ("the tools listed below cannot be called directly") otherwise convinces the model that tools are broken |
| **Assistant history re-serialised as envelopes** | the model imitates its own previous turns; a plain-text assistant turn makes it drop the format |
| **Retry when the reply is unhelpful**: prose, an envelope without tool calls on a first turn, or an *empty* reply | turns the remaining flakes into successes; free on the web plan |
| **Broken JSON is repaired, not dropped**: repair ladder (control chars, trailing commas, raw `arguments` blobs) + `salvageCalls()` + `cleanLeakedEnvelope()` | a raw file dump after `"arguments":` used to cost both tool calls and leak the envelope into the answer |
| **Structural JSON repair** (`readLenient()`): unclosed call objects, `arguments` closed one key early, unescaped quotes, a missing final bracket | 13 replies in one day lost tool calls or showed raw JSON; all 8 distinct shapes now parse into complete calls (§4.6) |
| **Calls are checked against the tool's own schema** (`inspectCalls()`): an unknown tool or a missing required argument is sent back to the model instead of to the agent | `edit` reached OpenCode without `newString` twice; `view_media` was called 12 times |
| **`status` decides, not words** (§4.7): `continue` without a tool call is retried; any other answer after a tool result goes to the judge | the word lists missed 13 of 13 real early stops (§4.7) |
| **Invented tool names are normalised**: `bash`, `cat`, `ls` and friends are mapped onto the available tool via `normalizeToolName()` | the model otherwise calls a tool that does not exist and the turn dies |
| **A blank reply never wins**: `preferAnswer()` guards the retry, and `applyFallback()` uses the raw text then an `(empty reply)` marker | an empty assistant message has no parts at all, so the client shows nothing and the session looks frozen |

Additional hardening in `extractEnvelopes()`:

* multiple concatenated envelopes are all parsed (models emit 2-3 at once),
* prose before/after an envelope is kept as `content`,
* arguments may sit at the call's top level instead of under `arguments`,
* `<tool_result>` / `<tool_response>` blocks and DeepSeek's native `｜DSML｜` tool markup are stripped; a complete native `invoke` block is read as a tool call,
* an envelope written *inside* the `content` string of another envelope is unwrapped,
* keys that landed on the call object instead of `arguments` are moved back,
* string escapes and nested braces are scanned correctly,
* `normalizeToolName()` maps invented tool names (`bash`, `sh`, `cat`, `ls`, `rg`, …) onto the real tool when that tool is available, and leaves unknown names alone.

### 4.6 Structural JSON repair

Measured on every reply of 2026-11-04 (9 sessions, ~190 requests): 13 replies showed envelope JSON to the user, and 4 of them lost a tool call outright. The slips are structural, not textual:

| Shape (fixture in `test/fixtures/real-replies.mjs`) | Before | After |
| --- | --- | --- |
| call object never closed: `…"timeout":120000}]}` | no call, raw JSON shown, turn ended | call kept |
| `arguments` closed after `oldString`, `newString` on the call object, call not closed before the next | first `edit` sent without `newString` | both edits complete |
| the same on the last call, meeting `]` | no call | call complete |
| `"},\n{"name":…` between two calls | first call lost silently | both calls kept |
| an envelope inside `content` | inner call shown as text, never run | inner call runs |
| `｜DSML｜` tail / `<parameter name="content">` wrapper / invented `<tool_response>` | markup shown | stripped |

`readLenient()` (`src/lib/lenient-json.mjs`) reads JSON by structure only: an object that meets `]`, the end, or `{` where a key belongs is closed; an array that meets `}` is closed; a `"key": value` inside an array continues the object before it; a quote ends a string only when JSON can follow it. It never looks at what the text says, so it behaves the same in every language. It runs after strict `JSON.parse` and the older text repairs, and before `salvageCalls()`. A reply that still cannot be read is retried with a "send valid JSON" reminder instead of being shown.

### 4.7 Deciding whether a turn may end

The hardest failure is the model ending its turn halfway: it writes what it is about to do ("Testi çalıştırıp sonucu bildiriyorum.", "Devam ediyorum.", a "Remaining:" list) with no tool call. The first fix matched Turkish and English words; on the labelled set below it caught **0 of 13** real early stops and could never work for other languages, so it was removed. Two structural layers replace it:

1. **`status` in the envelope.** `continue` without a tool call is retried at once. The model writes the field reliably only when its history has it too, so re-serialised assistant turns carry `continue` (calls) or `done` (no calls): `8/15 → 15/15` replies with a status.
2. **The judge.** Any other reply without tool calls after a tool result (`done`, `ask`, or no status) is shown to a second model with the user's request, the last two tool outputs and the reply, and it answers `finished`, `needs_user`, `stopped_early`, `ignored_failure` or `missing_result`. The last three trigger a retry with `CONTINUE_REMINDER` / `FAILURE_RETRY_REMINDER` / `RESULT_REMINDER`. A judge failure or timeout keeps the reply. The same check replaces the old English failure-word list ("not found", "failed", …).

Judge measurement: 29 labelled turn endings from real sessions (13 early stops, 16 correct endings; 6 of them translated into German, Japanese and Spanish), reasoning disabled:

| Judge model | Correct (1 run) | Missed stops | Needless retries | Median |
| --- | --- | --- | --- | --- |
| `qwen3-5-35b-a3b` (default) | 27/29 | 1 | 1 | 1.6 s |
| `zai-org-glm-5.2` | 25/29 | 1 | 3 | 1.6 s |
| `deepseek-v4-1-flash-free` (now `deepseek-v4-1-flash-uncensored`) | 24/29 | 2 | 3 | 1.5 s |
| `kimi-k2-5` | 24/29 | 2 | 3 | 2.0 s |
| old word lists | 16/29 | 13 | 0 | - |

> These runs asked for each judge model on the agent route, which served `qwen3-5-35b-a3b`, `zai-org-glm-5.2` and `kimi-k2-5` as DeepSeek V4.1 Flash Uncensored (§2d). The differences are run-to-run spread of one model, and the judge default is now `deepseek-v4-1-flash-uncensored`, the model that really produced the 27/29.

Over 3 more runs Qwen scored 76/87 (4 missed stops, 7 needless retries; all translated cases right in 17 of 18). Most disagreements are borderline labels (a summary that ends with "two notes remain", an honest "1 test still fails" report). A needless retry costs one upstream call: `preferAnswer()` keeps the first answer when the retry is not better.

Replaying the real conversations up to the 9 points where the model stopped (twice each, tool calls not executed): the new proxy continued at **18/18**, the previous build at 15/18; no reply leaked JSON.

#### Venice's own tool loop ("the tools all returned Tool not found")

The most common way a long task ended without its result had nothing to do with the envelope. `/agents/ad-hoc` runs Venice's own agent loop inside one response. When the model calls a tool with its *native* function calling instead of the envelope, Venice tries to run it server-side, answers `Tool not found` (or, for `view_media`, "invalid media_id"), and lets the model try again - up to 10 steps. None of it reaches the client. After a few rounds the model is sure its tools are broken and writes "bash/read/glob all returned Tool not found, I could not read the files" with `status: done`. The user asks again and the next turn works, because the fresh request starts without that history.

What the stream shows (debug mode logs it): one `veniceai:tool_call_generation` item per step (`id: tcg_agent-node:llm:<n>`), and `veniceai:tool_call_generation.in_progress` carries `detected_tools: [{"type":"Unrecognized","name":"bash"}]`. Arguments are not exposed, so the call cannot be forwarded. `veniceai:server_function_call(_output)` items appear only for Venice's own tools. Unknown request fields (`maxSteps`, `toolChoice`, `disableTools`, …) are accepted and ignored; there is no known switch for the loop.

| Steps in one response | Seen (code-stats/tests-fix runs) | Outcome |
| --- | --- | --- |
| 0-1 | most | normal reply |
| 2-3 | a few | the model recovered and sent a proper envelope |
| 10 (Venice's cap) | 12 of 86 replies | gave up without the result, every time |

Fix: `collectStream()` stops reading once a response starts a 4th step (`SERVER_LOOP_STEPS = 3`, now 0: see "Native calls come with reasoning" below), and the request is sent again with `NATIVE_CALL_REMINDER` ("your tools work; the only way to call a tool is `tool_calls`"). It counts as a format retry; the last allowed retry runs to the end so the turn always gets an answer. Format retries and judge checks now have separate budgets (2 each): with a shared budget, two format retries used it up and the last reply reached the user without the judge seeing it. The judge also treats "my tools are unavailable" as `stopped_early` when the tool results it sees worked.

Measured on the two tasks that triggered it (OpenCode, 6 runs each): before, 2 of 8 and 2 of 12 runs ended with a "tools are broken" answer and the result only came after "Sonucu söyle."; after, 12 of 12 delivered the result in the final message, with 10 loops stopped and retried along the way.

**Native calls come with reasoning** (2026-11-26, Codex-style requests). A Codex desktop session (`deepseek-v4-1-flash-uncensored`) logged 43 "venice tool loop stopped after 4 steps" in an hour, almost all `native calls: exec`, some `functions.exec`, `exec_command`, `image_gen__imagegen`. Scripted requests through the proxy with Codex-style tools (`exec_command`, `write_stdin`, `view_image`, `apply_patch`, `update_plan`, `image_gen__imagegen`) and a system prompt that names them `functions.<name>`: **without `reasoning_effort`, 1 native step in 389 requests** (one unnamed step on GLM; short and 30-step histories, with and without images, even when the user asked for "the exec tool" or "built-in function calling"). With `reasoning_effort` `high` or `medium` (Codex sends one; it becomes `reasoningMode` `enabled` / `adaptive`), 18 of 120 requests had native steps (`exec_command`, `functions.exec_command`, `view_image`, `update_plan`), and the `NATIVE_CALL_REMINDER` retry looped again in 5 of 16 stops. The names are the ones the system prompt uses, with or without its `functions.` prefix, or shortened (`exec`); Venice reports only the name, never the arguments.

The bad ends were not the 4-step loops: the last retry runs unstopped and usually recovered. They were responses with 1-3 steps, below the old threshold: 0 of 3 responses with 2-3 steps and 1 of 3 with one step ended in a usable call. One (`deepseek-v4-1-flash`, image in the tool message, before the fix in §2b) answered "the screenshot came back as an unrendered placeholder, and the shell command I tried came back as an unavailable tool" with `status: ask`, and the judge's two retries did not change it - the reported symptom.

Fix: `SERVER_LOOP_STEPS = 0` (the stream stops at the first native step, once its `in_progress` event has named the call; each step costs ~2.5 s), the retry reminder names the native calls and the client tool each meant (`nativeCallReminder()`, `clientToolFor()`: `functions.exec_command` → `exec_command`, `exec` → `exec_command` when it is the only `exec_*` tool, `imagegen` → `image_gen__imagegen`; no guess when two tools fit), and once a turn has looped every later attempt of it goes with `reasoningMode: "disabled"` (`disableReasoning` from `shouldRetry()`), and a judge retry that a loop cut off is followed by the loop's own retry instead of ending the turn with the first answer (the "shell tool unavailable" reply above survived two judge retries that way in a run with the stop at the second step).

Share of first attempts with a native step, Codex-style shapes (a first turn, after a command's output, after `view_image` with the image in the tool message, and in a user message after it), all runs before and after the fix (the first attempt is the same request either way):

| model | `reasoningMode` disabled (no effort) | adaptive (`medium`) | enabled (`high`) |
| --- | --- | --- | --- |
| `deepseek-v4-1-flash-uncensored` | 0/20 | 11/45 (24%) | 16/60 (27%) |
| `deepseek-v4-1-flash` | 0/20 | not measured | 14/59 (24%) |
| `z-ai-glm-5-3-flash` | 1/20 (unnamed step) | 5/45 (11%) | 16/60 (27%) |

The rate drifted between runs (enabled: 8/59 in the first hour, 20/60 and 18/60 later), so it is the outcome per native run that compares:

| 90 runs each (`high` 60 + `medium` 30) | before | stop at the 2nd step, named reminder, no reasoning on retry | final (stop at the 1st step, loop after a judge retry retried) |
| --- | --- | --- | --- |
| expected `exec_command` call | 87 | 88 | 89 |
| reply giving up ("tool unavailable", no call) | 1 | 1 | 0 |
| no answer within 300 s (upstream) | 2 | 1 | 1 |
| runs with native steps | 11 | 25 | 26 |
| average time of those (answered) | 11.6 s | 5.3 s | 5.2 s |
| "Tool not found" in the reply | 0 | 0 | 0 |

The 300 s cases are upstream: one was a model repeating the same `exec_command` call hundreds of times until its output limit, the others a retry that took two minutes to answer.

#### "Done" without the result

A second way a turn ends badly: the work is done, but the answer only says so ("İşlem tamamlandı, sonuçlar rapor.md'de", "All tests pass now") and leaves out what the user asked to be told; the user then has to ask "sonucu söyle". The first judge prompt had no verdict for this. Fed 5 such replies (Turkish and English: a pointer to a file, "tests pass" without the asked counts, a checked todo list, "analysis finished") twice each, `qwen3-5-35b-a3b` let **9 of 10** through: its reasons named the missing values, but it had to pick `finished` or `needs_user`, and neither retries.

Fix: a fifth verdict, `missing_result` ("the work is done, but the reply does not state a result the user asked to be told"), `finished` now requires the asked-for result, and `needs_user` requires an actual question. `missing_result` retries with `RESULT_REMINDER`, and that retry may replace the first answer (`preferAnswer(…, { replaceAnswer: true })`; otherwise two real answers keep the first, which would throw the corrected answer away). The tool prompt also says a `done` answer states the results, not just that the work is done.

| Probe (3 runs each) | Before | After |
| --- | --- | --- |
| no-result replies caught | 1/10 | **15/15** |
| needless retries on complete answers (short answers, action-only requests, a real question) | 0/4 | 3/18 |

The 3 needless retries are one case, "compute X and write it to a file" answered with "written to the file": the judge reads "compute" as wanting the figures. A retry there costs one call and returns the figures.

### Things that do **not** help (measured)

* Sending `execute`/`search` to the model: OpenCode's Code-Mode wrappers confuse tool naming (`tools.shell` inside `execute` fails with *Unknown tool*), so they are filtered out when real tools exist. `1/4 → 3/4` when removed.
* Longer, bullet-list format instructions: they read as advice rather than a contract. `3/4 → 0/4` with one draft versus the short wording.
* Retrying with a *system* reminder: `1/4`, versus `4/4` for a user-message reminder.

## 5. Translation tables

OpenAI → Venice:

| OpenAI | Venice |
| --- | --- |
| `system` / `developer` messages | joined into `systemPrompt.instructions` |
| `assistant` text | envelope `{"content": …, "tool_calls": []}` |
| `assistant.tool_calls` | envelope with `tool_calls: [{ id, name, arguments }]` |
| `tool` message | `user` message with `{"tool_result": {…}}` |
| `reasoning_effort` | `reasoningMode`: none given, `none|minimal|low|off|disabled` → `disabled`, `medium|auto|adaptive` → `adaptive`, `high` and any other value → `enabled`; `VENICE_WEB_REASONING` forces one for every request. `low` was `enabled` until 2026-11-26: Codex desktop offers no level below `low`, and reasoning brings native tool calls (§4.7) |
| `tools` | prompt text (see §4) |
| `stream` | response framing (upstream is always a stream) |

Venice → OpenAI:

| Venice | OpenAI |
| --- | --- |
| `response.output_text.delta` on a `message` item | `choices[0].delta.content` |
| `response.*reasoning*.delta` | `choices[0].delta.reasoning_content` |
| end of stream | parsed envelope → `delta.tool_calls` + `finish_reason: "tool_calls"`, or `delta.content` + `finish_reason: "stop"` |
| `response.completed` | final chunk carrying an estimated `usage` block |

Usage is estimated (`countTokens` ≈ characters/4) because the web endpoint reports none.

## 5b. Image generation and editing

Measured 2026-11-16, macOS and Linux, through `POST /v1/images/generations` and `/v1/images/edits`.

The web app makes pictures with Venice's own agent, not the ad-hoc route:

```
POST /api/inference/chat/agents/venice?paidImagesMode=block
{ "input": { "messages": [ { …one user message… } ] }, "clientTools": [] }
```

The agent calls its server tool `generate_image` (`{"requests":[{"prompt","resource_id","width","height","seed"?}]}`) or `edit_image` (`{"requests":[{"prompt","media_ids","resource_id"}]}`) and the bytes stream back in the same response. `paidImagesMode=block` keeps it on free models. Events, in order: `response.output_item.added` with a `veniceai:image_generation` item whose `requests[]` carry the `model_id`, `prompt` and `dimensions` really used; `response.content_part.added` (`veniceai:output_image`, `format`); `veniceai:image_generation.image_chunk` (`item_id`, `content_index`, `chunk_index`, `image_chunk_b64`); `response.content_part.done` (final `dimensions`, `is_blurred`, `is_content_violation`); `veniceai:image_generation.done`; then the server call, its output and a short message. `imageCollector()` reads them.

What was measured:

| question | result |
| --- | --- |
| prompt in plain words | the agent rewrites it, picks the size, chats afterwards |
| "Call generate_image once … exactly this prompt, unchanged … Model (resource_id): X. Width W, height H." | prompt used verbatim, model and size honoured, reply "Done." |
| sizes | clamped by the model with the aspect kept: 1792x1024 → 1344x768; chroma 512x512 → 768x768 |
| free models in the catalogue | `z-image-turbo`, `chroma`, `wai-illu` run. `stable-diffusion-3.5-rev2`, `lustify-sdxl`, `lustify-v8` are refused by the tool ("isn't available") and the agent silently switches to another model, so they are not offered |
| two requests in one tool call, different seeds | two **identical** pictures (0 % of pixels differ) |
| one call per picture, each with its own seed | `chroma`: different pictures (84.8 %, 73.5 %); `z-image-turbo`, `wai-illu`: identical, the seed has no effect there |
| edit: reference as `input_image` with its bytes in the multipart request, never uploaded | works in one round trip, no `hydrate_content` (as for chat, §2b); `firered-image-edit` and `qwen-edit-uncensored` both honoured |
| edit `n=2` as two calls | two variants (12.2 %, 5.5 % of pixels differ) |
| time | 4-8 s per generation, 7-15 s per edit; `n` calls run in parallel |

So the proxy sends one agent call per requested image, in parallel, with a seed each when `n > 1`. `mask` is refused (the edit tool has no mask; describe the change in the prompt). `response_format: url` is answered with a data URL, since the proxy hosts no files. OpenAI model names (`dall-e-3`, `gpt-image-1`, …) map to the default model; any other unknown name is a 400.

## 5c. Image generation on the Studio route

Read from the web app's bundle on 2026-11-25 (the request schema of the Studio page, `venice.ai/studio/image`), then measured through this proxy on the same day (all seven free models, Windows, curl 8.x Schannel).

```
POST /api/inference/image          (JSON, same auth and attestation headers as chat)
{ "requestId", "modelId", "prompt", "width", "height", "seed", "steps",
  "hideWatermark", "matureFilter", "embedExifMetadata", "format": "png"|"webp", "type": "image",
  "aspectRatio"?, "resolution"?, "negativePrompt"?, "cfgScale"?, "stylePreset"?, "variants"? (1-4),
  "loraStrength"?, "styleReferences"? [{ "url": data URL, "strength" }], "quality"?, "transparentBackground"? }
```

`seed`, `steps`, `width`, `height`, `hideWatermark` and `matureFilter` are required by the schema. The answer is the picture's bytes (`image/png|webp|jpeg`); the headers say what happened: `x-venice-model-id`, `x-venice-model-name`, `x-venice-is-blurred`, `x-venice-is-content-violation`, `x-venice-is-adult-content`, `x-venice-is-adult-model-content-violation`, plus `x-ratelimit-*`. `seed` must be at most 999999999 (`Number must be less than or equal to 999999999`).

Which settings a model takes comes from the catalogue (`GET /api/app/models`, section `image`): `supportsNegativePrompts`, `supportsSeed`, `supportsSteps`, `settings.steps.max`, `settings.cfgScale.scale`, `settings.widthHeightDivisor`, and for fixed-size models `settings.aspectRatio` + `settings.resolution` + `settings.customSizeMapping`. The web app drops settings the model does not take; the proxy answers 400 instead.

Schema limits measured on 2026-11-25, the same for every model: `width` and `height` at most 1344 each and 1,500,000 pixels in total ("Number must be less than or equal to 1344", "Total pixel count (width × height) must not exceed 1,500,000"); `prompt` at most the model's `promptCharacterLimit` ("String must contain at most 1500 character(s)" on SD35, while `z-image-turbo` takes 1600). On fixed-size models (`krea-2-turbo`) the picture's size comes from `aspectRatio` + `resolution` only: 16:9 at 2K returns 2560x1440 whatever `width`/`height` say, as long as those pass the limits. `chroma` and `lustify-v8` (`settings.outputScale: 1.5`) return 1.5x the size asked for (1024 → 1536).

Per-model effect, measured with one setting changed against the same seed (mean pixel difference to the base picture; the same request twice differs by 0 to 7):

| model | other seed | steps 4 | negativePrompt | cfgScale | stylePreset |
| --- | --- | --- | --- | --- | --- |
| z-image-turbo | 53 | 0 | 1 | 0 | 63 |
| chroma | 62 | 0 | 0 | 0 | 70 |
| wai-illu | 70 | 34 | 35 | 21 | 74 |
| krea-2-turbo | 65 | 0 | 0 | 0 | 113 |
| stable-diffusion-3.5-rev2 | 125 | 56 | 20 | 18 | 34 |
| lustify-sdxl | 48 | 31 | 22 | 41 | 39 |
| lustify-v8 | 60 | 20 | 22 | 28 | 38 |

None of these fields is refused upstream: a model that does not take one ignores it. `hideWatermark: false` adds the "Venice" mark in the bottom-left corner on every model, and `format: "webp"` returns WebP on every model, `krea-2-turbo` included (its catalogue says `supportsFormatSelection: false`). `src/lib/models.mjs` mirrors those values.

Unlike the agent route this one takes `modelId` directly, so the free models the agent refuses (SD35, Lustify) are offered here. The proxy warns when `x-venice-model-id` differs from the model asked for.

**Catalogue fields per image model** (`GET /api/app/models`, sections `image` and `inpaint`, read 2026-11-26): `apiUncensored` (true on `chroma`, `wai-illu`, `krea-2-turbo`, `lustify-sdxl`, `lustify-v8`, `qwen-edit-uncensored`), `trainedOnAdultContent` (the same generation models; `wai-illu` also `trainedOnHentaiContent`), `supportsSteps` / `supportsNegativePrompts` / `supportsStylePresents` (they agree with the measured table: steps and negative prompts only on `wai-illu`, SD35 and Lustify, style presets everywhere), `settings.promptCharacterLimit` (1500 on both free edit models), `settings.cfgScale.scale`, `settings.steps`, `settings.widthHeightDivisor` and, for `krea-2-turbo`, `settings.customSizeMapping`. `IMAGE_MODELS` / `EDIT_MODELS` carry these as `nsfw`, `promptLimit`, `steps`, `cfg`, `divisor` and `sizes`; `GET /v1/images/models` (`src/lib/image-catalog.mjs`) publishes them with the controls of the active route.

Edits on the Studio page use `POST /api/inference/multi-edit` (multipart: the fields of `{ modelId, prompt, requestId, aspectRatio?, resolution?, thinkingLevel?, … }` each as its own form field, the pictures as `files`, an optional `mask`) and answer bytes the same way. The proxy does not use it yet: edits stay on the agent route (§5b).

## 6. Free-model catalogue

`src/lib/models.mjs` mirrors the web catalogue entries flagged `usesCredits: false`, plus the measured `route`, `window` and `vision` of each (§2d). The web app fetches that list from `GET /api/app/models` and `GET /api/v2/agents/configuration_options` with the same session; both are useful if you want to regenerate the list automatically (the proxy currently ships a static copy so it works offline and with a dead session).

## 7. Version pins

| Header / query | Value | Where |
| --- | --- | --- |
| `x-venice-middleface-version` | `0.1.1128` | config `middlefaceVersion` |
| Clerk FAPI query | `?__clerk_api_version=2026-05-12&_clerk_js_version=6.39.0` | config `clerkVersion` |
| `clerk-active-*` / `__client_uat` cookies | not used | - |

Both are overridable via environment variables, which is the first thing to try when Venice ships a web update and something starts failing with `400`s.
