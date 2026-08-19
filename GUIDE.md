# User guide

For people who want to use this, not modify it. No coding required.

## What it does

You describe a feature. Then:

1. **A business analyst** writes down exactly what should be built —
   user stories, what counts as done, what is deliberately out of scope.
2. **You read it and approve it.** Nothing gets built until you do.
3. **A developer** writes the code and the tests.

The point is step 2. You get to see and correct the plan while changing it is
still cheap.

## Add it (one time)

You need [Claude Code](https://claude.com/claude-code). Open it in your project
and type:

```
/plugin marketplace add cedyx/ai-sdlc
/plugin install ai-sdlc
```

If a new session doesn't pick it up, restart Claude Code.

To check it worked, type `/plugin` and look for `ai-sdlc` in the list.

> **Using Codex instead of Claude Code?** It works there too, but it is set up
> per project rather than installed once — see *Set up for Codex* at the end.
> Everything in *Use it* below is the same, approval included.

## Use it

Say what you want built, and give it a short name to refer to later:

```
/epic-flow checkout-discount-codes
```

Or just describe the feature in plain language and ask for the pipeline:

> Build discount code support in checkout. Use the epic flow, call it
> checkout-discount-codes.

The name is anything you like — lowercase, dashes instead of spaces.

### What happens next

**It asks you questions.** The analyst can't talk to you directly, so anything
unclear comes back through the main chat. Answer in your own words.

**It writes a spec and stops.** A file appears at
`.ai/epics/<your-name>.yaml`. It will tell you it is waiting for approval.

**You read the spec.** Ask for it in plain language:

> Show me the spec for checkout-discount-codes in plain English.

Look for two things: anything wrong, and anything missing. Say so and it will
revise. This is the cheap moment to change your mind.

**You approve it.** When you're happy:

> Approve checkout-discount-codes.

**Then it builds.** Code and tests. It won't commit anything on its own.

## The one rule

**It asks before it builds, and "looks good" in chat is not the answer.**
Approval gets recorded in the file, with your name and the time. That is
deliberate: it means nobody can be vague later about whether you signed off.

Two things are worth keeping apart, because they fail differently:

- **Waiting for you is a habit of the workflow.** It stops there because it is
  told to. A confused or badly-prompted assistant can skip ahead and start
  writing code without asking you first.
- **Recorded approval is checked by the tool.** That part is not a habit. The
  epic cannot be marked approved without a named approver, so work done without
  asking you stays visibly unapproved rather than passing as signed off.

So if you find code written before you were asked, the right reaction is not
"the approval was bypassed" — it wasn't, because nothing recorded your name.
It's that the assistant got ahead of itself, and the work still needs your
review before it goes anywhere. Review is what catches that, not this tool.

If it seems stuck waiting, it's probably waiting for you.

## When something looks wrong

| What you see | What to do |
|---|---|
| It starts coding before you approved | Stop it and say so — that's a bug, please report it |
| It asks a question you can't answer | Say "assume X for now and flag it" — assumptions get written down |
| The spec is too big | Ask it to split into smaller epics, one feature each |
| Nothing happens after `/epic-flow` | Restart Claude Code, then check `/plugin` lists it |
| `/plugin install` can't find it | Check the marketplace line ran without an error first |

## What it will not do for you

- **Commit or push.** It leaves the changes in place for you to review.
- **Decide whether the feature is worth building.** That's your call.
- **Replace review.** A human still reads the code before it ships.

## Set up for Codex

Codex can install plugins, but we don't publish one for it. A Codex plugin
can't ship the two separate roles, so installing it would give you the workflow
without the analyst and the developer as distinct participants. Setting it up
per project keeps them separate.

The approval step is unaffected either way — that check lives in the tool, not
in how the roles are arranged.

In a terminal, in your project folder:

```bash
npx github:cedyx/ai-sdlc init
npx github:cedyx/ai-sdlc generate
```

Then commit the files it created. After that, use it exactly as described
above. If those two commands mean nothing to you, this is the one part worth
asking a developer for — it is a five-minute job and only happens once.

## Getting it out of the way

```
/plugin uninstall ai-sdlc
```

Your project files are untouched. Anything under `.ai/` stays, so you can pick
the work back up later.
