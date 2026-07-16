import * as path from 'node:path';
import type {
  BundleRef,
  HubSourceSpec,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  BlobCache,
  computeGitBlobSha,
} from '../../../src/harvest/blob-cache';
import {
  AwesomeCopilotPluginBundleProvider,
} from '../../../src/harvest/bundle-providers/plugin-bundle-provider';
import {
  FakeGitHubApi,
} from '../../helpers/fake-github-api';
import {
  createTempDir,
} from '../../helpers/temp-dir';

async function collectRefs(provider: AwesomeCopilotPluginBundleProvider): Promise<BundleRef[]> {
  const refs: BundleRef[] = [];
  for await (const ref of provider.listBundles()) {
    refs.push(ref);
  }
  return refs;
}

describe('plugin-bundle-provider', () => {
  it('produces one BundleRef per discovered plugin with shared commit sha', async () => {
    const commitSha = '1111aaaa2222bbbb3333cccc4444dddd5555eeee';
    const manifest1 = JSON.stringify({
      id: 'p1', name: 'p1', description: 'plugin 1',
      items: [{ kind: 'skill', path: './skills/a' }]
    });
    const manifest2 = JSON.stringify({
      id: 'p2', name: 'p2', description: 'plugin 2',
      items: [{ kind: 'prompt', path: './prompts/hello.prompt.md' }]
    });
    const skillBody = '# SKILL a\n';
    const promptBody = 'hello prompt';
    const m1Sha = computeGitBlobSha(Buffer.from(manifest1, 'utf8'));
    const m2Sha = computeGitBlobSha(Buffer.from(manifest2, 'utf8'));
    const b1Sha = computeGitBlobSha(Buffer.from(skillBody, 'utf8'));
    const b2Sha = computeGitBlobSha(Buffer.from(promptBody, 'utf8'));

    const client = new FakeGitHubApi();
    client.seedJson('/repos/github/awesome-copilot/commits/main', { sha: commitSha });
    client.seedJson(`/repos/github/awesome-copilot/git/trees/${commitSha}?recursive=1`, {
      sha: 't',
      truncated: false,
      tree: [
        { path: 'plugins/p1/.github/plugin/plugin.json', type: 'blob', sha: m1Sha, size: manifest1.length },
        { path: 'plugins/p1/skills/a/SKILL.md', type: 'blob', sha: b1Sha, size: skillBody.length },
        { path: 'plugins/p2/.github/plugin/plugin.json', type: 'blob', sha: m2Sha, size: manifest2.length },
        { path: 'plugins/p2/prompts/hello.prompt.md', type: 'blob', sha: b2Sha, size: promptBody.length }
      ]
    });
    client.seedJson(`/repos/github/awesome-copilot/git/blobs/${m1Sha}`, {
      sha: m1Sha, encoding: 'base64', content: Buffer.from(manifest1, 'utf8').toString('base64')
    });
    client.seedJson(`/repos/github/awesome-copilot/git/blobs/${m2Sha}`, {
      sha: m2Sha, encoding: 'base64', content: Buffer.from(manifest2, 'utf8').toString('base64')
    });
    client.seedText('https://raw.githubusercontent.com/github/awesome-copilot/main/plugins/p1/skills/a/SKILL.md', skillBody);
    client.seedText('https://raw.githubusercontent.com/github/awesome-copilot/main/plugins/p2/prompts/hello.prompt.md', promptBody);

    const [tmpDir, cleanup] = createTempDir('pbp-');
    const cache = new BlobCache(path.join(tmpDir, 'blobs'));

    const spec: HubSourceSpec = {
      id: 'awesome-upstream',
      name: 'github/awesome-copilot (plugins)',
      type: 'awesome-copilot-plugin',
      url: 'https://github.com/github/awesome-copilot',
      owner: 'github', repo: 'awesome-copilot', branch: 'main',
      pluginsPath: 'plugins',
      rawConfig: {}
    };
    const provider = new AwesomeCopilotPluginBundleProvider({ spec, client, cache });

    const refs = await collectRefs(provider);
    expect(refs.length).toBe(2);
    const byId = new Map(refs.map((r) => [r.bundleId, r]));
    expect(byId.has('p1') && byId.has('p2')).toBe(true);
    for (const r of refs) {
      expect(r.sourceId).toBe('awesome-upstream');
      expect(r.sourceType).toBe('awesome-copilot-plugin');
      expect(r.bundleVersion).toBe(commitSha);
      expect(r.installed).toBe(false);
    }

    const m1 = await provider.readManifest(byId.get('p1')!);
    expect(m1.id).toBe('p1');
    expect(m1.version).toBe(commitSha);
    expect(m1.items?.some((i) => i.path === 'plugins/p1/skills/a/SKILL.md')).toBe(true);
    expect(m1.items?.some((i) => i.path === 'plugins/p1/.github/plugin/plugin.json')).toBe(true);

    expect(
      await provider.readFile(byId.get('p1')!, 'plugins/p1/skills/a/SKILL.md')
    ).toBe('# SKILL a\n');
    expect(
      await provider.readFile(byId.get('p2')!, 'plugins/p2/prompts/hello.prompt.md')
    ).toBe('hello prompt');

    await expect(
      () => provider.readFile(byId.get('p1')!, 'plugins/p2/prompts/hello.prompt.md')
    ).rejects.toThrow(/not part of plugin/u);

    cleanup();
  });

  it('surfaces plugin-declared MCP servers via manifest.mcp.items', async () => {
    const commitSha = '2222aaaa3333bbbb4444cccc5555dddd6666eeee';
    const manifest = JSON.stringify({
      id: 'mcp-plugin', name: 'mcp-plugin', description: 'a plugin with MCP',
      items: [],
      mcp: {
        items: {
          context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7'] }
        }
      }
    });
    const mSha = computeGitBlobSha(Buffer.from(manifest, 'utf8'));

    const client = new FakeGitHubApi();
    client.seedJson('/repos/o/r/commits/main', { sha: commitSha });
    client.seedJson(`/repos/o/r/git/trees/${commitSha}?recursive=1`, {
      sha: 't',
      truncated: false,
      tree: [
        { path: 'plugins/mcp-plugin/.github/plugin/plugin.json', type: 'blob', sha: mSha, size: manifest.length }
      ]
    });
    client.seedJson(`/repos/o/r/git/blobs/${mSha}`, {
      sha: mSha, encoding: 'base64', content: Buffer.from(manifest, 'utf8').toString('base64')
    });

    const [tmpDir, cleanup] = createTempDir('pbp-mcp-');
    const cache = new BlobCache(path.join(tmpDir, 'blobs'));
    const spec: HubSourceSpec = {
      id: 'mcp-src', name: 'mcp-src', type: 'awesome-copilot-plugin',
      url: 'https://github.com/o/r',
      owner: 'o', repo: 'r', branch: 'main', pluginsPath: 'plugins',
      rawConfig: {}
    };
    const provider = new AwesomeCopilotPluginBundleProvider({ spec, client, cache });
    const refs = await collectRefs(provider);
    const bm = await provider.readManifest(refs[0]);
    expect(bm.mcp).toBeTruthy();
    expect(
      bm.mcp?.items?.context7
    ).toStrictEqual(
      { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7'] }
    );
    cleanup();
  });
});
