/** Authoritative collection registrations; never scans source repositories. */
import * as path from 'node:path';
import {
  type ArgvProcessRunner,
  type FileSystem,
  type HubCollectionIndex,
  type HubCollectionInventory,
  validateCollectionId,
} from '@ai-primitives-hub/core';
import {
  parseHubConfigYaml,
} from '../hub/validate-hub-config';
import {
  parseHubScopeDocument,
  readGitBlob,
} from './git-hub-scope';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read the config and index from the same exact commit, or an explicitly supplied trusted checkout. */
export class FileCollectionIndex implements HubCollectionIndex {
  public constructor(
    private readonly fs: FileSystem,
    private readonly configPath: string,
    private readonly revision?: { repoRoot: string; commit: string; runner: ArgvProcessRunner }
  ) {}

  private async readFile(file: string): Promise<string> {
    if (!this.revision) {
      return this.fs.readFile(file);
    }
    const relative = path.relative(this.revision.repoRoot, file).split(path.sep).join('/');
    const content = await readGitBlob(this.revision.runner, this.revision.repoRoot, this.revision.commit, relative);
    if (content === undefined) {
      throw new Error('Required registry blob is missing.');
    }
    return content;
  }

  public async read(): Promise<HubCollectionInventory> {
    let hub;
    let document: unknown;
    try {
      hub = parseHubScopeDocument(await this.readFile(this.configPath));
      // js-yaml's default mode rejects duplicate mapping keys; do not enable json mode.
      document = parseHubConfigYaml(await this.readFile(path.join(path.dirname(this.configPath), 'collection-index.yml')));
    } catch {
      throw new Error('Cannot read hub config and collection-index.yml. Supply both at the same trusted revision and fix invalid YAML or duplicate keys; no source-scan fallback is allowed.');
    }
    if (!isRecord(document) || document.schemaVersion !== 1 || !isRecord(document.collections)
      || Object.keys(document).some((key) => !['schemaVersion', 'collections'].includes(key))) {
      throw new Error('collection-index.yml requires numeric schemaVersion: 1 and a collections mapping only.');
    }
    const sourceIds = new Set(hub.sources.map((source) => source.id));
    const owners = new Map<string, string>();
    for (const [id, entry] of Object.entries(document.collections)) {
      if (!validateCollectionId(id).valid || !isRecord(entry) || typeof entry.sourceId !== 'string'
        || Object.keys(entry).length !== 1 || !sourceIds.has(entry.sourceId)) {
        throw new Error('Invalid collection-index.yml registration: use canonical collection IDs and { sourceId } entries referencing a configured hub source.');
      }
      owners.set(id, entry.sourceId);
    }
    const sources = new Map(hub.sources.filter((source) => source.enabled === true)
      .map((source) => [source.id, typeof source.url === 'string'
        ? source.url
        : (typeof source.repository === 'string' ? `https://github.com/${source.repository}` : '')]));
    return { collections: [], registry: { owners, sources }, unverifiedSources: [] };
  }
}
