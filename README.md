# opencode-venice-web

**Use your venice.ai *web* subscription - the unlimited one - from OpenCode (or any OpenAI-compatible agent), without spending a cent of API credits.**

Venice's API is metered: a Pro account includes only **$1/month** of API spend and the docs are explicit that "a paid subscription does not include free or unlimited API usage". The venice.ai **web app** is the opposite: text chat on the web models is unlimited on Pro and above.

This project runs a tiny local proxy that talks to the *web app's own* endpoints (`clerk.venice.ai` for the session, `outerface.venice.ai` for inference) using the cookie your browser already has, and exposes the result as a normal OpenAI-compatible endpoint on `127.0.0.1`. Point OpenCode at it and the free web models become the backend.

```
OpenCode ──HTTP──> 127.0.0.1:3456  ──HTTPS + your session cookie──>  outerface.venice.ai
   │                 (this proxy)                                            │
   └── tools ────────────/v1/chat/completions ────────────────────────────────┘
                     venice.ai web models, unlimited
```

- No API key, no credits, no password stored: only the browser's long-lived Clerk `__client` cookie.
- 20 free web models (DeepSeek, Qwen, GLM, Kimi, Gemma, Aion, TEE-hosted variants).
- Tool calling works: OpenCode's `read`/`write`/`edit`/`shell`/`glob`/`grep` tools are emulated through a JSON envelope (see [docs/PROTOCOL.md](docs/PROTOCOL.md)).
- Zero runtime dependencies. Node 22+ only.

---

## Quick start

```sh
git clone https://github.com/CanArslanDev/opencode-venice-web.git
cd opencode-venice-web
./install.sh --default
```

That installs the code to `~/.local/share/opencode-venice-web`, adds the `venice-web` provider to `~/.config/opencode/opencode.json`, starts a background service (launchd or systemd), and signs in by reading the `venice.ai` cookie from Brave/Chrome/Edge/Chromium.

