/**
 * Skills + local-variant bundle resolvers.
 *
 * Three resolvers in this file (all return Installable.inlineBytes):
 *
 *  1. SkillsBundleResolver — remote skills repo on GitHub (the
 *     `anthropics/skills` convention: each skill lives under
 *     `skills/<id>/SKILL.md` plus arbitrary support files /
 *     subdirectories). The resolver walks `skills/<id>/` via the
 *     contents API and packs every file into a synthesized zip.
 *
 *  2. LocalSkillsBundleResolver — same convention but read from the
 *     local filesystem.
 *
 *  3. LocalAwesomeCopilotBundleResolver — local clone of an
 *     awesome-copilot repo. Reuses AwesomeCopilotBundleResolver's
 *     parser, but with fs IO. Lives here to keep all "local-*"
 *     adapters in a single file.
 * @module install/skills-resolver
 */
import * as path from 'node:path';
import type {
  BundleResolver,
  BundleSpec,
  FileSystem,
  HttpClient,
  Installable,
  TokenProvider,
} from '@prompt-registry/core';
import {
  generateSourceId,
} from '@prompt-registry/core';
import * as yaml from 'js-yaml';
import {
  buildZip,
} from '../writers/zip-writer';

/* eslint-disable @typescript-eslint/naming-convention -- GitHub API */
interface ContentsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  download_url?: string | null;
  url: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
//  SkillsBundleResolver — remote
// ---------------------------------------------------------------------------

export interface SkillsResolverOptions {
  /** GitHub repo slug, e.g. `anthropics/skills`. */
  repoSlug: string;
  /** Branch / tag / sha; defaults to repo default branch. */
  ref?: string;
  /** Skills directory inside the repo (default `skills`). */
  skillsPath?: string;
  http: HttpClient;
  tokens: TokenProvider;
}

/**
 * Resolves a skill bundle from a GitHub repo using the
 * `<skillsPath>/<bundleId>/...` convention popularized by
 * anthropics/skills.
 */
export class SkillsBundleResolver implements BundleResolver {
  public constructor(private readonly opts: SkillsResolverOptions) {}

  /**
   * GET /repos/.../contents/<path> — returns null on 404.
   * @param p
   */
  private async fetchContents(p: string): Promise<ContentsEntry[] | null> {
    const refPart = this.opts.ref !== undefined && this.opts.ref.length > 0
      ? `?ref=${encodeURIComponent(this.opts.ref)}`
      : '';
    const url = `https://api.github.com/repos/${this.opts.repoSlug}/contents/${p}${refPart}`;
    const token = await this.opts.tokens.getToken('api.github.com');

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.opts.http.fetch({ url, headers });
    if (res.statusCode === 404) {
      return null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`contents API ${String(res.statusCode)} for ${url}`);
    }
    const text = new TextDecoder().decode(res.body);
    const parsed = JSON.parse(text) as ContentsEntry[] | ContentsEntry;
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  /**
   * GET a raw download URL; returns null on 404.
   * @param url
   */
  private async fetchBytes(url: string): Promise<Uint8Array | null> {
    const host = new URL(url).hostname;
    const token = await this.opts.tokens.getToken(host);
    const headers: Record<string, string> = { Accept: 'application/octet-stream' };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.opts.http.fetch({ url, headers });
    if (res.statusCode === 404) {
      return null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`download ${String(res.statusCode)} for ${url}`);
    }
    return res.body;
  }

  /**
   * Walk the skill directory recursively, fetch every file, and
   * return a synthesized in-memory zip via Installable.inlineBytes.
   * @param spec Parsed BundleSpec — `bundleId` is the skill id.
   * @returns Installable, or null when the skill directory is missing.
   */
  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    const skillsPath = (this.opts.skillsPath ?? 'skills').replaceAll(/^\/+|\/+$/g, '');
    const skillRoot = `${skillsPath}/${spec.bundleId}`;
    const entries: ZipEntry[] = [];
    let foundAny = false;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const items = await this.fetchContents(dir);
      if (items === null) {
        return;
      }
      for (const item of items) {
        const localPath = `${prefix}${item.name}`;
        if (item.type === 'dir') {
          await walk(item.path, `${localPath}/`);
        } else if (item.type === 'file' && item.download_url !== null && item.download_url !== undefined) {
          const bytes = await this.fetchBytes(item.download_url);
          if (bytes !== null) {
            entries.push({ path: localPath, bytes });
            foundAny = true;
          }
        }
      }
    };
    await walk(skillRoot, '');
    if (!foundAny) {
      return null;
    }
    // Derive id/version/name from SKILL.md frontmatter when present.
    const skillMd = entries.find((e) => /(^|\/)SKILL\.md$/i.test(e.path));
    const meta = skillMd === undefined
      ? { name: spec.bundleId, description: '' }
      : parseSkillFrontmatter(new TextDecoder().decode(skillMd.bytes));
    const manifestVersion = spec.bundleVersion === 'latest' || spec.bundleVersion === undefined
      ? '0.0.0'
      : spec.bundleVersion;
    const manifest = `id: ${spec.bundleId}\n`
      + `version: ${manifestVersion}\n`
      + `name: ${quote(meta.name)}\n`
      + (meta.description.length > 0 ? `description: ${quote(meta.description)}\n` : '');
    entries.push({ path: 'deployment-manifest.yml', bytes: Buffer.from(manifest, 'utf8') });
    const zipBytes = buildZip(entries);
    const sourceId = generateSourceId('skills', `https://github.com/${this.opts.repoSlug}`);
    return {
      ref: {
        sourceId,
        sourceType: 'skills',
        bundleId: spec.bundleId,
        bundleVersion: manifestVersion,
        installed: false
      },
      downloadUrl: '',
      inlineBytes: zipBytes
    };
  }
}

