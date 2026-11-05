#!/usr/bin/env bash
# The verification gate, run after every group of worker tasks.
#
#   gate.sh
#
# Prints running workers, the project's own checks, and stray temp files, then
# GATE_DONE. The project checks come from .orchestrator/gate.local.sh in the repo
# (tests, type checks, lint: whatever proves the work there). Without that file
# the gate falls back to `npm test` when package.json has a test script.
set -u
root=${ORCH_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
cd "$root" || exit 1

echo "== running opencode workers"
pgrep -fl "opencode run" || echo "(none)"

echo "== project checks"
if [ -x .orchestrator/gate.local.sh ]; then
  ./.orchestrator/gate.local.sh 2>&1 | tail -n 60
  echo "checks exit: ${PIPESTATUS[0]}"
elif [ -f package.json ] && node -e 'process.exit(require("./package.json").scripts?.test ? 0 : 1)' 2>/dev/null; then
  npm test --silent 2>&1 | tail -n 40
  echo "checks exit: ${PIPESTATUS[0]}"
else
  echo "no .orchestrator/gate.local.sh and no npm test script: write a gate.local.sh for this repo"
fi

echo "== changed files"
git status --short 2>/dev/null | head -n 40

echo "== stray temp files"
git status --short --untracked-files=all 2>/dev/null | grep -E 'zz-|\.orig$|\.rej$' || echo "(none)"

echo GATE_DONE
