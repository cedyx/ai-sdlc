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

## Getting started

`ai-sdlc` is a build tool you run *in* a repo; it is not something the agents
call. You run `generate` when the source changes and commit the output.

```bash
cd your-project
npx github:cedyx/ai-sdlc init       # seeds .ai/ and scripts/hooks/
$EDITOR .ai/contract.md             # the starter is a TODO skeleton on purpose
npx github:cedyx/ai-sdlc generate   # emit provider files
git add .ai .claude .codex .agents scripts CLAUDE.md AGENTS.md && git commit
```

`init` refuses to run if `.ai/` already exists, so it cannot clobber a team's
definitions. Commit the generated files: agents load them from a plain
checkout, where `node_modules` may not exist.

## Using it from Claude Code

Everything is picked up from the checkout — there is nothing to configure.

- `.claude/agents/*.md` become subagents. Claude selects them from their
  `description`, or you can name one: *"use the business-analyst subagent to
  spec out CSV export"*.
- `.claude/skills/` is a symlink to `.ai/skills/`, so `epic-flow` loads as a
  skill. Invoke it with `/epic-flow "add CSV export"`.
- `CLAUDE.md` is read automatically as repo context.
- The `PreToolUse` hooks in each agent file are enforced by Claude itself: a
  write outside the allowed globs, or a `git commit` from the developer role,
  fails the tool call.

## Using it from Codex

Same checkout, different files.

- `.codex/agents/*.toml` become agents, with `sandbox_mode` set from the same
  capability block that produced Claude's hooks.
- `.agents/skills/` is a symlink to `.ai/skills/` — the same `SKILL.md`, shared
  verbatim rather than copied.
- `AGENTS.md` is read automatically as repo context.
- Restrictions the sandbox cannot express are appended to the agent prompt as a
  `# Capability restrictions` section. See *Capability asymmetry* below: on
  Codex these are instructions, not enforcement.

## The workflow

The two roles hand off through the epic artifact, not through conversation.

```
/epic-flow "add CSV export"
  └─ business-analyst  writes .ai/epics/EPIC-1.yaml     status: DRAFT
                       (only path it may write to)

you                    read it, then approve:
                       ai-sdlc approve EPIC-1 --by you  status: APPROVED

  └─ developer         implements it, writes tests
                       (may not touch the epic, may not commit)

you                    review the diff, commit, push
```

The skill checks the gate by running the CLI, so the stop is real:

```bash
ai-sdlc status EPIC-1
# EPIC-1  DRAFT  Add CSV export to the reports page
#
# Open questions (1):
#   - Which delimiter for locales using comma as decimal separator?
#     assumption: Using comma; revisit if EU users report breakage.
echo $?   # 1 — blocked

ai-sdlc approve EPIC-1 --by yse
ai-sdlc status EPIC-1 ; echo $?   # 0 — implementable
```

Exit codes: `0` implementable, `1` blocked, `2` no such epic. The same check
works in CI as a required status check, which is the layer that holds when an
agent talks itself past a prompt.

## Commands

```bash
ai-sdlc init                     # seed .ai/ + scripts/hooks/ (refuses to overwrite)
ai-sdlc generate                 # compile .ai/ -> provider files
ai-sdlc status <epic-id>         # gate check; exit 0/1/2
ai-sdlc approve <id> --by <name> # record approver + timestamp
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
