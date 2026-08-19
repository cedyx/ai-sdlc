#!/usr/bin/env bash
# Allow writes only to the glob patterns passed as arguments.
#
# Claude PreToolUse hook for Write|Edit. Reads the tool call on stdin and exits
# non-zero to deny. Arguments are globs matched against the repo-relative path.
set -euo pipefail

payload=$(cat)
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

# No path in the payload means nothing to restrict (e.g. a tool shape we do not
# recognise). Fail closed only on paths we can actually evaluate.
[ -z "$path" ] && exit 0

rel="${path#"$(pwd)/"}"

for pattern in "$@"; do
  # shellcheck disable=SC2053  # intentional glob match, not string equality
  if [[ $rel == $pattern ]]; then
    exit 0
  fi
done

echo "Write denied: ${rel} is outside this role's allowed paths ($*)." >&2
exit 2
