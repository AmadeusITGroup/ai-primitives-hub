/**
 * AwesomeCopilotBundleProvider — exposes multiple bundles from an
 * awesome-copilot GitHub repo (one per collection file).
 *
 * Unlike GitHubSingleBundleProvider (one bundle per repo), this provider
 * lists all .collection.yml files in the configured collections directory
 * and yields one BundleRef per collection, using the collection.id as the
 * bundleId. This matches what AwesomeCopilotBundleResolver expects during
 * installation.
 *
 * Topology:
 *   spec (1 repo with collectionsPath)
 *     └── listBundles() → one BundleRef per .collection.yml file
 *          ├── readManifest(ref) → synthetic manifest from collection.yml
 *          └── readFile(ref, path) → raw GitHub content
 */

import * as yaml from 'js-yaml';
import type {
  HubSourceSpec,
} from '@prompt-registry/core';
import {
  BlobCache,
} from '../../github/blob-cache';
import type {
  GitHubClient,
} from '../../github/client';
import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '../../search/types';
import {
  enumerateRepoTree,
  type EnumerateResult,
  isPrimitiveCandidatePath,
} from '../tree-enumerator';

export interface AwesomeCopilotBundleProviderOpts {
  spec: HubSourceSpec;
  client: GitHubClient;
  cache: BlobCache;
}

interface CollectionManifest {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  items?: { path: string; kind?: string }[];
}

/* eslint-disable @typescript-eslint/member-ordering -- public API kept at top. */
export class AwesomeCopilotBundleProvider implements BundleProvider {
  private enumeration: EnumerateResult | undefined;
  private readonly collections: Map<string, CollectionManifest> = new Map();
  private readonly bundleIdToPath: Map<string, string> = new Map();

  public constructor(private readonly opts: AwesomeCopilotBundleProviderOpts) {}

  public async* listBundles(): AsyncIterable<BundleRef> {
    const enumeration = await this.ensureEnumeration();
    const collectionsPath = this.opts.spec.collectionsPath ?? 'collections';

    for (const entry of enumeration.candidates) {
      if (!entry.path.startsWith(`${collectionsPath}/`) || !entry.path.endsWith('.collection.yml')) {
        continue;
      }

      const collection = await this.loadCollection(entry.path);
      if (collection?.id) {
        this.bundleIdToPath.set(collection.id, entry.path);
        yield {
          sourceId: this.opts.spec.id,
          sourceType: this.opts.spec.type,
          bundleId: collection.id,
          bundleVersion: enumeration.commitSha,
          installed: false
        };
      }
    }
  }

  public async readManifest(ref: BundleRef): Promise<BundleManifest> {
    const enumeration = await this.ensureEnumeration();
    const collectionFile = this.bundleIdToPath.get(ref.bundleId);
    if (!collectionFile) {
      throw new Error(`Collection file not found for bundleId: ${ref.bundleId}`);
    }
    const collection = this.collections.get(collectionFile);
    if (!collection) {
      throw new Error(`Collection not found for bundleId: ${ref.bundleId}`);
    }

    return {
      id: collection.id,
      version: enumeration.commitSha,
      name: collection.name || collection.id,
      description: collection.description ?? `Harvested from ${this.opts.spec.url}@${this.opts.spec.branch}`,
      tags: [this.opts.spec.type],
      items: collection.items?.map((item) => ({
        path: item.path,
        kind: item.kind || pathKindHint(item.path)
      })) || []
    };
  }

  public async readFile(ref: BundleRef, relPath: string): Promise<string> {
    const enumeration = await this.ensureEnumeration();
    const entry = enumeration.candidates.find((c) => c.path === relPath);
    if (!entry) {
      if (!isPrimitiveCandidatePath(relPath)) {
        throw new Error(`not a primitive candidate: ${relPath}`);
      }
      throw new Error(`not found in repo tree: ${relPath}`);
    }
    const rawUrl = `https://raw.githubusercontent.com/${this.opts.spec.owner}/${this.opts.spec.repo}/${this.opts.spec.branch}/${relPath}`;
    const bytes = await this.opts.cache.getOrFetch(entry.blobSha, async () => {
      const text = await this.opts.client.getText(rawUrl);
      return Buffer.from(text);
    });
    return bytes.toString('utf8');
  }

  public async getCommitSha(): Promise<string> {
    return (await this.ensureEnumeration()).commitSha;
  }

  private async ensureEnumeration(): Promise<EnumerateResult> {
    this.enumeration ??= await enumerateRepoTree(this.opts.client, {
      owner: this.opts.spec.owner,
      repo: this.opts.spec.repo,
      ref: this.opts.spec.branch
    });
    return this.enumeration;
  }

  private async loadCollection(path: string): Promise<CollectionManifest | null> {
    if (this.collections.has(path)) {
      return this.collections.get(path)!;
    }

    try {
      const rawUrl = `https://raw.githubusercontent.com/${this.opts.spec.owner}/${this.opts.spec.repo}/${this.opts.spec.branch}/${path}`;
      const content = await this.opts.client.getText(rawUrl);
      const collection = yaml.load(content) as CollectionManifest | null;
      if (collection?.id) {
        this.collections.set(path, collection);
        return collection;
      }
    } catch (error) {
      // Invalid YAML or missing id - skip this collection
      console.warn(`Failed to load collection ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

function pathKindHint(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith('.prompt.md')) {
    return 'prompt';
  }
  if (lower.endsWith('.instructions.md')) {
    return 'instruction';
  }
  if (lower.endsWith('.chatmode.md')) {
    return 'chat-mode';
  }
  if (lower.endsWith('.agent.md') || lower.endsWith('/agent.md')) {
    return 'agent';
  }
  if (lower.endsWith('skill.md') || lower.endsWith('/skill.md')) {
    return 'skill';
  }
  return 'prompt';
}
