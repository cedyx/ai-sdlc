import { describe, expect, it } from 'vitest';
import { AgentSpec } from '../schema/agent.js';
import { generateClaudeAgent } from '../generators/claude.js';
import { generateCodexAgent } from '../generators/codex.js';

const base = {
  name: 'analyst',
  description: 'Writes specs.',
  instructions: 'You are an analyst.',
};

describe('agent IR', () => {
  it('rejects write_paths with both allow and deny', () => {
    const result = AgentSpec.safeParse({
      ...base,
      capabilities: { filesystem: 'write', write_paths: { allow: ['a'], deny: ['b'] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects write_paths without write access', () => {
    const result = AgentSpec.safeParse({
      ...base,
      capabilities: { filesystem: 'read', write_paths: { allow: ['a'] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-kebab-case names', () => {
    expect(AgentSpec.safeParse({ ...base, name: 'Business Analyst' }).success).toBe(false);
  });
});

describe('claude generator', () => {
  it('grants only read tools to a read-only role', () => {
    const spec = AgentSpec.parse({ ...base, capabilities: { filesystem: 'read' } });
    const out = generateClaudeAgent(spec);
    expect(out).toMatch(/^tools: Read, Grep, Glob$/m);
  });

  it('emits a restrict hook for an allow-list', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: { filesystem: 'write', write_paths: { allow: ['.ai/epics/*.yaml'] } },
    });
    const out = generateClaudeAgent(spec);
    expect(out).toMatch(/restrict-write-paths\.sh '\.ai\/epics\/\*\.yaml'/);
  });

  it('emits a deny hook for a deny-list', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: { filesystem: 'write', write_paths: { deny: ['CHANGELOG.md'] } },
    });
    expect(generateClaudeAgent(spec)).toMatch(/deny-write-paths\.sh 'CHANGELOG\.md'/);
  });

  it('blocks VCS mutation only when the role has a shell', () => {
    const withShell = AgentSpec.parse({ ...base, capabilities: { shell: true, vcs_mutate: false } });
    expect(generateClaudeAgent(withShell)).toMatch(/block-vcs-mutations\.sh/);

    const noShell = AgentSpec.parse({ ...base, capabilities: { shell: false, vcs_mutate: false } });
    expect(generateClaudeAgent(noShell)).not.toMatch(/block-vcs-mutations\.sh/);
  });
});

describe('codex generator', () => {
  it('maps read-only capability to a read-only sandbox', () => {
    const spec = AgentSpec.parse({ ...base, capabilities: { filesystem: 'read' } });
    expect(generateCodexAgent(spec)).toMatch(/sandbox_mode = "read-only"/);
  });

  it('maps write without network to workspace-write', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: { filesystem: 'write', network: false },
    });
    expect(generateCodexAgent(spec)).toMatch(/sandbox_mode = "workspace-write"/);
  });

  it('restates path restrictions the sandbox cannot encode', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: { filesystem: 'write', write_paths: { allow: ['.ai/epics/*.yaml'] } },
    });
    const out = generateCodexAgent(spec);
    expect(out).toMatch(/Capability restrictions/);
    expect(out).toMatch(/only at these paths: \.ai\/epics\/\*\.yaml/);
  });

  it('restates the VCS ban for shell roles', () => {
    const spec = AgentSpec.parse({ ...base, capabilities: { shell: true, vcs_mutate: false } });
    expect(generateCodexAgent(spec)).toMatch(/must not run history-mutating VCS commands/);
  });

  it('escapes quotes in single-line fields', () => {
    const spec = AgentSpec.parse({ ...base, description: 'Handles "quoted" input.' });
    expect(generateCodexAgent(spec)).toMatch(/description = "Handles \\"quoted\\" input\."/);
  });
});