Add `--with-nul-plugin` if you also use other providers from OpenCode (see [NUL bytes](#nul-bytes-and-400-invalid-request)).

Then **restart OpenCode** and pick a model such as `venice-web/deepseek-v4-1-flash-free`.

Or without cloning:

```sh
curl -fsSL https://raw.githubusercontent.com/CanArslanDev/opencode-venice-web/main/install.sh | sh -s -- --default
```

> The `raw.githubusercontent.com` shortcut only works while the repository is **public**. For a private repo, use the `git clone` flow above (or any mirror you control).

Prefer doing it by hand? Three commands:

```sh
npm install -g .        # or run everything from the checkout with `node src/...`
venice-web-login        # reads the cookie from your browser
venice-web-sync --default   # writes the OpenCode provider
venice-web             # starts the proxy on 127.0.0.1:3456
```

Check everything is wired up:

```sh
node src/doctor.mjs      # or venice-web-doctor
curl -s 127.0.0.1:3456/health
```

---

## How it works

| Step | Endpoint | Notes |
| --- | --- | --- |
| Session cookie | `venice.ai` cookie jar | long-lived Clerk `__client`, read straight out of the browser |
| Session JWT | `POST clerk.venice.ai/v1/client/sessions/<id>/tokens` | ~60 s lifetime, refreshed by the proxy, single-flight |
| Client attestation | `POST outerface.venice.ai/api/app/user/client_attestation/mint` | short-lived token, cached 5 minutes |
| Inference | `POST outerface.venice.ai/api/inference/chat/agents/ad-hoc` | newline-delimited SSE |
| Tool calls | emulated | the web endpoint does not accept OpenAI `tools` |

The proxy exposes:

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness + signed-in account |
| `GET /v1/models` | the free web catalogue |
| `POST /v1/chat/completions` | streaming and non-streaming chat, with tool emulation |
| `POST /reload` | drop cached token/attestation (after re-login) |

Full details, including the exact request/response shapes and the tool-emulation protocol, are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

---

## Models

Only models the web catalogue marks as free (`usesCredits: false`) are exposed - picking a credit-billed model through this proxy would silently spend your API balance, so they are left out on purpose.

| Family | Model ids |
| --- | --- |
| DeepSeek | `deepseek-v4-1-flash-free`, `deepseek-ai-DeepSeek-V3.2` |
| Qwen | `qwen-3-8-27b`, `qwen3-6-27b`, `qwen3-5-35b-a3b` |
| GLM | `zai-org-glm-5.2`, `zai-org-glm-4.6` |
| Kimi | `kimi-k2-5` |
| Gemma | `google-gemma-4-31b-it`, `google-gemma-4-26b-a4b-it`, `gemma4-uncensored` |
| Venice | `venice-uncensored-1-2` |
| Aion | `aion-labs-aion-3-0`, `aion-labs-aion-3-0-mini` |
| TEE / E2EE hosted | `e2ee-qwen3-8-27b`, `e2ee-gpt-oss-120b-p`, `e2ee-qwen3-6-35b-a3b`, `e2ee-gemma-4-26b-a4b-uncensored-p`, `e2ee-qwen-2-5-7b-p`, `e2ee-qwen3-vl-30b-a3b-p` |

The catalogue lives in [`src/lib/models.mjs`](src/lib/models.mjs); edit it and rerun `venice-web-sync` if Venice adds models. If the web catalogue ships a model you want, run `GET /v1/models` (or `venice-web-doctor`) after adding it to verify it is reachable.

---

## Commands

| Command | What it does |
| --- | --- |
| `node src/proxy.mjs` | run the proxy in the foreground |
| `node src/login.mjs` | (re)read the browser cookie and store the session |
| `node src/login.mjs --browser brave` | pick a browser explicitly |
| `node src/login.mjs --cookie "__client=…" --ua "Mozilla/5.0 …"` | manual mode for unsupported browsers |
| `node src/sync.mjs` | add/update the OpenCode provider |
| `node src/sync.mjs --default` | also set `model` and `small_model` |
| `node src/sync.mjs --remove` | remove the provider again |
| `node src/doctor.mjs` | diagnose node/session/proxy/config |
| `npm test` | unit tests for the parser and translator |
| `node test/smoke.mjs` | end-to-end smoke test against a running proxy |

`install.sh` also understands `--uninstall` (`--purge` deletes the stored session too).

---

## Configuration

All environment variables are optional; the defaults are what the installer uses.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VENICE_WEB_CONFIG_DIR` | `~/.config/opencode/venice-web` | session file and logs |
| `VENICE_WEB_SESSION` | `<config dir>/session.json` | session file path |
| `VENICE_WEB_PORT` | `3456` | proxy port |
| `VENICE_WEB_HOST` | `127.0.0.1` | proxy bind address |
| `VENICE_WEB_DEBUG` | off | write every raw model reply to `<config dir>/debug.log` |
| `VENICE_WEB_DUMP` | off | dump the last translated upstream request |
| `VENICE_WEB_TIMEOUT` | `900000` | per-request upstream timeout (ms) |
| `VENICE_WEB_MIDDLEFACE` | `0.1.1128` | `x-venice-middleface-version` header |
| `VENICE_WEB_CLERK_VERSION` | pinned | Clerk frontend API version query |
| `OPENCODE_CONFIG` | `~/.config/opencode/opencode.json` | config file `sync.mjs` patches |

---

## Security and privacy

- The session file (`~/.config/opencode/venice-web/session.json`, mode `600`) holds your Clerk cookie - treat it like a login token, keep it out of git.
- Only `clerk.venice.ai` and `outerface.venice.ai` are contacted; the proxy is bound to loopback by default. Anything that can reach it can use your Venice account, so do not expose the port publicly without thinking about it.
- No password is stored (unlike password-based proxies). Logging out of venice.ai in the browser invalidates the cookie; `/out` from the browser plus a fresh login fixes it.
- Requests leave your machine exactly as the web app would send them: same user agent, same headers, no extra telemetry.

---

## Limitations (read these)

- **Not the official API.** The web endpoints are undocumented and may change. `middleface` version headers are pinned to what the current web client sends.
- **Tool calls are emulated.** The web endpoint ignores OpenAI `tools`, so the model answers with a JSON envelope that the proxy turns into `tool_calls`. This is reliable in practice (see [docs/PROTOCOL.md](docs/PROTOCOL.md) for the measured technique) but it is a prompt contract, not a native feature: `tool_choice: required` is advisory, and streaming answers arrive buffered rather than token-by-token.
- **No sampling controls.** `temperature`, `top_p` and `max_tokens` are not applied by this endpoint.
- **Unlimited, not infinite.** Venice's fair-use and Cloudflare bot checks apply. A Cloudflare challenge surfaces as HTTP 401 with a "refresh the cookies" message.
- **Web session, not API route.** Anything that needs the official API surface (embeddings, images, video, `/responses`) still has to use `api.venice.ai` with an API key. Both can coexist in OpenCode - the installer only *adds* a provider.

### NUL bytes and `400 Invalid request parameters`

Reading a binary file with `grep -a`, `cat` or `tail` puts NUL bytes into a tool result, from there into the stored conversation, and from there into every later request. The web inference endpoint tolerates NUL bytes in most places but rejects them inside `systemPrompt` with `String must not contain null bytes`, which breaks that session for good.

The proxy handles this on its own, so `venice-web` needs no plugin:

* a request body with a raw control byte is repaired before parsing,
* every string in the outgoing payload is scrubbed (NUL becomes a space) and logged.

Installing `--with-nul-plugin` adds a small OpenCode plugin (`packaging/opencode-nul-sanitizer.ts`, copied to `~/.config/opencode/plugins/`) that does the same for **every other provider** you use from OpenCode. It is redundant for `venice-web` but the official Venice API has the same limit, so it is worth having if you switch providers per session. Use `/fix-nuls` style history cleanups as usual.

---

## Troubleshooting

Start with `node src/doctor.mjs`. The full list - Cloudflare challenges, expired sessions, "tools do not work", a turn with no output, port conflicts, service logs - is in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

Common ones:

```sh
node src/login.mjs                       # everything auth related
node src/sync.mjs                        # provider missing from /models
tail -f ~/.config/opencode/venice-web/proxy.log   # see each request and tool call
launchctl kickstart -k gui/$(id -u)/ai.opencode.venice-web   # macOS: restart the service
systemctl --user restart ai.opencode.venice-web               # Linux
```

---

## Related work

- [`despin/venice-ai-chat-proxy`](https://github.com/despin/venice-ai-chat-proxy) - password login, requires `wreq-js` for Chrome TLS fingerprints.
- [`weizsw/magpie-venice-web`](https://github.com/weizsw/magpie-venice-web) - the same idea as a Magpie plugin. Note that OpenCode v2 no longer loads the v1 plugin hook shape, so it does not drop into OpenCode unchanged.
- [`Parsa-Nasiri/venice-free-ai-chat`](https://github.com/Parsa-Nasiri/venice-free-ai-chat) - anonymous access with per-IP daily caps instead of an account session.

This project differs by: no runtime dependencies, cookie-only auth, an explicit tool-emulation protocol with reliability safeguards, and an OpenCode installer.

---

## License

[MIT](LICENSE). Not affiliated with Venice.ai.
