# Troubleshooting

Work through the list in order; most problems are auth or OpenCode config, not the protocol.

**First step, always:**

```sh
node src/doctor.mjs
tail -40 ~/.config/opencode/venice-web/proxy.log
```

`doctor` checks node, the session file, the running proxy and the OpenCode provider. The log line for every request looks like this - if you see `->` but no `<-`, the upstream call is failing:

```
2026-01-01T00:00:00.000Z -> deepseek-v4-1-flash-free • 4 msgs • 11 tools [edit,glob,…] • stream=true
2026-01-01T00:00:02.000Z   <- tools: read({"path":"a.txt"})
```

---

## The model answers but never calls tools

Symptom: the model says things like *"the tools are not available / Tool not found"* although OpenCode listed them.

1. Look at the log: `<- no tools • text: …` means the model ignored the envelope.
2. `VENICE_WEB_DEBUG=1` + restart, then read `~/.config/opencode/venice-web/debug.log` - it contains every raw model reply and whether it parsed.
3. If the raw text *is* an envelope and still does not parse, you found a parser bug: the envelope scanner lives in `src/lib/emulate.mjs` (`extractEnvelopes`), with tests in `test/emulate.test.mjs`.
4. If the raw text is prose, the model is not following the contract: switch models (`venice-web/qwen-3-8-27b` and `venice-web/zai-org-glm-5.2` are the most obedient in testing) or tighten `TOOL_PROMPT`.

## `401` / "refresh the cookies" / Cloudflare challenge

The session cookie is stale, was rotated by a fresh browser login, or Cloudflare decided to challenge your IP.

```sh
node src/login.mjs           # re-read the cookie from the browser
curl -s 127.0.0.1:3456/reload
```

Logging out of venice.ai in the browser invalidates `__client` - sign in again, then rerun the login command.

## `no usable session yet` right after install

Sign in at venice.ai in a supported browser first, then:

```sh
node src/login.mjs --browser brave
# or, when your browser is not supported:
# copy the `__client` value (or the whole Cookie header) from a clerk.venice.ai request
node src/login.mjs --cookie "__client=…" --ua "Mozilla/5.0 (…) Chrome/… Safari/537.36"
```

The `--ua` must look like the browser that owns the cookie; generic user agents can trigger Cloudflare.

## Model missing from `/models` in OpenCode

```sh
node src/sync.mjs            # rewrite the provider entry
```

Then check `~/.config/opencode/opencode.json` contains `provider.venice-web` with `options.baseURL` pointing at your port. If you run OpenCode with a project-level `opencode.json`, run `sync --config ./opencode.json` too.

## Port already in use

```sh
lsof -nP -iTCP:3456 -sTCP:LISTEN
VENICE_WEB_PORT=4000 node src/proxy.mjs
```

Remember to rerun `sync` after changing the port, or set `VENICE_WEB_PORT` for both the service and `sync`.

## Streaming feels "chunky"

Expected: with tool emulation the whole message is buffered, parsed, and then replayed. Non-tool requests could stream live - a small change in `openaiChunks` - but then a half-written envelope would flash in the UI first.

## Service problems

macOS:

```sh
launchctl list | grep venice-web
launchctl kickstart -k gui/$(id -u)/ai.opencode.venice-web
tail -f ~/.config/opencode/venice-web/proxy.log
launchctl bootout gui/$(id -u)/ai.opencode.venice-web     # stop
```

Linux:

```sh
systemctl --user status ai.opencode.venice-web
systemctl --user restart ai.opencode.venice-web
journalctl --user -u ai.opencode.venice-web -f
```

## A turn produces no output and the session looks frozen

Symptom: the assistant message ends with nothing in it (`content: []`, `finish: stop`,
no error), so the client shows no answer and the session appears to stop. Asking
`cevap?` may produce another blank turn.

Cause: the model sometimes replies with an empty envelope,
`{"content":"","tool_calls":[]}`. Forwarded as-is, that is an assistant turn with
no parts at all.

The proxy handles it (0 blank turns over a 24-turn reproduction):

* an empty reply is detected and retried with a reminder that says the content was
  empty (`empty reply, retrying...` in the log),
* a retry may only replace the first answer when it is actually better
  (`preferAnswer`), so a blank retry cannot overwrite a good reply,
* if everything is blank, the raw text is used and then an `(empty reply)` marker,
  so the turn is never invisible.

If you still see it, check the log for the reason and open an issue with the raw
reply (`VENICE_WEB_DEBUG=1`, then `debug.log`).

## The session stops mid-task with a plan

Symptom: the assistant writes "Şimdi ... bakacağım / Sıradaki adım: ..." (or a
numbered next-steps list) and the turn ends with `tool_calls: []`, so the session
looks finished while half the work is open.

The proxy retries such a reply once with an ACT NOW reminder, sent as a *user*
message (the channel the model actually obeys), and prefers the retry when it
contains tool calls. The same applies when the last tool output looks like a
failure. Watch it in the log:

```
  ~ reply describes the next step, retrying...
  ~ retry improved the reply
  <- tools: write(...)
```

If it still stops, the model is out of step with the task: ask for the next step
explicitly ("devam et") or switch to a more obedient model
(`venice-web/qwen-3-8-27b`). `VENICE_WEB_DEBUG=1` writes the raw replies to
`debug.log`.

## `400 String must not contain null bytes`

A NUL byte (`\x00`) reached the request. It usually comes from reading a binary file: `grep -a`, `cat` or `tail` on a `.db`, `.pyc`, binary or app bundle puts NUL bytes into a tool result, they land in the stored session, and every later request of that session carries them.

The web endpoint tolerates NUL bytes in messages and tool results but rejects them in the system prompt, where the message is:

```
String must not contain null bytes   (path: ["systemPrompt","instructions"])
```

The proxy already fixes this for you:

* it repairs a request body that contains a raw control byte before parsing it, and
* it replaces NUL bytes in the outgoing payload, logging `scrubbed N NUL byte(s)`.

So a NUL byte in the session is harmless for `venice-web`. For **other** providers, install the plugin once:

```sh
./install.sh --with-nul-plugin
# or: cp packaging/opencode-nul-sanitizer.ts ~/.config/opencode/plugins/
```

To keep the tool output clean in the first place:

```sh
grep -a "pattern" file | tr -d '\000'
strings -a file | grep "pattern"
tail -5 file | tr -d '\000'
```

## `400 Invalid request body` from Venice

The web client shipped a new schema. Try:

```sh
VENICE_WEB_MIDDLEFACE=0.1.9999 node src/proxy.mjs      # bump the version header
VENICE_WEB_CLERK_VERSION='?__clerk_api_version=2026-01-01&_clerk_js_version=7.0.0' node src/proxy.mjs
```

The error body names the offending field/path; compare it with `docs/PROTOCOL.md` §2.

## `temperature`/`top_p`/`max_tokens` are ignored

By design - the web endpoint does not support them. Map what matters through model choice and `reasoning_effort` variants instead.

## Uninstall

```sh
./install.sh --uninstall          # keeps your session file
./install.sh --uninstall --purge   # removes the session too
```

## Reporting a bug

Include: platform, node version, `doctor` output, the log lines around the failing request, and (with secrets redacted) `VENICE_WEB_DUMP=/tmp/req.json` output. Do not paste `session.json` publicly - it contains a live cookie.
