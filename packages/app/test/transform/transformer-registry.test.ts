/**
 * Unit tests for TransformerRegistry.
 *
 * Ported from the reference branch's
 * `app/test/transform/transformer-registry.test.ts`; extended with
 * coverage for `withBuiltIns()`'s additional `windsurf`/`claude-code`
 * registrations (real transformers, not the reference's kiro-only set
 * — see `transformer-registry.ts`'s own module header).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  TransformerRegistry,
} from '../../src/transform/transformer-registry';
import {
  ClaudeCodeTransformer,
} from '../../src/transform/transformers/claude-code-transformer';
import {
  KiroTransformer,
} from '../../src/transform/transformers/kiro-transformer';
import {
  NoOpTransformer,
} from '../../src/transform/transformers/noop-transformer';
import {
  WindsurfTransformer,
} from '../../src/transform/transformers/windsurf-transformer';

describe('TransformerRegistry', () => {
  it('should return NoOpTransformer for unknown target type', () => {
    const registry = new TransformerRegistry();
    const transformer = registry.getTransformer('vscode');
    expect(transformer).toBeInstanceOf(NoOpTransformer);
  });

  it('should return registered transformer for known target type', () => {
    const customTransformer = new NoOpTransformer();
    const registry = new TransformerRegistry({ vscode: customTransformer });
    const transformer = registry.getTransformer('vscode');
    expect(transformer).toBe(customTransformer);
  });

  it('should allow registering transformers', () => {
    const registry = new TransformerRegistry();
    const customTransformer = new NoOpTransformer();
    registry.register('windsurf', customTransformer);
    const transformer = registry.getTransformer('windsurf');
    expect(transformer).toBe(customTransformer);
  });

  it('should create registry with built-in transformers', () => {
    const registry = TransformerRegistry.withBuiltIns();
    const kiroTransformer = registry.getTransformer('kiro');
    expect(kiroTransformer).toBeInstanceOf(KiroTransformer);
  });

  it('should register a real WindsurfTransformer as a built-in', () => {
    const registry = TransformerRegistry.withBuiltIns();
    const transformer = registry.getTransformer('windsurf');
    expect(transformer).toBeInstanceOf(WindsurfTransformer);
  });

  it('should register a real ClaudeCodeTransformer as a built-in', () => {
    const registry = TransformerRegistry.withBuiltIns();
    const transformer = registry.getTransformer('claude-code');
    expect(transformer).toBeInstanceOf(ClaudeCodeTransformer);
  });

  it('should register a WindsurfTransformer for both devin targets', () => {
    const registry = TransformerRegistry.withBuiltIns();
    expect(registry.getTransformer('devin')).toBeInstanceOf(WindsurfTransformer);
    expect(registry.getTransformer('devin-cli')).toBeInstanceOf(WindsurfTransformer);
  });

  it('should turn Copilot applyTo into a Devin glob rule', () => {
    const registry = TransformerRegistry.withBuiltIns();
    for (const target of ['devin', 'devin-cli'] as const) {
      const result = registry.getTransformer(target).transform({
        filePath: 'instructions/typescript.instructions.md',
        content: '---\napplyTo: "**/*.ts"\n---\nUse strict mode.\n',
        target: { name: 'devin', type: target, scope: 'repository', rootPath: '/ws' }
      });
      expect(result.content).toMatch(/^trigger: "?glob"?$/m);
      expect(result.content).toContain('**/*.ts');
    }
  });

  it('should leave devin prompts untouched (Desktop workflows) but make them rules on devin-cli', () => {
    const registry = TransformerRegistry.withBuiltIns();
    const context = { filePath: 'prompts/review.prompt.md', content: '---\ndescription: Review code\n---\nReview.\n' };
    const target = (type: 'devin' | 'devin-cli') => ({ name: type, type, scope: 'repository' as const, rootPath: '/ws' });
    expect(registry.getTransformer('devin').transform({ ...context, target: target('devin') }).content).toBe(context.content);
    expect(registry.getTransformer('devin-cli').transform({ ...context, target: target('devin-cli') }).content)
      .toMatch(/^trigger: "?model_decision"?$/m);
  });

  it('should return NoOpTransformer for unregistered built-in target', () => {
    const registry = TransformerRegistry.withBuiltIns();
    const transformer = registry.getTransformer('vscode');
    expect(transformer).toBeInstanceOf(NoOpTransformer);
  });
});
