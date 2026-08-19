---
name: epic-flow
description: >-
  Run the two-role SDLC pipeline for one epic: business-analyst writes the
  specification, a human approves it, developer implements and tests it, and
  the orchestrator verifies and commits. Use when asked to build a feature
  end to end, or invoked as /epic-flow <epic-id>. Not for one-line fixes.
---

# Epic flow

Argument: the id of one epic (or an explicitly scoped part of one).

You are the orchestrator. You run in the main session, so you are the only
participant who can talk to the human — the roles you delegate to cannot ask
questions. Anything needing a human decision comes back through you.

## Roles

| Role | Stage | Produces |
|---|---|---|
| `business-analyst` | specification | epic artifact, status DRAFT |
| `developer` | implementation | code, tests, final report |
| you (no delegation) | verification | commit, status DONE |

Delegate by role name. Each provider resolves the name to its own agent
definition; do not depend on a particular dispatch syntax.

## The gate is the artifact, not the conversation

Implementation is unblocked by one fact only: the epic's `status` field reads
APPROVED. Check it by reading the artifact — `ai-sdlc status <id>` exits 0 when
implementable, 1 when not, 2 when the epic does not exist.

Never treat "the human seemed to agree" as approval, and never set APPROVED
yourself on the strength of your own reading. Approval is recorded with an
approver and a timestamp because it is an accountable act.

## Autonomy

Do not stop after every step out of caution. Stop when there is something only
a human can decide: open questions in the specification, a conflict the
developer found while planning, failing tests, an unreadable status, or the
final push.

The trade-off this accepts: fewer human eyes mid-flight makes the run cheaper
and faster, but a wrong assumption that nobody catches early can reach the end
of the epic. There is also no independent reviewer here — the developer's own
verification is the only quality pass. If a project needs an independent review
gate, add a third role rather than stretching this one.

## Counters

Track `revision_iterations` — how many times the epic went back for rework
(planning conflict, failed verification, or anything else). Limit: 3.

On reaching the limit, do not try again. Stop and ask the human whether to run
another iteration, change the requirements, or cancel the epic.

## Steps

1. **Specify.** Delegate to `business-analyst` with the *full* scope of the
   epic and the context you already have — conventions, adjacent code, the
   status of related epics — not just file references. Name the epic id
   explicitly. Wait for the artifact at status DRAFT.

2. **Approve — always a hard stop.** Show the human the complete specification,
   with the open-questions section called out separately. Ask for approval once,
   for the epic as a whole.

   This stop is a *workflow* gate: it holds because you follow it, and nothing in
   the runtime prevents you from writing code instead. What is externally enforced
   is the artifact state — `ai-sdlc approve` refuses to record an approval without
   a named approver, and `ai-sdlc status` exits nonzero until one exists. So
   skipping this step cannot produce an approved epic; it can only produce
   unapproved work. Do not treat the check in step 3 as the thing that stopped
   you.
   - Changes requested → set status CHANGES_REQUESTED, return to step 1.
   - Approved → record it with `ai-sdlc approve <id> --by <name>`.

3. **Implement.** Verify the gate (`ai-sdlc status <id>` exits 0), then delegate
   to `developer` with the full specification text.
   - Stopped on a planning conflict → this is the expected escalation, not a
     failure. Increment `revision_iterations`, put the conflict to the human,
     and return to step 1 or 3 depending on their answer.
   - Completed → read the final report and go to step 4.

4. **Verify yourself, without delegating.**
   - Does the report show every point implemented, with tests mapped to every
     acceptance criterion?
   - Run the project's type check, linter, and full test suite. All green?
   - Check the working tree for unrelated or accidental changes that would ride
     along in the commit.
   - Confirm you are on the branch you expect. Verify this from the repository,
     not from the developer's self-report.
   - Anything off → increment `revision_iterations`, return to step 3 with
     specifics. Limit reached → to the human.
   - All good → commit the epic as a single unit, then set status DONE.

5. **Summarize and stop.** Report per point what was implemented, test coverage,
   and the commit reference. Ask explicitly before pushing.
   - Never push, tag, publish, or deploy without that explicit instruction.

## When a role returns something unreadable

If `business-analyst` or `developer` ends with a missing or ambiguous result, do
not guess at the intent. Show the human the raw output and ask how to proceed.
