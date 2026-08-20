import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AgentSpec } from '../schema/agent.js';
import { generateClaudeAgent } from '../generators/claude.js';
import {
  generatePluginAgent,
  generatePluginHooks,
  generatePluginManifest,
  generateMarketplaceManifest,
  generateCodexPluginManifest,
  generateCodexMarketplaceManifest,
} from '../generators/plugin.js';

const developer = AgentSpec.parse({
  name: 'developer',
  description: 'Implements an approved epic.',
  instructions: 'Implement the epic.',
  capabilities: {
    filesystem: 'write',
    write_paths: { deny: ['.ai/epics/*.yaml'] },
    shell: true,
    vcs_mutate: false,
  },
});

const analyst = AgentSpec.parse({
  name: 'business-analyst',
  description: 'Writes the epic.',
  instructions: 'Write the epic.',
  capabilities: {
    filesystem: 'write',
    write_paths: { allow: ['.ai/epics/*.yaml'] },
  },
});

const releaser = AgentSpec.parse({
  name: 'releaser',
  description: 'Cuts releases.',
  instructions: 'Tag and push.',
  capabilities: { filesystem: 'write', shell: true, vcs_mutate: true },
});

function frontmatter(md: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  return parse(m![1]!) as Record<string, unknown>;
}

describe('plugin agents', () => {
  // The loader discards these silently, so an agent shipped with them looks
  // enforced and is not. This is the whole reason the lowering differs.
  it('omits frontmatter keys the plugin loader would drop', () => {
    const md = generatePluginAgent(developer);
    const fm = frontmatter(md);
    expect(fm).not.toHaveProperty('hooks');
    expect(fm).not.toHaveProperty('permissionMode');
    expect(fm).not.toHaveProperty('mcpServers');
  });

  it('keeps the shared lowering identical to repo mode', () => {
    const fm = frontmatter(generatePluginAgent(developer));
    const repo = frontmatter(generateClaudeAgent(developer));
    expect(fm.name).toBe(repo.name);
    expect(fm.description).toBe(repo.description);
    expect(fm.tools).toBe(repo.tools);
    expect(fm.model).toBe(repo.model);
  });

  it('restates dropped restrictions in the prompt', () => {
    const md = generatePluginAgent(developer);
    expect(md).toContain('.ai/epics/*.yaml');
    expect(md).toMatch(/advisory/i);
    expect(md).toMatch(/commit, push/);
  });

  it('states allow-lists for a role scoped by allow rather than deny', () => {
    const md = generatePluginAgent(analyst);
    expect(md).toContain('Write only to: .ai/epics/*.yaml');
  });

  it('preserves the instruction body', () => {
    expect(generatePluginAgent(developer)).toContain('Implement the epic.');
  });
});

