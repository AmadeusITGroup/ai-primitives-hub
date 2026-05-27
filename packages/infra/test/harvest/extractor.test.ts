/**
 * Coverage tests for infra/harvest/extractor.ts.
 *
 * Tests parseFrontmatter, detectKindFromPath, computePrimitiveId, hashContent,
 * buildBodyPreview, extractFromFile, extractMcpPrimitives.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildBodyPreview,
  computePrimitiveId,
  detectKindFromPath,
  type ExtractContext,
  extractFromFile,
  extractMcpPrimitives,
  hashContent,
  parseFrontmatter,
} from '../../src/harvest/extractor';
import type {
  BundleManifest,
  BundleRef,
  HarvestedFile,
} from '../../src/search/types';

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter', () => {
    const content = '---\ntitle: Test\ndescription: A test\n---\nBody content';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({ title: 'Test', description: 'A test' });
    expect(result.body).toBe('Body content');
  });

  it('returns null frontmatter when missing', () => {
    const content = 'No frontmatter here';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe('No frontmatter here');
  });

  it('handles empty frontmatter', () => {
    const content = '---\n---\nBody content';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe('---\n---\nBody content');
  });
});

describe('detectKindFromPath', () => {
  it('detects skill from /skill.md', () => {
    expect(detectKindFromPath('skills/my-skill/skill.md')).toBe('skill');
  });

  it('detects skill from skill.md', () => {
    expect(detectKindFromPath('skill.md')).toBe('skill');
  });

  it('detects prompt from .prompt.md', () => {
    expect(detectKindFromPath('test.prompt.md')).toBe('prompt');
  });

  it('detects instruction from .instructions.md', () => {
    expect(detectKindFromPath('test.instructions.md')).toBe('instruction');
  });

  it('detects instruction from .instruction.md', () => {
    expect(detectKindFromPath('test.instruction.md')).toBe('instruction');
  });

  it('detects chat-mode from .chatmode.md', () => {
    expect(detectKindFromPath('test.chatmode.md')).toBe('chat-mode');
  });

  it('detects chat-mode from .chat-mode.md', () => {
    expect(detectKindFromPath('test.chat-mode.md')).toBe('chat-mode');
  });

  it('detects agent from .agent.md', () => {
    expect(detectKindFromPath('test.agent.md')).toBe('agent');
  });

  it('returns null for unknown file', () => {
    expect(detectKindFromPath('readme.md')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectKindFromPath('TEST.PROMPT.MD')).toBe('prompt');
  });
});

describe('computePrimitiveId', () => {
  it('generates stable id', () => {
    const id = computePrimitiveId('source123', 'bundle456', 'path/to/file.md');
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('generates different ids for different inputs', () => {
    const id1 = computePrimitiveId('source1', 'bundle1', 'path1');
    const id2 = computePrimitiveId('source2', 'bundle2', 'path2');
    expect(id1).not.toBe(id2);
  });

  it('generates same id for same inputs', () => {
    const id1 = computePrimitiveId('source1', 'bundle1', 'path1');
    const id2 = computePrimitiveId('source1', 'bundle1', 'path1');
    expect(id1).toBe(id2);
  });
});

describe('hashContent', () => {
  it('generates SHA-256 hash', () => {
    const hash = hashContent('test content');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates different hashes for different content', () => {
    const hash1 = hashContent('content1');
    const hash2 = hashContent('content2');
    expect(hash1).not.toBe(hash2);
  });

  it('generates same hash for same content', () => {
    const hash1 = hashContent('same content');
    const hash2 = hashContent('same content');
    expect(hash1).toBe(hash2);
  });
});

describe('buildBodyPreview', () => {
  it('strips code fences', () => {
    const body = '```js\nconsole.log("hello");\n```\nSome text';
    const preview = buildBodyPreview(body);
    expect(preview).not.toContain('```');
    expect(preview).toContain('Some text');
  });

  it('strips inline code', () => {
    const body = 'Text with `code` inside';
    const preview = buildBodyPreview(body);
    expect(preview).not.toContain('`');
  });

  it('strips images', () => {
    const body = 'Text ![alt](url.png) more text';
    const preview = buildBodyPreview(body);
    expect(preview).not.toContain('![');
  });

  it('strips links but keeps text', () => {
    const body = 'Text [link](url) more text';
    const preview = buildBodyPreview(body);
    expect(preview).toContain('link');
    expect(preview).not.toContain('[');
  });

  it('strips markdown emphasis', () => {
    const body = '*bold* _italic_ ~~strike~~';
    const preview = buildBodyPreview(body);
    expect(preview).not.toContain('*');
    expect(preview).not.toContain('_');
  });

  it('normalizes whitespace', () => {
    const body = 'Text  with\nmultiple   spaces';
    const preview = buildBodyPreview(body);
    expect(preview).not.toContain('\n');
    expect(preview).toBe('Text  with multiple   spaces');
  });

  it('truncates to max length', () => {
    const body = 'a'.repeat(500);
    const preview = buildBodyPreview(body, 100);
    expect(preview.length).toBeLessThanOrEqual(101); // 100 + ellipsis
    expect(preview.endsWith('…')).toBe(true);
  });

  it('returns original when under max', () => {
    const body = 'short text';
    const preview = buildBodyPreview(body, 100);
    expect(preview).toBe('short text');
  });
});

describe('extractFromFile', () => {
  const ref: BundleRef = {
    sourceId: 'source123',
    bundleId: 'bundle456',
    sourceType: 'github',
    bundleVersion: '1.0.0',
    installed: false
  };
  const manifest: BundleManifest = {
    id: 'bundle456',
    version: '1.0.0',
    name: 'Test Bundle'
  };
  const ctx: ExtractContext = { ref, manifest };

  it('extracts primitive from file with frontmatter', () => {
    const file: HarvestedFile = {
      path: 'test.prompt.md',
      content: '---\ntitle: Test\ndescription: A test\ntags: [test, example]\n---\nBody content'
    };
    const result = extractFromFile(ctx, file);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.kind).toBe('prompt');
      expect(result.title).toBe('Test');
      expect(result.description).toBe('A test');
      expect(result.tags).toEqual(['test', 'example']);
    }
  });

  it('extracts primitive from file without frontmatter', () => {
    const file: HarvestedFile = {
      path: 'test.prompt.md',
      content: '# Title\nBody content'
    };
    const result = extractFromFile(ctx, file);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.kind).toBe('prompt');
      expect(result.title).toBe('Title');
    }
  });

  it('returns null when kind cannot be determined', () => {
    const file: HarvestedFile = {
      path: 'readme.md',
      content: 'Some content'
    };
    const result = extractFromFile(ctx, file);
    expect(result).toBeNull();
  });
});

describe('extractMcpPrimitives', () => {
  const ref: BundleRef = {
    sourceId: 'source123',
    bundleId: 'bundle456',
    sourceType: 'github',
    bundleVersion: '1.0.0',
    installed: false
  };
  const manifest: BundleManifest = {
    id: 'bundle456',
    version: '1.0.0',
    name: 'Test Bundle',
    tags: ['bundle-tag']
  };
  const ctx: ExtractContext = { ref, manifest };

  it('extracts MCP server primitives', () => {
    const manifestWithMcp: BundleManifest = {
      ...manifest,
      mcp: {
        items: {
          'test-server': {
            command: 'test-cmd',
            args: ['--arg1', 'value1'],
            description: 'A test MCP server'
          }
        }
      }
    };
    const ctxWithMcp: ExtractContext = { ref, manifest: manifestWithMcp };
    const result = extractMcpPrimitives(ctxWithMcp);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('mcp-server');
    expect(result[0].title).toBe('test-server');
    expect(result[0].description).toBe('A test MCP server');
    expect(result[0].tags).toContain('mcp');
  });

  it('returns empty array when no MCP items', () => {
    const result = extractMcpPrimitives(ctx);
    expect(result).toEqual([]);
  });

  it('builds preview from command and args', () => {
    const manifestWithMcp: BundleManifest = {
      ...manifest,
      mcp: {
        items: {
          'test-server': {
            command: 'test-cmd',
            args: ['--arg1']
          }
        }
      }
    };
    const ctxWithMcp: ExtractContext = { ref, manifest: manifestWithMcp };
    const result = extractMcpPrimitives(ctxWithMcp);
    expect(result[0].bodyPreview).toContain('test-cmd');
  });
});
