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
`status: APPROVED` plus a recorded approver, and reading the artifact is the only
way to learn that. Any change that lets a role advance past the gate without
reading it is a bug, not a convenience.

`approval.mode` decides who writes that record, and it is the default that
changed: under `chat` the orchestrator runs `ai-sdlc approve` on the human's
behalf as soon as they assent, so there is one stop rather than a stop plus a
command; under `artifact` the human runs it themselves. Both write the same
field, so the gate and `ai-sdlc status` are untouched either way — the artifact
still decides, and conversational assent still authorises nothing on its own.

What `chat` costs is the evidentiary weight of `approved_by`, not its presence.
The agent attests to the name, so the field records whose repo this is rather
than who read the specification. That is a fair trade for a single maintainer and
a bad one wherever a second person relies on the field; say which is meant rather
than letting the field look equally authoritative in both. Never let the mode
reach `isImplementable`, the `Epic` refinement, or the gate: a mode that changed
what APPROVED *means* would make the exit code unreadable, which is the failure
this file spends the rest of its length avoiding.

Distinguish workflow separation from an enforcement boundary. Splitting the
roles into two agents sequences the work and keeps each context small; it does
not make the gate hard, because subagent orchestration is model-driven and the
main agent keeps its own tool access. Treat agent definitions as division of
labour, and put enforcement where a model cannot argue with it: `ai-sdlc status`
exits nonzero unless the artifact is APPROVED with a recorded approver, and
`Epic` refuses to parse APPROVED without one. New enforcement belongs in the
CLI, where it is identical across providers, rather than in per-provider agent
configuration.

The CI check in `src/enforcement/` closes the loop by consuming that exit code
wherever `approval.ci_gate` turns it on. It is off by default, because the check
fails every pull request that does not name an approved epic — a repo-wide policy
nobody should acquire as a side effect of running a scaffolder. `generate` emits
the workflow only when asked, and never deletes one already committed: removing a
required check because a config default changed would disable enforcement
silently. When it is on, its claim is narrower than it first reads:

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

## Capability findings are addressed, not read

`CapabilityFinding.capability` is a machine id mirroring the IR field path, and
the value the role asked for travels separately in `requested`. These were one
string once — `'filesystem: none'`, `` `network: ${network}` `` — which put three
spellings of `network` in what should be a single addressable key, so anything
keying on a finding had to parse the value back out of a human-facing label.

The union is therefore discriminated on `capability`: `requested` carries the
IR's own type, and `{ capability: 'network', requested: 'write' }` does not
compile. Presentation belongs to the CLI's `formatCapabilityFinding`, not to the
finding. Note that moving it there is invisible to `tsc` — `capability` is still
a string, merely the wrong one for display — so a change here is verified by
diffing `generate` output, not by a clean typecheck.

## Requirements are a set of fidelities, never a threshold

`requirements.codex` says which lowering fidelities are acceptable per
capability. Membership is the whole test: there is no ordering, and generation
fails when a finding's fidelity is not in its set.

Ordering was rejected because `advisory` and `broadened` are different failure
modes, not two strengths of one. `write_paths.allow` lowers to `broadened` — the
runtime enforces a boundary, but a wider one than asked. `write_paths.deny`
lowers to `advisory` — there is no boundary, only prose. Which is worse depends
on the threat model: a broadened sandbox still contains a confused model, while
prose contains nothing; an adversarial model may find the extra grant more
useful than the missing prohibition. Both appear in this repo's own agents on
the same axis, so a ladder would have had to rank them. Do not add one, and do
not let `native` satisfy a set that does not list it.

`default` is required per target so the policy is total: every (capability,
target) pair has an answer, and a new `CapabilityId` inherits the default rather
than becoming silently unconstrained. Permissiveness stays legal but must be
written out — there is no `any`, because one grep-able line is the point.

`codex` is the only nameable target because it is the only one that emits
findings; `claude-repo` and `claude-plugin` are schema errors. A target becomes
nameable when it reports fidelity, not when the architecture has a slot for it.
Naming one that reports nothing would validate nothing and pass, which is the
same green-check-proving-the-wrong-thing failure as inferring the epic from
changed files.

`--allow-lossy=<target>` skips enforcement for that target only. It never alters
the fidelity computation, and the report still prints — the flag waives the
policy, not the finding.

The checker lives in `src/generators/`, not `src/enforcement/`: it consumes a
Codex type and judges one provider's lowering, whereas enforcement is
provider-neutral and may not import from generators.

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

## Backlog reads must fail closed in three distinguishable ways

A backlog read has three outcomes that must never collapse into one, because
each sends the reader after a different bug:

- **not found** — a fact about the backlog. The epic does not exist.
- **unavailable** — an absence of knowledge. Bad credentials, a missing API
  scope, an unreachable host, no `gh` on PATH. Says nothing about the epic.
- **corrupt** — the epic is present but unreadable.

Reporting corruption as absence is the worst of the three: it hides the
artifact from the one person who could repair it. Reporting a 403 as absence
points the reader at the epic when the fix is in the workflow permissions.
`BacklogUnavailableError` and `EpicCorruptError` exist for exactly this, and
`ai-sdlc status` gives each its own exit code — six in total, no aliasing,
because a required check that cannot separate "not approved" from "could not
check" lets an outage read as a policy decision.

Corruption arrives in two shapes with opposite symptoms: `parse` *throws* on
YAML syntax errors, while `safeParse` *returns* a failure on YAML that parses
but violates the schema. Guarding only the second leaves the first an uncaught
crash. Both are reachable by hand-editing an issue in the GitHub UI, which is
the likeliest real corruption path.

## Do not filter the GitHub identity lookup by label

`findIssue` deliberately omits `--label`, though every epic carries one.
Passing it makes the lookup a *search* query, and GitHub's search index trails
the issue store: measured against the live API, an issue created by `save`
stayed invisible to a label-filtered list for ~7.7s while the unfiltered list
returned it immediately. Read-after-write — save an epic, then approve it — is
this provider's normal shape, so a lagging lookup meant `get` reporting a
just-created epic as nonexistent. The label stays for humans filtering in the
UI; correctness must not depend on it.

The status label is likewise a projection, never a source. The fenced artifact
wins on read, and `list` re-filters on it so a stale label causes neither a
wrong include nor a wrong exclude.

## Workflow token scopes follow the backlog kind

The generated workflow grants `issues: read` and passes `GH_TOKEN` only when
the backlog is `github-issues`. Verified in Actions rather than assumed: with
`contents: read` alone the Issues API returns 403 and the gate cannot resolve
the epic at all. Granting the scope unconditionally would hand API access to
the filesystem backend, which never uses it.

`gh` does honour `GITHUB_TOKEN` — an invalid value yields `HTTP 401`, so it is
not being ignored — but Actions does not place the token in the environment
unless the workflow passes it.

## Re-approval requires a fresh approver

`setStatus('APPROVED')` overwrites the approval block from its `actor` argument
instead of inheriting whatever was there. Downgrading to `CHANGES_REQUESTED`
leaves the old block in place, so inheriting would let a previously-approved
epic return to APPROVED carrying a stale approver — approval by history rather
than by decision. The schema refinement rejects APPROVED without both fields,
which makes the omission a hard failure rather than a silent one.
