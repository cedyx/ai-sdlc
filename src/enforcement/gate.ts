/**
 * The CI entry point. Reads the PR body from the environment, resolves the epic
 * it names, and exits nonzero unless that epic is approved.
 *
 * A separate binary from `ai-sdlc status` on purpose: `status` answers "what is
 * the state of epic X" for a human who already knows X, while this answers "is
 * this change authorised" for a machine that must first work out which epic is
 * in play. Same predicate underneath -- `isImplementable`, which `gate.test.ts`
 * already pins -- so the CI verdict cannot drift from the CLI's.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Config } from '../schema/config.js';
import { isImplementable, type Epic } from '../schema/epic.js';
import {
  BacklogUnavailableError,
  EpicCorruptError,
  makeBacklog,
} from '../backlog/provider.js';
import { EPIC_MARKER, extractEpicId, markerFailure } from './ci.js';

/** Exit codes, distinct so a CI log tells you which step failed. */
export const EXIT = {
  pass: 0,
  notApproved: 1,
  notFound: 2,
  noMarker: 3,
  /**
   * The backlog could not be read: bad credentials, a missing API scope, an
   * unreachable host, no `gh` on PATH.
   *
   * Separate from `notFound` because the two are opposite claims. Not-found
   * asserts a fact about the backlog; this admits we learned nothing. Live
   * exercise against the GitHub API showed why it matters: a token without
   * `issues: read` produced "epic not found", pointing the reader at the epic
   * instead of at the workflow permissions.
   */
  unavailable: 4,
  /**
   * The epic exists but its artifact is unreadable — usually a hand-edit in the
   * GitHub UI that broke the fenced YAML. Distinct so the log says "repair this
   * epic" rather than "create it".
   */
  corrupt: 5,
} as const;

export async function runGate(root: string, body: string | undefined): Promise<number> {
  const marker = extractEpicId(body);
  if (!marker.ok) {
    console.error(markerFailure(marker.reason));
    return EXIT.noMarker;
  }

  let epic: Epic | null;
  try {
    const config = Config.parse(parse(await readFile(join(root, '.ai', 'config.yaml'), 'utf8')));
    epic = await makeBacklog(config, root).get(marker.id);
  } catch (err) {
    // Fail closed on every path, but never silently, and never as the wrong
    // reason. A gate that cannot read the backlog must not pass, and must not
    // claim the epic is missing.
    if (err instanceof EpicCorruptError) {
      console.error(
        `${err.message}\n\n` +
          'The epic exists but its ai-sdlc block could not be read. Repair the\n' +
          'fenced YAML in the issue body; do not delete it.',
      );
      return EXIT.corrupt;
    }
    if (err instanceof BacklogUnavailableError) {
      console.error(
        `${err.message}\n\n` +
          'The gate could not read the backlog, so it cannot confirm approval and\n' +
          'fails closed. This is not a statement about the epic. Check credentials\n' +
          'and, for the github-issues backend in Actions, that the workflow grants\n' +
          '`issues: read`.',
      );
      return EXIT.unavailable;
    }
    console.error(
      `${(err as Error).message}\n\n` +
        'The gate could not complete its check and fails closed.',
    );
    return EXIT.unavailable;
  }

  if (!epic) {
    console.error(
      `${EPIC_MARKER}: ${marker.id} names an epic that does not exist.\n\n` +
        'The marker is not a free-text field: it must resolve to a real epic artifact.',
    );
    return EXIT.notFound;
  }

  if (!isImplementable(epic)) {
    console.error(
      `${epic.id} is ${epic.status}, not APPROVED.\n\n` +
        `${epic.title}\n\n` +
        'A human must approve the epic before its implementation can merge:\n\n' +
        `    ai-sdlc approve ${epic.id}\n\n` +
        'Approval means reading the specification, not running the command.',
    );
    return EXIT.notApproved;
  }

  // Print the approver, not just a pass. The property this check establishes is
  // "a named human approved this epic at a known time"; showing it makes the
  // green check auditable instead of merely green.
  console.log(
    `${epic.id} APPROVED  ${epic.title}\n` +
      `approved by ${epic.approval.approved_by} at ${epic.approval.approved_at}\n\n` +
      'This proves the pull request identifies an approved epic. It does not prove\n' +
      'the change implements it -- that is what review is for.',
  );
  return EXIT.pass;
}

// Guarded so importing this module in tests does not run the gate.
if (process.argv[1]?.endsWith('gate.js')) {
  const code = await runGate(process.env.AI_SDLC_ROOT ?? process.cwd(), process.env.PR_BODY);
  process.exit(code);
}
