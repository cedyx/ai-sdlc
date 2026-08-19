import { z } from 'zod';

/**
 * Neutral agent IR.
 *
 * Providers express the same intent through different mechanisms, so the IR
 * describes *what* a role may do, never *how* a provider enforces it:
 *
 *   write-path limits  -> Claude: PreToolUse hook | Codex: instructions only
 *   vcs mutation ban   -> Claude: PreToolUse hook | Codex: instructions only
 *   model selection    -> Claude: model alias     | Codex: model + reasoning effort
 *
 * Read the right column as "what the provider does with it", not as an
 * equivalence. Codex's `sandbox_mode` draws a filesystem and network boundary
 * and knows nothing about which commands run inside it, so neither a write-path
 * allow-list nor a `git commit` ban lowers onto it -- both survive as prose.
 * `lowerCapabilities` in the Codex generator is the authority on what actually
 * became of a field: it reports each as native, advisory, broadened, or
 * unsupported, and `generate` prints the result. A field existing here does not
 * imply anything enforces it.
 *
 * Adding a field here means teaching every generator to lower it. Prefer
 * expressing a new restriction with the existing vocabulary where possible.
 */

/** Coarse model tier. Generators map this onto each provider's own naming. */
export const ModelClass = z.enum(['fast', 'balanced', 'reasoning']);
export type ModelClass = z.infer<typeof ModelClass>;

export const Effort = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof Effort>;

/**
 * `class` and `effort` are preferences: each generator maps them onto whatever
 * its provider currently offers. `pin` overrides that with an exact model id
 * per provider.
 *
 * The default is deliberately to emit no model id at all. A compiled-in name
 * freezes consumers onto whatever was current when this was written — and model
 * catalogues deprecate faster than this tool releases. Inheriting the user's
 * configured model is both more correct and less maintenance; pin only when a
 * role genuinely depends on one model's behaviour.
 */
export const ModelPreference = z
  .object({
    class: ModelClass.default('balanced'),
    effort: Effort.optional(),
    pin: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ModelPreference = z.infer<typeof ModelPreference>;

/** Filesystem reach. `read` still allows every read-only tool. */
export const FilesystemAccess = z.enum(['none', 'read', 'write']);

/**
 * Glob-scoped write permissions. `allow` is a whitelist (everything else is
 * denied); `deny` subtracts from an otherwise-open write permission. They are
 * mutually exclusive — mixing them makes precedence ambiguous across providers.
 */
export const WritePaths = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .refine((v) => !(v.allow && v.deny), {
    message: 'write_paths: use either allow or deny, not both',
  });
export type WritePaths = z.infer<typeof WritePaths>;

export const Capabilities = z
  .object({
    filesystem: FilesystemAccess.default('read'),
    /** Only meaningful when filesystem is `write`. */
    write_paths: WritePaths.optional(),
    shell: z.boolean().default(false),
    network: z.boolean().default(false),
    /**
     * Whether the role may run history-mutating VCS commands (commit, push,
     * tag, merge). Read-only inspection stays available regardless.
     */
    vcs_mutate: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.filesystem === 'write' || !v.write_paths, {
    message: 'write_paths requires filesystem: write',
  });
export type Capabilities = z.infer<typeof Capabilities>;

export const AgentSpec = z
  .object({
    /** Stable role id. Referenced by skills and by generated provider files. */
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, 'name must be kebab-case'),
    /** Drives automatic selection on both providers — front-load trigger words. */
    description: z.string().min(1),
    /** The role prompt. Becomes the Claude body / Codex developer_instructions. */
    instructions: z.string().min(1),
    capabilities: Capabilities.default({}),
    model: ModelPreference.default({}),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpec>;
