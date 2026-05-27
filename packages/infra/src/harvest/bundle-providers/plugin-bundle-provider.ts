/**
 * AwesomeCopilotPluginBundleProvider — exposes a plugin-format GitHub
 * repo as N bundles (one per plugin) to the PrimitiveIndex harvester.
 *
 * Topology:
 *   spec (1 repo)
 *     └── listBundles() → one BundleRef per plugin folder
 *          ├── readManifest(ref) → items[] = manifest + entry files
 *          └── readFile(ref, path) → blob bytes (via BlobFetcher cache)
 *
 * bundleVersion is the **repo commit sha**, shared across all plugins
 * in the same repo; that's fine because the harvester's smart-rebuild
 * also keys its progress log per (sourceId, bundleId, commitSha), so
 * a bump in the plugin repo will invalidate every plugin bundle at
 * once (which is semantically correct — any plugin could have changed).
 */

import type {
  PluginManifest,
} from '@prompt-registry/core';
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
  EtagStore,
} from '../../github/etag-store';
import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '../../search/types';
import {
  extractPluginMcpServers,
} from '../plugin-manifest';
import {
  enumeratePluginRepo,
  type EnumeratePluginRepoResult,
  type PluginDiscovery,
} from '../plugin-tree-enumerator';

export interface AwesomeCopilotPluginBundleProviderOpts {
  spec: HubSourceSpec;
  client: GitHubClient;
  cache: BlobCache;
  etagStore?: EtagStore;
}

/* eslint-disable @typescript-eslint/member-ordering -- public API kept at top */
export class AwesomeCopilotPluginBundleProvider implements BundleProvider {
  private enumeration: EnumeratePluginRepoResult | undefined;

  public constructor(private readonly opts: AwesomeCopilotPluginBundleProviderOpts) {}

  public async* listBundles(): AsyncIterable<BundleRef> {
    const enumeration = await this.ensureEnumeration();
    for (const plugin of enumeration.plugins) {
      yield {
        sourceId: this.opts.spec.id,
        sourceType: this.opts.spec.type,
        bundleId: plugin.pluginId,
        bundleVersion: enumeration.commitSha,
        installed: false
      };
    }
  }

  public async readManifest(ref: BundleRef): Promise<BundleManifest> {
    const plugin = await this.findPlugin(ref);
    const enumeration = await this.ensureEnumeration();
    const mcpServers = extractPluginMcpServers(plugin.manifest as PluginManifest);
    const hasMcp = Object.keys(mcpServers).length > 0;
    return {
      id: plugin.pluginId,
      version: enumeration.commitSha,
      name: plugin.pluginId,
      description: `Plugin ${plugin.pluginId} harvested from ${this.opts.spec.url}@${this.opts.spec.branch}`,
      tags: [this.opts.spec.type],
      items: plugin.candidates.map((c) => ({
        path: c.path,
        kind: pathKindHint(c.path)
      })),
      ...(hasMcp ? { mcp: { items: mcpServers as Record<string, { type?: string; command?: string; args?: string[]; url?: string; description?: string }> } } : {})
    };
  }

  public async readFile(ref: BundleRef, relPath: string): Promise<string> {
    const plugin = await this.findPlugin(ref);
    const entry = plugin.candidates.find((c) => c.path === relPath);
    if (!entry) {
      throw new Error(`path not part of plugin ${plugin.pluginId}: ${relPath}`);
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

  private async ensureEnumeration(): Promise<EnumeratePluginRepoResult> {
    this.enumeration ??= await enumeratePluginRepo(this.opts.client, {
      owner: this.opts.spec.owner,
      repo: this.opts.spec.repo,
      ref: this.opts.spec.branch,
      pluginsPath: this.opts.spec.pluginsPath ?? 'plugins',
      etagStore: this.opts.etagStore,
      cache: this.opts.cache,
      client: this.opts.client
    });
    return this.enumeration;
  }

  private async findPlugin(ref: BundleRef): Promise<PluginDiscovery> {
    const enumeration = await this.ensureEnumeration();
    const plugin = enumeration.plugins.find((p) => p.pluginId === ref.bundleId);
    if (!plugin) {
      throw new Error(`unknown plugin ${ref.bundleId} in source ${this.opts.spec.id}`);
    }
    return plugin;
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
  if (lower.endsWith('plugin.json') || lower.endsWith('/plugin.json')) {
    return 'plugin-manifest';
  }
  return 'unknown';
}
