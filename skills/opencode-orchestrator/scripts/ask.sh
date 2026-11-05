#!/usr/bin/env bash
# A research task that must end with a report file.
#
#   ask.sh <report-path> <title> <prompt-file>
#
# The report path is relative to the repo root. When the file is still missing,
# the SAME session is told to write what it has, up to 3 times.
# Prints RESULT_OK <path> or RESULT_MISSING <path>.
set -u
here=$(cd "$(dirname "$0")" && pwd)

out=${1:?usage: ask.sh <report-path> <title> <prompt-file>}
title=${2:?usage: ask.sh <report-path> <title> <prompt-file>}
prompt_file=${3:?usage: ask.sh <report-path> <title> <prompt-file>}
root=${ORCH_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
export ORCH_ROOT=$root

full="$(dirname "$prompt_file")/$(basename "$prompt_file" .txt).full.txt"
{
  echo "READ-ONLY research task. Do not change any file except the report $out."
  echo "Pipe long command output through 'head -c 3000'. Give a file:line source for every claim; mark anything you did not verify as UNVERIFIED."
  echo "Your LAST action must be writing the report file $out with your write tool."
  echo
  cat "$prompt_file"
} > "$full"

line=$("$here/oc-run.sh" "$title" "$full")
echo "$line"
session=$(printf '%s' "$line" | sed -n 's/.* session=\([^ ]*\).*/\1/p')

for attempt in 1 2 3; do
  [ -s "$root/$out" ] && break
  [ -z "$session" ] || [ "$session" = none ] && break
  nudge="${full%.full.txt}.nudge$attempt.txt"
  echo "The file $out does not exist yet. Stop investigating. Use your write tool NOW to create $out with what you have found so far; mark unknowns as UNVERIFIED." > "$nudge"
  line=$("$here/oc-run.sh" "$title-nudge$attempt" "$nudge" "$session")
  echo "$line"
done

if [ -s "$root/$out" ]; then echo "RESULT_OK $out"; else echo "RESULT_MISSING $out"; exit 1; fi