describe('plugin hooks', () => {
  it('blocks VCS mutation when no shell role may mutate', () => {
    const doc = JSON.parse(generatePluginHooks([analyst, developer]));
    expect(doc.hooks.PreToolUse).toHaveLength(1);
    expect(doc.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toContain('CLAUDE_PLUGIN_ROOT');
  });

  // A blanket block would break the role that is supposed to commit, and the
  // hook has no way to exempt it — so it must be dropped, and said out loud.
  it('emits no VCS guard, and explains why, when a role may mutate', () => {
    const doc = JSON.parse(generatePluginHooks([developer, releaser]));
    expect(doc.hooks.PreToolUse).toBeUndefined();
    expect(doc.description).toContain('releaser');
    expect(doc.description).toMatch(/CI or branch protection/);
  });

  it('emits no guard when no role has shell at all', () => {
    const doc = JSON.parse(generatePluginHooks([analyst]));
    expect(doc.hooks).toEqual({});
  });

  it('quotes the script path so a spaced install dir survives', () => {
    const doc = JSON.parse(generatePluginHooks([developer]));
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toMatch(/^"\$\{CLAUDE_PLUGIN_ROOT\}/);
  });
});

describe('manifests', () => {
  const meta = { name: 'ai-sdlc', version: '0.1.0', description: 'd', author: 'a' };

  it('emits the fields Claude strict validation requires', () => {
    const plugin = JSON.parse(generatePluginManifest(meta));
    expect(plugin).toMatchObject({ name: 'ai-sdlc', version: '0.1.0', author: { name: 'a' } });
    expect(plugin.description).toBeTruthy();

    const mk = JSON.parse(generateMarketplaceManifest(meta));
    expect(mk.owner).toEqual({ name: 'a' });
    expect(mk.description).toBeTruthy();
    expect(mk.plugins[0]).toMatchObject({ name: 'ai-sdlc', source: './plugins/ai-sdlc' });
  });

  it('emits the fields Codex plugin ingestion requires', () => {
    const plugin = JSON.parse(generateCodexPluginManifest(meta));
    expect(plugin).toMatchObject({
      name: 'ai-sdlc',
      version: '0.1.0',
      author: { name: 'a' },
      skills: './skills/',
    });
    expect(plugin).not.toHaveProperty('hooks');
    expect(plugin.interface).toMatchObject({
      displayName: 'ai-sdlc',
      category: 'Productivity',
    });

    const mk = JSON.parse(generateCodexMarketplaceManifest(meta));
    expect(mk.interface.displayName).toBe('ai-sdlc');
    expect(mk.plugins[0]).toMatchObject({
      name: 'ai-sdlc',
      source: { source: 'local', path: './plugins/ai-sdlc' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    });
  });
});

/**
 * `plugin build` is filesystem work in the CLI rather than a pure generator, so
 * it is covered by running the built binary against a scratch repo. Both facts
 * asserted here are load-bearing for the one-click install: the tree must land
 * where `marketplace add` looks, and re-running must not accrete stale files
 * into a version-controlled destination.
 */
describe('plugin build (CLI)', () => {
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  let dir: string;

  beforeAll(async () => {
    // The pure generators are the unit under test elsewhere; this needs a build.
    if (!existsSync(cli)) throw new Error('run `npm run build` before this suite');
    dir = await mkdtemp(join(tmpdir(), 'ai-sdlc-plugin-'));
    execFileSync(process.execPath, [cli, 'init'], { cwd: dir, stdio: 'pipe' });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to the repo root, where marketplace add looks', () => {
    execFileSync(process.execPath, [cli, 'plugin', 'build'], { cwd: dir, stdio: 'pipe' });

    // Not merely "a file exists": these exact paths are the contract with the
    // plugin loader, and marketplace.json must resolve its relative source.
    const marketplace = JSON.parse(
      readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: { name: string; source: string }[] };
    const entry = marketplace.plugins[0]!;
    expect(existsSync(join(dir, entry.source, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(dir, 'plugins', entry.name, 'skills', 'epic-flow', 'SKILL.md'))).toBe(
      true,
    );

    const codexMarketplace = JSON.parse(
      readFileSync(join(dir, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
    ) as { plugins: { name: string; source: { path: string } }[] };
    const codexEntry = codexMarketplace.plugins[0]!;
    expect(existsSync(join(dir, codexEntry.source.path, '.codex-plugin', 'plugin.json'))).toBe(
      true,
    );
  });

  it('drops files removed from .ai/ instead of leaving them behind', async () => {
    const skills = join(dir, '.ai', 'skills');
    await mkdir(join(skills, 'scratch'), { recursive: true });
    await writeFile(join(skills, 'scratch', 'SKILL.md'), '# scratch\n');
    execFileSync(process.execPath, [cli, 'plugin', 'build'], { cwd: dir, stdio: 'pipe' });

    const emitted = join(dir, 'plugins', 'ai-sdlc', 'skills', 'scratch');
    expect(existsSync(emitted)).toBe(true);

    await rm(join(skills, 'scratch'), { recursive: true });
    execFileSync(process.execPath, [cli, 'plugin', 'build'], { cwd: dir, stdio: 'pipe' });

    // The destination is committed, so a stale skill would ship to consumers.
    expect(existsSync(emitted)).toBe(false);
  });
});
