import { join } from 'node:path';
import type { Config } from '../schema/config.js';
import type { Epic, EpicStatus } from '../schema/epic.js';
import { FilesystemBacklog } from './filesystem.js';
import { GitHubIssuesBacklog } from './github.js';

/**
 * Persistence boundary for epic artifacts.
 *
 * The orchestration skill talks only to this interface, so GitHub semantics
 * (labels, issue numbers, project fields) never leak into the workflow
 * definition. A provider is a *representation* of the epic state machine, not
 * the domain model — the model lives in schema/epic.ts.
 */
export interface BacklogProvider {
  readonly kind: string;

  /** Returns null when no epic with this id exists. */
  get(id: string): Promise<Epic | null>;

  list(filter?: { status?: EpicStatus }): Promise<Epic[]>;

  /** Creates or replaces the stored representation of `epic`. */
  save(epic: Epic): Promise<void>;

  /**
   * Transitions status, recording who approved when moving to APPROVED.
   *
   * Separate from `save` because approval is the one transition a human owns:
   * providers may enforce extra checks here (permissions, audit trail) that
   * must not be bypassable by writing the whole artifact.
   */
  setStatus(
    id: string,
    status: EpicStatus,
    actor?: { by: string; at: string },
  ): Promise<Epic>;
}

export class EpicNotFoundError extends Error {
  constructor(id: string, kind: string) {
    super(`epic ${id} not found in ${kind} backlog`);
    this.name = 'EpicNotFoundError';
  }
}

/**
 * The backlog itself could not be reached or read.
 *
 * Distinct from `EpicNotFoundError` because the two demand opposite responses:
 * a missing epic is a fact about the backlog, while this is an absence of
 * knowledge. Collapsing them lets an expired token or a missing API scope be
 * reported as "no such epic", which sends the reader looking for the wrong bug.
 * Live exercise against the GitHub API produced exactly that: a 403 surfaced as
 * a nonexistent epic.
 */
export class BacklogUnavailableError extends Error {
  constructor(
    readonly kind: string,
    detail: string,
  ) {
    super(`${kind} backlog unavailable: ${detail}`);
    this.name = 'BacklogUnavailableError';
  }
}

/**
 * An epic exists but its stored representation could not be understood.
 *
 * Also distinct from not-found, and for a sharper reason: the epic is *there*.
 * Reporting corruption as absence hides the artifact from the person able to
 * repair it. Raised for both malformed YAML and YAML that parses but violates
 * the schema — a hand-edit in the GitHub UI produces either one.
 */
export class EpicCorruptError extends Error {
  constructor(
    readonly id: string,
    kind: string,
    detail: string,
  ) {
    super(`epic ${id} in ${kind} backlog is unreadable: ${detail}`);
    this.name = 'EpicCorruptError';
  }
}

/**
 * Constructs the provider named by config.
 *
 * Lives here rather than in the CLI because it is not a CLI concern: the CI gate
 * needs it too, and importing it from `cli.ts` would run `main()` as a side
 * effect of asking for a backlog.
 */
export function makeBacklog(config: Config, root: string): BacklogProvider {
  return config.backlog.kind === 'github-issues'
    ? new GitHubIssuesBacklog(config.backlog.repo, { epicLabel: config.backlog.epic_label })
    : new FilesystemBacklog(join(root, config.backlog.dir));
}
