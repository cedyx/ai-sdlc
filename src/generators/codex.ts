import type { AgentSpec, Effort } from '../schema/agent.js';

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

/** Reasoning tiers Codex accepts, mapped from the neutral effort scale. */
const EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/** How faithfully one IR capability survived lowering. */
export type Fidelity = 'native' | 'advisory' | 'broadened';

export interface CapabilityFinding {
  capability: string;
  fidelity: Fidelity;
  detail: string;
}

export interface CodexLowering {
  /** `sandbox_mode` value. */
  sandbox: string;
  /** Emitted as `[sandbox_workspace_write] network_access`, when relevant. */
  networkAccess: boolean | null;
  findings: CapabilityFinding[];
}

/**
 * Lowers the capability block onto Codex's sandbox surface.
 *
 * Filesystem reach and network egress are *orthogonal* in Codex:
 * `workspace-write` denies network by default and
 * `[sandbox_workspace_write] network_access = true` re-grants it. Collapsing
 * both onto `sandbox_mode` alone — and reaching for `danger-full-access`
 * whenever a role needed network — granted unrestricted filesystem and shell
 * to buy egress the narrower mode could already provide. Never widen one axis
 * to satisfy the other.
 */
export function lowerCapabilities(spec: AgentSpec): CodexLowering {
  const { filesystem, network, shell, write_paths, vcs_mutate } = spec.capabilities;
  const findings: CapabilityFinding[] = [];

  const sandbox = filesystem === 'write' ? 'workspace-write' : 'read-only';
  // Only meaningful under workspace-write; read-only already denies egress.
  const networkAccess = sandbox === 'workspace-write' ? network : null;

  findings.push({
    capability: `filesystem: ${filesystem}`,
    fidelity: 'native',
    detail: `sandbox_mode = "${sandbox}"`,
  });
  findings.push({
    capability: `network: ${network}`,
    fidelity: 'native',
    detail:
      networkAccess === null
        ? 'denied by read-only sandbox'
        : `sandbox_workspace_write.network_access = ${networkAccess}`,
  });

  // Codex reserves .git, .agents and .codex inside a writable root, but there
  // is no documented key to narrow writes to a path list — so an allow-list is
  // strictly wider once lowered, and saying so is the point of this report.
  if (filesystem === 'write' && write_paths?.allow) {
    findings.push({
      capability: 'write_paths.allow',
      fidelity: 'broadened',
      detail: `IR allows only ${write_paths.allow.join(', ')}; workspace-write permits the whole workspace. Restated as instructions.`,
    });
  }
  if (filesystem === 'write' && write_paths?.deny) {
    findings.push({
      capability: 'write_paths.deny',
      fidelity: 'advisory',
      detail: `${write_paths.deny.join(', ')} restated as instructions; the sandbox cannot exclude paths.`,
    });
  }
  // `read-only` genuinely denies execution, so the restriction is native there.
  // It degrades only in `workspace-write`, which grants writes and shell together.
  if (!shell) {
    const native = sandbox === 'read-only';
    findings.push({
      capability: 'shell: false',
      fidelity: native ? 'native' : 'advisory',
      detail: native
        ? 'denied by read-only sandbox'
        : 'no sandbox_mode denies command execution while allowing writes; restated as instructions.',
    });
  }
  if (shell && !vcs_mutate) {
    findings.push({
      capability: 'vcs_mutate: false',
      fidelity: 'advisory',
      detail: 'git is an ordinary binary to the sandbox; restated as instructions. Back with branch protection.',
    });
  }

  return { sandbox, networkAccess, findings };
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
  const lines = [`name = "${esc(spec.name)}"`, `description = "${esc(spec.description)}"`];

  // No model id unless the IR pins one: an emitted name would outlive the
  // catalogue entry it referred to. `class` still informs `effort` below.
  const pinned = spec.model.pin?.codex;
  if (pinned) lines.push(`model = "${esc(pinned)}"`);

  if (spec.model.effort) {
    lines.push(`model_reasoning_effort = "${EFFORT[spec.model.effort]}"`);
  }

  const lowering = lowerCapabilities(spec);
  lines.push(`sandbox_mode = "${lowering.sandbox}"`);
  lines.push('');
  lines.push(
    `developer_instructions = ${multiline(spec.instructions.trim() + restrictionNotes(spec))}`,
  );

  // Table syntax: every key after a table header belongs to it, so this must
  // come last.
  if (lowering.networkAccess !== null) {
    lines.push('');
    lines.push('[sandbox_workspace_write]');
    lines.push(`network_access = ${lowering.networkAccess}`);
  }

  return lines.join('\n') + '\n';
}
