#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, symlink, lstat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { parse } from 'yaml';
import { AgentSpec } from './schema/agent.js';
import { Config } from './schema/config.js';
import { Epic } from './schema/epic.js';
import { generateClaudeAgent } from './generators/claude.js';
import { generateCodexAgent } from './generators/codex.js';
import { generateContracts } from './generators/contracts.js';
import { FilesystemBacklog } from './backlog/filesystem.js';
import { GitHubIssuesBacklog } from './backlog/github.js';
import type { BacklogProvider } from './backlog/provider.js';

const AI_DIR = '.ai';

async function loadConfig(root: string): Promise<Config> {
  const raw = await readFile(join(root, AI_DIR, 'config.yaml'), 'utf8');
  return Config.parse(parse(raw));
}

export function makeBacklog(config: Config, root: string): BacklogProvider {
  return config.backlog.kind === 'github-issues'
    ? new GitHubIssuesBacklog(config.backlog.repo, { epicLabel: config.backlog.epic_label })
    : new FilesystemBacklog(join(root, config.backlog.dir));
}

async function loadAgents(root: string): Promise<AgentSpec[]> {
  const dir = join(root, AI_DIR, 'agents');
  const names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) =>
      AgentSpec.parse(parse(await readFile(join(dir, name), 'utf8'))),
    ),
  );
}

async function write(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  console.log(`  ${path}`);
}

/** Points a provider's skills directory at the shared source. Idempotent. */
async function linkSkills(root: string, providerDir: string): Promise<void> {
  const linkPath = join(root, providerDir, 'skills');
  try {
    // Already linked (or a real directory the user manages) — leave it alone.
    await lstat(linkPath);
    return;
  } catch {
    // Not present; create it below.
  }
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(relative(dirname(linkPath), join(root, AI_DIR, 'skills')), linkPath, 'dir');
  console.log(`  ${providerDir}/skills -> ${AI_DIR}/skills`);
}

async function generate(root: string): Promise<void> {
  const config = await loadConfig(root);
  const agents = await loadAgents(root);
  console.log(`Generating for: ${config.providers.join(', ')}`);

  for (const spec of agents) {
    if (config.providers.includes('claude')) {
      await write(root, `.claude/agents/${spec.name}.md`, generateClaudeAgent(spec));
    }
    if (config.providers.includes('codex')) {
      await write(root, `.codex/agents/${spec.name}.toml`, generateCodexAgent(spec));
    }
  }

  const contract = await readFile(join(root, AI_DIR, 'contract.md'), 'utf8');
  for (const target of generateContracts(contract)) {
    // Claude reads CLAUDE.md, Codex reads AGENTS.md; emit only what is used.
    const wanted =
      (target.path === 'CLAUDE.md' && config.providers.includes('claude')) ||
      (target.path === 'AGENTS.md' && config.providers.includes('codex'));
    if (wanted) await write(root, target.path, target.content);
  }

  if (config.providers.includes('claude')) await linkSkills(root, '.claude');
  if (config.providers.includes('codex')) await linkSkills(root, '.agents');
}

/** Prints the gate decision for an epic. Exit 0 = implementable. */
async function status(root: string, id: string): Promise<number> {
  const config = await loadConfig(root);
  const epic = await makeBacklog(config, root).get(id);
  if (!epic) {
    console.error(`epic ${id} not found`);
    return 2;
  }
  console.log(`${epic.id}  ${epic.status}  ${epic.title}`);
  if (epic.open_questions.length) {
    console.log(`\nOpen questions (${epic.open_questions.length}):`);
    for (const q of epic.open_questions) {
      console.log(`  - ${q.text}${q.assumption ? `\n    assumption: ${q.assumption}` : ''}`);
    }
  }
  if (epic.compliance_flags.length) {
    console.log(`\nCompliance flags: ${epic.compliance_flags.join(', ')}`);
  }
  return epic.status === 'APPROVED' ? 0 : 1;
}

async function approve(root: string, id: string, by: string): Promise<number> {
  const config = await loadConfig(root);
  const epic = await makeBacklog(config, root).setStatus(id, 'APPROVED', {
    by,
    at: new Date().toISOString(),
  });
  console.log(`${epic.id} approved by ${by}`);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.env.AI_SDLC_ROOT ?? process.cwd();

  switch (command) {
    case 'generate':
      await generate(root);
      return 0;
    case 'status':
      if (!args[0]) throw new Error('usage: ai-sdlc status <epic-id>');
      return status(root, args[0]);
    case 'approve': {
      if (!args[0]) throw new Error('usage: ai-sdlc approve <epic-id> [--by <name>]');
      const byFlag = args.indexOf('--by');
      const by =
        (byFlag >= 0 ? args[byFlag + 1] : undefined) ?? process.env.USER ?? 'unknown';
      return approve(root, args[0], by);
    }
    default:
      console.error('usage: ai-sdlc <generate|status|approve>');
      return 64;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
