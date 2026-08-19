import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { Epic, EpicStatus } from '../schema/epic.js';
import {
  BacklogUnavailableError,
  EpicCorruptError,
  EpicNotFoundError,
  type BacklogProvider,
} from './provider.js';

const run = promisify(execFile);

/** Fenced block carrying the machine-readable epic state inside an issue body. */
const BLOCK = /```ai-sdlc\r?\n([\s\S]*?)```/;
const STATUS_LABEL = /^status:(.+)$/;

/**
 * Epics as GitHub Issues — the canonical backend.
 *
 * The issue body holds a fenced `ai-sdlc` YAML block with the full artifact;
 * prose around it stays free-form so humans can discuss in place. Status is
 * mirrored onto a `status:<value>` label purely so the GitHub UI can filter —
 * the label is a projection, and the YAML block always wins on read.
 *
 * Shells out to `gh` rather than taking an API-client dependency: the user is
 * already authenticated for the org, and multi-account setups resolve the same
 * way the rest of their tooling does.
 */
export class GitHubIssuesBacklog implements BacklogProvider {
  readonly kind = 'github-issues';

  constructor(
    private readonly repo: string,
    private readonly opts: { epicLabel?: string } = {},
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`repo must be owner/name, got: ${repo}`);
    }
  }

  private get epicLabel(): string {
    return this.opts.epicLabel ?? 'epic';
  }

  /**
   * Runs `gh`, converting process failure into a typed backlog error.
   *
   * Without this, a 403 from a missing `issues: read` scope propagated as a raw
   * execFile error and the CI gate died on a stack trace. Auth and permission
   * problems are reported as unavailability, never as a missing epic: the gate
   * must fail closed *and* say which of the two it hit.
   */
  private async gh(args: string[]): Promise<string> {
    try {
      const { stdout } = await run('gh', args, { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: string };
      const detail = (e.stderr || e.message || String(err)).trim().split('\n')[0] ?? '';
      if (e.code === 'ENOENT') {
        throw new BacklogUnavailableError(this.kind, 'the gh CLI is not installed or not on PATH');
      }
      throw new BacklogUnavailableError(this.kind, detail);
    }
  }

  /**
   * Finds the issue number whose artifact carries `id`.
   *
   * Deliberately does *not* pass `--label`, even though every epic carries one.
   * Label filtering makes this a search query, and GitHub's search index trails
   * the issue store: measured against the live API, an issue created by `save`
   * stayed invisible to a label-filtered list for ~7.7s while the unfiltered
   * list returned it immediately. Read-after-write is the normal shape of this
   * provider's use — save an epic, then approve it — so a lagging lookup meant
   * `get` reporting a just-created epic as nonexistent. The label remains for
   * humans filtering in the GitHub UI; correctness must not depend on it.
   *
   * The cost is decoding non-epic issues, which `decode` already tolerates.
   */
  private async findIssue(id: string): Promise<number | null> {
    const out = await this.gh([
      'issue', 'list',
      '--repo', this.repo,
      '--state', 'all',
      '--limit', '200',
      '--json', 'number,body,title',
    ]);
    const issues = JSON.parse(out) as { number: number; body: string; title: string }[];
    for (const issue of issues) {
      const parsed = this.decode(issue.body);
      if (parsed?.id === id) return issue.number;
    }
    // Nothing decoded to this id. Before concluding it is absent, match on the
    // title `encode` writes, so a corrupted artifact is still *found* and `get`
    // can report corruption. Without this the epic reads as nonexistent, which
    // is the failure mode that sends a reader hunting for a missing epic that
    // is sitting in the backlog with a broken body.
    const titled = issues.find((i) => i.title.startsWith(`[${id}]`));
    return titled?.number ?? null;
  }

  /**
   * Reads the artifact out of an issue body.
   *
   * Returns `absent` when there is no fenced block at all — an issue carrying
   * the epic label that a human opened by hand is not ours to interpret, and
   * scanning must skip it rather than fail.
   *
   * Returns `corrupt` when a block exists but does not yield a valid epic.
   * Both failure paths land here on purpose: `parse` throws on malformed YAML
   * while `safeParse` rejects YAML that is well-formed but not an epic, and a
   * caller that cannot tell those from "no such epic" reports the wrong thing.
   */
  private read(
    body: string | null | undefined,
  ): { kind: 'ok'; epic: Epic } | { kind: 'absent' } | { kind: 'corrupt'; detail: string } {
    const block = body?.match(BLOCK)?.[1];
    if (!block) return { kind: 'absent' };

    let parsed: unknown;
    try {
      parsed = parse(block);
    } catch (err) {
      return { kind: 'corrupt', detail: `invalid YAML (${(err as Error).message.split('\n')[0]})` };
    }

    const result = Epic.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      const where = first?.path.length ? first.path.join('.') : 'artifact';
      return { kind: 'corrupt', detail: `${where}: ${first?.message ?? 'does not match the epic schema'}` };
    }
    return { kind: 'ok', epic: result.data };
  }

  /** Scanning helper: yields the epic, or null for anything unreadable. */
  private decode(body: string | null | undefined): Epic | null {
    const r = this.read(body);
    return r.kind === 'ok' ? r.epic : null;
  }

  /** Renders an issue body: human prose first, machine block last. */
  private encode(epic: Epic): string {
    return [
      `**Status:** ${epic.status}`,
      '',
      '<!-- Managed by ai-sdlc. Edit the block below, or use the CLI. -->',
      '',
      '```ai-sdlc',
      stringify(epic).trimEnd(),
      '```',
    ].join('\n');
  }

  async get(id: string): Promise<Epic | null> {
    const number = await this.findIssue(id);
    if (number === null) return null;
    const out = await this.gh([
      'issue', 'view', String(number),
      '--repo', this.repo,
      '--json', 'body',
    ]);
    const result = this.read((JSON.parse(out) as { body: string }).body);
    // Corruption is raised, not returned as null: the epic is present, and
    // reporting it as absent would hide it from whoever can repair it.
    if (result.kind === 'corrupt') throw new EpicCorruptError(id, this.kind, result.detail);
    return result.kind === 'ok' ? result.epic : null;
  }

  async list(filter?: { status?: EpicStatus }): Promise<Epic[]> {
    const args = [
      'issue', 'list',
      '--repo', this.repo,
      '--label', this.epicLabel,
      '--state', 'all',
      '--limit', '200',
      '--json', 'body',
    ];
    if (filter?.status) args.push('--label', `status:${filter.status}`);

    const epics: Epic[] = [];
    for (const issue of JSON.parse(await this.gh(args)) as { body: string }[]) {
      const epic = this.decode(issue.body);
      // Skip issues carrying the epic label but no valid artifact — they are
      // hand-written and not ours to interpret.
      if (epic && (!filter?.status || epic.status === filter.status)) epics.push(epic);
    }
    return epics;
  }

  async save(epic: Epic): Promise<void> {
    const validated = Epic.parse(epic);
    const number = await this.findIssue(validated.id);
    const body = this.encode(validated);

    if (number === null) {
      await this.gh([
        'issue', 'create',
        '--repo', this.repo,
        '--title', `[${validated.id}] ${validated.title}`,
        '--body', body,
        '--label', this.epicLabel,
        '--label', `status:${validated.status}`,
      ]);
      return;
    }

    await this.gh([
      'issue', 'edit', String(number),
      '--repo', this.repo,
      '--title', `[${validated.id}] ${validated.title}`,
      '--body', body,
    ]);
    await this.syncStatusLabel(number, validated.status);
  }

  /** Drops stale `status:*` labels and applies the current one. */
  private async syncStatusLabel(number: number, status: EpicStatus): Promise<void> {
    const out = await this.gh([
      'issue', 'view', String(number),
      '--repo', this.repo,
      '--json', 'labels',
    ]);
    const labels = (JSON.parse(out) as { labels: { name: string }[] }).labels;
    const stale = labels
      .map((l) => l.name)
      .filter((n) => STATUS_LABEL.test(n) && n !== `status:${status}`);

    const args = ['issue', 'edit', String(number), '--repo', this.repo, '--add-label', `status:${status}`];
    for (const name of stale) args.push('--remove-label', name);
    await this.gh(args);
  }

  async setStatus(
    id: string,
    status: EpicStatus,
    actor?: { by: string; at: string },
  ): Promise<Epic> {
    const epic = await this.get(id);
    if (!epic) throw new EpicNotFoundError(id, this.kind);

    const validated = Epic.parse({
      ...epic,
      status,
      approval:
        status === 'APPROVED'
          ? { approved_by: actor?.by ?? null, approved_at: actor?.at ?? null }
          : epic.approval,
    });
    await this.save(validated);
    return validated;
  }
}
