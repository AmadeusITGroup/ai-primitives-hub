/**
 * ProfileActivationStore.
 *
 * Persists `ProfileActivationState` per (hubId, profileId) under
 * `<userConfig>/profile-activations/`. The store enforces
 * (single-active-profile-globally) at the API level: there is no
 * `setMany` and `get()` returns the single active state if any.
 */
import * as path from 'node:path';
import {
  type ProfileActivationState,
} from '@prompt-registry/core';
import type {
  FileSystem,
} from '@prompt-registry/core';

/**
 * Filesystem-backed profile-activation store. Lives at
 * `<userConfig>/profile-activations/{hubId}_{profileId}.json`.
 */
export class ProfileActivationStore {
  /**
   * Construct a ProfileActivationStore instance.
   * @param dir Resolved path of the activations directory.
   * @param fs Filesystem abstraction.
   */
  public constructor(
    private readonly dir: string,
    private readonly fs: FileSystem
  ) {}

  private statePath(hubId: string, profileId: string): string {
    return path.join(this.dir, `${hubId}_${profileId}.json`);
  }

  /**
   * Persist an activation state. Caller is expected to have
   * cleared any previously-active profile first.
   * @param state Activation state.
   */
  public async save(state: ProfileActivationState): Promise<void> {
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.fs.writeJson(this.statePath(state.hubId, state.profileId), state);
  }

  /**
   * Read an activation state.
   * @param hubId Hub id.
   * @param profileId Profile id.
   * @returns State or null when no activation file exists.
   * @throws {Error} If schema version is unsupported.
   */
  public async load(hubId: string, profileId: string): Promise<ProfileActivationState | null> {
    const p = this.statePath(hubId, profileId);
    if (!(await this.fs.exists(p))) {
      return null;
    }
    const state = await this.fs.readJson<ProfileActivationState>(p);
    // Validate schema version
    if (state.schemaVersion !== 1) {
      throw new Error(
        `Unsupported profile activation schema version: ${String(state.schemaVersion)}. Expected version 1.`
      );
    }
    return state;
  }

  /**
   * Delete an activation state. No-op when missing.
   * @param hubId Hub id.
   * @param profileId Profile id.
   * @throws {Error} If deletion fails.
   */
  public async remove(hubId: string, profileId: string): Promise<void> {
    const p = this.statePath(hubId, profileId);
    if (await this.fs.exists(p)) {
      await this.fs.remove(p);
    }
  }

  /**
   * Get the single active profile across all hubs.
   * Throws if more than one activation file is present (corrupt
   * state); callers may catch and remediate.
   * @returns The active state or null.
   * @throws {Error} If schema version is unsupported.
   */
  public async getActive(): Promise<ProfileActivationState | null> {
    if (!(await this.fs.exists(this.dir))) {
      return null;
    }
    const files = (await this.fs.readDir(this.dir)).filter((f) => f.endsWith('.json'));
    if (files.length === 0) {
      return null;
    }
    if (files.length > 1) {
      throw new Error(
        `D21 violation: ${String(files.length)} active profiles on disk, expected at most 1: ${files.join(', ')}`
      );
    }
    const state = await this.fs.readJson<ProfileActivationState>(path.join(this.dir, files[0]));
    // Validate schema version
    if (state.schemaVersion !== 1) {
      throw new Error(
        `Unsupported profile activation schema version: ${String(state.schemaVersion)}. Expected version 1.`
      );
    }
    return state;
  }

  /**
   * List all activation states.
   * @returns Array of activation states.
   * @throws {Error} If listing fails.
   */
  public async listAll(): Promise<ProfileActivationState[]> {
    if (!(await this.fs.exists(this.dir))) {
      return [];
    }
    const files = (await this.fs.readDir(this.dir)).filter((f) => f.endsWith('.json'));
    const out: ProfileActivationState[] = [];
    for (const f of files) {
      const state = await this.fs.readJson<ProfileActivationState>(path.join(this.dir, f));
      // Validate schema version
      if (state.schemaVersion !== 1) {
        throw new Error(
          `Unsupported profile activation schema version: ${String(state.schemaVersion)}. Expected version 1.`
        );
      }
      out.push(state);
    }
    return out;
  }
}
