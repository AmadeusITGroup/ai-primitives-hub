import * as assert from 'node:assert';
import {
  createResourceTransformerPipeline,
} from '../../src/services/resource-transformer';
import type {
  Resource,
  ResourceTransformer,
  Target,
} from '../../src/types/target';

suite('ResourceTransformer', () => {
  const target: Target = {
    type: 'vscode',
    scope: 'repository'
  };

  const resource: Resource = {
    kind: 'prompt',
    id: 'review',
    sourcePath: 'prompts/review.prompt.md',
    content: '# Review\n'
  };

  test('returns deterministic output for the same resource and target', async () => {
    const transformer: ResourceTransformer = {
      transform: (input) => Promise.resolve({
        resource: {
          ...input,
          content: `${input.content ?? ''}\n<!-- target:vscode -->\n`
        },
        diagnostics: []
      })
    };
    const pipeline = createResourceTransformerPipeline({ transformers: [transformer] });

    const first = await pipeline.transform(resource, target);
    const second = await pipeline.transform(resource, target);

    assert.deepStrictEqual(first, second);
  });

  test('does not duplicate transformations when the same pipeline is applied again', async () => {
    const markerTransformer: ResourceTransformer = {
      transform: (input) => Promise.resolve({
        resource: {
          ...input,
          content: input.content?.includes('<!-- migrated -->')
            ? input.content
            : `${input.content ?? ''}\n<!-- migrated -->\n`
        },
        diagnostics: []
      })
    };
    const pipeline = createResourceTransformerPipeline({ transformers: [markerTransformer] });

    const first = await pipeline.transform(resource, target);
    const second = await pipeline.transform(first.resource, target);

    assert.deepStrictEqual(second.resource, first.resource);
    assert.deepStrictEqual(second.diagnostics, []);
  });

  test('returns the original resource with diagnostics when a transformer fails', async () => {
    const failingTransformer: ResourceTransformer = {
      transform: () => Promise.reject(new Error('API_TOKEN=secret-value failed to transform'))
    };
    const pipeline = createResourceTransformerPipeline({ transformers: [failingTransformer] });

    const result = await pipeline.transform(resource, target);

    assert.deepStrictEqual(result.resource, resource);
    assert.deepStrictEqual(result.diagnostics, [
      {
        severity: 'error',
        message: '[REDACTED] failed to transform',
        resourceId: 'review'
      }
    ]);
  });
});
