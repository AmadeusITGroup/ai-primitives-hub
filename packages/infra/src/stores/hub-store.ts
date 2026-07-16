/**
 * HubStore.
 *
 * Persists hub configs + reference metadata as one YAML + a sidecar
 * JSON per hub. Faithfully mirrors the extension's `HubStorage`
 * on-disk layout (`<id>.yml`, `<id>.meta.json`, plus cleanup of
 * `profile-activations/<id>_*.json` on removal) so the extension can
 * delegate to this store with zero migration of existing user data.
 *
 * Deliberately stateless (no in-memory cache) — the extension's
 * `HubStorage` facade layers its own cache on top for fidelity with
 * pre-existing behavior; a fresh CLI process gains nothing from an
 * in-memory cache anyway.
 * @module stores/hub-store
 */
import * as path from 'node:path';
import {
  type FileSystem,
  type HubConfig,
  type HubReference,
  sanitizeHubId,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';

/**
 * Sidecar metadata stored next to each hub-config YAML.
 */
export interface HubStoreMetadata {
  reference: HubReference;
  /** ISO-8601 timestamp of last write. */
  lastModified: string;
  size: number;
}

export interface LoadHubResult {
  config: HubConfig;
  reference: HubReference;
}

/**
 * Filesystem-backed hub store. Stateless except for the injected `fs`.
 */
export class HubStore {
  /**
   * Construct an instance bound to `dir`.
   * @param dir Resolved path of the hubs directory.
   * @param fs Filesystem abstraction.
   */
  public constructor(
    private readonly dir: string,
    private readonly fs: FileSystem
  ) {}

  private configPath(id: string): string {
    return path.join(this.dir, `${id}.yml`);
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.meta.json`);
  }

  /**
   * Persist a hub config + its reference. Replaces any existing
   * entry with the same id.
   * @param id Hub id (validated, not normalized — see `sanitizeHubId`).
   * @param config HubConfig to write.
   * @param reference HubReference for the sidecar.
   */
  public async save(id: string, config: HubConfig, reference: HubReference): Promise<void> {
    sanitizeHubId(id);
    try {
      await this.fs.mkdir(this.dir, { recursive: true });
      const yamlText = yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
      await this.fs.writeFile(this.configPath(id), yamlText);
      const meta: HubStoreMetadata = {
        reference,
        lastModified: new Date().toISOString(),
        size: Buffer.byteLength(yamlText, 'utf8')
      };
      await this.fs.writeJson(this.metaPath(id), meta);
    } catch (error) {
      throw new Error(`Failed to save hub '${id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load a hub by id. Throws on missing or malformed entries.
   * @param id Hub id.
   * @returns Loaded hub config + reference.
   */
  public async load(id: string): Promise<LoadHubResult> {
    sanitizeHubId(id);
    if (!(await this.fs.exists(this.configPath(id)))) {
      throw new Error(`Hub not found: ${id}`);
    }
    try {
      const configText = await this.fs.readFile(this.configPath(id));
      const config = yaml.load(configText) as HubConfig;

      let reference: HubReference;
      if (await this.fs.exists(this.metaPath(id))) {
        const meta = await this.fs.readJson<HubStoreMetadata>(this.metaPath(id));
        reference = meta.reference;
      } else {
        reference = { type: 'local', location: this.configPath(id) };
      }
      return { config, reference };
    } catch (error) {
      throw new Error(`Failed to load hub '${id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Remove a hub + its sidecar + any recorded profile-activation
   * state files for it.
   * @param id Hub id.
   */
  public async remove(id: string): Promise<void> {
    sanitizeHubId(id);
    if (!(await this.fs.exists(this.configPath(id)))) {
      throw new Error(`Hub not found: ${id}`);
    }
    try {
      await this.fs.remove(this.configPath(id));
      if (await this.fs.exists(this.metaPath(id))) {
        await this.fs.remove(this.metaPath(id));
      }

      const activationsDir = path.join(this.dir, 'profile-activations');
      if (await this.fs.exists(activationsDir)) {
        const files = await this.fs.readDir(activationsDir);
        for (const file of files) {
          if (file.startsWith(`${id}_`) && file.endsWith('.json')) {
            await this.fs.remove(path.join(activationsDir, file));
          }
        }
      }
    } catch (error) {
      throw new Error(`Failed to delete hub '${id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List every saved hub id (filename-derived).
   * @returns Hub ids, in filesystem-listing order.
   */
  public async list(): Promise<string[]> {
    if (!(await this.fs.exists(this.dir))) {
      return [];
    }
    const entries = await this.fs.readDir(this.dir);
    return entries
      .filter((e) => e.endsWith('.yml'))
      .map((e) => e.slice(0, -'.yml'.length));
  }

  /**
   * Get a hub's sidecar metadata without loading the full config.
   * @param id Hub id.
   * @returns Sidecar metadata.
   */
  public async getMetadata(id: string): Promise<HubStoreMetadata> {
    sanitizeHubId(id);
    if (!(await this.fs.exists(this.metaPath(id)))) {
      throw new Error(`Hub not found: ${id}`);
    }
    try {
      return await this.fs.readJson<HubStoreMetadata>(this.metaPath(id));
    } catch (error) {
      throw new Error(`Failed to get metadata for hub '${id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check whether a hub exists.
   * @param id Hub id.
   * @returns true iff the hub config is on disk.
   */
  public async has(id: string): Promise<boolean> {
    try {
      sanitizeHubId(id);
    } catch {
      return false;
    }
    return this.fs.exists(this.configPath(id));
  }
}
