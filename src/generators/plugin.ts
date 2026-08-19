import { stringify, parse as parseYaml } from 'yaml';
import type { AgentSpec } from '../schema/agent.js';
import { generateClaudeAgent } from './claude.js';

/**
 * Lowers the agent IR onto a Claude Code *plugin* tree, so a consuming repo can
 * use the pipeline without running `generate` or committing provider files.
 *
 * This is not the same lowering as `.claude/agents/`. Two verified constraints
 * force it apart (see `docs/plugin-constraints.md` for the probe transcript):
 *
 *   1. Plugin-shipped agents may not declare `hooks`, `mcpServers`, or
 *      `permissionMode`. The loader drops them *silently* — no error from the
 *      runtime and none from `claude plugin validate --strict`. Emitting the
 *      repo-mode agent verbatim would therefore ship an agent that looks
 *      enforced and is not.
 *   2. The PreToolUse payload carries no agent identity (`agent_name` /
 *      `subagent_type` are absent), so a plugin-level hook cannot re-scope
 *      itself to one role by inspecting the event.
 *
 * Consequence: per-role write-path limits cannot be enforced by a plugin hook.
 * What survives is the union of restrictions that hold for *every* role in the
 * pipeline — enforced plugin-wide — plus per-role prose. Anything narrower is
 * advisory here and must be backed by CI or branch protection.
 */

/** Frontmatter keys the plugin loader discards without warning. */
const UNSUPPORTED_IN_PLUGIN = ['hooks', 'permissionMode', 'mcpServers'] as const;

export interface PluginFile {
  path: string;
  content: string;
  /** Marks guard scripts, which must stay executable through packaging. */
  executable?: boolean;
}

export interface PluginMeta {
  name: string;
  version: string;
  description: string;
  author: string;
}

/**
 * Strips the frontmatter keys a plugin cannot honour and appends the dropped
 * restrictions to the body as prose.
 *
 * Reusing `generateClaudeAgent` keeps one lowering of tools/model/description:
 * the plugin variant is that output minus what the loader would discard, so the
 * two cannot drift in the parts they share.
 */
export function generatePluginAgent(spec: AgentSpec): string {
  const source = generateClaudeAgent(spec);
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(source);
  if (!match?.[1] || !match[2]) {
    throw new Error(`could not parse generated agent for ${spec.name}`);
  }
  const [, rawFrontmatter, body] = match;

  // Rebuild rather than regex the YAML: dropping a key by pattern would also
  // match a `hooks:` line inside a description or instruction block.
  // Round-trip through the same library that wrote it, so the parse is exact.
  const parsed = (parseYaml(rawFrontmatter) ?? {}) as Record<string, unknown>;
  const dropped: string[] = [];
  for (const key of UNSUPPORTED_IN_PLUGIN) {
    if (key in parsed) {
      delete parsed[key];
      dropped.push(key);
    }
  }

  const yaml = stringify(parsed, { lineWidth: 0 }).trimEnd();
  const notice = dropped.includes('hooks') ? pluginEnforcementNotice(spec) : '';
  return `---\n${yaml}\n---\n\n${body.trim()}\n${notice}`;
}

/**
 * States, in the agent's own prompt, that its limits are not machine-enforced
 * here. The repo-mode agent gets a hook; this one gets a sentence, and saying
 * so is the difference between an advisory limit and a silent one.
 */
function pluginEnforcementNotice(spec: AgentSpec): string {
  const lines = ['\n## Capability restrictions (advisory in plugin mode)\n'];
  const { write_paths, vcs_mutate, filesystem, shell } = spec.capabilities;

  if (filesystem === 'write' && write_paths?.allow) {
    lines.push(`- Write only to: ${write_paths.allow.join(', ')}. Treat every other path as read-only.`);
  }
  if (filesystem === 'write' && write_paths?.deny) {
    lines.push(`- Never write to: ${write_paths.deny.join(', ')}. These belong to other roles.`);
  }
  if (shell && !vcs_mutate) {
    lines.push(
      '- Do not run history-mutating VCS commands (commit, push, tag, merge, rebase, reset). Leave changes in the working tree.',
    );
  }
  lines.push(
    '\nIn repo mode these are PreToolUse hooks and the tool call fails. Installed as a plugin they are instructions only: the loader does not accept per-agent hooks. Do not rely on being stopped.',
  );
  return lines.join('\n') + '\n';
}


/**
 * The plugin-wide guard. Scoped to what is true for every role, because the
 * hook cannot tell which role is calling it.
 *
 * Emitting a *narrower* rule here would be worse than emitting none: it would
 * block the orchestrator from committing, which is its job.
 */
export function generatePluginHooks(specs: AgentSpec[]): string {
  const shellRoles = specs.filter((s) => s.capabilities.shell);
  const hooks: Record<string, unknown[]> = {};

  // Only when *no* shell-capable role may mutate VCS is a blanket block correct.
  const allDenyVcs = shellRoles.length > 0 && shellRoles.every((s) => !s.capabilities.vcs_mutate);

  // A role that *may* commit collapses the guard for every role, because the
  // hook cannot tell them apart. Silence here would read as "nothing to
  // enforce"; say it instead, so the gap is a decision and not a surprise.
  const degraded = shellRoles.filter((s) => s.capabilities.vcs_mutate).map((s) => s.name);

  if (allDenyVcs) {
    hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: '"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/block-vcs-mutations.sh"',
          },
        ],
      },
    ];
  }

  const note = degraded.length
    ? ` No VCS guard is emitted: ${degraded.join(', ')} may mutate VCS, and a plugin hook cannot ` +
      'exempt one role, so blocking would break them. Enforce this in CI or branch protection.'
    : '';

  const doc = {
    description:
      'ai-sdlc capability guards. Plugin-level because the loader discards per-agent hooks; ' +
      'scoped to restrictions common to every role because the PreToolUse payload has no agent identity.' +
      note,
    hooks,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

export function generatePluginManifest(meta: PluginMeta): string {
  return (
    JSON.stringify(
      {
        name: meta.name,
        version: meta.version,
        description: meta.description,
        author: { name: meta.author },
      },
      null,
      2,
    ) + '\n'
  );
}

export function generateMarketplaceManifest(meta: PluginMeta): string {
  return (
    JSON.stringify(
      {
        name: `${meta.name}-marketplace`,
        owner: { name: meta.author },
        description: `Marketplace for ${meta.name}`,
        plugins: [
          {
            name: meta.name,
            source: `./plugins/${meta.name}`,
            description: meta.description,
            version: meta.version,
          },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}
