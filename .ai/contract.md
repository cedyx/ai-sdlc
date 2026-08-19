# Project contract

Shared instructions for every AI agent working in this repository, regardless of
provider. This file is the source; `CLAUDE.md` and `AGENTS.md` are generated
from it by `ai-sdlc generate`. Edit here, never there.

## What this project is

`ai-sdlc` compiles one provider-neutral definition of an agent SDLC pipeline
into the native formats of Claude Code and Codex, so the same roles, the same
workflow, and the same repo conventions work in either tool.

## Architecture

- `.ai/` is the single source of truth: the contract, agent IR, and skills.
- `src/schema/` defines the neutral IR with Zod. Adding a field means teaching
  every generator to lower it — prefer expressing new restrictions with the
  existing vocabulary.
- `src/generators/` lowers the IR to each provider. Generators are pure
  functions from spec to string; keep filesystem work in the CLI.
- `src/generators/plugin.ts` is a third lowering, not a packaging step. Claude
  plugins reject the frontmatter hooks that carry enforcement in repo mode, so
  the two outputs are deliberately different files.
- `src/backlog/` implements `BacklogProvider`. Provider-specific vocabulary
  (issue numbers, labels, file paths) must not escape this directory.
- `src/enforcement/` holds the boundary itself, and is provider-neutral for the
  same reason `src/backlog/` is: it constrains what enters the repository, which
  is true whichever agent wrote the code, or none. Nothing here may import from
  `src/generators/`. Emitting the CI workflow from `generate` is a convenience of
  packaging, not evidence it belongs to a provider.
- `.claude-plugin/` and `plugins/ai-sdlc/` at the repo root are generated too,
  but committed on purpose: `claude plugin marketplace add <owner>/<repo>` reads
  them from the default branch, which is what makes installing one step. Change
  `.ai/`, then `ai-sdlc plugin build`; do not edit the tree.
- Generated files are build output. Never hand-edit `.claude/agents/*`,
  `.codex/agents/*`, `CLAUDE.md`, `AGENTS.md`, or the root plugin tree.

## Conventions

- TypeScript, ESM, Node 20+. Strict mode stays on.
- Validate external input at the boundary with Zod, then trust the parsed type.
- Tests are Vitest, colocated in `src/__tests__/`.
- Comments explain why, not what. Do not narrate the diff.

## The approval gate

The epic artifact is the state machine. Implementation is gated on
`status: APPROVED` plus a recorded approver — never on conversational assent.
Any change that lets a role advance past the gate without reading the artifact
is a bug, not a convenience.

Distinguish workflow separation from an enforcement boundary. Splitting the
roles into two agents sequences the work and keeps each context small; it does
not make the gate hard, because subagent orchestration is model-driven and the
main agent keeps its own tool access. Treat agent definitions as division of
labour, and put enforcement where a model cannot argue with it: `ai-sdlc status`
exits nonzero unless the artifact is APPROVED with a recorded approver, and
`Epic` refuses to parse APPROVED without one. New enforcement belongs in the
CLI, where it is identical across providers, rather than in per-provider agent
configuration.

The CI check in `src/enforcement/` closes the loop by consuming that exit code,
and its claim is narrower than it first reads:

> No pull request passes the approval gate unless it identifies an approved epic.

It does not prove the change implements that epic. The `AI-SDLC-Epic:` marker is
author-supplied, so a confused or adversarial author can point at any approved
epic; only review establishes the semantic relationship. Do not widen that
sentence in docs or output. Inferring the epic from changed files was rejected
for the same reason it looks attractive — its failure mode is a green check that
proves the wrong thing, which is worse than no check.

Checking global state instead was rejected too: with `DRAFT` and
`CHANGES_REQUESTED` both legitimately long-lived, requiring every non-terminal
epic to be approved would block unrelated work for days, and passing would still
not show that *this* change belongs to an approved epic. Resist adding an
`IN_PROGRESS` status to make such a scan viable; that would let an enforcement
detail leak backward into the domain model.

## The IR expresses intent, not enforcement

A field in `src/schema/agent.ts` says what a role *wants*. It implies nothing
about anything stopping the role from doing otherwise. `lowerCapabilities` in
the Codex generator is the authority on what became of a given field, reporting
each as `native`, `advisory`, `broadened`, or `unsupported`; `generate` prints
the result.

Two bugs came from ignoring this, and both read as reasonable at the time. A
comment here claimed `sandbox_mode` enforced a `git commit` ban -- it cannot
distinguish `git commit` from `git diff`. The report called a read-only role's
denied network request `native`, describing the outcome as if it were the
request. When documenting a restriction, name the mechanism and say which of the
three modes actually runs it; if the answer is "none, it is prose", say that.

## Capability asymmetry between providers

Claude enforces write-path and VCS limits with PreToolUse hooks, which are
mandatory. Codex expresses the coarse grant via `sandbox_mode` and the rest as
instructions, which are advisory. Claude *plugin* mode sits between them: the
loader silently discards per-agent hooks, and the PreToolUse payload has no
agent identity, so only restrictions shared by every role can be enforced and
the rest are prose.

Codex is not offered as a plugin at all. Codex supports plugins and custom
subagents, but agent definitions are not currently a distributable plugin
component, so installing one would carry the workflow without the two role
configurations. Repo mode emits `.codex/agents/*.toml` instead and keeps the
topology. Revisit if the format gains agents.

Do not justify that choice by appealing to the approval gate. The gate is
`ai-sdlc status` and holds regardless of how many agents are configured; what a
Codex plugin cannot reproduce is role separation. Conflating the two is the same
error as treating agent separation as an authorization boundary.

A restriction that must hold under an adversarial or confused model therefore
needs a second layer — branch protection, CI checks, or review — not agent
configuration alone. When adding a restriction, state which of the three modes
actually enforce it; an unqualified claim will be wrong in at least one.
