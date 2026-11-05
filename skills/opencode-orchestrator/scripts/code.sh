#!/usr/bin/env bash
# A coding task that must change every listed file.
#
#   code.sh "<path> <path> ..." <title> <prompt-file>
#
# Paths are relative to the repo root. Content hashes are taken before and after,
# so a file that was already dirty cannot fake success. When a promised file did
# not change, the SAME session is continued (it keeps its context) with a short
# "make the edit now" nudge, up to 2 times.
#
# Prints CODE_OK <title> or CODE_MISSING <title>: <files>. CODE_OK only proves
# that the files changed; the gate decides whether the work is right.
set -u
here=$(cd "$(dirname "$0")" && pwd)

paths=${1:?usage: code.sh "<paths>" <title> <prompt-file>}
title=${2:?usage: code.sh "<paths>" <title> <prompt-file>}
prompt_file=${3:?usage: code.sh "<paths>" <title> <prompt-file>}
root=${ORCH_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
export ORCH_ROOT=$root

hash_of() { if [ -e "$root/$1" ]; then cksum < "$root/$1"; else echo none; fi; }
declare -a files
read -r -a files <<< "$paths"
before=()
for f in "${files[@]}"; do before+=("$(hash_of "$f")"); done

unchanged() {
  local i out=""
  for i in "${!files[@]}"; do
    [ "$(hash_of "${files[$i]}")" = "${before[$i]}" ] && out+="${files[$i]} "
  done
  printf '%s' "${out% }"
}

full="$(dirname "$prompt_file")/$(basename "$prompt_file" .txt).full.txt"
{ cat "$here/../reference/preamble.txt"; echo; echo "FILES YOU MAY CHANGE: $paths"; echo; echo "TASK:"; cat "$prompt_file"; } > "$full"

line=$("$here/oc-run.sh" "$title" "$full")
echo "$line"
session=$(printf '%s' "$line" | sed -n 's/.* session=\([^ ]*\).*/\1/p')

for attempt in 1 2; do
  missing=$(unchanged)
  [ -z "$missing" ] && break
  nudge="${full%.full.txt}.nudge$attempt.txt"
  cat > "$nudge" <<EOF
These files have not changed yet: $missing.
Stop investigating. Read at most 3 more files, then make the edits with your edit/write tool now, then run the test command from the task. Your last action must be the edit or the test run. Reply with one line DONE and the test result.
EOF
  if [ -n "$session" ] && [ "$session" != none ]; then
    line=$("$here/oc-run.sh" "$title-nudge$attempt" "$nudge" "$session")
  else
    # the first run never reached the model: start over with the full prompt
    line=$("$here/oc-run.sh" "$title-retry$attempt" "$full")
    session=$(printf '%s' "$line" | sed -n 's/.* session=\([^ ]*\).*/\1/p')
  fi
  echo "$line"
done

missing=$(unchanged)
if [ -z "$missing" ]; then echo "CODE_OK $title"; else echo "CODE_MISSING $title: $missing"; exit 1; fi
