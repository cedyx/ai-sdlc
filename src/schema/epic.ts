import { z } from 'zod';

/**
 * The epic artifact is the state machine.
 *
 * Approval is never a conversational step ("wait for the human") — neither
 * provider guarantees a model-driven delegation actually pauses. Instead the
 * orchestration skill reads `status` and refuses to advance unless it is
 * APPROVED. Backlog providers persist this shape; they do not define it.
 */

export const EpicStatus = z.enum([
  /** Written by the analyst role, not yet reviewed by a human. */
  'DRAFT',
  /** Human requested changes; analyst re-runs. */
  'CHANGES_REQUESTED',
  /** Human approved. The only status that unblocks implementation. */
  'APPROVED',
  /** Implementation finished and verified. */
  'DONE',
  /** Abandoned; retained for history. */
  'CANCELLED',
]);
export type EpicStatus = z.infer<typeof EpicStatus>;

/** Status values from which implementation may begin. */
export const IMPLEMENTABLE: readonly EpicStatus[] = ['APPROVED'];

export const AcceptanceCriterion = z
  .object({
    id: z.string().min(1),
    /** Given/When/Then or equivalent testable statement. */
    text: z.string().min(1),
  })
  .strict();

export const UserStory = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    acceptance_criteria: z.array(AcceptanceCriterion).default([]),
  })
  .strict();

export const OpenQuestion = z
  .object({
    text: z.string().min(1),
    /**
     * Set when the analyst chose to proceed on an assumption instead of
     * blocking. An empty open-questions list is a warning sign, not a quality
     * signal — most requests contain some ambiguity.
     */
    assumption: z.string().optional(),
  })
  .strict();

export const Approval = z
  .object({
    approved_by: z.string().nullable().default(null),
    approved_at: z.string().datetime().nullable().default(null),
  })
  .strict();

export const Analysis = z
  .object({
    author_role: z.string().min(1),
    completed_at: z.string().datetime(),
  })
  .strict();

export const Epic = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: EpicStatus,
    stories: z.array(UserStory).default([]),
    out_of_scope: z.array(z.string()).default([]),
    non_functional: z.array(z.string()).default([]),
    /**
     * Regulated-content markers (PII, payments, health data...) raised by the
     * analyst. Non-empty means a human security/legal review is advised before
     * implementation.
     */
    compliance_flags: z.array(z.string()).default([]),
    open_questions: z.array(OpenQuestion).default([]),
    analysis: Analysis.optional(),
    approval: Approval.default({}),
  })
  .strict()
  .refine(
    (e) => e.status !== 'APPROVED' || (e.approval.approved_by !== null && e.approval.approved_at !== null),
    { message: 'status APPROVED requires approval.approved_by and approval.approved_at' },
  );
export type Epic = z.infer<typeof Epic>;

/** Whether implementation may begin. The single gate consulted by epic-flow. */
export function isImplementable(epic: Epic): boolean {
  return IMPLEMENTABLE.includes(epic.status);
}
