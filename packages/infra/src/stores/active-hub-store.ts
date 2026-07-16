/**
 * ActiveHubStore.
 *
 * Persists "which hub is active right now" as a tiny JSON pointer.
 * Singleton across all hubs (the profile-activation invariant builds
 * on top of the active-hub invariant). Existence validation of the
 * target hub id is deliberately **not** done here — that's the
 * caller's job (mirrors the extension's `HubStorage.setActiveHubId`,
 * which validates against its own `listHubs()` before delegating).
 * @module stores/active-hub-store
 */
import type {
  FileSystem,
} from '@ai-primitives-hub/core';

interface ActiveHubFile {
  hubId: string | null;
  setAt: string;
}

/**
 * Filesystem-backed active-hub pointer.
 */
export class ActiveHubStore {
  /**
   * Construct an ActiveHubStore instance.
   * @param activeHubPath Resolved path of the active-hub pointer file.
   * @param fs Filesystem abstraction.
   */
  public constructor(
    private readonly activeHubPath: string,
    private readonly fs: FileSystem
  ) {}

  /**
   * Get the active hub id, if any.
   * @returns Active hub id or null.
   */
  public async get(): Promise<string | null> {
    if (!(await this.fs.exists(this.activeHubPath))) {
      return null;
    }
    try {
      const data = await this.fs.readJson<ActiveHubFile>(this.activeHubPath);
      return data.hubId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set the active hub id, or clear it with `null`.
   * @param hubId Hub id (already validated by the caller) or null.
   */
  public async set(hubId: string | null): Promise<void> {
    if (hubId === null) {
      if (await this.fs.exists(this.activeHubPath)) {
        await this.fs.remove(this.activeHubPath);
      }
      return;
    }
    await this.fs.writeJson(this.activeHubPath, {
      hubId,
      setAt: new Date().toISOString()
    });
  }
}
