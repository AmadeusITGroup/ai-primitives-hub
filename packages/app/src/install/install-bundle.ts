/**
 * InstallBundleUseCase — application-layer orchestrator for bundle
 * installation. Wraps `InstallPipeline` and depends only on port
 * interfaces; concrete adapters are injected by the composition root.
 *
 * This module never instantiates concrete classes; it only calls
 * port interface methods.
 * @module app/install/install-bundle
 */
import {
  type InstallOutcome,
  InstallPipeline,
  type PipelineEvent,
} from '../install/pipeline';
import type {
  BundleSpec,
  Target,
} from '@prompt-registry/core';
import type {
  BundleDownloader,
} from '@prompt-registry/core';
import type {
  BundleExtractor,
} from '@prompt-registry/core';
import type {
  BundleResolver,
} from '@prompt-registry/core';
import type {
  TargetWriter,
} from '@prompt-registry/core';

export interface InstallBundleInput {
  spec: BundleSpec;
  target: Target;
}

export interface InstallBundleOptions {
  resolver: BundleResolver;
  downloader: BundleDownloader;
  extractor: BundleExtractor;
  writerFactory: (target: Target) => TargetWriter;
  onEvent?: (event: PipelineEvent) => void;
}

/**
 * Execute a bundle installation. Returns the install outcome on
 * success; throws `InstallPipelineError` on failure.
 * @param input Bundle spec and target.
 * @param opts Injected port implementations.
 * @returns Install outcome.
 */
export const installBundle = (
  input: InstallBundleInput,
  opts: InstallBundleOptions
): Promise<InstallOutcome> => {
  const pipeline = new InstallPipeline({
    resolver: opts.resolver,
    downloader: opts.downloader,
    extractor: opts.extractor,
    writerFactory: opts.writerFactory,
    onEvent: opts.onEvent
  });
  return pipeline.run(input.spec, input.target);
};
