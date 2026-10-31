# Changelog

## 0.1.4 - 2026-10-31

- Stop the session from pausing on a plan. Real session ("Notchnook Pro
  crackleme"): after a tool result the model wrote "Şimdi ... arayacağım" with
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
