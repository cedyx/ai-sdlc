import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Config } from '../schema/config.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = join('.github', 'workflows', 'approval-gate.yml');

async function run(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], { cwd });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const exists = (p: string) => access(p).then(() => true, () => false);

describe('approval config', () => {
  // The loose default is the point of the feature, and it is a default rather
  // than a required field so every config written before it keeps parsing.
  it('defaults to chat mode with no CI gate, and needs no approval block', () => {
    const config = Config.parse({ backlog: { kind: 'filesystem' } });
    expect(config.approval).toEqual({ mode: 'chat', ci_gate: false });
  });

  it('accepts the strict combination', () => {
    const config = Config.parse({
      backlog: { kind: 'filesystem' },
      approval: { mode: 'artifact', ci_gate: true },
    });
    expect(config.approval).toEqual({ mode: 'artifact', ci_gate: true });
  });

  it('rejects an unknown approval key rather than ignoring it', () => {
    const result = Config.safeParse({
      backlog: { kind: 'filesystem' },
      approval: { mode: 'chat', enforce: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a mode outside the two it knows', () => {
    const result = Config.safeParse({
      backlog: { kind: 'filesystem' },
      approval: { mode: 'off' },
    });
    expect(result.success).toBe(false);
  });
});

describe('generate and the CI gate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-sdlc-approval-'));
    // A minimal seeded repo: generate needs agents and a contract, nothing else.
    await mkdir(join(dir, '.ai'), { recursive: true });
    await cp(join(REPO, '.ai', 'agents'), join(dir, '.ai', 'agents'), { recursive: true });
    await writeFile(join(dir, '.ai', 'contract.md'), '# Contract\n\n## What this project is\n\nA fixture.\n', 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeConfig = (approval?: string) =>
    writeFile(
      join(dir, '.ai', 'config.yaml'),
      `providers: [claude]\nbacklog:\n  kind: filesystem\n  dir: .ai/epics\n${approval ?? ''}`,
      'utf8',
    );

  it('emits no workflow by default', async () => {
    await writeConfig();
    const { code } = await run(dir, 'generate');
    expect(code).toBe(0);
    expect(await exists(join(dir, WORKFLOW))).toBe(false);
  });

  it('emits the workflow when ci_gate is on', async () => {
    await writeConfig('approval:\n  ci_gate: true\n');
    const { code } = await run(dir, 'generate');
    expect(code).toBe(0);
    expect(await readFile(join(dir, WORKFLOW), 'utf8')).toMatch(/name: approval gate/);
  });

  // Deleting a committed workflow because a default changed would turn a
  // required check off as a side effect of regenerating unrelated files.
  it('leaves an existing workflow alone when ci_gate is off', async () => {
    await writeConfig('approval:\n  ci_gate: true\n');
    await run(dir, 'generate');
    await writeConfig('approval:\n  ci_gate: false\n');
    const { code, stdout } = await run(dir, 'generate');
    expect(code).toBe(0);
    expect(await exists(join(dir, WORKFLOW))).toBe(true);
    expect(stdout).toMatch(/leaving existing/);
  });
});

describe('the gate is unaffected by the mode', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-sdlc-mode-'));
    await mkdir(join(dir, '.ai', 'epics'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const epic = (status: string, approval = '') =>
    writeFile(
      join(dir, '.ai', 'epics', 'EPIC-1.yaml'),
      `id: EPIC-1\ntitle: Example\nstatus: ${status}\nstories: []\n${approval}`,
      'utf8',
    );

  const config = (mode: string) =>
    writeFile(
      join(dir, '.ai', 'config.yaml'),
      `providers: [claude]\nbacklog:\n  kind: filesystem\n  dir: .ai/epics\napproval:\n  mode: ${mode}\n`,
      'utf8',
    );

  // The whole safety argument rests on this: chat mode changes who runs the
  // approve command, never what APPROVED means to the exit code.
  it.each(['chat', 'artifact'])('exits 1 on DRAFT under mode %s', async (mode) => {
    await config(mode);
    await epic('DRAFT');
    expect((await run(dir, 'status', 'EPIC-1')).code).toBe(1);
  });

  it.each(['chat', 'artifact'])('exits 0 on a recorded approval under mode %s', async (mode) => {
    await config(mode);
    await epic('APPROVED', 'approval:\n  approved_by: yse\n  approved_at: 2026-08-20T06:00:00.000Z\n');
    expect((await run(dir, 'status', 'EPIC-1')).code).toBe(0);
  });

  // Self-attestation is the cost of chat mode, so it is stated where it is
  // recorded rather than left for the reader to infer from the config.
  it('names the attestation weakness when approving in chat mode', async () => {
    await config('chat');
    await epic('DRAFT');
    const { code, stdout } = await run(dir, 'approve', 'EPIC-1', '--by', 'yse');
    expect(code).toBe(0);
    expect(stdout).toMatch(/self-attested/);
  });

  it('says nothing about attestation in artifact mode', async () => {
    await config('artifact');
    await epic('DRAFT');
    const { stdout } = await run(dir, 'approve', 'EPIC-1', '--by', 'yse');
    expect(stdout).not.toMatch(/self-attested/);
  });
});

describe('init seeds the loose default', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-sdlc-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // This repo ships the gate and so must run it, which makes its own config the
  // one file init must not copy: a seeded repo would get the strict path as if
  // it had chosen it.
  it('writes a starter config rather than copying this repo\'s', async () => {
    const { code } = await run(dir, 'init');
    expect(code).toBe(0);
    const raw = await readFile(join(dir, '.ai', 'config.yaml'), 'utf8');
    expect(raw).toMatch(/mode: chat/);
    expect(raw).toMatch(/ci_gate: false/);
    expect(raw).not.toMatch(/mode: artifact/);
  });

  it('generates no workflow from the seeded config', async () => {
    await run(dir, 'init');
    await writeFile(join(dir, '.ai', 'contract.md'), '# Contract\n\n## What this project is\n\nA fixture.\n', 'utf8');
    const { code } = await run(dir, 'generate');
    expect(code).toBe(0);
    expect(await exists(join(dir, WORKFLOW))).toBe(false);
  });
});
