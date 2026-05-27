/**
 * TargetStateStore.
 *
 * Persists the last-used target configuration for CLI interactions.
 * Enables:
 * - Subsequent CLI interactions without re-specifying --target
 * - Desired-vs-actual state comparison (prompt-registry status command)
 *
 * State is persisted at:
 * - Per-project: <project>/.prompt-registry/target-state.json
 * - User-level: <XDG_CONFIG_HOME>/prompt-registry/target-state.json (optional)
 */

import type {
  FileSystem,
} from '@prompt-registry/core';

/**
 * State for a single target's last installation.
 */
export interface TargetState {
  /** Target name. */
  targetName: string;
  /** Last installed bundles with their versions and timestamps. */
  lastInstalledBundles: {
    bundleId: string;
    version: string;
    installedAt: string;
  }[];
  /** Timestamp of last use. */
  lastUsedAt: string;
}

/**
 * All target states persisted in the state file.
 */
export interface TargetStateData {
  /** Map of target name to state. */
  targets: Record<string, TargetState>;
}

/**
 * Options for TargetStateStore.
 */
export interface TargetStateStoreOptions {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Path to the state file (per-project or user-level). */
  statePath: string;
}

/**
 * Store for persisting and loading target state.
 */
export class TargetStateStore {
  private readonly fs: FileSystem;
  private readonly statePath: string;

  public constructor(opts: TargetStateStoreOptions) {
    this.fs = opts.fs;
    this.statePath = opts.statePath;
  }

  /**
   * Save state for a target.
   * @param state - Target state to save.
   */
  public async save(state: TargetState): Promise<void> {
    let data: TargetStateData = { targets: {} };

    // Read existing data if file exists
    try {
      const content = await this.fs.readFile(this.statePath);
      data = JSON.parse(content) as TargetStateData;
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Update the target state
    data.targets[state.targetName] = state;

    // Write back
    const dir = this.statePath.split('/').slice(0, -1).join('/');
    await this.fs.mkdir(dir, { recursive: true });
    await this.fs.writeJson(this.statePath, data);
  }

  /**
   * Load state for a specific target.
   * @param targetName - Target name.
   * @returns Target state or null if not found.
   */
  public async load(targetName: string): Promise<TargetState | null> {
    try {
      const content = await this.fs.readFile(this.statePath);
      const data = JSON.parse(content) as TargetStateData;
      return data.targets[targetName] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Load all target states.
   * @returns All target states or empty object if file doesn't exist.
   */
  public async loadAll(): Promise<TargetStateData> {
    try {
      const content = await this.fs.readFile(this.statePath);
      return JSON.parse(content) as TargetStateData;
    } catch {
      return { targets: {} };
    }
  }

  /**
   * Remove state for a target.
   * @param targetName - Target name.
   */
  public async remove(targetName: string): Promise<void> {
    try {
      const content = await this.fs.readFile(this.statePath);
      const data = JSON.parse(content) as TargetStateData;
      delete data.targets[targetName];
      await this.fs.writeJson(this.statePath, data);
    } catch {
      // File doesn't exist, nothing to remove
    }
  }

  /**
   * Get the most recently used target.
   * @returns Target name of most recently used target, or null if no state.
   */
  public async getLastUsedTarget(): Promise<string | null> {
    const data = await this.loadAll();
    const entries = Object.entries(data.targets);
    if (entries.length === 0) {
      return null;
    }

    // Sort by lastUsedAt descending and return the first
    const sorted = entries.toSorted(([, a], [, b]) =>
      new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
    );
    return sorted[0][0];
  }
}
