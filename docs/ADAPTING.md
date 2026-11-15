# Adapting to Venice instead of fighting it

Measured on 2026-11-15 against the live web client. The question was whether the
envelope can be dropped. It cannot, but three things were established that the
proxy can use:

1. Venice's own agent loop runs server tools correctly, with arguments, and
   chains several steps in one response without help.
2. The agent does **not** hand `clientTools` to the model. Declaring them (7
   variants, 3 reminder syntaxes) never produced a single
   `veniceai:client_function_call`. The model also does not list them when asked
   what tools it has.
3. A `function_call` + `function_call_output` pair sent as **top-level sibling
   messages** in `input.messages` is accepted: the model reads the result and
   answers. The same pair nested inside a user message's `content` is not.

So: server tools can be delegated to Venice, client tools cannot. The boundary
is the tool's name, not the envelope.

## What the server loop can do

| server tool | client tool it can stand in for | argument mapping | measured |
| --- | --- | --- | --- |
| `web_scrape` | `webfetch` | `{url}` → `{url}` | recognised, called, output returned |
| `context_grep` | `grep` | `{pattern}` → `{pattern}` | recognised, called |
| `calculator` | `bash` with one arithmetic expression | `{expression}` | 2 chained calls, `391` then `400`, `failed: 0` |
| `web_search` | `websearch` | `{query}` | recognised |
| `view_media` | `read` on an image | `{media_ids}` | already handled by the proxy |

Everything else has no counterpart: `read` on a local path, `write`, `edit`,
`glob`, `shell` with real commands, `task`, and any MCP tool. `web_scrape` does
not read `file://`.

Frequency in one real log: `shell` 1638, `view_media` 1351, `edit` 80,
`bash` 28, `write` 22, `read` 5, `websearch` 2, `webfetch` 2, `grep` 2. The
convertible ones are rare; the heavy ones are exactly the ones with no
counterpart.

## Option A - delegate the convertible names (no model, no envelope change)

A static table, in the spirit of `TOOL_ALIASES`: when the client offers
`webfetch`, `websearch`, `grep` or a `bash` whose command is a bare expression,
send that tool to Venice as the matching `type` in `tools[]` and drop it from the
tool prompt. Venice runs it, the answer comes back as
`veniceai:server_function_call_output`, and no call has to be parsed.

What it buys: the `Tool not found` loop disappears for those tools, and the
model cannot mis-quote their JSON. What it costs: the proxy has to keep
`SERVER_LOOP_STEPS` only for the emulated remainder, and the mapping has to be
narrow enough not to lie (a `bash` command that is not arithmetic must stay
emulated).

Blocker to settle first: with a converted tool in `tools[]` **and** other client
tools emulated, the model still prefers its own server tools even when the task
needs the emulated ones, so the prompt has to say which is which. That is the
same failure the envelope was built for; it is why this is a per-tool choice and
not a switch.

Status (2026-11-15): implemented behind `VENICE_WEB_DELEGATE` (`0` turns it off),
currently only `webfetch` -> `web_scrape` and `grep` -> `context_grep`
(`DELEGATED_TOOLS` in `emulate.mjs`). `toVeniceRequest({ delegate })` moves those
names out of the prompt and into `tools[]` as server types; three tests pin it.
**Not yet measured on a live turn** - that is what decides whether the model uses
the delegated tool or falls back to the envelope.

## Option B - stop having tools the server cannot run

The other direction, and the one nobody has tried: change what the *client* sees.

- **`read` over a URL, not a path.** If the proxy served the working tree at a
  local HTTP port, `read` would become `web_scrape` and `grep` would become
  `context_grep`, both of which Venice already runs. The conversion then needs no
  heuristics: the tool *is* a server tool.
- **`shell` as `calculator` plus `web_scrape`** only covers a fraction; a real
  shell still needs the envelope.
- **`edit`/`write` stay emulated** whatever happens, because they need the bytes
  back.

This is the honest version of "adapt ourselves": not a cleverer prompt, but a
narrower tool surface where Venice can do the work.

## What does not help (measured)

- `clientTools` with the right `{name, description, inputSchema}`: accepted, 200,
  ignored.
- The browser's own `clientTools` (`approve_paid_usage`, `edit_video`) added to
  the set: no change.
- A system-prompt reminder with `｜DSML｜invoke`, with `{"name":…}`, and inside the
  user message: 0 `tool_call_generation` steps in all three.
- `tools: [{type:'function',…}]` (OpenAI shape): still rejected, as documented.
  `tools: [{type:'calculator'}]` is the accepted shape.

## Result of the first live measurement

Delegation works, with a caveat per tool:

| delegated | recognised | output returned | turn closed with the answer |
| --- | --- | --- | --- |
| `webfetch` -> `web_scrape` | yes (`Recognized`) | yes, `{\"url\",\"title\",\"content\"}` | yes |
| `grep` -> `context_grep` | **no** (`Unrecognized`) | yes, `total_matches` + `results` | yes |

`context_grep` being `Unrecognized` did not matter: the server ran it anyway and
returned the matches. The `Unrecognized` label is a naming guess by the parser,
not a refusal, so it is not a criterion for what may be delegated.

What the tool returns is not what a client tool would return (`web_scrape` gives
an object, `grep` gives matches over the *conversation*), so a delegated tool
only fits when the client accepts a server-shaped result. That is true for
`webfetch` and `grep` in OpenCode: both are read-only lookups.

## Result of the second measurement (naming the server tool)

A delegated tool leaves the prompt, so the model kept calling the emulated
neighbour: a URL went to `read` instead of `web_scrape`. One line of the system
prompt now names the server tool. Three runs each, through the proxy:

| tools offered | result |
| --- | --- |
| `webfetch` alone | 3/3 the server ran `web_scrape`, the answer carried the title, `finish_reason: stop`, no tool call reached the client |
| `webfetch` + `read` | the model still called `read` with `{path: "https://example.com"}`, `finish_reason: tool_calls` |

So the line helps when nothing competes, and does not settle the ambiguity with
`read`. The tool list itself is the stronger signal and the model reads `read` as
the way to open things.

## Result of the third measurement (rewriting the call)

A `read` whose `path` is a URL is turned into a `web_scrape` call by the proxy
(`delegatedCallTarget`), with the URL moved from `path` to `url`. The client never
sees the call. Through the proxy, with `read` alone, with `read` + `webfetch`, and
three runs each: the answer carried the title every time, `finish_reason: stop`,
no tool call returned to the client. The rewrite is unconditional on the shape of
the argument, so a `read` of `/tmp/a.txt` stays with the client.

That settles the ambiguity without asking the model: the call is recognised
whatever name it used.

## What is left

- Settle `read` against `webfetch`. Options, cheapest first: drop `read` from the
turn when a URL is in the message; rename the delegated tool in the prompt to
  something file-shaped is not possible (the server picks by `type`); teach the
  proxy to answer a `read` whose `path` starts with `http` by delegating it.
- Watch a mixed turn: one delegated tool plus one emulated one. `emulatedTools`
  stays true there, so `SERVER_LOOP_STEPS` still bounds the server loop.
- Decide on `calculator` for a bare-expression `bash`: it needs a check of the
  command before the turn, which is a heuristic the current table does not have.
