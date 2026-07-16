/**
 * TransformerRegistry — maintains target-specific ResourceTransformers.
 *
 * Application layer: pure registry logic, no IO.
 * Concrete transformer implementations live in transformers/ subdirectory.
 *
 * The registry provides a single point to look up transformers by
 * target type. Unknown target types fall back to NoOpTransformer.
 *
 * Ported from the reference branch's
 * `app/src/transform/transformer-registry.ts`; `withBuiltIns()` is
 * extended beyond the reference to also register `WindsurfTransformer`
 * and `ClaudeCodeTransformer` (real implementations — see those
 * modules' own headers — the reference itself only ever registered
 * `kiro`, per migration plan §8 decision 5's "actually implement it,
 * not just model it" scope for these two targets).
 * @module transform/transformer-registry
 */
import type {
  ResourceTransformer,
  TargetType,
} from '@ai-primitives-hub/core';
import {
  ClaudeCodeTransformer,
} from './transformers/claude-code-transformer';
import {
  KiroTransformer,
} from './transformers/kiro-transformer';
import {
  NoOpTransformer,
} from './transformers/noop-transformer';
import {
  WindsurfTransformer,
} from './transformers/windsurf-transformer';

/**
 * Registry of target-specific transformers.
 * Maps target type identifiers to transformer implementations.
 */
export class TransformerRegistry {
  private readonly transformers: Map<TargetType, ResourceTransformer>;

  /**
   * Create a TransformerRegistry.
   * @param transformers - Map of target type to transformer implementation.
   */
  public constructor(transformers: Partial<Record<TargetType, ResourceTransformer>> = {}) {
    this.transformers = new Map(Object.entries(transformers) as [TargetType, ResourceTransformer][]);
  }

  /**
   * Get a transformer for the given target type.
   * Returns NoOpTransformer for unknown target types (fail-safe).
   * @param targetType - Target type identifier.
   * @returns ResourceTransformer instance.
   */
  public getTransformer(targetType: TargetType): ResourceTransformer {
    return this.transformers.get(targetType) ?? new NoOpTransformer();
  }

  /**
   * Register a transformer for a target type.
   * @param targetType - Target type identifier.
   * @param transformer - Transformer implementation.
   */
  public register(targetType: TargetType, transformer: ResourceTransformer): void {
    this.transformers.set(targetType, transformer);
  }

  /**
   * Create a registry with built-in transformers.
   * This factory method initializes the registry with all
   * known target-specific transformers.
   * @returns TransformerRegistry with built-in transformers.
   */
  public static withBuiltIns(): TransformerRegistry {
    const registry = new TransformerRegistry();
    registry.register('kiro', new KiroTransformer());
    registry.register('windsurf', new WindsurfTransformer());
    registry.register('claude-code', new ClaudeCodeTransformer());
    return registry;
  }
}
