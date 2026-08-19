#!/usr/bin/env bash
# Block history-mutating VCS commands; allow read-only inspection.
#
# Claude PreToolUse hook for Bash. Commit granularity belongs to the
# orchestrator, so implementer roles leave their work uncommitted.
set -euo pipefail

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# Matches the verb after `git`, tolerating global flags such as -C <dir>.
if printf '%s' "$command" | grep -Eq '(^|[;&|]|\$\()[[:space:]]*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+(commit|push|tag|merge|rebase|reset|cherry-pick|revert)\b'; then
  echo "VCS mutation denied: committing and releasing belong to the orchestrator. Leave changes in the working tree." >&2
  exit 2
fi

exit 0
