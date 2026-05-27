import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildBodyPreview,
  computePrimitiveId,
  detectKindFromPath,
  extractFromFile,
  extractMcpPrimitives,
  parseFrontmatter,
} from '../../src/harvest/extractor';
import type {
  BundleManifest,
  BundleRef,
} from '../../src/search/types';

const ref: BundleRef = {
  sourceId: 'hub-a',
  sourceType: 'github',
  bundleId: 'b1',
  bundleVersion: '1.0.0',
  installed: true
};

describe('parseFrontmatter()', () => {
  it('returns null frontmatter when none present', () => {
    const r = parseFrontmatter('# just a body');
    expect(r.frontmatter).toBe(null);
    expect(r.body).toBe('# just a body');
  });

  it('parses YAML and strips frontmatter from body', () => {
    const content = '---\ntitle: "T"\n---\n\n# H';
    const r = parseFrontmatter(content);
    expect(r.frontmatter?.title).toBe('T');
    expect(r.body).toMatch(/^# H/);
  });
});

describe('detectKindFromPath()', () => {
  it('maps file suffixes to kinds', () => {
    expect(detectKindFromPath('a/b.prompt.md')).toBe('prompt');
    expect(detectKindFromPath('a/b.instructions.md')).toBe('instruction');
    expect(detectKindFromPath('a/b.chatmode.md')).toBe('chat-mode');
    expect(detectKindFromPath('a/b.agent.md')).toBe('agent');
    expect(detectKindFromPath('skills/x/SKILL.md')).toBe('skill');
    expect(detectKindFromPath('README.md')).toBe(null);
  });
});

describe('buildBodyPreview()', () => {
  it('strips code fences, links and markdown emphasis', () => {
    const out = buildBodyPreview('**bold** `code` ```ts\nx\n``` [link](http://x) text');
    expect(out.includes('**')).toBe(false);
    expect(out.includes('`')).toBe(false);
    expect(out.includes('[')).toBe(false);
    expect(out.includes('link')).toBe(true);
    expect(out.includes('text')).toBe(true);
  });

  it('caps length', () => {
    const long = 'word '.repeat(500);
    const out = buildBodyPreview(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('extractFromFile()', () => {
  const manifest: BundleManifest = {
    id: 'b1', version: '1.0.0', tags: ['iac'],
    items: [{ path: 'prompts/x.prompt.md', kind: 'prompt', tags: ['iac'] }]
  };

  it('builds a primitive with merged tags and frontmatter title', () => {
    const prim = extractFromFile(
      { ref, manifest },
      {
        path: 'prompts/x.prompt.md',
        content: '---\ntitle: "My Prompt"\ndescription: "d"\ntags: [extra]\n---\n\n# H\nbody'
      }
    );
    expect(prim).toBeTruthy();
    expect(prim!.kind).toBe('prompt');
    expect(prim!.title).toBe('My Prompt');
    expect(prim!.description).toBe('d');
    expect(prim!.tags).toStrictEqual(['iac', 'extra']);
    expect(prim!.bundle).toStrictEqual(ref);
    expect(prim!.id).toBe(computePrimitiveId(ref.sourceId, ref.bundleId, 'prompts/x.prompt.md'));
    expect(prim!.contentHash.length).toBe(64);
  });

  it('falls back to first H1 when no frontmatter title', () => {
    const prim = extractFromFile(
      { ref, manifest: { id: 'b1', version: '1.0.0' } },
      { path: 'prompts/y.prompt.md', content: '# Heading Title\n\nbody' }
    );
    expect(prim?.title).toBe('Heading Title');
  });

  it('returns null when kind cannot be determined', () => {
    const prim = extractFromFile(
      { ref, manifest: { id: 'b1', version: '1.0.0' } },
      { path: 'random.txt', content: 'anything' }
    );
    expect(prim).toBe(null);
  });
});

describe('extractMcpPrimitives()', () => {
  it('synthesises records from manifest.mcp.items', () => {
    const manifest: BundleManifest = {
      id: 'b1', version: '1.0.0',
      mcp: { items: { srv: { type: 'stdio', command: 'node', args: ['server.js'] } } }
    };
    const prims = extractMcpPrimitives({ ref, manifest });
    expect(prims.length).toBe(1);
    expect(prims[0].kind).toBe('mcp-server');
    expect(prims[0].title).toBe('srv');
    expect(prims[0].bodyPreview.includes('node')).toBe(true);
    expect(prims[0].tags.includes('mcp')).toBe(true);
  });
});
