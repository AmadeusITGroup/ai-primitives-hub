/**
 * HubStore.
 *
 * Persists hub configs + reference metadata under the user-config
 * dir resolved by `UserConfigPaths.hubs`. One YAML per hub plus a
 * sidecar JSON for reference metadata. Mirrors the extension's
 * `HubStorage` shape (modulo the storage location).
 */
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  type HubConfig,
  type HubReference,
  isHubConfig,
  sanitizeHubId,
} from '@prompt-registry/core';
import type {
  FileSystem,
} from '@prompt-registry/core';

/**
 * Sidecar metadata stored next to each hub-config YAML.
 * Contains reference metadata and last modified timestamp.
 */
export interface HubMetaSidecar {
  reference: HubReference;
  /** ISO-8601 timestamp of last write. */
  lastModified: string;
  size: number;
}

export interface SavedHub {
  id: string;
  config: HubConfig;
  reference: HubReference;
}

/**
 * Filesystem-backed hub store.
 * Persists hub configs + reference metadata under the user-config dir.
 * Stateless except for the injected `fs`.
 */
export class HubStore {
  /**
   * Construct an instance bound to `hubsDir`.
   * @param hubsDir Resolved path of the hubs directory.
   * @param fs Filesystem abstraction (typically `ctx.fs`).
   */
  public constructor(
    private readonly hubsDir: string,
    private readonly fs: FileSystem
  ) {}

  private metaPath(safeId: string): string {
    return path.join(this.hubsDir, `${safeId}.meta.json`);
  }

  public configPath(safeId: string): string {
    return path.join(this.hubsDir, `${safeId}.yml`);
  }

  /**
   * Persist a hub config + its reference. Replaces any existing
   * entry with the same id.
   * @param id Hub id (will be sanitized).
   * @param config HubConfig to write.
   * @param reference HubReference for the sidecar.
   * @returns The sanitized id used on disk.
   */
  public async save(id: string, config: HubConfig, reference: HubReference): Promise<string> {
    const safeId = sanitizeHubId(id);
    await this.fs.mkdir(this.hubsDir, { recursive: true });
    const yamlText = yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
    await this.fs.writeFile(this.configPath(safeId), yamlText);
    const meta: HubMetaSidecar = {
      reference,
      lastModified: new Date().toISOString(),
      size: Buffer.byteLength(yamlText, 'utf8')
    };
    await this.fs.writeJson(this.metaPath(safeId), meta);
    return safeId;
  }

  /**
   * Load a hub by id. Throws on missing or malformed entries.
   * @param id Hub id.
   * @returns Saved hub.
   */
  public async load(id: string): Promise<SavedHub> {
    const safeId = sanitizeHubId(id);
    const cfgPath = this.configPath(safeId);
    if (!(await this.fs.exists(cfgPath))) {
      throw new Error(`Hub not found: ${safeId}`);
    }
    const cfgText = await this.fs.readFile(cfgPath);
    const parsed = yaml.load(cfgText);
    if (!isHubConfig(parsed)) {
      throw new Error(`Hub config is malformed: ${safeId}`);
    }
    let reference: HubReference;
    if (await this.fs.exists(this.metaPath(safeId))) {
      const meta = await this.fs.readJson<HubMetaSidecar>(this.metaPath(safeId));
      reference = meta.reference;
    } else {
      reference = { type: 'local', location: cfgPath };
    }
    return { id: safeId, config: parsed, reference };
  }

  /**
   * List every saved hub id (filename-derived).
   * @returns Sorted list of hub ids.
   */
  public async list(): Promise<string[]> {
    if (!(await this.fs.exists(this.hubsDir))) {
      return [];
    }
    const entries = await this.fs.readDir(this.hubsDir);
    return entries
      .filter((e) => typeof e === 'string' && e.endsWith('.yml'))
      .map((e) => e.slice(0, -'.yml'.length))
      .toSorted((a, b) => a.localeCompare(b));
  }

  /**
   * Remove a hub + its sidecar.
   * @param id Hub id.
   */
  public async remove(id: string): Promise<void> {
    const safeId = sanitizeHubId(id);
    const cfg = this.configPath(safeId);
    const meta = this.metaPath(safeId);
    if (await this.fs.exists(cfg)) {
      await this.fs.remove(cfg);
    }
    if (await this.fs.exists(meta)) {
      await this.fs.remove(meta);
    }
  }

  /**
   * Check whether a hub exists.
   * @param id Hub id.
   * @returns true iff the hub config is on disk.
   */
  public async has(id: string): Promise<boolean> {
    return this.fs.exists(this.configPath(sanitizeHubId(id)));
  }
}
