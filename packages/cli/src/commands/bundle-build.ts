/**
 * `bundle build` subcommand.
 *
 * Generates a deployment manifest (delegating to `bundle manifest`'s
 * in-process helper) and zips it together with the referenced primitive
 * files into a reproducible `<collection-id>.bundle.zip`.
 *
 * Reproducibility:
 *   - All entries get the same fixed timestamp (`1980-01-01T00:00:00Z`).
 *   - File entries are sorted lexicographically before being added to
 *     the archive.
 *   - `archiver` is configured with maximum zlib compression for
 *     deterministic byte-identical output across runs.
 * @module commands/bundle-build
 */
// archiver needs a real Node WriteStream. Context.fs is a high-level
// abstraction (read/write/exists/mkdir) and does not expose stream APIs. The
// bounded usage is the single createWriteStream call inside
// createDeterministicZip; the natural moment to add Context.fs.createWriteStream
// is when install downloads are added.
import {
  createWriteStream,
  existsSync,
  unlinkSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  readCollection,
  resolveCollectionItemPaths,
} from '@ai-primitives-hub/app';
import {
  generateBundleId,
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';
import {
  generateBundleManifest,
} from './bundle-manifest';

/**
 * Bundle build data.
 */
interface BundleBuildData {
  collectionId: string;
  version: string;
  outDir: string;
  manifestAsset: string;
  zipAsset: string;
  bundleId: string;
}

/** Fixed date for reproducible bundle timestamps. */
const FIXED_DATE = new Date('1980-01-01T00:00:00.000Z');

/**
 * Create a deterministic ZIP archive with fixed timestamps and sorted entries.
 * @param input - Zip creation parameters.
 * @param input.repoRoot
 * @param input.zipPath
 * @param input.manifestPath
 * @param input.itemPaths
 * @returns Promise that resolves when the ZIP is created.
 */
const createDeterministicZip = (input: {
  repoRoot: string;
  zipPath: string;
  manifestPath: string;
  itemPaths: string[];
}): Promise<void> => {
  // The single archiver/streams use site in this command file.
  // Reproducible timestamps, sorted entry order, max zlib compression.
  return new Promise((resolve, reject) => {
    const output = createWriteStream(input.zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    // Flag to prevent double-cleanup if both output and archive error handlers fire
    let cleaned = false;

    // Cleanup function to remove partially written zip on error
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        // Use destroy() instead of close() for error cleanup - it aborts the stream
        // immediately without waiting for buffered data to flush
        output.destroy();
        if (existsSync(input.zipPath)) {
          unlinkSync(input.zipPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    };

    output.on('close', resolve);
    output.on('error', (err) => {
      cleanup();
      reject(err);
    });
    archive.on('error', (err) => {
      cleanup();
      reject(err);
    });
    archive.pipe(output);
    archive.file(input.manifestPath, { name: 'deployment-manifest.yml', date: FIXED_DATE });
    const sorted = input.itemPaths
      .map((p) => normalizeRepoRelativePath(p))
      .toSorted((a, b) => a.localeCompare(b));
    for (const rel of sorted) {
      const abs = path.join(input.repoRoot, rel);
      archive.file(abs, { name: rel, date: FIXED_DATE });
    }
    archive.finalize().catch(() => { /* handled by archive.on('error') above */ });
  });
};

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */
const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'bundle.build',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};

/**
 * Bundle build command class.
 */
export class BundleBuildCommand extends Command {
  public static readonly paths = [['bundle', 'build']];

  public static readonly usage = Command.Usage({
    description: 'Generate a deployment manifest and zip collection items into a bundle.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub bundle build [options]

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --collection-file <path>    Collection file path (repo-relative)
        --version <version>         Bundle version (e.g. 1.0.0)
        --out-dir <dir>             Output directory (default: dist)
        --repo-slug <slug>          Repo slug (owner-repo, or GITHUB_REPOSITORY env var, or cwd dirname)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public collectionFile = Option.String('--collection-file');
  public version = Option.String('--version');
  public outDir = Option.String('--out-dir');
  public repoSlug = Option.String('--repo-slug');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const collectionFile = this.collectionFile ?? '';
    const version = this.version ?? '';

    try {
      const cwd = ctx.cwd();
      const repoSlug = (this.repoSlug
        ?? (ctx.env.GITHUB_REPOSITORY ?? '').replaceAll('/', '-'))
      || path.basename(cwd);
      // Resolve outDir against ctx.cwd() so the command honors
      // injected working directories (Context invariant).
      const outDirRel = this.outDir ?? 'dist';
      const outDir = path.isAbsolute(outDirRel) ? outDirRel : path.join(cwd, outDirRel);
      const collection = readCollection(cwd, collectionFile);
      const collectionId = collection.id;
      if (typeof collectionId !== 'string' || collectionId.length === 0) {
        throw new RegistryError({
          code: 'BUNDLE.INVALID_MANIFEST',
          message: 'collection.id is required'
        });
      }

      const bundleId = generateBundleId(repoSlug, collectionId, version);
      const collectionOutDir = path.join(outDir, collectionId);
      await ctx.fs.mkdir(collectionOutDir, { recursive: true });

      // Generate the deployment-manifest.yml in the bundle output
      // directory by calling `bundle manifest`'s exported helper
      // in-process (its own errors propagate via the same try/catch).
      const standaloneManifestPath = path.join(collectionOutDir, 'deployment-manifest.yml');
      // Suppress the manifest sub-step's own stdout envelope so it
      // doesn't pollute this command's output. The OutputStream
      // contract is just `{ write(chunk: string): void }`.
      const subCtx: Context = {
        ...ctx,
        stdout: { write: () => undefined }
      };
      await generateBundleManifest(
        subCtx,
        cwd,
        { output: 'json', version, collectionFile },
        standaloneManifestPath
      );

      const itemPaths = resolveCollectionItemPaths(cwd, collection);
      const zipPath = path.join(collectionOutDir, `${collectionId}.bundle.zip`);
      await createDeterministicZip({
        repoRoot: cwd,
        zipPath,
        manifestPath: standaloneManifestPath,
        itemPaths
      });

      const data: BundleBuildData = {
        collectionId,
        version,
        outDir: collectionOutDir.replaceAll('\\', '/'),
        manifestAsset: standaloneManifestPath.replaceAll('\\', '/'),
        zipAsset: zipPath.replaceAll('\\', '/'),
        bundleId
      };
      formatOutput({
        ctx,
        command: 'bundle.build',
        output: fmt,
        status: 'ok',
        data,
        textRenderer: (d) =>
          `Built ${d.zipAsset} (bundle id: ${d.bundleId}, version: ${d.version})\n`
      });
      return 0;
    } catch (err) {
      const re = err instanceof RegistryError
        ? err
        : new RegistryError({
          code: 'INTERNAL.UNEXPECTED',
          message: err instanceof Error ? err.message : String(err),
          cause: err
        });
      emitError(ctx, fmt, re);
      return 1;
    }
  }
}
