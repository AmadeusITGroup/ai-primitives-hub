/**
 * InstallPipeline orchestrator.
 *
 * Composes the four stages (resolve → download → extract → validate
 * → write) behind a single `run()` entry. Each stage is plug-in
 * via the constructor so unit tests inject deterministic doubles
 * and the production CLI wires real GitHub/HTTP/zip impls.
 *
 * The pipeline emits structured progress events through an optional
 * `onEvent` callback so the install command can render per-step
 * status (verbose mode) or feed the JSON envelope's `meta.events`.
 *
 * Scope-aware routing.
 * - Changed from single `writer` to `writerFactory: (target: Target) => TargetWriter`
 * - Factory routes to RepositoryScopeWriter for repository scope, FileTreeTargetWriter for user scope
 * - Enables lockfile updates to include commitMode for repository scope
 */
import {
  type ValidatedManifest,
  validateManifest,
} from '@prompt-registry/core';
import type {
  BundleSpec,
  Installable,
  Target,
} from '@prompt-registry/core';
import type {
  TargetWriter,
  TargetWriteResult,
} from '../writers/file-tree-writer';
import type {
  BundleDownloader,
} from '@prompt-registry/core';
import type {
  BundleExtractor,
} from '@prompt-registry/core';
import type {
  BundleResolver,
} from '@prompt-registry/core';

/**
 * Pipeline events emitted during install.
 * Used for progress tracking and logging.
 */
export type PipelineEvent =
  | { kind: 'resolve.start'; spec: BundleSpec }
  | { kind: 'resolve.done'; installable: Installable }
  | { kind: 'download.start'; url: string }
  | { kind: 'download.done'; sha256: string; bytes: number }
  | { kind: 'extract.start' }
  | { kind: 'extract.done'; fileCount: number }
  | { kind: 'validate.start' }
  | { kind: 'validate.done'; manifestId: string; manifestVersion: string }
  | { kind: 'write.start'; target: string }
  | { kind: 'write.done'; target: string; written: number; skipped: number };

/**
 * Options for configuring the install pipeline.
 */
export interface InstallPipelineOptions {
  resolver: BundleResolver;
  downloader: BundleDownloader;
  extractor: BundleExtractor;
  /** Factory that returns the appropriate writer for a given target. */
  writerFactory: (target: Target) => TargetWriter;
  onEvent?: (event: PipelineEvent) => void;
}

/**
 * Outcome of a successful install operation.
 */
export interface InstallOutcome {
  installable: Installable;
  manifest: ValidatedManifest;
  write: TargetWriteResult;
  sha256: string;
}

/**
 * Error thrown when the install pipeline fails.
 */
export class InstallPipelineError extends Error {
  /**
   * Create an InstallPipelineError.
   * @param message Error message.
   * @param code Error code for programmatic handling.
   * @param stage Pipeline stage where the error occurred.
   */
  public constructor(
    message: string,
    public readonly code: string,
    public readonly stage: 'resolve' | 'download' | 'extract' | 'validate' | 'write'
  ) {
    super(message);
    this.name = 'InstallPipelineError';
  }
}

/**
 * InstallPipeline orchestrates the install process.
 * Composes resolve → download → extract → validate → write stages.
 */
export class InstallPipeline {
  /**
   * Create an InstallPipeline.
   * @param opts Pipeline options including resolver, downloader, extractor, writer factory, and event callback.
   */
  public constructor(private readonly opts: InstallPipelineOptions) {}

  /**
   * Run the install pipeline end-to-end.
   * @param spec - Parsed BundleSpec.
   * @param target - Target to write into.
   * @returns InstallOutcome.
   */
  public async run(spec: BundleSpec, target: Target): Promise<InstallOutcome> {
    const emit = (e: PipelineEvent): void => {
      if (this.opts.onEvent !== undefined) {
        this.opts.onEvent(e);
      }
    };

    // 1. Resolve.
    emit({ kind: 'resolve.start', spec });
    const installable = await this.opts.resolver.resolve(spec);
    if (installable === null) {
      throw new InstallPipelineError(
        `bundle "${describeSpec(spec)}" not found`,
        'BUNDLE.NOT_FOUND',
        'resolve'
      );
    }
    emit({ kind: 'resolve.done', installable });

    // 2. Download.
    emit({ kind: 'download.start', url: installable.downloadUrl });
    let download;
    try {
      download = await this.opts.downloader.download(installable);
    } catch (downloadError) {
      throw new InstallPipelineError(
        `download failed: ${(downloadError as Error).message}`,
        'NETWORK.DOWNLOAD_FAILED',
        'download'
      );
    }
    emit({ kind: 'download.done', sha256: download.sha256, bytes: download.bytes.byteLength });

    // 3. Extract.
    emit({ kind: 'extract.start' });
    let files;
    try {
      files = await this.opts.extractor.extract(download.bytes);
    } catch (extractError) {
      throw new InstallPipelineError(
        `extract failed: ${(extractError as Error).message}`,
        'BUNDLE.EXTRACT_FAILED',
        'extract'
      );
    }
    emit({ kind: 'extract.done', fileCount: files.size });

    // 4. Validate manifest.
    emit({ kind: 'validate.start' });
    let manifest;
    try {
      manifest = validateManifest(files, {
        expectedId: spec.bundleId,
        expectedVersion: spec.bundleVersion
      });
    } catch (validateError) {
      const e = validateError as { code?: string; message: string };
      throw new InstallPipelineError(
        e.message,
        e.code ?? 'BUNDLE.MANIFEST_INVALID',
        'validate'
      );
    }
    emit({ kind: 'validate.done', manifestId: manifest.id, manifestVersion: manifest.version });

    // 5. Write to target.
    emit({ kind: 'write.start', target: target.name });
    let writeResult;
    try {
      const writer = this.opts.writerFactory(target);
      writeResult = await writer.write(target, files);
    } catch (writeError) {
      throw new InstallPipelineError(
        `write failed: ${(writeError as Error).message}`,
        'FS.WRITE_FAILED',
        'write'
      );
    }
    emit({
      kind: 'write.done',
      target: target.name,
      written: writeResult.written.length,
      skipped: writeResult.skipped.length
    });

    return {
      installable,
      manifest,
      write: writeResult,
      sha256: download.sha256
    };
  }
}

const describeSpec = (s: BundleSpec): string => {
  const head = s.sourceId === undefined ? s.bundleId : `${s.sourceId}:${s.bundleId}`;
  return s.bundleVersion === undefined ? head : `${head}@${s.bundleVersion}`;
};
