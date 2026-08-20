import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'block-vcs-mutations.sh');

/** Runs the hook the way Claude does: payload on stdin, decision as exit code. */
function run(payload: unknown): { code: number; stderr: string } {
  try {
    execFileSync(SCRIPT, { input: JSON.stringify(payload), encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, stderr: err.stderr };
  }
}

const SUBAGENT = 'a4d2c8f1e0b3a297';

describe('block-vcs-mutations hook', () => {
  it('denies a mutating verb from a subagent', () => {
    for (const verb of ['commit -m x', 'push', 'tag v1', 'rebase main']) {
      const r = run({ agent_id: SUBAGENT, tool_input: { command: `git ${verb}` } });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/belong to the orchestrator/);
    }
  });

  // The reason the guard is safe to ship plugin-wide. A plugin hook fires for
  // the orchestrating session too, and that session is what commits each epic
  // once the implementer leaves the work in the tree. Blocking it stops the
  // pipeline at its last step.
  it('allows a mutating verb from the orchestrating session, which has no agent_id', () => {
    expect(run({ tool_input: { command: 'git commit -m x' } }).code).toBe(0);
    expect(run({ agent_id: null, tool_input: { command: 'git push' } }).code).toBe(0);
  });

  it('allows read-only inspection from a subagent', () => {
    for (const verb of ['status', 'log -1', 'diff --stat']) {
      expect(run({ agent_id: SUBAGENT, tool_input: { command: `git ${verb}` } }).code).toBe(0);
    }
  });

  it('still catches a mutation behind global flags or a shell chain', () => {
    for (const command of ['git -C sub commit -m x', 'ls && git push origin main']) {
      expect(run({ agent_id: SUBAGENT, tool_input: { command } }).code).toBe(2);
    }
  });

  it('ignores a payload carrying no command', () => {
    expect(run({ agent_id: SUBAGENT, tool_input: {} }).code).toBe(0);
  });
});
