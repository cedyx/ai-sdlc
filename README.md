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
| Plugin packaging | Claude: committed tree, installable from the repo |

## Layout

```
.claude-plugin/             marketplace manifest (generated, committed)
plugins/ai-sdlc/           the plugin itself (generated, committed)

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

> Just want to install and use it? See **[GUIDE.md](GUIDE.md)** — no setup, no
> terminal. The rest of this README is for people configuring or extending it.

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

## Install as a plugin

This repo *is* a plugin marketplace. Nothing to clone, build, or npm-install:

```bash
claude plugin marketplace add cedyx/ai-sdlc
claude plugin install ai-sdlc@ai-sdlc-marketplace
```

The slash-command equivalent, and why both lines must run in the same client,
are in [*Add it (one time)*](GUIDE.md#add-it-one-time).

You get both agents, the `epic-flow` skill, and the guard scripts. The consuming
repo needs no `.ai/`, no `.claude/`, and no `node_modules`.

Two things the plugin cannot bring, both by nature rather than omission:

- **The repo contract.** `CLAUDE.md` describes *your* codebase, so it can only
  come from your own `.ai/contract.md` via `generate`.
- **Per-role capability enforcement.** See *Capability asymmetry* — plugin mode
  enforces the VCS guard but demotes write-path limits to prose.

Use `init` + `generate` when you want the definitions versioned in your repo and
editable per project; use the plugin when you want the pipeline as-is.

### Publishing your own

The tree at `.claude-plugin/` and `plugins/` is generated and committed, which is
what makes the install one step — `marketplace add` reads it straight from the
default branch. If you fork and change `.ai/`, regenerate and commit:

```bash
ai-sdlc plugin build     # writes to the repo root
claude plugin validate . --strict
```

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


Codex supports plugins and custom subagents, but custom agent definitions are
not currently a distributable component of a Codex plugin. `ai-sdlc` therefore
does not publish one: it would install the shared workflow without installing
the separate business-analyst and developer configurations. The plugin surface
could approximate the workflow with skills, but the installed result would not
reproduce the two-role topology that repo mode does.

`init` + `generate` emits native `.codex/agents/*.toml` instead, which keeps the
same role structure as the Claude setup.

The approval boundary does not depend on that topology. `ai-sdlc status`
enforces artifact state independently of how many agents are configured — see
*Where the gate actually holds*. Role separation is what the plugin cannot
carry; the gate is not.
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
ai-sdlc plugin build             # compile .ai/ -> plugin tree at repo root
ai-sdlc status <epic-id>         # gate check; exit 0 approved / 1 not / 2 unknown
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

## Where the gate actually holds

Separating the roles into two agents is workflow structure, not an authorization
boundary. Both providers spawn subagents under model control, and the main agent
generally retains filesystem and tool access regardless, so "two agents" buys
sequencing and a smaller context per role — not a guarantee that implementation
cannot start early. Read `.claude/agents/*` or `.codex/agents/*.toml` as a
description of intended division of labour.

What can hold is a deterministic check the model cannot talk its way past:

```
ai-sdlc status EPIC-123    # exit 0 only if APPROVED with a recorded approver
```

`Epic` refuses to parse `status: APPROVED` unless `approved_by` and
`approved_at` are both set, so a hand-edited artifact fails validation rather
than passing the gate. Prompt-level instructions are the fallback, not the
mechanism.

`ai-sdlc generate` emits `.github/workflows/approval-gate.yml`, which consumes
that exit code on every pull request. It reads an `AI-SDLC-Epic: EPIC-123` line
from the pull request body, resolves it, and fails unless that epic is APPROVED
with a recorded approver. State the property it establishes precisely:

> No pull request passes the approval gate unless it identifies an approved epic.

Not "the change implements that epic". The association is author-supplied, so
whoever opens the pull request can point it at any approved epic; verifying that
the diff actually delivers the acceptance criteria is review's job, and no exit
code substitutes for it. What the check removes is the *silent* path — merging
implementation while no human ever read a specification.

It fails closed. A missing marker is not an exemption, a malformed id is not
guessed at, and an id naming no epic fails rather than being skipped; the four
outcomes get distinct exit codes so a CI log says which one happened. The gate
is generated unconditionally, outside the provider branches, because it
constrains what enters the repository rather than what a role may do — dropping
a provider from `.ai/config.yaml` must not quietly drop the boundary.

The check existing is not the same as merge being blocked on it. That second
step is branch protection: repository-host configuration, not generated output.
Until it is set, the gate reports and does not prevent.

This is why capability asymmetry between providers matters less than it looks:
once the gate is a nonzero exit, it is identical everywhere, and each provider's
agent configuration is left to express division of labour rather than security.
Moving the remaining enforcement into the CLI is the direction of travel — and
the point at which a Codex skills-only plugin would become safe to ship, since
the property would no longer rest on agent separation.

## Capability asymmetry

The same capability block lowers to three different strengths. Codex's row is
weaker than it looks: `sandbox_mode` draws a filesystem and network boundary and
knows nothing about which *commands* run inside it, so `git commit` and
`git diff` are indistinguishable to it. `ai-sdlc generate` prints exactly what
survived per role, so the loss is visible at build time rather than inferred
from this table.

| Mode | Write paths | VCS mutation | Roles |
|---|---|---|---|
| Claude, repo | enforced per role | enforced per role | separate agents |
| Claude, plugin | advisory | enforced, but plugin-wide | separate agents |
| Codex, repo | broadened: `workspace-write` grants the whole workspace | advisory | separate agents |
| Codex, plugin | — | — | not offered: agents are not a distributable component |

In repo mode each agent carries its own `PreToolUse` hooks and the tool call
fails. Plugin mode cannot do this, for two reasons verified against a live
install rather than read from docs:

- Plugin-shipped agents may not declare `hooks` or `permissionMode`. The loader
  drops them **silently** — no runtime error, and `claude plugin validate
  --strict` passes. Shipping the repo-mode agents as-is would produce agents
  that look enforced and are not.
- The `PreToolUse` payload carries no agent identity, so a plugin-level hook
  cannot tell which role called it.

So `plugin build` moves what it can into a plugin-wide `hooks/hooks.json` — the
VCS guard, which every role in the default pipeline shares — and demotes the
rest to a `## Capability restrictions (advisory in plugin mode)` section in the
agent's own prompt, which says plainly that it is not backed by a hook. If you
add a role that *may* commit, the VCS guard is dropped entirely rather than
silently breaking that role, and the generated `hooks.json` `description` says
so.

Because Codex loses the most, `ai-sdlc generate` ends by reporting what each
role actually got:

```
  developer
    ✓ filesystem: write        sandbox_mode = "workspace-write"
    ✓ network: false           sandbox_workspace_write.network_access = false
    ~ write_paths.deny         .ai/epics/*.yaml, .ai/contract.md restated as instructions
    ~ vcs_mutate: false        git is an ordinary binary to the sandbox
```

Four levels: `✓ native` is enforced by the runtime, `~ advisory` survives only
as instructions a model may ignore, `! broadened` means the grant is wider than
asked for, and `✗ unsupported` means the request was not honoured at all. That
last one is not a warning to skim past — it says the generated config does not
do what the IR asked. It fires today only for a read-only role that requests
network access, since Codex's `network_access` key exists only under
`workspace-write`; buying egress by widening the sandbox would also grant
writes, so the generator refuses and says so.

The report is unconditional. Gating it behind a flag was tempting, but every
role in the default pipeline trips it — a permanently-on warning stops being a
signal.

None of the three modes is a security boundary. A restriction that must hold
under an adversarial or confused model needs branch protection, CI checks, or
human review — not agent configuration alone.

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
consuming repo. Plugin mode has been installed and its guard confirmed to fire,
but only against the default two-role pipeline.
