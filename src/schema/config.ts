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

export const Config = z
  .object({
    providers: z
      .array(z.enum(['claude', 'codex']))
      .nonempty()
      .default(['claude', 'codex']),
    backlog: BacklogConfig,
  })
  .strict();
export type Config = z.infer<typeof Config>;
