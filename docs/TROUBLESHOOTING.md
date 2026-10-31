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
