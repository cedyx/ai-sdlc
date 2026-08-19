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
- `src/backlog/` implements `BacklogProvider`. Provider-specific vocabulary
  (issue numbers, labels, file paths) must not escape this directory.
- Generated files are build output. Never hand-edit `.claude/agents/*`,
  `.codex/agents/*`, `CLAUDE.md`, or `AGENTS.md`.

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

## Capability asymmetry between providers

Claude enforces write-path and VCS limits with PreToolUse hooks, which are
mandatory. Codex expresses the coarse grant via `sandbox_mode` and the rest as
instructions, which are advisory. A restriction that must hold under an
adversarial or confused model therefore needs a second layer — branch
protection, CI checks, or review — not agent configuration alone.
