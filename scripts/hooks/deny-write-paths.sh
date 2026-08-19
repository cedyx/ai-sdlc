#!/usr/bin/env bash
# Deny writes to the glob patterns passed as arguments; allow everything else.
#
# Claude PreToolUse hook for Write|Edit. The inverse of restrict-write-paths.sh,
# for roles that own the codebase but must not touch other roles' artifacts.
set -euo pipefail

payload=$(cat)
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

[ -z "$path" ] && exit 0

rel="${path#"$(pwd)/"}"

for pattern in "$@"; do
  # shellcheck disable=SC2053  # intentional glob match, not string equality
  if [[ $rel == $pattern ]]; then
    echo "Write denied: ${rel} belongs to another role. Report the needed change instead." >&2
    exit 2
  fi
done

exit 0
