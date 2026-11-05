---
name: opencode-orchestrator
description: Orchestrate opencode worker agents from Claude Code. Claude plans, splits the work into small tasks, hands each one to an `opencode run` worker, then verifies every result itself (tests, type checks, diffs) before reporting. Use when the user asks to delegate coding or research to opencode workers, or invokes /opencode-orchestrator.
argument-hint: "[task, or empty to continue the backlog in .orchestrator/STATUS.md]"
---

# opencode orchestrator

You are the **orchestrator and controller**. Workers (opencode sessions started with `opencode run`) do the research and the edits; you plan, delegate, verify and report. A worker's "DONE" is a claim, never a fact: a task is finished only when **your own** verification passes.

Talk to the user in their language, briefly and honestly: lead with the result, say what you could not verify, never present a guess as a fact, never say "it is running" before you have confirmed it.

Task for this session: `$ARGUMENTS` (empty: read `.orchestrator/STATUS.md` in the repo and continue its backlog, or ask the user one short question).

## Setup (once per session)

1. `export ORCH_MODEL=<provider/model>` - the worker model. If you do not know it, ask the user; never guess.
2. Run `scripts/preflight.sh`. It checks that `opencode` exists, that every flag the scripts use is accepted by the installed version (an unknown flag makes `opencode run` print its help and **exit 0 without running** - the most expensive silent failure there is), that the model is listed, and that no stale workers are running.
3. Read the repo's own rules (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, whichever exist) and `.orchestrator/STATUS.md` if present. Create `.orchestrator/STATUS.md` from `templates/STATUS.md` when the user wants state kept between sessions.
4. Run `scripts/gate.sh` once to learn the real baseline. Never trust numbers written in STATUS.md or by a worker.

All scripts live next to this file (`scripts/`). They take the prompt from a **file**, never inline: write prompts with a quoted heredoc (`<<'EOF'`) into the run directory the scripts print, so quotes cannot break the shell.

## The loop

1. **Plan** a phase as groups of small tasks (one function or one file, a few related files at most). Tasks in one group touch **disjoint files** and can run in parallel; anything sharing a file or depending on another task is sequential.
2. **Contract first**: shared types, function names, config keys go in one small task before the parallel ones, so they agree on names.
3. **Run** the group with `scripts/code.sh` (edits) or `scripts/ask.sh` (research). Start a whole group as **one** background Bash task and wait for its completion notification. Do not poll with `sleep`/`pgrep` loops.
4. **Gate**: `scripts/gate.sh` after every group.
5. **Triage failures yourself** before sending anything back: run the failing test alone and in its whole file (passes alone, fails in the file = shared state between tests), read the assertion and the code, decide: wrong test, wrong code, or test pollution. Send the worker the verified cause, the exact failing test and error line, and the fix direction. Never "please fix the tests".
6. **Probe logic changes** (parsers, rules, validators) with a few concrete inputs of your own; green tests written by the same worker prove little.
7. **Read the diff** of anything risky: security-relevant code (input validation, process spawning, IPC, auth), shared entry points, generated files that must not be edited.
8. After a phase: the **full** test suites of the touched packages and a build when shared code changed.
9. **Report**: what is done and verified (with numbers), what is not verified, what you need from the user. If you made a mistake, say so plainly. Update `.orchestrator/STATUS.md`.

## Writing a worker prompt

Use `reference/worker-prompt.md` as the template. It must contain:

- the exact files the worker may touch, and "touch only these files";
- the goal as behaviour, with exact names and signatures when you know them;
- what to read first (neighbouring code to copy the style from);
- the hard rules (below) and the exact test command;
- an end condition: "your LAST action is the edit/write tool", "reply with one line DONE and the test result";
- research: READ-ONLY, a tool-call budget, output limits (`| head -c 3000`), every claim with a `file:line` source, the report file written as the last action.

## Rules for you and every worker

- Never commit, push, open PRs, switch branches or stash unless the user asked in this conversation. Tell workers the same.
- No secrets: never read or print tokens, cookies, credential files, keychains, session files. Never edit the user's personal config (shell, editor, Claude Code settings).
- No new dependencies and no global installs without the user's approval; use the package manager the repo already uses.
- Every behaviour change comes with tests; a worker must never weaken what a test proves to make it pass.
- Throwaway files are named `zz-*`, stay inside the repo, and are deleted afterwards (the gate lists leftovers).
- Do not stop processes you did not start (the user's dev servers, other sessions).

## Known worker failure modes (verify against all of them)

| Symptom | What to do |
| --- | --- |
| Stops after a few tool calls, says DONE or "DONE (partial)" without the edit | `code.sh` hashes every promised file and re-prods the **same session** when one did not change |
| Claims tests pass that it never ran | re-run them yourself; `oc-run.sh` prints how many tool calls really happened |
| Guesses instead of reading the error | give it the exact failing test, the error line and your diagnosis |
| Loops on big prompts or big tool output | small tasks, `head -c 3000` on command output |
| "Fixes" a test by weakening it | read test diffs; the rule above goes into every prompt |
| Breaks syntax in a small edit | type-check / compile after every group |
| Invents facts in research reports (names, values) | require `file:line` sources and check the quotes with a script |
| Ends with "my tools are not working" although earlier calls worked | a provider-side tool loop, not a real failure: continue the same session with "your tools work, call the tool now" |

## Harness facts that cost hours before (do not relearn them)

- **Close stdin**: `opencode run` reads extra input from stdin when stdin is a pipe that stays open; it then blocks **before calling the model** - no output, no change, for hours. Every call ends with `< /dev/null` (the scripts do this).
- **Hard time limit on every worker**: `perl -e 'alarm shift; exec @ARGV' <seconds> ...` (exit 142 = killed). macOS has no `timeout`. One worker without a limit ran all night.
- **Working directory**: pass `--dir <repo root>`; do not rely on `cd` alone.
- **Permissions**: a non-interactive run rejects anything that would need an approval (writing outside the project, some commands) and the session simply ends. Keep worker work inside the repo. `--auto` approves everything not explicitly denied: only with the user's consent (`ORCH_AUTO=1`).
- **Launcher done is not task done**: a backgrounded launcher returns at once. Trust only the completion notification of the background task, the run log, and `pgrep -fl "opencode run"`.
- **A changed-file check can lie** when the file was already dirty: compare content hashes before and after (code.sh does).
- **Stale workers** can still edit files hours later: list them with `pgrep -fl "opencode run"`, stop only the ones you started.
- **Liveness**: the run log (`--format json` events) grows while a worker works. If the model provider has a local proxy with its own log, a new request line per model call is the best signal; retries logged by the proxy itself are not a problem.
- Syntax-check any script you write (`bash -n` / `zsh -n`) before starting it.

Testing pitfalls for vitest + jsdom + React + state stores: `reference/test-pitfalls.md`.
