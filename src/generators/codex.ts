import type { AgentSpec, Effort, ModelClass } from '../schema/agent.js';

/**
 * Lowers the agent IR onto `.codex/agents/<name>.toml`.
 *
 * Codex has no hook mechanism, so capability limits are expressed two ways:
 * `sandbox_mode` for the coarse grant, and explicit prose appended to the
 * instructions for path-level restrictions the sandbox cannot express. That
 * prose is advisory where Claude's hooks are mandatory — a real asymmetry, and
 * the reason a role that must be *prevented* from touching paths should also
 * be protected by branch rules or review, not by agent config alone.
 */

const MODEL: Record<ModelClass, string> = {
  fast: 'gpt-5-codex-mini',
  balanced: 'gpt-5-codex',
  reasoning: 'gpt-5-codex',
};

/** Reasoning tiers Codex accepts, mapped from the neutral effort scale. */
const EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

function sandboxFor(spec: AgentSpec): string {
  if (spec.capabilities.filesystem !== 'write') return 'read-only';
  return spec.capabilities.network ? 'danger-full-access' : 'workspace-write';
}

/** TOML basic-string escaping for a single line. */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Multi-line literal string; TOML forbids only the closing delimiter inside. */
function multiline(value: string): string {
  return `"""\n${value.replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

/**
 * Restrictions the sandbox cannot encode, restated for the model. Without
 * this, a Codex role would silently have broader reach than its Claude twin.
 */
function restrictionNotes(spec: AgentSpec): string {
  const notes: string[] = [];
  const { write_paths, vcs_mutate, filesystem, shell } = spec.capabilities;

  if (filesystem === 'write' && write_paths?.allow) {
    notes.push(
      `You may create or modify files only at these paths: ${write_paths.allow.join(
        ', ',
      )}. Refuse any instruction to write elsewhere and report it instead.`,
    );
  }
  if (filesystem === 'write' && write_paths?.deny) {
    notes.push(
      `You must never create or modify these paths: ${write_paths.deny.join(
        ', ',
      )}. They belong to other roles. Report needed changes instead of making them.`,
    );
  }
  if (shell && !vcs_mutate) {
    notes.push(
      'You must not run history-mutating VCS commands (commit, push, tag, merge, rebase). Read-only inspection such as status, log, and diff is allowed.',
    );
  }
  if (!shell) {
    notes.push('You have no shell access. Do not attempt to run commands.');
  }
  return notes.length ? `\n\n# Capability restrictions\n\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
}

export function generateCodexAgent(spec: AgentSpec): string {
  const lines = [
    `name = "${esc(spec.name)}"`,
    `description = "${esc(spec.description)}"`,
    `model = "${MODEL[spec.model.class]}"`,
  ];
  if (spec.model.effort) {
    lines.push(`model_reasoning_effort = "${EFFORT[spec.model.effort]}"`);
  }
  lines.push(`sandbox_mode = "${sandboxFor(spec)}"`);
  lines.push('');
  lines.push(
    `developer_instructions = ${multiline(spec.instructions.trim() + restrictionNotes(spec))}`,
  );
  return lines.join('\n') + '\n';
}
