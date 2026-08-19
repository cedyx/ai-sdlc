#!/usr/bin/env node
import {
  readFile, writeFile, mkdir, readdir, symlink, lstat, cp, access, chmod, rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AgentSpec } from './schema/agent.js';
import { Config } from './schema/config.js';
import { Epic } from './schema/epic.js';
import { generateClaudeAgent } from './generators/claude.js';
import { generateCodexAgent, lowerCapabilities, type CapabilityFinding } from './generators/codex.js';
import { checkRequirements, formatViolation } from './generators/requirements.js';
import { generateContracts } from './generators/contracts.js';
import { generateCiWorkflow } from './enforcement/ci.js';
import {
  generatePluginAgent,
  generatePluginHooks,
  generatePluginManifest,
  generateMarketplaceManifest,
} from './generators/plugin.js';
import { FilesystemBacklog } from './backlog/filesystem.js';
import { GitHubIssuesBacklog } from './backlog/github.js';
import { makeBacklog } from './backlog/provider.js';

const AI_DIR = '.ai';

async function loadConfig(root: string): Promise<Config> {
  const raw = await readFile(join(root, AI_DIR, 'config.yaml'), 'utf8');
  return Config.parse(parse(raw));
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

async function generate(root: string, allowLossy: Set<string>): Promise<number> {
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

  // Unconditional, and deliberately outside the provider branches: the gate
  // constrains what enters the repository, which is true whichever agent wrote
  // the code, or none. Making it provider-conditional would let removing a
  // provider quietly remove the enforcement boundary.
  const ci = generateCiWorkflow({ backlog: config.backlog.kind });
  await write(root, ci.path, ci.content);

  if (config.providers.includes('codex')) reportCodexFidelity(agents);

  // Requirements are checked after the report, and the report is printed either
  // way: --allow-lossy skips enforcement only, never the fidelity computation.
  const reqs = config.requirements?.codex;
  if (reqs && config.providers.includes('codex') && !allowLossy.has('codex')) {
    const rows = agents.map((spec) => ({ name: spec.name, findings: lowerCapabilities(spec).findings }));
    const violations = checkRequirements(rows, reqs);
    if (violations.length) {
      for (const v of violations) console.error(`\n${formatViolation(v)}`);
      return 1;
    }
  }
  return 0;
}

/**
 * Prints what survived lowering onto Codex and what did not.
 *
 * The asymmetry between providers was documented in prose, which put it where a
 * reader had to already suspect a problem to go looking. Printing it at build
 * time makes the degradation impossible to adopt unknowingly: a role whose
 * write scope is advisory is a role that needs branch protection behind it.
 */
/**
 * Renders a finding's identity for the terminal.
 *
 * Presentation lives here, not in the finding: `capability` is a stable machine
 * id, and the value it was asked for travels separately in `requested`.
 */
function formatCapabilityFinding(f: CapabilityFinding): string {
  switch (f.capability) {
    case 'filesystem':
    case 'network':
    case 'shell':
    case 'vcs_mutate':
      return `${f.capability}: ${String(f.requested)}`;
    // The paths are already in the detail line; repeating them would wrap the column.
    case 'write_paths.allow':
    case 'write_paths.deny':
      return f.capability;
  }
}

function reportCodexFidelity(agents: AgentSpec[]): void {
  const rows = agents.map((spec) => ({ name: spec.name, findings: lowerCapabilities(spec).findings }));
  const weak = (f: CapabilityFinding) => f.fidelity !== 'native';
  if (!rows.some((r) => r.findings.some(weak))) return;

  const mark = { native: '\u2713', advisory: '~', broadened: '!', unsupported: '\u2717' } as const;
  console.log('\nCodex capability report');
  for (const { name, findings } of rows) {
    console.log(`\n  ${name}`);
    for (const f of findings) {
      console.log(`    ${mark[f.fidelity]} ${formatCapabilityFinding(f).padEnd(24)} ${f.detail}`);
    }
  }
  const kinds = new Set(rows.flatMap((r) => r.findings.map((f) => f.fidelity)));
  const legend: string[] = [];
  if (kinds.has('advisory')) legend.push('  ~ advisory: instructions only, a model may ignore it.');
  if (kinds.has('broadened')) legend.push('  ! broadened: the runtime grant is wider than the IR asked for.');
  if (kinds.has('unsupported')) legend.push('  \u2717 unsupported: Codex cannot express this at all. The IR asks for something the generated config does not do.');
  legend.push('  Back the rest with branch protection or CI; agent config alone will not hold.');
  console.log('\n' + legend.join('\n'));
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
  if (epic.status === 'APPROVED') {
    console.log(`\napproved by ${epic.approval.approved_by} at ${epic.approval.approved_at}`);
    return 0;
  }

  // The exit code is the enforced half of the gate, and it is worth saying which
  // half that is. Nothing stops an agent from writing code without consulting
  // this command; what it cannot do is make unapproved work *look* approved.
  console.log(`\nnot approved: implementation of ${epic.id} is not authorised.`);
  console.log('This exit code is the enforced gate. The stop before implementing');
  console.log('is a workflow convention — if code already exists, it was written');
  console.log('unapproved, not approved by bypass. Review it before it ships.');
  return 1;
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

/**
 * Directory of the installed package (dist/ -> package root). `init` seeds a
 * consuming repo from the starter `.ai/` and hook scripts shipped in `files`.
 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seeds `.ai/` and `scripts/hooks/` into a repo that does not have them.
 *
 * Refuses to overwrite an existing `.ai/`: the source of truth is hand-edited,
 * so clobbering it would silently discard a team's agent definitions. Hook
 * scripts are copied rather than symlinked because generated Claude hooks
 * resolve them relative to the consuming repo, which must survive a fresh
 * clone with no node_modules.
 */
/**
 * Placeholder contract for a freshly-initialised repo. Deliberately terse and
 * obviously incomplete — a plausible-looking default would get shipped unread,
 * and every line here is compiled into CLAUDE.md and AGENTS.md.
 */
const STARTER_CONTRACT = `# Project contract

Shared instructions for every AI agent working in this repository, regardless
of provider. This file is the source; \`CLAUDE.md\` and \`AGENTS.md\` are
generated from it by \`ai-sdlc generate\`. Edit here, never there.

## What this project is

TODO: one paragraph. What the codebase does and who uses it.

## Architecture

TODO: the handful of facts an agent would otherwise get wrong — module
boundaries, where state lives, what must not be imported from where.

## Conventions

TODO: language, test framework and how to run it, formatting, commit style.

## Boundaries

TODO: what agents must not touch without a human — CI, secrets, migrations,
infrastructure.
`;

async function init(root: string): Promise<number> {
  const aiDir = join(root, AI_DIR);
  if (await exists(aiDir)) {
    console.error(`${AI_DIR}/ already exists — refusing to overwrite.`);
    console.error('Edit it directly, or remove it first to re-seed from the starter.');
    return 1;
  }

  // The example epic and this project's own contract are artifacts of the
  // ai-sdlc repo, not a starting point for a consuming one: seeding them would
  // plant a fake epic and describe the wrong codebase.
  await cp(join(PKG_ROOT, AI_DIR), aiDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(join(PKG_ROOT, AI_DIR), src);
      return rel !== 'epics' && !rel.startsWith(`epics${sep}`) && rel !== 'contract.md';
    },
  });
  await mkdir(join(aiDir, 'epics'), { recursive: true });
  await writeFile(join(aiDir, 'contract.md'), STARTER_CONTRACT, 'utf8');
  console.log(`  ${AI_DIR}/`);

  const hooks = join(root, 'scripts', 'hooks');
  if (!(await exists(hooks))) {
    await cp(join(PKG_ROOT, 'scripts', 'hooks'), hooks, { recursive: true });
    console.log('  scripts/hooks/');
  }

  console.log('\nNext: edit .ai/agents/*.yaml and .ai/contract.md, then run `ai-sdlc generate`.');
  return 0;
}

