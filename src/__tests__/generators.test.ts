import { describe, expect, it } from 'vitest';
import { AgentSpec } from '../schema/agent.js';
import { generateClaudeAgent } from '../generators/claude.js';
import { generateCodexAgent, lowerCapabilities } from '../generators/codex.js';

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

  // The regression that motivated splitting the axes. Network egress and
  // filesystem reach are separate keys in Codex; resolving a request for
  // network by escalating the sandbox granted unrestricted writes and shell to
  // a role whose IR asks for neither.
  it('buys network inside workspace-write, never by escalating the sandbox', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: {
        filesystem: 'write',
        network: true,
        shell: false,
        write_paths: { allow: ['.ai/epics/*.yaml'] },
      },
    });
    const out = generateCodexAgent(spec);
    expect(out).toMatch(/sandbox_mode = "workspace-write"/);
    expect(out).not.toMatch(/danger-full-access/);
    expect(out).toMatch(/\[sandbox_workspace_write\]\nnetwork_access = true/);
  });

  it('states network denial rather than leaving it implicit', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: { filesystem: 'write', network: false },
    });
    expect(generateCodexAgent(spec)).toMatch(/\[sandbox_workspace_write\]\nnetwork_access = false/);
  });

  it('omits network config entirely for read-only roles', () => {
    const spec = AgentSpec.parse({ ...base, capabilities: { filesystem: 'read', network: true } });
    expect(generateCodexAgent(spec)).not.toMatch(/sandbox_workspace_write/);
  });

  // A compiled-in model id ages out of the provider catalogue faster than this
  // tool releases; inheriting the caller's configured model is the safe default.
  it('emits no model id unless a role pins one', () => {
    const spec = AgentSpec.parse({ ...base, capabilities: { filesystem: 'read' } });
    expect(generateCodexAgent(spec)).not.toMatch(/^model = /m);
  });

  it('emits a pinned model id for codex only', () => {
    const pinned = AgentSpec.parse({
      ...base,
      model: { class: 'balanced', pin: { codex: 'gpt-5.3-codex' } },
      capabilities: { filesystem: 'read' },
    });
    expect(generateCodexAgent(pinned)).toMatch(/^model = "gpt-5\.3-codex"$/m);

    const otherProvider = AgentSpec.parse({
      ...base,
      model: { class: 'balanced', pin: { claude: 'some-claude-model' } },
      capabilities: { filesystem: 'read' },
    });
    expect(generateCodexAgent(otherProvider)).not.toMatch(/^model = /m);
  });

  it('keeps the workspace-write table last so later keys do not fall into it', () => {
    const spec = AgentSpec.parse({
      ...base,
      capabilities: { filesystem: 'write', network: true, shell: true, vcs_mutate: false },
    });
    const out = generateCodexAgent(spec);
    const table = out.indexOf('[sandbox_workspace_write]');
    expect(table).toBeGreaterThan(-1);
    // Nothing may follow the table except its own keys.
    const after = out.slice(table).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(after.every((l) => /^network_access = /.test(l))).toBe(true);
  });
});

// The report exists so a lossy lowering cannot be adopted unknowingly. These
// assert the classification, not the wording: `advisory` and `broadened` are
// the signal that a restriction needs branch protection behind it.
describe('codex capability fidelity', () => {
  const find = (spec: unknown, capability: string) =>
    lowerCapabilities(AgentSpec.parse(spec)).findings.find((f) => f.capability === capability);

  it('reports a write-path allow-list as broadened, not enforced', () => {
    const f = find(
      { ...base, capabilities: { filesystem: 'write', write_paths: { allow: ['.ai/epics/*.yaml'] } } },
      'write_paths.allow',
    );
    expect(f?.fidelity).toBe('broadened');
  });

  it('reports a write-path deny-list as advisory', () => {
    const f = find(
      { ...base, capabilities: { filesystem: 'write', write_paths: { deny: ['CHANGELOG.md'] } } },
      'write_paths.deny',
    );
    expect(f?.fidelity).toBe('advisory');
  });

  it('reports shell denial as advisory when writes are allowed', () => {
    const f = find({ ...base, capabilities: { filesystem: 'write', shell: false } }, 'shell: false');
    expect(f?.fidelity).toBe('advisory');
  });

  // workspace-write grants writes and execution together; read-only denies both.
  // The same IR restriction is therefore enforced in one sandbox and not the other.
  it('reports shell denial as native under a read-only sandbox', () => {
    const f = find({ ...base, capabilities: { filesystem: 'read', shell: false } }, 'shell: false');
    expect(f?.fidelity).toBe('native');
  });

  it('reports a VCS restriction as advisory', () => {
    const f = find(
      { ...base, capabilities: { filesystem: 'write', shell: true, vcs_mutate: false } },
      'vcs_mutate: false',
    );
    expect(f?.fidelity).toBe('advisory');
  });

  it('reports both sandbox axes as native', () => {
    const { findings } = lowerCapabilities(
      AgentSpec.parse({ ...base, capabilities: { filesystem: 'write', network: true } }),
    );
    const axes = findings.filter((f) => /^(filesystem|network):/.test(f.capability));
    expect(axes).toHaveLength(2);
    expect(axes.every((f) => f.fidelity === 'native')).toBe(true);
  });

  it('leaves a read-only role with nothing weaker than native', () => {
    const { findings } = lowerCapabilities(AgentSpec.parse({ ...base, capabilities: { filesystem: 'read' } }));
    expect(findings.every((f) => f.fidelity === 'native')).toBe(true);
  });
});
