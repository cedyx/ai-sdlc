import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { Epic, type EpicStatus } from '../schema/epic.js';
import { EpicNotFoundError, type BacklogProvider } from './provider.js';

/**
 * Epics as YAML files in a directory — one file per epic, `<id>.yaml`.
 *
 * The fallback provider: no network, no auth, diffable in the repo. Suited to
 * single-owner projects where the backlog and the code share a review flow.
 */
export class FilesystemBacklog implements BacklogProvider {
  readonly kind = 'filesystem';

  constructor(private readonly dir: string) {}

  private path(id: string): string {
    // Ids are validated on parse, but this is a filesystem write — refuse
    // anything that could escape the backlog directory.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`unsafe epic id for filesystem backlog: ${id}`);
    }
    return join(this.dir, `${id}.yaml`);
  }

  async get(id: string): Promise<Epic | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return Epic.parse(parse(raw));
  }

  async list(filter?: { status?: EpicStatus }): Promise<Epic[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const epics: Epic[] = [];
    for (const name of names.filter((n) => n.endsWith('.yaml')).sort()) {
      const raw = await readFile(join(this.dir, name), 'utf8');
      epics.push(Epic.parse(parse(raw)));
    }
    return filter?.status ? epics.filter((e) => e.status === filter.status) : epics;
  }

  async save(epic: Epic): Promise<void> {
    const validated = Epic.parse(epic);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(validated.id), stringify(validated), 'utf8');
  }

  async setStatus(
    id: string,
    status: EpicStatus,
    actor?: { by: string; at: string },
  ): Promise<Epic> {
    const epic = await this.get(id);
    if (!epic) throw new EpicNotFoundError(id, this.kind);

    const next: Epic = {
      ...epic,
      status,
      approval:
        status === 'APPROVED'
          ? { approved_by: actor?.by ?? null, approved_at: actor?.at ?? null }
          : epic.approval,
    };

    // Re-parse so the APPROVED-requires-approver invariant is enforced here
    // too, not only at the call site.
    const validated = Epic.parse(next);
    await this.save(validated);
    return validated;
  }
}
