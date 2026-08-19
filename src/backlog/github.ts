import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { Epic, EpicStatus } from '../schema/epic.js';
import { EpicNotFoundError, type BacklogProvider } from './provider.js';

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

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await run('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  }

  /** Finds the issue number whose artifact carries `id`. */
  private async findIssue(id: string): Promise<number | null> {
    const out = await this.gh([
      'issue', 'list',
      '--repo', this.repo,
      '--label', this.epicLabel,
      '--state', 'all',
      '--limit', '200',
      '--json', 'number,body',
    ]);
    for (const issue of JSON.parse(out) as { number: number; body: string }[]) {
      const parsed = this.decode(issue.body);
      if (parsed?.id === id) return issue.number;
    }
    return null;
  }

  /** Extracts the artifact from an issue body, or null when absent/invalid. */
  private decode(body: string | null | undefined): Epic | null {
    const match = body?.match(BLOCK);
    const block = match?.[1];
    if (!block) return null;
    const result = Epic.safeParse(parse(block));
    return result.success ? result.data : null;
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
    return this.decode((JSON.parse(out) as { body: string }).body);
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
