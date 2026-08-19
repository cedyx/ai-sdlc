import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** Runs the built CLI in `cwd`, returning the exit code rather than throwing. */
async function run(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], { cwd });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('ai-sdlc init', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-sdlc-init-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds a repo that has no .ai/', async () => {
    const { code } = await run(dir, 'init');
    expect(code).toBe(0);
    expect((await readdir(join(dir, '.ai', 'agents'))).sort()).toEqual([
      'business-analyst.yaml',
      'developer.yaml',
    ]);
    await expect(stat(join(dir, '.ai', 'skills', 'epic-flow', 'SKILL.md'))).resolves.toBeDefined();
  });

  it('does not seed the example epic into a consuming repo', async () => {
    await run(dir, 'init');
    expect(await readdir(join(dir, '.ai', 'epics'))).toEqual([]);
  });

  it('writes a placeholder contract, not this project\'s own', async () => {
    await run(dir, 'init');
    const contract = await readFile(join(dir, '.ai', 'contract.md'), 'utf8');
    expect(contract).toContain('TODO');
    // Facts specific to the ai-sdlc repo must not leak into a consumer: this
    // sentence appears only in this project's own contract.
    expect(contract).not.toContain('compiles one provider-neutral definition');
    expect(contract).not.toContain('src/generators/');
  });

  it('copies hook scripts with the executable bit intact', async () => {
    await run(dir, 'init');
    const st = await stat(join(dir, 'scripts', 'hooks', 'block-vcs-mutations.sh'));
    expect(st.mode & 0o111).toBeTruthy();
  });

  it('refuses to overwrite an existing .ai/', async () => {
    await mkdir(join(dir, '.ai'), { recursive: true });
    await writeFile(join(dir, '.ai', 'contract.md'), 'hand written', 'utf8');
    const { code } = await run(dir, 'init');
    expect(code).toBe(1);
    expect(await readFile(join(dir, '.ai', 'contract.md'), 'utf8')).toBe('hand written');
  });

  it('produces a tree that generate can compile', async () => {
    await run(dir, 'init');
    const { code } = await run(dir, 'generate');
    expect(code).toBe(0);
    await expect(stat(join(dir, '.claude', 'agents', 'developer.md'))).resolves.toBeDefined();
    await expect(stat(join(dir, '.codex', 'agents', 'developer.toml'))).resolves.toBeDefined();
    // Skills reach the shared source through the generated symlink.
    await expect(
      readFile(join(dir, '.claude', 'skills', 'epic-flow', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('epic-flow');
  });
});
