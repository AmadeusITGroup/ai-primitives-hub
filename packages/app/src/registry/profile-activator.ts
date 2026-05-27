/**
 * ProfileActivator.
 *
 * Atomic activation engine for a registry Profile. Resolves every
 * bundle via the existing install pipeline, then
 * writes them across the chosen targets transactionally:
 *
 *   1. Resolve all bundles upfront. Any null abort BEFORE downloads.
 *   2. Download all bundles. Any failure abort BEFORE extracts.
 *   3. Extract + validate. Any failure abort BEFORE writes.
 *   4. Write across every target. On any per-write failure, REVERT
 *      every previously-written file by deleting it, then re-throw
 *      with PROFILE.ACTIVATION_FAILED.
 *
 * Target-agnostic: the activator iterates over the supplied targets;
 * the same Profile activates uniformly into vscode + claude-code +
 * kiro + windsurf + copilot-cli. No target-specific code paths.
 *
 * Enforcement: caller MUST pass a fresh activation (the
 * deactivation of any previous active profile is the orchestrator's
 * job, not the activator's).
 */
import * as path from 'node:path';
import {
  type Profile,
  type ProfileActivationState,
  type RegistrySource,
  type Target,
} from '../../domain';
import {
  validateManifest,
} from '../../domain';
import {
  type Installable,
} from '../../domain/install';
import {
  HttpsBundleDownloader,
} from '../../infra/downloaders/https-downloader';
import {
  YauzlBundleExtractor,
} from '../../infra/extractors/yauzl-extractor';
import {
  AssetFetcher,
} from '../../infra/github/asset-fetcher';
import {
  readLocalBundle,
} from '../../infra/resolvers/local-resolver';
import {
  SourceDispatcher,
} from '../../infra/resolvers/resolver-registry';
import {
  FileTreeTargetWriter,
} from '../../infra/writers/file-tree-writer';
import {
  type ExtractedFiles,
} from '../../ports/bundle-extractor';
import type {
  FileSystem,
} from '../../ports/filesystem';
import {
  type HttpClient,
  type TokenProvider,
} from '../../ports/http';

export interface ProfileActivatorDeps {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Env (passed to FileTreeTargetWriter for ${HOME} expansion). */
  env: Record<string, string | undefined>;
  /** HttpClient for github resolves + downloads. */
  http: HttpClient;
  /** TokenProvider. */
  tokens: TokenProvider;
}

export interface ActivationInput {
  hubId: string;
  profile: Profile;
  /** Map sourceId -> RegistrySource (from the hub config). */
  sources: Record<string, RegistrySource>;
  /** All targets to write into (target-agnostic). */
  targets: Target[];
}

export interface ActivationOutcome {
  state: ProfileActivationState;
  /** Per-target written file lists. */
  written: Record<string, string[]>;
  /** Map profile bundle ref ID -> manifest bundle ID */
  bundleIdMap: Record<string, string>;
}

/**
 * Atomic Profile activation engine.
 */
export class ProfileActivator {
  private readonly dispatcher: SourceDispatcher;

  /**
   * Construct a ProfileActivator instance.
   * @param deps Injected dependencies.
   */
  public constructor(private readonly deps: ProfileActivatorDeps) {
    this.dispatcher = new SourceDispatcher({
      http: deps.http,
      tokens: deps.tokens,
      fs: deps.fs
    });
  }

  private async resolveAll(input: ActivationInput): Promise<ResolvedBundle[]> {
    const out: ResolvedBundle[] = [];
    for (const b of input.profile.bundles) {
      const src = input.sources[b.source];
      if (src === undefined) {
        throw new Error(
          `PROFILE.SOURCE_MISSING: profile "${input.profile.id}" references source "${b.source}" not in hub`
        );
      }
      const resolver = this.resolverFor(src);
      if (resolver !== null) {
        const inst = await resolver.resolve({
          bundleId: b.id, bundleVersion: b.version === 'latest' ? undefined : b.version
        });
        if (inst === null) {
          throw new Error(
            `PROFILE.BUNDLE_NOT_FOUND: ${b.id}@${b.version} not in source ${b.source}`
          );
        }
        out.push({ bundleRef: b, source: src, installable: inst, kind: 'remote' });
      } else if (src.type === 'local') {
        out.push({ bundleRef: b, source: src, installable: null, kind: 'local' });
      } else {
        throw new Error(
          `PROFILE.SOURCE_UNSUPPORTED: source type "${src.type}" not implemented yet`
        );
      }
    }
    return out;
  }

  /**
   * Pick the right resolver for a source's type. Returns null when
   * the type has no remote resolver (e.g., `local` — handled by
   * `readLocalBundle`).
   * @param src Source.
   * @returns Resolver instance or null.
   */
  private resolverFor(src: RegistrySource): {
    resolve: (s: { bundleId: string; bundleVersion: string | undefined }) => Promise<Installable | null>;
  } | null {
    const resolver = this.dispatcher.resolverFor(src);
    if (resolver === null) {
      return null;
    }
    return resolver;
  }

