import type { Epic, EpicStatus } from '../schema/epic.js';

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
