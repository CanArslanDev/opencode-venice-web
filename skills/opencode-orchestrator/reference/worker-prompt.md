# Worker prompt template

Write the task part into a file with a quoted heredoc and pass that file to `code.sh` / `ask.sh`. The scripts add the hard rules (`preamble.txt` for code, a READ-ONLY header for research) and the list of files.

```bash
cat > "$RUNS/add-parser.txt" <<'EOF'
GOAL: <behaviour in one or two sentences, with exact names>
  e.g. Add `parseDuration(text: string): number` to src/lib/time.ts. It accepts "90s", "5m", "2h"
  and returns milliseconds; anything else throws `RangeError("invalid duration: <text>")`.

READ FIRST: <the files to copy style from>
  e.g. src/lib/time.ts (existing helpers), test/time.test.ts (test style)

CHANGE: <every file, and what goes where>
  e.g. src/lib/time.ts: the function. test/time.test.ts: tests for the three units, "0s", "",
  "5x", "-1m".

TEST COMMAND: <exact command, one file only>
  e.g. npx vitest run test/time.test.ts

KNOWN CAUSE (repairs only): <the failing test, the exact error line, your diagnosis>
EOF
"$SKILL/scripts/code.sh" "src/lib/time.ts test/time.test.ts" add-parser "$RUNS/add-parser.txt"
```

Rules of thumb:

- One function or one file per task; a few closely related files at most. Big tasks make the worker loop or stop early.
- List the test file in the paths when the task must add tests, so `code.sh` checks that it changed.
- Exact names, signatures, keys and messages beat descriptions. If two parallel tasks must agree on a name, define it in an earlier task.
- For repairs, reproduce the failure first and hand over the verified cause. "Fix the failing tests" without a diagnosis wastes rounds.
- Research: a tool-call budget ("at most 15 tool calls"), the report path, and "a file:line source for every claim".
