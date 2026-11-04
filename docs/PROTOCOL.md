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

  So: HTTP/1.1, the user agent via `-A`, no `accept: text/event-stream` (the backend streams SSE without it), one short-lived curl process per request. Headers go over fd 3 so the bearer token never shows up in `ps`. Clerk calls still use Node's fetch. `VENICE_WEB_TRANSPORT=fetch|curl` overrides the default `auto` (curl when installed).
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
  "modelId": "deepseek-v4-1-flash-free",
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
* The endpoint ignores `temperature`, `top_p` and `max_tokens`.
* Requests with `attestationToken` minted are required for `/api/inference/*`; the mint call needs the same headers (sans attestation).

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
2. **The judge.** Any other reply without tool calls after a tool result (`done`, `ask`, or no status) is shown to a second model with the user's request, the last two tool outputs and the reply, and it answers `finished`, `needs_user`, `stopped_early` or `ignored_failure`. The last two trigger a retry with `CONTINUE_REMINDER` / `FAILURE_RETRY_REMINDER`. A judge failure or timeout keeps the reply. The same check replaces the old English failure-word list ("not found", "failed", …).

Judge measurement: 29 labelled turn endings from real sessions (13 early stops, 16 correct endings; 6 of them translated into German, Japanese and Spanish), reasoning disabled:

| Judge model | Correct (1 run) | Missed stops | Needless retries | Median |
| --- | --- | --- | --- | --- |
| `qwen3-5-35b-a3b` (default) | 27/29 | 1 | 1 | 1.6 s |
| `zai-org-glm-5.2` | 25/29 | 1 | 3 | 1.6 s |
| `deepseek-v4-1-flash-free` | 24/29 | 2 | 3 | 1.5 s |
| `kimi-k2-5` | 24/29 | 2 | 3 | 2.0 s |
| old word lists | 16/29 | 13 | 0 | - |

Over 3 more runs Qwen scored 76/87 (4 missed stops, 7 needless retries; all translated cases right in 17 of 18). Most disagreements are borderline labels (a summary that ends with "two notes remain", an honest "1 test still fails" report). A needless retry costs one upstream call: `preferAnswer()` keeps the first answer when the retry is not better.

Replaying the real conversations up to the 9 points where the model stopped (twice each, tool calls not executed): the new proxy continued at **18/18**, the previous build at 15/18; no reply leaked JSON.

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
| `reasoning_effort` | `reasoningMode`: `none|minimal|disabled` → `disabled`, `medium|auto|adaptive` → `adaptive`, else `enabled` |
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

## 6. Free-model catalogue

`src/lib/models.mjs` mirrors the web catalogue entries flagged `usesCredits: false`. The web app fetches that list from `GET /api/app/models` and `GET /api/v2/agents/configuration_options` with the same session; both are useful if you want to regenerate the list automatically (the proxy currently ships a static copy so it works offline and with a dead session).

## 7. Version pins

| Header / query | Value | Where |
| --- | --- | --- |
| `x-venice-middleface-version` | `0.1.1128` | config `middlefaceVersion` |
| Clerk FAPI query | `?__clerk_api_version=2026-05-12&_clerk_js_version=6.39.0` | config `clerkVersion` |
| `clerk-active-*` / `__client_uat` cookies | not used | - |

Both are overridable via environment variables, which is the first thing to try when Venice ships a web update and something starts failing with `400`s.
