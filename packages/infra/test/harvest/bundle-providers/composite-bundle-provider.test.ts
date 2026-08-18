import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  CompositeBundleProvider,
} from '../../../src/harvest/bundle-providers/composite-bundle-provider';

function providerThatLists(...refs: BundleRef[]): BundleProvider {
  return {
    async* listBundles(): AsyncIterable<BundleRef> {
      yield* refs;
    },
    readManifest: async (): Promise<BundleManifest> => ({ id: 'test', version: '1.0.0', name: 'Test', items: [] }),
    readFile: async (): Promise<string> => ''
  };
}

describe('CompositeBundleProvider', () => {
  it('continues enumerating healthy sources when one source fails', async () => {
    const errors: { sourceId: string; error: unknown }[] = [];
    const provider = new CompositeBundleProvider([
      {
        sourceId: 'broken',
        provider: {
          async* listBundles(): AsyncIterable<BundleRef> {
            yield* [];
            throw new Error('branch not found');
          },
          readManifest: async (): Promise<BundleManifest> => ({ id: 'broken', version: '1.0.0', name: 'Broken', items: [] }),
          readFile: async (): Promise<string> => ''
        }
      },
      {
        sourceId: 'healthy',
        provider: providerThatLists({
          sourceId: 'healthy',
          sourceType: 'github',
          bundleId: 'healthy-bundle',
          bundleVersion: 'main',
          installed: false
        })
      }
    ], {
      onSourceError: (sourceId, error) => errors.push({ sourceId, error })
    });

    const refs: BundleRef[] = [];
    for await (const ref of provider.listBundles()) {
      refs.push(ref);
    }

    expect(refs).toHaveLength(1);
    expect(refs[0]?.bundleId).toBe('healthy-bundle');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.sourceId).toBe('broken');
    expect(provider.getSourceIds()).toEqual(['broken', 'healthy']);
    expect(provider.getSourceErrors()).toHaveLength(1);
    expect(provider.getSourceErrors()[0]?.sourceId).toBe('broken');
  });
});
