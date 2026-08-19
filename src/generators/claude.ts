import { stringify } from 'yaml';
import type { AgentSpec, ModelClass } from '../schema/agent.js';

/**
 * Lowers the agent IR onto `.claude/agents/<name>.md`.
 *
 * Claude enforces capability limits through PreToolUse hooks, so write-path and
 * VCS restrictions become hook commands pointing at the shipped guard scripts.
 * The hooks are the enforcement; the prose restated in the body is only there
 * so the model knows why a denial happened.
 */

const MODEL: Record<ModelClass, string> = {
  fast: 'haiku',
  balanced: 'sonnet',
  reasoning: 'opus',
};

/** Tools granted per filesystem level, before shell/network adjustments. */
function toolsFor(spec: AgentSpec): string[] {
  const tools = ['Read', 'Grep', 'Glob'];
  if (spec.capabilities.filesystem === 'write') tools.push('Write', 'Edit');
  if (spec.capabilities.shell) tools.push('Bash');
  if (spec.capabilities.network) tools.push('WebSearch', 'WebFetch');
  return tools;
}

function hooksFor(spec: AgentSpec): unknown | undefined {
  const pre: unknown[] = [];
  const { write_paths, vcs_mutate, filesystem, shell } = spec.capabilities;

  if (filesystem === 'write' && write_paths) {
    const mode = write_paths.allow ? 'restrict' : 'deny';
    const globs = write_paths.allow ?? write_paths.deny ?? [];
    pre.push({
      matcher: 'Write|Edit',
      hooks: [
        {
          type: 'command',
          command: `\${CLAUDE_PLUGIN_ROOT:-.}/scripts/hooks/${mode}-write-paths.sh ${globs
            .map((g) => `'${g}'`)
            .join(' ')}`,
        },
      ],
    });
  }

  // Only meaningful when the role can run commands at all.
  if (shell && !vcs_mutate) {
    pre.push({
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: '${CLAUDE_PLUGIN_ROOT:-.}/scripts/hooks/block-vcs-mutations.sh',
        },
      ],
    });
  }

  return pre.length ? { PreToolUse: pre } : undefined;
}

export function generateClaudeAgent(spec: AgentSpec): string {
  const frontmatter: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    tools: toolsFor(spec).join(', '),
    model: MODEL[spec.model.class],
  };

  // acceptEdits spares the human a prompt per file when the role is already
  // fenced in by write-path hooks.
  if (spec.capabilities.filesystem === 'write' && spec.capabilities.write_paths) {
    frontmatter.permissionMode = 'acceptEdits';
  }

  const hooks = hooksFor(spec);
  if (hooks) frontmatter.hooks = hooks;

  // lineWidth: 0 disables folding. Hook values are shell commands; a folded
  // command would depend on the reader rejoining lines exactly as written.
  const yaml = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${spec.instructions.trim()}\n`;
}
