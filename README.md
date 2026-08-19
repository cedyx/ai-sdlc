# ai-sdlc

One definition of an agent SDLC pipeline, compiled to Claude Code and Codex.

Both tools now support skills, subagents, and plugins, but only the skill format
is genuinely shared. Agent definitions and repo contracts carry the same
information in different shapes. `ai-sdlc` keeps the source neutral and
generates each provider's native files.

## What is shared, and what is compiled

| Layer | Portability |
|---|---|
| Skill instructions (`SKILL.md`) | shared verbatim, symlinked into both providers |
| Agent semantics (role, prompt, model, capabilities) | one IR, compiled per provider |
| Capability enforcement | provider-specific: Claude hooks vs Codex sandbox |
| Repo contract | one source, generated to `CLAUDE.md` and `AGENTS.md` |
| Backlog state | provider-neutral artifact behind `BacklogProvider` |
| Plugin packaging | provider-specific, out of scope here |

## Layout

```
.ai/                        source of truth
├── contract.md             repo conventions, generated to CLAUDE.md + AGENTS.md
├── config.yaml             providers to emit, backlog backend
├── agents/*.yaml           neutral agent IR
├── skills/epic-flow/       orchestration, shared by both providers
└── epics/*.yaml            artifacts (filesystem backend only)

src/
├── schema/                 Zod: agent IR, epic state machine, config
├── generators/             IR -> .claude/agents, .codex/agents, contracts
└── backlog/                BacklogProvider: github-issues | filesystem

scripts/hooks/              guard scripts backing Claude capability limits
```

Everything under `.claude/`, `.codex/`, `.agents/`, `CLAUDE.md`, and `AGENTS.md`
is build output. Edit `.ai/` and re-run the generator.

## Usage

```bash
npm install
npm run generate          # build + emit provider files

ai-sdlc status <epic-id>  # exit 0 implementable, 1 blocked, 2 not found
ai-sdlc approve <id> --by <name>
```

## The approval gate

The epic artifact is the state machine. Implementation is unblocked by one fact:
`status: APPROVED`, with a recorded approver and timestamp.

```
business-analyst  ->  status: DRAFT
                        |
                   human approves
                        |
                      APPROVED  ->  developer may execute
```

This is deliberately not a conversational step. Neither provider guarantees that
a model-driven delegation pauses where you expect, so `epic-flow` checks the
artifact instead of trusting sequencing. `ai-sdlc status` exits non-zero when the
gate is closed, which makes it usable from CI as well as from the orchestrator.

## Capability asymmetry

Claude enforces write-path and VCS restrictions through `PreToolUse` hooks:
mandatory, and the tool call fails. Codex expresses the coarse grant through
`sandbox_mode` and the rest as instructions appended to the agent prompt:
advisory, and a confused model can talk itself past them.

The generator emits both, but they are not equivalent. A restriction that must
hold under an adversarial or confused model needs a second layer — branch
protection, CI checks, or human review — not agent configuration alone.

## Backlog backends

`github-issues` is canonical: the artifact lives in a fenced `ai-sdlc` YAML block
in the issue body, with `status:<value>` mirrored to a label so the GitHub UI can
filter. The label is a projection; the block wins on read.

`filesystem` stores `<id>.yaml` under `.ai/epics/`. No network, no auth,
reviewable in the same PR as the code.

Switch backends in `.ai/config.yaml`. `epic-flow` never names either one.

## Status

Early. The generators, gate, guard scripts, and both backends work and are
tested; the pipeline has not yet been run end to end on a real feature in a
consuming repo.