/**
 * Emits a Claude Code plugin tree, so a consuming repo can install the pipeline
 * instead of running `init` + `generate` and committing provider files.
 *
 * Defaults to *this* repo's root, because that is what makes the install one
 * step for a consumer: `claude plugin marketplace add <owner>/<repo>` clones
 * the repo and looks for `.claude-plugin/marketplace.json` at its root. Build
 * to a throwaway directory and there is nothing to point an install at.
 *
 * Not a packaging of the `generate` output: plugin-shipped agents may not carry
 * `hooks` or `permissionMode`, and the loader drops them without a word. See
 * `src/generators/plugin.ts` for what that costs and what replaces it.
 */
async function buildPlugin(root: string, outDir: string): Promise<number> {
  const agents = await loadAgents(root);
  const pkg = JSON.parse(
    await readFile(join(PKG_ROOT, 'package.json'), 'utf8'),
  ) as { name: string; version: string; description: string };
  const meta = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    author: 'ai-sdlc',
  };

  const out = resolve(root, outDir);
  const pluginRoot = join(out, 'plugins', meta.name);

  const emit = async (rel: string, content: string): Promise<void> => {
    const full = join(out, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    console.log(`  ${join(outDir, rel)}`);
  };

  await emit(join('.claude-plugin', 'marketplace.json'), generateMarketplaceManifest(meta));
  await emit(join('plugins', meta.name, '.claude-plugin', 'plugin.json'),
    generatePluginManifest(meta));

  for (const spec of agents) {
    await emit(join('plugins', meta.name, 'agents', `${spec.name}.md`),
      generatePluginAgent(spec));
  }

  await emit(join('plugins', meta.name, 'hooks', 'hooks.json'), generatePluginHooks(agents));

  // Skills and guard scripts are copied, not symlinked: a plugin is fetched as
  // a standalone tree and a link out of it would dangle on the installing machine.
  await rm(join(pluginRoot, 'skills'), { recursive: true, force: true });
  await cp(join(root, AI_DIR, 'skills'), join(pluginRoot, 'skills'), { recursive: true });
  console.log(`  ${outDir}/plugins/${meta.name}/skills/`);
  await rm(join(pluginRoot, 'scripts'), { recursive: true, force: true });
  await cp(join(PKG_ROOT, 'scripts', 'hooks'), join(pluginRoot, 'scripts', 'hooks'), {
    recursive: true,
    // cp does not preserve the executable bit by default on every platform.
    mode: constants.COPYFILE_FICLONE,
  });
  for (const name of await readdir(join(pluginRoot, 'scripts', 'hooks'))) {
    await chmod(join(pluginRoot, 'scripts', 'hooks', name), 0o755);
  }
  console.log(`  ${outDir}/plugins/${meta.name}/scripts/hooks/`);

  console.log(`\nValidate with: claude plugin validate ${outDir}`);
  console.log('Commit the tree so consumers can install it directly from the repo.');
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.env.AI_SDLC_ROOT ?? process.cwd();

  switch (command) {
    case 'init':
      return init(root);
    case 'generate': {
      const lossy = new Set(
        args.filter((a) => a.startsWith('--allow-lossy=')).map((a) => a.slice('--allow-lossy='.length)),
      );
      for (const t of lossy) {
        if (t !== 'codex') {
          console.error(`--allow-lossy: unknown target '${t}' (only 'codex' reports fidelity)`);
          return 64;
        }
      }
      return generate(root, lossy);
    }
    case 'plugin':
      if (args[0] !== 'build') {
        console.error('usage: ai-sdlc plugin build [--out <dir>]');
        return 64;
      }
      {
        // indexOf returns -1 when absent, which would index args[0] ('build').
        const i = args.indexOf('--out');
        // Repo root by default: see buildPlugin.
        return buildPlugin(root, (i >= 0 ? args[i + 1] : undefined) ?? '.');
      }
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
      console.error('usage: ai-sdlc <init|generate|plugin|status|approve>');
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
