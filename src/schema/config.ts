import { z } from 'zod';

/** Which provider adapters to emit, and where the backlog lives. */
export const BacklogConfig = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('github-issues'),
      /** owner/name. */
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      /** Label marking an issue as an ai-sdlc epic. */
      epic_label: z.string().default('epic'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('filesystem'),
      /** Directory of `<id>.yaml` artifacts, relative to the repo root. */
      dir: z.string().default('.ai/epics'),
    })
    .strict(),
]);
export type BacklogConfig = z.infer<typeof BacklogConfig>;

/**
 * Acceptable lowering fidelities per capability, per target.
 *
 * A set, never a threshold: `advisory` and `broadened` are distinct failure
 * modes — a prohibition a model may ignore, versus a runtime grant wider than
 * requested — and which is worse depends on the threat model. Ordering them
 * would let one silently substitute for the other, so membership is the only
 * test. `write_paths.allow` lowering to `broadened` and `write_paths.deny`
 * lowering to `advisory` are the allow/deny duals of one axis, not two rungs.
 *
 * `codex` is the only target here because it is the only one that emits
 * findings. A target becomes nameable when it reports fidelity, not when the
 * architecture has a slot for it.
 */
const AcceptedFidelities = z
  .array(z.enum(['native', 'advisory', 'broadened', 'unsupported']))
  .nonempty();

/**
 * `default` is required so the policy is total: every (capability, target) pair
 * has an answer, and a newly added `CapabilityId` inherits the default instead
 * of becoming silently unconstrained. Permissiveness stays legal but must be
 * written out — there is no `any`, because one grep-able line is the point.
 */
export const TargetRequirements = z
  .object({
    default: AcceptedFidelities,
    filesystem: AcceptedFidelities.optional(),
    network: AcceptedFidelities.optional(),
    'write_paths.allow': AcceptedFidelities.optional(),
    'write_paths.deny': AcceptedFidelities.optional(),
    shell: AcceptedFidelities.optional(),
    vcs_mutate: AcceptedFidelities.optional(),
  })
  .strict();
export type TargetRequirements = z.infer<typeof TargetRequirements>;

export const Requirements = z.object({ codex: TargetRequirements }).strict().partial();
export type Requirements = z.infer<typeof Requirements>;

export const Config = z
  .object({
    providers: z
      .array(z.enum(['claude', 'codex']))
      .nonempty()
      .default(['claude', 'codex']),
    backlog: BacklogConfig,
    requirements: Requirements.optional(),
  })
  .strict();
export type Config = z.infer<typeof Config>;
