import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Epic, isImplementable } from '../schema/epic.js';
import { FilesystemBacklog } from '../backlog/filesystem.js';
import { EpicNotFoundError } from '../backlog/provider.js';

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