  /**
   * Fetch + extract every resolved bundle into memory. Returns
   * MaterializedBundle[] (bundleId + version + files).
   * @param resolved Resolved bundles.
   * @returns Materialized bundles.
   */
  private async materializeAll(resolved: ResolvedBundle[]): Promise<MaterializedBundle[]> {
    const out: MaterializedBundle[] = [];
    // Use the new shared AssetFetcher (lib/src/github/) so the bundle
    // download path gains retries on transient 5xx, the strict-Accept
    // switch for api.github.com release assets, and the inline-
    // bytes shortcut used by awesome-copilot/skills resolvers.
    const downloader = new HttpsBundleDownloader(
      new AssetFetcher({ tokens: this.deps.tokens })
    );
    const extractor = new YauzlBundleExtractor();
    for (const r of resolved) {
      let files: ExtractedFiles;
      if (r.kind === 'remote' && r.installable !== null) {
        const dl = await downloader.download(r.installable);
        files = await extractor.extract(dl.bytes);
      } else {
        // local: read the directory pointed at by source.url
        files = await readLocalBundle(r.source.url, this.deps.fs);
      }
      // For hub-driven activation we trust the source+release as
      // the bundle's identity; the hub config's `id` is often a
      // synthesized "owner-repo-bundle" string that does not match
      // the manifest's natural id (and we never used it to fetch
      // the bytes anyway). Validate version when explicit.
      const manifest = validateManifest(files, {
        expectedVersion: r.bundleRef.version === 'latest' ? undefined : r.bundleRef.version
      });
      out.push({
        bundleId: manifest.id,
        bundleVersion: manifest.version,
        files
      });
    }
    return out;
  }

  /**
   * Rollback: delete every file in writtenByTarget. Best-effort:
   * errors are logged but not re-thrown.
   * @param writtenByTarget Per-target written file lists.
   */
  private async rollback(writtenByTarget: Record<string, string[]>): Promise<void> {
    for (const files of Object.values(writtenByTarget)) {
      for (const f of files) {
        try {
          await this.deps.fs.remove(f);
        } catch {
          // best-effort; rollback continues
        }
      }
    }
    // Clean up empty parent directories left by partial writes.
    for (const files of Object.values(writtenByTarget)) {
      const dirs = new Set(files.map((f) => path.dirname(f)));
      for (const d of dirs) {
        try {
          const entries = await this.deps.fs.readDir(d);
          if (entries.length === 0) {
            await this.deps.fs.remove(d);
          }
        } catch {
          // best-effort
        }
      }
    }
  }

  /**
   * Activate a profile across all targets atomically. Throws on
   * any failure with rollback already complete.
   * @param input Activation input.
   * @returns Activation outcome (state + per-target write log).
   */
  public async activate(input: ActivationInput): Promise<ActivationOutcome> {
    if (input.targets.length === 0) {
      throw new Error('PROFILE.ACTIVATION_NO_TARGETS: at least one target is required');
    }
    // Step 1: resolve every bundle. No IO writes yet.
    const resolved = await this.resolveAll(input);
    // Step 2: fetch + extract every bundle into memory.
    const materialized = await this.materializeAll(resolved);
    // Step 3: write every bundle into every target. Track for rollback.
    const writer = new FileTreeTargetWriter({ fs: this.deps.fs, env: this.deps.env });
    const writtenByTarget: Record<string, string[]> = {};
    try {
      for (const t of input.targets) {
        writtenByTarget[t.name] = [];
        for (const m of materialized) {
          const result = await writer.write(t, m.files);
          writtenByTarget[t.name].push(...result.written);
        }
      }
    } catch (cause) {
      await this.rollback(writtenByTarget);
      const err = new Error(
        `PROFILE.ACTIVATION_FAILED: ${(cause as Error).message}`
      );
      (err as { code?: string }).code = 'PROFILE.ACTIVATION_FAILED';
      throw err;
    }
    const versions: Record<string, string> = {};
    const bundleIdMap: Record<string, string> = {}; // profile bundle ref id -> manifest id
    for (const [i, m] of materialized.entries()) {
      const r = resolved[i];
      versions[m.bundleId] = m.bundleVersion;
      bundleIdMap[r.bundleRef.id] = m.bundleId;
    }
    const state: ProfileActivationState = {
      schemaVersion: 1,
      hubId: input.hubId,
      profileId: input.profile.id,
      activatedAt: new Date().toISOString(),
      syncedBundles: resolved.map((r) => r.bundleRef.id),
      syncedBundleVersions: versions,
      syncedTargets: input.targets.map((t) => t.name)
    };
    return { state, written: writtenByTarget, bundleIdMap };
  }
}

interface ResolvedBundle {
  bundleRef: { id: string; version: string; source: string; required: boolean };
  source: RegistrySource;
  installable: Installable | null;
  kind: 'remote' | 'local';
}

interface MaterializedBundle {
  bundleId: string;
  bundleVersion: string;
  files: ExtractedFiles;
}
