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
src/lib/emulate.mjs           tool-call emulation: prompt, envelope parser, SSE reader, translation
src/lib/server.mjs            routing + OpenAI chunk translation + retry logic
src/lib/cookies.mjs           Chromium cookie decryption (macOS Keychain / Linux secret-tool)
test/emulate.test.mjs         unit tests (node --test)
test/smoke.mjs                end-to-end check against a running proxy
docs/PROTOCOL.md              upstream protocol + why tools are emulated + measurements
docs/TROUBLESHOOTING.md       user-facing problem solving
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

1. **Zero runtime dependencies.** `node_modules` must stay empty; `package.json` has no `dependencies`.
2. **Only two hosts** may be contacted: `clerk.venice.ai` and `outerface.venice.ai` (`assertDestination`).
3. **Only the `__client` cookie** is sent upstream, never `cf_clearance`.
4. **English** everywhere in code, logs, docs, commit messages.
5. **Node 22+**, ESM, no build step, no TypeScript.
6. Session file stays mode `600`; never commit it.
7. `src/lib/emulate.mjs` stays pure (no I/O) so it is unit-testable.

## Gotchas that cost real debugging time

* OpenCode v2 plugins must `export default { id, setup|effect }` — the v1 "function returning hooks" shape (as used by `magpie-venice-web`) is **not** loaded. Hence this is a proxy, not a plugin.
* The web endpoint ignores OpenAI `tools`; `clientTools` exists (`{name, description, inputSchema}`) but the model prefers Venice's own server tools. Tool calling is therefore emulated through a JSON envelope. Details and measured trade-offs: `docs/PROTOCOL.md` §4.
* OpenCode's Code Mode system prompt says "the tools listed below cannot be called directly" — models read this as "tools are broken" and stop calling them. The proxy therefore filters `execute`/`search` out of the advertised tools and states plainly that the tools *are* called directly.
* Models imitate their own history: if an assistant turn is plain text, the next turn is plain text too. Assistant history is re-serialised into envelope form for that reason.
* Models emit **several** envelopes per message, or prose plus an envelope. `JSON.parse` of the whole text loses the calls — `extractEnvelopes()` exists for this.
* The format reminder appended as the *last user message* is the single biggest reliability lever (`1/4 → 4/4` in testing). A system reminder in the same place is much weaker.
* `response.output_text.delta` carries reasoning too; distinguish via `item.type` of the `output_index`.
* Clerk rotates `__client` on use — always read `set-cookie` and persist.

## Changing the model catalogue

`src/lib/models.mjs` is curated to `usesCredits: false` web models only. Credit-billed models are excluded because the agent endpoint may silently serve a different (free) model for them. After editing, rerun `node src/sync.mjs` so the OpenCode config picks up the new list.

## Version pins

`middlefaceVersion` and `clerkVersion` are pinned in `src/lib/config.mjs` to what the current web client sends, and are env-overridable. A sudden run of `400 Invalid request body` normally means Venice changed the schema: capture the real web-app traffic, update the pin, and update `docs/PROTOCOL.md`.

## Testing checklist before a release

1. `npm test`
2. `node src/login.mjs` then `node test/smoke.mjs`
3. One real OpenCode session: list a directory, read a file, edit it, run a command.
4. Re-run the failing-session scenario from `docs/PROTOCOL.md` §4 (prose-only model first turn) to confirm the retry still rescues it.
5. `./install.sh` on a clean `$HOME` (or `$VENICE_WEB_INSTALL_DIR`) to confirm install/uninstall.
