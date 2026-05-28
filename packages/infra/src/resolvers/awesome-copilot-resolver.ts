/**
 * `awesome-copilot` BundleResolver.
 *
 * Mirrors `AwesomeCopilotAdapter.downloadBundle` from the VS Code
 * extension: the source is a GitHub repo (or local clone) with
 * `<collectionsPath>/*.collection.yml` files. Each collection lists
 * `items: [{ path, kind }]`. We fetch the collection YAML, fetch
 * every referenced file, build a `deployment-manifest.yml`, and
 * return everything as an in-memory zip via `Installable.inlineBytes`
 * (extension to the Installable shape).
 *
 * Local clones use `LocalAwesomeCopilotBundleResolver` from the
 * companion file; same parser, different IO.
 * @module install/awesome-copilot-resolver
 */
import {
  type BundleResolver,
  type BundleSpec,
  generateSourceId,
  type HttpClient,
  type Installable,
  type TokenProvider,
} from '@prompt-registry/core';
import * as yaml from 'js-yaml';
import {
  buildZip,
} from '../writers/zip-writer';

function resolveManifestVersion(spec: BundleSpec): string {
  if (spec.bundleVersion === 'latest') {
    return '0.0.0';
  }
  return spec.bundleVersion ?? '0.0.0';
}

/** Subset of the `*.collection.yml` shape we consume. */
interface CollectionManifest {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  items?: { path: string; kind?: string }[];
}

export interface AwesomeCopilotResolverOptions {
  /** GitHub repo slug, e.g. `github/awesome-copilot`. */
  repoSlug: string;
  /** Default branch (`main` if not given). */
  branch?: string;
  /** Collections directory (`collections` if not given). */
  collectionsPath?: string;
  http: HttpClient;
  tokens: TokenProvider;
}

/**
 * Resolver that builds an awesome-copilot bundle on the fly by
 * fetching the collection manifest + every referenced file from
 * `raw.githubusercontent.com`.
 */
export class AwesomeCopilotBundleResolver implements BundleResolver {
  public constructor(private readonly opts: AwesomeCopilotResolverOptions) {}

  /**
   * Build a raw.githubusercontent.com URL.
   * @param branch
   * @param p
   */
  private rawUrl(branch: string, p: string): string {
    return `https://raw.githubusercontent.com/${this.opts.repoSlug}/${branch}/${p}`;
  }

  /**
   * Fetch text; return null on 404.
   * @param url
   */
  private async fetchText(url: string): Promise<string | null> {
    const host = new URL(url).hostname;
    const token = await this.opts.tokens.getToken(host);
    const headers: Record<string, string> = { Accept: 'application/octet-stream, text/plain, */*' };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.opts.http.fetch({ url, headers });
    if (res.statusCode === 404) {
      return null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`raw fetch ${String(res.statusCode)} for ${url}`);
    }
    return new TextDecoder().decode(res.body);
  }

  /**
   * Build an Installable carrying the synthesized bundle bytes.
   * @param spec Parsed BundleSpec — `bundleId` matches the
   *             `<id>.collection.yml` filename minus the suffix.
   * @returns Installable with `inlineBytes` set, or `null` when the
   *          collection cannot be located or has no items.
   */
  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    const branch = this.opts.branch ?? 'main';
    const collectionsPath = (this.opts.collectionsPath ?? 'collections').replaceAll(/^\/+|\/+$/g, '');
    const collectionFile = `${spec.bundleId}.collection.yml`;
    const collectionUrl = this.rawUrl(branch, `${collectionsPath}/${collectionFile}`);
    const yamlText = await this.fetchText(collectionUrl);
    if (yamlText === null) {
      return null;
    }
    let collection: CollectionManifest | null;
    try {
      collection = yaml.load(yamlText) as CollectionManifest | null;
    } catch {
      return null;
    }
    if (collection === null || collection === undefined) {
      return null;
    }
    const items = collection.items ?? [];
    // Fetch every referenced item file. Items are typically tiny
    // markdown/yaml docs; sequential fetch keeps the code simple
    // and is still parallelizable later if needed.
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const item of items) {
      if (item.path === undefined || item.path.length === 0) {
        continue;
      }
      const itemUrl = this.rawUrl(branch, item.path);
      const text = await this.fetchText(itemUrl);
      if (text === null) {
        // Missing item -> skip rather than fail; the resolver mirrors
        // the extension's tolerant behavior here.
        continue;
      }
      // Place the item under its repo-relative path, mirroring the
      // collection layout. The extension's installer maps these to
      // target paths via the manifest's `kind` mapping.
      files.push({ path: item.path, bytes: Buffer.from(text, 'utf8') });
    }
    // Add a deployment-manifest.yml so downstream BundleInstaller
    // accepts the synthesized bundle.
    const manifestId = collection.id ?? spec.bundleId;
    const manifestVersion = collection.version ?? resolveManifestVersion(spec);
    const manifestName = collection.name ?? manifestId;
    const manifest = `id: ${manifestId}\nversion: ${manifestVersion}\nname: ${quote(manifestName)}\n`;
    files.push(
      { path: 'deployment-manifest.yml', bytes: Buffer.from(manifest, 'utf8') },
      { path: `${collectionsPath}/${collectionFile}`, bytes: Buffer.from(yamlText, 'utf8') }
    );
    if (files.length <= 2) {
      // Only manifest + collection file — no real content. Treat as not-found so
      // the activator can produce a helpful error.
      return null;
    }
    const zipBytes = buildZip(files);
    const sourceId = generateSourceId('awesome-copilot', `https://github.com/${this.opts.repoSlug}`);
    return {
      ref: {
        sourceId,
        sourceType: 'awesome-copilot',
        bundleId: spec.bundleId,
        bundleVersion: manifestVersion,
        installed: false
      },
      downloadUrl: '',
      inlineBytes: zipBytes
    };
  }
}

const quote = (s: string): string => {
  if (/^[\w. -]+$/.test(s)) {
    return s;
  }
  return `'${s.replaceAll("'", "''")}'`;
};