// ---------------------------------------------------------------------------
//  LocalSkillsBundleResolver — local filesystem clone
// ---------------------------------------------------------------------------

export interface LocalSkillsResolverOptions {
  /** Path on disk to the skills repo root. */
  rootPath: string;
  skillsPath?: string;
  fs: FileSystem;
}

/**
 * Local-filesystem skills resolver. Same convention but reads from a local clone of the
 * skills repo. The `rootPath` may be absolute or `file://`-prefixed.
 */
export class LocalSkillsBundleResolver implements BundleResolver {
  public constructor(private readonly opts: LocalSkillsResolverOptions) {}

  /**
   * Resolve a local skills bundle by walking the skills directory.
   * @param spec Parsed BundleSpec.
   * @returns Installable, or null when the directory is missing.
   */
  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    const root = stripFileScheme(this.opts.rootPath);
    const skillsPath = (this.opts.skillsPath ?? 'skills').replaceAll(/^\/+|\/+$/g, '');
    const skillRoot = path.join(root, skillsPath, spec.bundleId);
    const entries: ZipEntry[] = [];
    const walk = async (abs: string, prefix: string): Promise<void> => {
      if (!(await this.opts.fs.exists(abs))) {
        return;
      }
      const items = await this.opts.fs.readDir(abs);
      for (const name of items) {
        const child = path.join(abs, name);
        const localPath = `${prefix}${name}`;
        // Heuristic: if readDir returns a name without an extension,
        // try as a directory first by attempting to read it.
        try {
          await this.opts.fs.readDir(child);
          // Successful readDir → directory.
          await walk(child, `${localPath}/`);
        } catch {
          const text = await this.opts.fs.readFile(child);
          entries.push({ path: localPath, bytes: Buffer.from(text, 'utf8') });
        }
      }
    };
    await walk(skillRoot, '');
    if (entries.length === 0) {
      return null;
    }
    const skillMd = entries.find((e) => /(^|\/)SKILL\.md$/i.test(e.path));
    const meta = skillMd === undefined
      ? { name: spec.bundleId, description: '' }
      : parseSkillFrontmatter(new TextDecoder().decode(skillMd.bytes));
    const manifestVersion = spec.bundleVersion === 'latest' || spec.bundleVersion === undefined
      ? '0.0.0'
      : spec.bundleVersion;
    const manifest = `id: ${spec.bundleId}\n`
      + `version: ${manifestVersion}\n`
      + `name: ${quote(meta.name)}\n`
      + (meta.description.length > 0 ? `description: ${quote(meta.description)}\n` : '');
    entries.push({ path: 'deployment-manifest.yml', bytes: Buffer.from(manifest, 'utf8') });
    const zipBytes = buildZip(entries);
    const sourceId = generateSourceId('local-skills', `file://${root}`);
    return {
      ref: {
        sourceId,
        sourceType: 'local-skills',
        bundleId: spec.bundleId,
        bundleVersion: manifestVersion,
        installed: false
      },
      downloadUrl: '',
      inlineBytes: zipBytes
    };
  }
}

