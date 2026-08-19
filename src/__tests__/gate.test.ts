import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Epic, isImplementable } from '../schema/epic.js';
import { FilesystemBacklog } from '../backlog/filesystem.js';
import { BacklogUnavailableError, EpicCorruptError, EpicNotFoundError } from '../backlog/provider.js';
import { parse as parseYaml } from 'yaml';
import { EXIT } from '../enforcement/gate.js';

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

describe('epic state machine', () => {
  it('gates implementation on APPROVED only', () => {
    for (const status of ['DRAFT', 'CHANGES_REQUESTED', 'DONE', 'CANCELLED'] as const) {
      expect(isImplementable(Epic.parse({ ...draft, status }))).toBe(false);
    }
  });

  it('refuses APPROVED without a recorded approver', () => {
    const result = Epic.safeParse({ ...draft, status: 'APPROVED' });
    expect(result.success).toBe(false);
  });

  it('accepts APPROVED with an approver and timestamp', () => {
    const epic = Epic.parse({
      ...draft,
      status: 'APPROVED',
      approval: { approved_by: 'yse', approved_at: '2026-08-19T06:00:00.000Z' },
    });
    expect(isImplementable(epic)).toBe(true);
  });
});

describe('filesystem backlog', () => {
  let dir: string;
  let backlog: FilesystemBacklog;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-sdlc-'));
    backlog = new FilesystemBacklog(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips an epic', async () => {
    await backlog.save(Epic.parse(draft));
    const loaded = await backlog.get('EPIC-1');
    expect(loaded?.title).toBe('Example');
    expect(loaded?.stories[0]?.acceptance_criteria[0]?.id).toBe('AC1');
  });

  it('returns null for a missing epic and empty list for a missing dir', async () => {
    expect(await backlog.get('nope')).toBeNull();
    expect(await new FilesystemBacklog(join(dir, 'absent')).list()).toEqual([]);
  });

  it('records the approver when transitioning to APPROVED', async () => {
    await backlog.save(Epic.parse(draft));
    const approved = await backlog.setStatus('EPIC-1', 'APPROVED', {
      by: 'yse',
      at: '2026-08-19T06:00:00.000Z',
    });
    expect(approved.approval.approved_by).toBe('yse');
    expect(isImplementable(approved)).toBe(true);
  });

  it('refuses to approve without an actor', async () => {
    await backlog.save(Epic.parse(draft));
    await expect(backlog.setStatus('EPIC-1', 'APPROVED')).rejects.toThrow();
  });

  it('throws a typed error for an unknown epic', async () => {
    await expect(backlog.setStatus('ghost', 'APPROVED', { by: 'a', at: '2026-08-19T06:00:00.000Z' }))
      .rejects.toThrow(EpicNotFoundError);
  });

  it('rejects path-traversing ids', async () => {
    await expect(backlog.get('../escape')).rejects.toThrow(/unsafe epic id/);
  });

  it('filters by status', async () => {
    await backlog.save(Epic.parse(draft));
    await backlog.save(Epic.parse({ ...draft, id: 'EPIC-2' }));
    await backlog.setStatus('EPIC-2', 'APPROVED', { by: 'yse', at: '2026-08-19T06:00:00.000Z' });
    const approved = await backlog.list({ status: 'APPROVED' });
    expect(approved.map((e) => e.id)).toEqual(['EPIC-2']);
  });
});

/**
 * Regression cover for the three failure classes the live GitHub exercise
 * showed collapsing into one.
 *
 * These are unit-level on purpose: the live run proved the behaviour against
 * the real API once, and this pins it so a refactor cannot quietly re-merge
 * absence with unavailability or corruption. The distinction matters because
 * each demands a different fix from whoever reads the CI log — repair the
 * artifact, widen the workflow scopes, or create the epic.
 */
describe('backlog failure classes stay distinguishable', () => {
  const decode = (body: string) => {
    const block = /```ai-sdlc\n([\s\S]*?)```/.exec(body)?.[1];
    if (!block) return { kind: 'absent' as const };
    let parsed: unknown;
    try {
      parsed = parseYaml(block);
    } catch (err) {
      return { kind: 'corrupt' as const, detail: (err as Error).message };
    }
    const result = Epic.safeParse(parsed);
    return result.success
      ? { kind: 'ok' as const }
      : { kind: 'corrupt' as const, detail: result.error.issues[0]?.message ?? '' };
  };

  it('reads no artifact as absent, not corrupt', () => {
    expect(decode('Just prose, no fenced block.').kind).toBe('absent');
  });

  // Live finding: `parse` throws on syntax errors while `safeParse` returns a
  // failure object, so guarding only the second left this as an uncaught crash.
  it('treats malformed YAML as corrupt', () => {
    const body = '```ai-sdlc\nid: EPIC-1\nstories: [{id: S1, x: y\n  bad: nesting}]\n```';
    const result = decode(body);
    expect(result.kind).toBe('corrupt');
  });

  // Live finding: this one previously surfaced as exit 2 "epic not found",
  // which is a lie — the epic is present and someone can repair it.
  it('treats schema-valid-YAML-invalid-epic as corrupt, naming the field', () => {
    const body =
      '```ai-sdlc\nid: EPIC-1\ntitle: T\nstatus: TOTALLY_BOGUS\nstories: []\n' +
      'out_of_scope: []\nnon_functional: []\ncompliance_flags: []\nopen_questions: []\n```';
    const result = decode(body);
    expect(result.kind).toBe('corrupt');
    if (result.kind === 'corrupt') expect(result.detail).toMatch(/enum|status/i);
  });

  it('gives unavailability and corruption distinct error types', () => {
    const unavailable = new BacklogUnavailableError('github-issues', 'HTTP 403');
    const corrupt = new EpicCorruptError('EPIC-1', 'github-issues', 'status: bad enum');
    expect(unavailable).not.toBeInstanceOf(EpicNotFoundError);
    expect(corrupt).not.toBeInstanceOf(EpicNotFoundError);
    expect(unavailable.name).toBe('BacklogUnavailableError');
    expect(corrupt.name).toBe('EpicCorruptError');
    // The message must point at the workflow, not the epic.
    expect(unavailable.message).toMatch(/unavailable/);
    // And this one must point at the epic, by id.
    expect(corrupt.message).toContain('EPIC-1');
  });
});

/**
 * The gate's exit codes are a contract with branch protection: a required
 * check that cannot distinguish "not approved" from "could not check" would
 * let an outage read as a policy decision. Six distinct values, no aliasing.
 */
describe('gate exit codes', () => {
  it('assigns a distinct code to every outcome', () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
    expect(EXIT.pass).toBe(0);
  });

  it('separates cannot-check from not-approved', () => {
    expect(EXIT.unavailable).not.toBe(EXIT.notApproved);
    expect(EXIT.corrupt).not.toBe(EXIT.notFound);
  });
});
