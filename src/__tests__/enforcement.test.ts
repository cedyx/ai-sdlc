import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractEpicId, generateCiWorkflow, EPIC_MARKER } from '../enforcement/ci.js';
import { runGate, EXIT } from '../enforcement/gate.js';
import { FilesystemBacklog } from '../backlog/filesystem.js';
import { Epic } from '../schema/epic.js';

describe('epic marker extraction', () => {
  it('reads the marker from a line of its own', () => {
    expect(extractEpicId('AI-SDLC-Epic: EPIC-1')).toEqual({ ok: true, id: 'EPIC-1' });
  });

  // Contributors write prose above the marker; a gate that only accepts it at
  // the top of the body would fail for a reason unrelated to approval.
  it('finds the marker below a description', () => {
    const body = '## What\n\nAdds the thing.\n\nAI-SDLC-Epic: EPIC-42\n';
    expect(extractEpicId(body)).toEqual({ ok: true, id: 'EPIC-42' });
  });

  it('accepts list and quote prefixes, and normalises case', () => {
    expect(extractEpicId('- ai-sdlc-epic: epic-7')).toEqual({ ok: true, id: 'EPIC-7' });
  });

  // Fail closed: no marker is not an exemption. If absence were a skip, every
  // pull request could opt out of the gate by saying nothing.
  it('fails on an absent marker', () => {
    expect(extractEpicId('No mention here.')).toEqual({ ok: false, reason: 'absent' });
    expect(extractEpicId('')).toEqual({ ok: false, reason: 'absent' });
    expect(extractEpicId(undefined)).toEqual({ ok: false, reason: 'absent' });
  });

  // Reported separately from absence so the message can say which mistake it
  // was. A typo must not be guessed at: guessing could resolve to another epic.
  it('distinguishes a malformed marker from a missing one', () => {
    expect(extractEpicId('AI-SDLC-Epic: 1')).toEqual({ ok: false, reason: 'malformed' });
    expect(extractEpicId('AI-SDLC-Epic:')).toEqual({ ok: false, reason: 'malformed' });
  });

  // A marker mentioned mid-sentence is not an association. Requiring its own
  // line keeps "documenting the convention" from accidentally satisfying it.
  it('ignores the marker inside prose', () => {
    expect(extractEpicId('Add AI-SDLC-Epic: EPIC-1 to the body.')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('generated CI workflow', () => {
  it('runs on body edits, since editing is how a bad marker gets fixed', () => {
    const { content } = generateCiWorkflow();
    expect(content).toMatch(/types: \[opened, edited, synchronize, reopened\]/);
  });

  // A PR body is attacker-controlled text. Interpolating it into a run block
  // would make the gate a shell-injection site in the name of enforcement.
  it('passes the PR body through the environment, never into the script', () => {
    const { content } = generateCiWorkflow();
    expect(content).toMatch(/PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
    expect(content).not.toMatch(/run:.*github\.event\.pull_request\.body/);
  });

  it('asks for no write permissions', () => {
    expect(generateCiWorkflow().content).toMatch(/permissions:\n {2}contents: read/);
  });
});

describe('the gate, end to end', () => {
  let root: string;
  let backlog: FilesystemBacklog;
  const draft = {
    id: 'EPIC-1',
    title: 'Example',
    status: 'DRAFT' as const,
    stories: [
      {
        id: 'S1',
        text: 'As a user, I want a thing, so that value.',
        acceptance_criteria: [{ id: 'AC1', text: 'Given x, when y, then z.' }],
      },
    ],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-sdlc-gate-'));
    await mkdir(join(root, '.ai', 'epics'), { recursive: true });
    await writeFile(
      join(root, '.ai', 'config.yaml'),
      'providers: [claude]\nbacklog:\n  kind: filesystem\n  dir: .ai/epics\n',
    );
    backlog = new FilesystemBacklog(join(root, '.ai', 'epics'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('fails a DRAFT epic', async () => {
    await backlog.save(Epic.parse(draft));
    expect(await runGate(root, `${EPIC_MARKER}: EPIC-1`)).toBe(EXIT.notApproved);
  });

  it('fails a CHANGES_REQUESTED epic', async () => {
    await backlog.save(Epic.parse({ ...draft, status: 'CHANGES_REQUESTED' }));
    expect(await runGate(root, `${EPIC_MARKER}: EPIC-1`)).toBe(EXIT.notApproved);
  });

  it('passes an APPROVED epic with a recorded approver', async () => {
    await backlog.save(Epic.parse(draft));
    await backlog.setStatus('EPIC-1', 'APPROVED', {
      by: 'yse',
      at: '2026-08-19T06:00:00.000Z',
    });
    expect(await runGate(root, `body text\n\n${EPIC_MARKER}: EPIC-1\n`)).toBe(EXIT.pass);
  });

  // An approved epic elsewhere in the backlog must not authorise a PR that
  // points at an unapproved one. This is the case a global scan cannot catch.
  it('fails when the named epic is unapproved even though another is approved', async () => {
    await backlog.save(Epic.parse(draft));
    await backlog.save(Epic.parse({ ...draft, id: 'EPIC-2' }));
    await backlog.setStatus('EPIC-2', 'APPROVED', {
      by: 'yse',
      at: '2026-08-19T06:00:00.000Z',
    });
    expect(await runGate(root, `${EPIC_MARKER}: EPIC-1`)).toBe(EXIT.notApproved);
  });

  it('fails an id that resolves to nothing', async () => {
    expect(await runGate(root, `${EPIC_MARKER}: EPIC-99`)).toBe(EXIT.notFound);
  });

  it('fails a body with no marker at all', async () => {
    await backlog.save(Epic.parse(draft));
    expect(await runGate(root, 'Looks fine to me.')).toBe(EXIT.noMarker);
  });
});
