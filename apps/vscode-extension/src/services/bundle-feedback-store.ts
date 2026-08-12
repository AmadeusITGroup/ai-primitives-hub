/** Private, device-local bundle ratings backed by VS Code global state. */
import type * as vscode from 'vscode';

const STORAGE_KEY = 'promptRegistry.bundleRatings.v1';

export type BundleRating = 1 | 2 | 3 | 4 | 5;

export class BundleFeedbackStore {
  public constructor(private readonly state: vscode.Memento | undefined) {}

  public get(bundleId: string): BundleRating | undefined {
    return this.state?.get<Record<string, BundleRating>>(STORAGE_KEY, {})[bundleId];
  }

  public getAll(): Record<string, BundleRating> {
    return { ...this.state?.get<Record<string, BundleRating>>(STORAGE_KEY, {}) };
  }

  public async set(bundleId: string, rating: number): Promise<void> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new RangeError('Rating must be an integer from 1 to 5');
    }
    if (this.state === undefined) {
      return;
    }
    const ratings = this.getAll();
    ratings[bundleId] = rating as BundleRating;
    await this.state.update(STORAGE_KEY, ratings);
  }
}