// ---------------------------------------------------------------------------
//  LocalAwesomeCopilotBundleResolver — local clone of an awesome-copilot repo
// ---------------------------------------------------------------------------

export interface LocalAwesomeCopilotResolverOptions {
  rootPath: string;
  collectionsPath?: string;
  fs: FileSystem;
}

/**
 * Local-filesystem variant of AwesomeCopilotBundleResolver. Same
 * collection schema; IO is via FsAbstraction instead of HTTP.
 */
export class LocalAwesomeCopilotBundleResolver implements BundleResolver {
  public constructor(private readonly opts: LocalAwesomeCopilotResolverOptions) {}

  /**
   * Resolve a local awesome-copilot collection by reading the collection file.
   * @param spec Parsed BundleSpec.
   * @returns Installable, or null when the collection is missing.
   */
  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    const root = stripFileScheme(this.opts.rootPath);
    const collectionsPath = (this.opts.collectionsPath ?? 'collections').replaceAll(/^\/+|\/+$/g, '');
    const collectionFile = `${spec.bundleId}.collection.yml`;
    const collectionAbs = path.join(root, collectionsPath, collectionFile);
    if (!(await this.opts.fs.exists(collectionAbs))) {
      return null;
    }
    const yamlText = await this.opts.fs.readFile(collectionAbs);
    const collection = yaml.load(yamlText) as { id?: string; name?: string; version?: string;
      items?: { path: string; kind?: string }[]; } | null;
    if (collection === null || collection === undefined) {
      return null;
    }
    const entries: ZipEntry[] = [];
    for (const item of collection.items ?? []) {
      if (item.path === undefined || item.path.length === 0) {
        continue;
      }
      const itemAbs = path.join(root, item.path);
      if (!(await this.opts.fs.exists(itemAbs))) {
        continue;
      }
      const text = await this.opts.fs.readFile(itemAbs);
      entries.push({ path: item.path, bytes: Buffer.from(text, 'utf8') });
    }
    if (entries.length === 0) {
      return null;
    }
    entries.push({
      path: `${collectionsPath}/${collectionFile}`,
      bytes: Buffer.from(yamlText, 'utf8')
    });
    const manifestId = collection.id ?? spec.bundleId;
    const manifestVersion = collection.version
      ?? (spec.bundleVersion === 'latest' || spec.bundleVersion === undefined
        ? '0.0.0'
        : spec.bundleVersion);
    const manifestName = collection.name ?? manifestId;
    const manifest = `id: ${manifestId}\nversion: ${manifestVersion}\nname: ${quote(manifestName)}\n`;
    entries.push({ path: 'deployment-manifest.yml', bytes: Buffer.from(manifest, 'utf8') });
    const zipBytes = buildZip(entries);
    const sourceId = generateSourceId('local-awesome-copilot', `file://${root}`);
    return {
      ref: {
        sourceId,
        sourceType: 'local-awesome-copilot',
        bundleId: manifestId,
        bundleVersion: manifestVersion,
        installed: false
      },
      downloadUrl: '',
      inlineBytes: zipBytes
    };
  }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Extract `name` + `description` from a SKILL.md YAML frontmatter block.
 * @param md
 */
const parseSkillFrontmatter = (md: string): { name: string; description: string } => {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (m === null) {
    return { name: '', description: '' };
  }
  try {
    const fm = yaml.load(m[1]) as { name?: string; description?: string } | null;
    return {
      name: typeof fm?.name === 'string' ? fm.name : '',
      description: typeof fm?.description === 'string' ? fm.description : ''
    };
  } catch {
    return { name: '', description: '' };
  }
};

const stripFileScheme = (p: string): string => p.replace(/^file:\/\//, '');

const quote = (s: string): string => {
  if (s.length === 0) {
    return '""';
  }
  if (/^[\w. -]+$/.test(s)) {
    return s;
  }
  return `'${s.replaceAll("'", "''")}'`;
};
