# Changelog

## Unreleased

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
