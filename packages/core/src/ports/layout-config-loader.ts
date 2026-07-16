/**
 * LayoutConfigLoader port — abstract interface for loading target layout
 * configuration layers.
 *
 * The concrete implementation in `infra/stores/layout-config-store.ts`
 * reads from the filesystem hierarchy (built-in → user → project).
 * Tests inject a stub that returns a fixed set of layers.
 * @module ports/layout-config-loader
 */
import type {
  TargetLayoutsConfig,
} from '../domain/install/layout';

/**
 * Loads the ordered list of layout configuration layers.
 *
 * Layers are returned from least-specific to most-specific:
 * `[built-in, user, project]`. The resolver merges them in order so
 * later layers take precedence.
 *
 * Implementations must always include at least the built-in layer.
 */
export interface LayoutConfigLoader {
  /**
   * Load and return all available layout config layers.
   * @returns Ordered array of configs — at minimum `[builtIn]`.
   */
  load(): Promise<TargetLayoutsConfig[]>;
}
