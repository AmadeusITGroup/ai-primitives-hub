import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type FetchLike,
  GitHubClient,
} from '../../src/github/client';
import {
  staticTokenProvider,
} from '../../src/github/token';
import {
  enumeratePluginRepo,
} from '../../src/harvest/plugin-tree-enumerator';

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

describe('plugin-tree-enumerator', () => {
  it('discovers plugin manifests and groups candidate files per plugin', async () => {
    const commitSha = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
    const tree = {
      sha: 'tree',
      tree: [
        { path: 'plugins', type: 'tree', sha: 't0' },
        { path: 'plugins/skills-plugin', type: 'tree', sha: 't1' },
        { path: 'plugins/skills-plugin/.github/plugin/plugin.json', type: 'blob', sha: 'm1', size: 500 },
        { path: 'plugins/skills-plugin/skills/analyzer/SKILL.md', type: 'blob', sha: 'b1', size: 120 },
        { path: 'plugins/skills-plugin/skills/reporter/SKILL.md', type: 'blob', sha: 'b2', size: 130 },
        { path: 'plugins/skills-plugin/skills/analyzer/README.md', type: 'blob', sha: 'n1', size: 200 },
        { path: 'plugins/upstream-plugin', type: 'tree', sha: 't2' },
        { path: 'plugins/upstream-plugin/.github/plugin/plugin.json', type: 'blob', sha: 'm2', size: 400 },
        { path: 'plugins/upstream-plugin/skills/java-docs/SKILL.md', type: 'blob', sha: 'b3', size: 150 },
        { path: 'plugins/upstream-plugin/agents/code-reviewer/AGENT.md', type: 'blob', sha: 'b4', size: 180 },
        { path: 'README.md', type: 'blob', sha: 'r1', size: 100 },
        { path: 'plugins/incomplete/skills/x/SKILL.md', type: 'blob', sha: 'xx', size: 100 }
      ],
      truncated: false
    };
    const manifests: Record<string, string> = {
      m1: JSON.stringify({
        id: 'skills-plugin',
        name: 'skills-plugin',
        description: 'two skills',
        items: [
          { kind: 'skill', path: './skills/analyzer' },
          { kind: 'skill', path: './skills/reporter' }
        ]
      }),
      m2: JSON.stringify({
        name: 'upstream-plugin',
        description: 'upstream format',
        agents: ['./agents/code-reviewer'],
        skills: ['./skills/java-docs']
      })
    };
    const urls: string[] = [];
    const fakeFetch: FetchLike = async (req) => {
      const url = (req).url;
      urls.push(url);
      if (url.includes('/commits/')) {
        return jsonResponse({ sha: commitSha });
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse(tree);
      }
      const m = /\/repos\/[^/]+\/[^/]+\/git\/blobs\/(\w+)/u.exec(url);
      if (m && manifests[m[1]]) {
        return jsonResponse({
          sha: m[1],
          encoding: 'base64',
          content: Buffer.from(manifests[m[1]], 'utf8').toString('base64')
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch: fakeFetch });

    const result = await enumeratePluginRepo(client, {
      owner: 'o', repo: 'r', ref: 'main', pluginsPath: 'plugins', client
    });

    expect(result.commitSha).toBe(commitSha);
    expect(result.plugins.length).toBe(2);

    const skillsPlugin = result.plugins.find((p) => p.pluginId === 'skills-plugin')!;
    expect(skillsPlugin).toBeTruthy();
    expect(skillsPlugin.pluginRoot).toBe('plugins/skills-plugin');
    expect(
      skillsPlugin.candidates.map((c) => c.path).toSorted()
    ).toStrictEqual(
      [
        'plugins/skills-plugin/.github/plugin/plugin.json',
        'plugins/skills-plugin/skills/analyzer/SKILL.md',
        'plugins/skills-plugin/skills/reporter/SKILL.md'
      ]
    );

    const upstreamPlugin = result.plugins.find((p) => p.pluginId === 'upstream-plugin')!;
    expect(upstreamPlugin).toBeTruthy();
    expect(
      upstreamPlugin.candidates.map((c) => c.path).toSorted()
    ).toStrictEqual(
      [
        'plugins/upstream-plugin/.github/plugin/plugin.json',
        'plugins/upstream-plugin/agents/code-reviewer/AGENT.md',
        'plugins/upstream-plugin/skills/java-docs/SKILL.md'
      ]
    );
  });

  it('throws on a truncated tree (we need all blobs to be present)', async () => {
    const fakeFetch: FetchLike = async (req) => {
      const url = (req).url;
      if (url.includes('/commits/')) {
        return jsonResponse({ sha: 'ff' });
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse({ sha: 't', tree: [], truncated: true });
      }
      throw new Error(`unexpected: ${url}`);
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch: fakeFetch });
    await expect(
      () => enumeratePluginRepo(client, { owner: 'o', repo: 'r', ref: 'main', pluginsPath: 'plugins', client })
    ).rejects.toThrow(/truncated/u);
  });

  it('tolerates a plugin with empty items[] (0 primitives harvestable)', async () => {
    const manifest = JSON.stringify({
      id: 'empty', name: 'empty', description: 'a plugin with nothing to harvest',
      items: []
    });
    const fakeFetch: FetchLike = async (req) => {
      const url = (req).url;
      if (url.includes('/commits/')) {
        return jsonResponse({ sha: 'aaaa' });
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse({
          sha: 't', truncated: false,
          tree: [
            { path: 'plugins/empty/.github/plugin/plugin.json', type: 'blob', sha: 'mempty', size: manifest.length }
          ]
        });
      }
      if (url.includes('/repos/o/r/git/blobs/mempty')) {
        return jsonResponse({
          sha: 'mempty', encoding: 'base64',
          content: Buffer.from(manifest, 'utf8').toString('base64')
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch: fakeFetch });
    const r = await enumeratePluginRepo(client, { owner: 'o', repo: 'r', ref: 'main', pluginsPath: 'plugins', client });
    expect(r.plugins.length).toBe(1);
    expect(r.plugins[0].candidates.length).toBe(1);
    expect(r.plugins[0].candidates[0].path).toBe('plugins/empty/.github/plugin/plugin.json');
  });

  it('skips plugins with external: true (external content hosted elsewhere)', async () => {
    const manifest = JSON.stringify({
      id: 'ext', name: 'ext', description: 'external plugin',
      external: true,
      source: { source: 'github', repo: 'o/r', path: 'some/path' }
    });
    const fakeFetch: FetchLike = async (req) => {
      const url = (req).url;
      if (url.includes('/commits/')) {
        return jsonResponse({ sha: 'aaaa' });
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse({
          sha: 't', truncated: false,
          tree: [
            { path: 'plugins/ext/.github/plugin/plugin.json', type: 'blob', sha: 'mext', size: manifest.length }
          ]
        });
      }
      if (url.includes('/repos/o/r/git/blobs/mext')) {
        return jsonResponse({
          sha: 'mext', encoding: 'base64',
          content: Buffer.from(manifest, 'utf8').toString('base64')
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch: fakeFetch });
    const r = await enumeratePluginRepo(client, { owner: 'o', repo: 'r', ref: 'main', pluginsPath: 'plugins', client });
    expect(r.plugins.length).toBe(0);
  });

  it('returns an empty plugins array when no plugin.json is found under pluginsPath', async () => {
    const fakeFetch: FetchLike = async (req) => {
      const url = (req).url;
      if (url.includes('/commits/')) {
        return jsonResponse({ sha: 'aa' });
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse({
          sha: 't',
          truncated: false,
          tree: [
            { path: 'README.md', type: 'blob', sha: 'r', size: 10 },
            { path: 'plugins/not-a-plugin/skills/s/SKILL.md', type: 'blob', sha: 'x', size: 20 }
          ]
        });
      }
      throw new Error(`unexpected: ${url}`);
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch: fakeFetch });
    const r = await enumeratePluginRepo(client, { owner: 'o', repo: 'r', ref: 'main', pluginsPath: 'plugins', client });
    expect(r.plugins.length).toBe(0);
  });
});
