#!/usr/bin/env bash
# Checks the environment before any worker is started.
#
#   preflight.sh
#
# Fails when opencode is missing, when the installed version does not accept a
# flag the scripts use (an unknown flag makes `opencode run` print its help and
# exit 0 without running anything), or when ORCH_MODEL is not a listed model.
set -u
ok=1
fail() { echo "FAIL $*"; ok=0; }

command -v opencode >/dev/null || { echo "FAIL opencode is not on PATH"; exit 1; }
for tool in perl node git; do command -v "$tool" >/dev/null || fail "$tool is not on PATH"; done
echo "opencode $(opencode --version 2>/dev/null)"

help=$(opencode run --help 2>&1)
for flag in --format --dir --title --session --model; do
  printf '%s' "$help" | grep -q -- "$flag" || fail "opencode run does not accept $flag (update opencode or the scripts)"
done
[ "${ORCH_AUTO:-0}" = "1" ] && { printf '%s' "$help" | grep -q -- "--auto" || fail "opencode run does not accept --auto"; }

if [ -z "${ORCH_MODEL:-}" ]; then
  fail "ORCH_MODEL is not set (export ORCH_MODEL=provider/model)"
else
  provider=${ORCH_MODEL%%/*}
  opencode models "$provider" 2>/dev/null | grep -qxF "$ORCH_MODEL" || fail "model $ORCH_MODEL is not listed by 'opencode models $provider'"
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a git repository"
echo "repo ${root:-?}"

echo "== workers already running"
pgrep -fl "opencode run" || echo "(none)"

[ "$ok" = 1 ] && echo PREFLIGHT_OK || { echo PREFLIGHT_FAILED; exit 1; }
