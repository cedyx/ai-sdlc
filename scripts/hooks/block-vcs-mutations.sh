#!/usr/bin/env bash
# Block history-mutating VCS commands; allow read-only inspection.
#
# Claude PreToolUse hook for Bash. Commit granularity belongs to the
# orchestrator, so implementer roles leave their work uncommitted.
set -euo pipefail

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# `agent_id` is set only inside a subagent, so its absence means the
# orchestrating session -- which is the actor that must commit. A plugin-level
# hook fires for both, and has no matcher that can tell them apart.
agent_id=$(printf '%s' "$payload" | jq -r '.agent_id // empty')
[ -z "$agent_id" ] && exit 0

# Quoted arguments are stripped first: a mutation verb inside one is data,
# not a command position, so searching for the literal is not a mutation.
unquoted=$(printf '%s' "$command" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g")

# Matches the verb after `git`, tolerating global flags such as -C <dir>.
if printf '%s' "$unquoted" | grep -Eq '(^|[;&|]|\$\()[[:space:]]*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+(commit|push|tag|merge|rebase|reset|cherry-pick|revert)\b'; then
  echo "VCS mutation denied by the ai-sdlc plugin (block-vcs-mutations.sh): committing and releasing belong to the orchestrator. Leave changes in the working tree." >&2
  exit 2
fi

exit 0
