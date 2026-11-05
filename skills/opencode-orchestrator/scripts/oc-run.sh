#!/usr/bin/env bash
# One opencode worker run with every guard the orchestrator needs.
#
#   oc-run.sh <title> <prompt-file> [session-id]
#
# - stdin closed (an open stdin pipe makes `opencode run` hang before the model)
# - hard time limit (ORCH_LIMIT seconds, default 1500; exit 142 = timed out)
# - runs in the repo root via --dir, JSON events logged to the run directory
# - prints one summary line: exit code, session id, tool calls, tool errors, final text
#
# Environment: ORCH_MODEL (required), ORCH_ROOT (default: git top level),
# ORCH_LIMIT, ORCH_RUNS (default: $TMPDIR/opencode-orchestrator/<repo>), ORCH_AUTO=1 adds --auto.
set -u

title=${1:?usage: oc-run.sh <title> <prompt-file> [session-id]}
prompt_file=${2:?usage: oc-run.sh <title> <prompt-file> [session-id]}
session=${3:-}

: "${ORCH_MODEL:?set ORCH_MODEL to the worker model (provider/model)}"
root=${ORCH_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
limit=${ORCH_LIMIT:-1500}
runs=${ORCH_RUNS:-${TMPDIR:-/tmp}/opencode-orchestrator/$(basename "$root")}
mkdir -p "$runs"

[ -s "$prompt_file" ] || { echo "RUN $title ERROR prompt file missing or empty: $prompt_file"; exit 2; }

safe=$(printf '%s' "$title" | tr -c 'A-Za-z0-9._-' '_')
log="$runs/$safe.$(date +%H%M%S).jsonl"

args=(run --format json --dir "$root" -m "$ORCH_MODEL" --title "$title")
[ -n "$session" ] && args+=(-s "$session")
[ "${ORCH_AUTO:-0}" = "1" ] && args+=(--auto)

perl -e 'alarm shift; exec @ARGV' "$limit" opencode "${args[@]}" "$(cat "$prompt_file")" < /dev/null > "$log" 2> "$log.err"
code=$?

summary=$(node -e '
const fs = require("fs")
const events = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})
const session = events.find((e) => e.sessionID)?.sessionID ?? "none"
const tools = events.filter((e) => e.type === "tool_use")
const failed = tools.filter((e) => e.part?.state?.status === "error").length
let last = []
for (const e of events) {
  if (e.type === "step_start") last = []
  if (e.type === "text" && e.part?.text) last.push(e.part.text)
}
const text = last.join(" ").replace(/\s+/g, " ").trim().slice(0, 300)
process.stdout.write(`session=${session} tools=${tools.length} tool_errors=${failed} final=${JSON.stringify(text)}`)
' "$log" 2>/dev/null || echo "session=none tools=0 tool_errors=0 final=\"\"")

status=ok
[ "$code" = "142" ] && status=TIMEOUT
[ "$code" != "0" ] && [ "$code" != "142" ] && status="EXIT_$code"
# `opencode run` prints its help and exits 0 on an unknown flag: no events at all is a failure too
[ "$code" = "0" ] && ! grep -q '"sessionID"' "$log" && status=NO_EVENTS

echo "RUN $title $status $summary log=$log"
[ "$status" = ok ]
