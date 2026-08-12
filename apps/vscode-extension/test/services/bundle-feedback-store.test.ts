import * as assert from 'node:assert';
import type * as vscode from 'vscode';
import {
  BundleFeedbackStore,
} from '../../src/services/bundle-feedback-store';

suite('BundleFeedbackStore', () => {
  test('persists a private rating by bundle id', async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: <T>(key: string, fallback?: T): T => (values.get(key) as T | undefined) ?? fallback as T,
      update: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
      keys: (): readonly string[] => [...values.keys()]
    } as vscode.Memento;
    const store = new BundleFeedbackStore(state);

    await store.set('review-kit', 4);

    assert.strictEqual(store.get('review-kit'), 4);
    assert.deepStrictEqual(store.getAll(), { 'review-kit': 4 });
  });

  test('rejects ratings outside the five-star scale', async () => {
    const store = new BundleFeedbackStore(undefined);
    await assert.rejects(store.set('review-kit', 6), /1 to 5/);
  });
});
