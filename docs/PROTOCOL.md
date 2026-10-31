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
* **Only `__client` is sent back — never `cf_clearance`.** `cf_clearance` is bound to the browser's TLS/IP and expires; `__client` alone passes Cloudflare. `user-agent` must look like a real browser (picked from the browser that owns the cookie), otherwise Cloudflare replies `403` with `cf-mitigated: challenge`.
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
* `tools` and `clientTools` are what the web *agent* uses. Sending `tools: []` does not disable Venice's built-in server tools — the model may still call `view_media`/`get_attachment`.
* The endpoint ignores `temperature`, `top_p` and `max_tokens`.
* Requests with `attestationToken` minted are required for `/api/inference/*`; the mint call needs the same headers (sans attestation).

## 3. Inference response

Newline-delimited SSE (`\n\n` separated `event:`/`data:` frames, `: keepalive` comments, `data: [DONE]` terminator) with `content-type: text/event-stream`. Event names seen:

| Event | Meaning |
| --- | --- |
| `response.created`, `response.in_progress` | lifecycle |
| `response.output_item.added` / `.done` | item boundaries; `item.type` is `message`, `reasoning`, `veniceai:tool_call_generation`, `veniceai:server_function_call`, `veniceai:server_function_call_output` |
| `response.content_part.added` / `.done` | content part boundaries |
| `response.output_text.delta` / `.done` | text deltas (also used for reasoning — disambiguate via the `item.type` of the `output_index`) |
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
2. `clientTools` must be shaped `{ name, description, inputSchema }`, and handing them over did **not** make the model call them: it kept calling Venice's own server tools (`view_media`) and then concluded `read_file` did not exist. Making that path work would mean teaching the model Venice's own call syntax *and* handling `veniceai:client_function_call` items — more moving parts than the envelope below.

So the proxy hides the tool machinery from Venice entirely and asks the model for an envelope:

```json
{"content": "text for the user", "tool_calls": [{"name": "read", "arguments": {"path": "a.txt"}}]}
```

The proxy then emits real OpenAI `tool_calls` and, on the next turn, sends results back as a user message containing `{"tool_result": {"tool_call_id": …, "content": …}}`.

### Reliability measures

A small model asked for a custom format is *usually* compliant, but not always. Four measures, each measured on ~6–12 runs of a real OpenCode session:

| Measure | Effect |
| --- | --- |
| **Format reminder as the last user message** (`(format reminder) …`, two variants depending on whether the last real message is a tool result) | the strongest single lever: `1/4 → 4/4` tool use on a task that needs files |
| **System prompt rewritten to envelope form + "these ARE called directly, not inside `execute`"** | the OpenCode Code Mode paragraph ("the tools listed below cannot be called directly") otherwise convinces the model that tools are broken |
| **Assistant history re-serialised as envelopes** | the model imitates its own previous turns; a plain-text assistant turn makes it drop the format |
| **One automatic retry with a harder reminder** when the reply is prose, or an envelope without tool calls on a first turn | turns the remaining flakes into successes; free on the web plan |

Additional hardening in `extractEnvelopes()`:

* multiple concatenated envelopes are all parsed (models emit 2–3 at once),
* prose before/after an envelope is kept as `content`,
* arguments may sit at the call's top level instead of under `arguments`,
* `<tool_result>` tags the model writes by hand are stripped,
* string escapes and nested braces are scanned correctly.

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
| `clerk-active-*` / `__client_uat` cookies | not used | — |

Both are overridable via environment variables, which is the first thing to try when Venice ships a web update and something starts failing with `400`s.
