import { describe, expect, it } from 'vitest';
import { AgentSpec } from '../schema/agent.js';
import { Config, TargetRequirements } from '../schema/config.js';
import { lowerCapabilities, type CapabilityFinding } from '../generators/codex.js';
import { checkRequirements, formatViolation } from '../generators/requirements.js';

const reqs = (o: unknown) => TargetRequirements.parse(o);
const finding = (capability: string, fidelity: string) =>
  ({ capability, fidelity, requested: false, detail: '' }) as unknown as CapabilityFinding;
const rows = (findings: CapabilityFinding[]) => [{ name: 'r', findings }];

describe('requirements schema', () => {
  it('requires a default so no pair is unconstrained', () => {
    expect(TargetRequirements.safeParse({ shell: ['native'] }).success).toBe(false);
  });

  it('rejects an unknown capability key rather than ignoring it', () => {
    expect(TargetRequirements.safeParse({ default: ['native'], 'write_path.allow': ['native'] }).success).toBe(false);
  });

  it('rejects an empty accepted set, which would accept nothing', () => {
    expect(TargetRequirements.safeParse({ default: [] }).success).toBe(false);
  });

  it('has no `any` escape hatch; permissiveness is spelled out', () => {
    expect(reqs({ default: ['native', 'advisory', 'broadened', 'unsupported'] }).default).toHaveLength(4);
    expect(TargetRequirements.safeParse({ default: 'any' }).success).toBe(false);
  });

  it('accepts only targets that emit findings', () => {
    const base = { backlog: { kind: 'filesystem' as const } };
    expect(Config.safeParse({ ...base, requirements: { codex: { default: ['native'] } } }).success).toBe(true);
    expect(Config.safeParse({ ...base, requirements: { 'claude-repo': { default: ['native'] } } }).success).toBe(false);
  });
});

describe('membership, not ordering', () => {
  it('does not treat advisory and broadened as interchangeable strengths', () => {
    const r = reqs({ default: ['native', 'broadened'] });
    expect(checkRequirements(rows([finding('write_paths.deny', 'advisory')]), r)).toHaveLength(1);
    expect(checkRequirements(rows([finding('write_paths.allow', 'broadened')]), r)).toHaveLength(0);
  });

  it('does not accept native merely because it is "better" than a listed value', () => {
    // An explicitly narrow set means exactly that set.
    expect(checkRequirements(rows([finding('shell', 'native')]), reqs({ default: ['advisory'] }))).toHaveLength(1);
  });
});

describe('default inheritance', () => {
  it('applies the default to a capability with no override', () => {
    const v = checkRequirements(rows([finding('shell', 'advisory')]), reqs({ default: ['native'] }));
    expect(v[0]?.capability).toBe('shell');
    expect(v[0]?.accepted).toEqual(['native']);
  });

  it('lets an override widen or narrow relative to the default', () => {
    const r = reqs({ default: ['native'], 'write_paths.deny': ['native', 'advisory'] });
    expect(checkRequirements(rows([finding('write_paths.deny', 'advisory')]), r)).toHaveLength(0);
    expect(checkRequirements(rows([finding('shell', 'advisory')]), r)).toHaveLength(1);
  });

  it('covers every CapabilityId a real lowering can emit', () => {
    // The policy is total: no finding from any spec escapes unjudged.
    const specs = [
      { name: 'a', description: 'd', instructions: 'i', capabilities: { filesystem: 'none' } },
      { name: 'b', description: 'd', instructions: 'i', capabilities: { filesystem: 'read', network: true } },
      {
        name: 'c', description: 'd', instructions: 'i',
        capabilities: { filesystem: 'write', write_paths: { deny: ['x'] }, shell: true },
      },
      {
        name: 'd', description: 'd', instructions: 'i',
        capabilities: { filesystem: 'write', write_paths: { allow: ['y'] } },
      },
    ];
    const all = specs.flatMap((s) => lowerCapabilities(AgentSpec.parse(s)).findings);
    const strict = reqs({ default: ['native'] });
    const judged = checkRequirements([{ name: 'r', findings: all }], strict);
    const nonNative = all.filter((f) => f.fidelity !== 'native');
    expect(judged).toHaveLength(nonNative.length);
    expect(new Set(judged.map((v) => v.capability))).toEqual(new Set(nonNative.map((f) => f.capability)));
  });
});

describe('failure message', () => {
  it('names target, capability, actual and accepted', () => {
    const [v] = checkRequirements(rows([finding('write_paths.allow', 'advisory')]), reqs({ default: ['native', 'broadened'] }));
    const out = formatViolation(v!);
    expect(out).toContain('target:      codex');
    expect(out).toContain('capability:  write_paths.allow');
    expect(out).toContain('actual:      advisory');
    // Without the accepted set the reader cannot tell a too-strict requirement
    // from a genuine lowering regression.
    expect(out).toContain('accepted:    native, broadened');
  });
});
