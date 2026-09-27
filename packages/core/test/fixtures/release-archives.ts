import {
  createHash,
} from 'node:crypto';
import {
  dump as dumpYaml,
} from 'js-yaml';
import type {
  ExtractedFiles,
} from '../../src/ports/bundle-extractor';

export interface ReleaseArchiveFixtureOptions {
  id?: string;
  version?: string;
  includeKnowledge?: boolean;
  includeKnowledgePair?: boolean;
  includeSkillKnowledge?: boolean;
  includeLegacyProjection?: boolean;
}

const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

const sha256 = (content: string): string =>
  `sha256:${createHash('sha256').update(bytes(content)).digest('hex')}`;

/**
 * Minimal historical archive shape: no formatVersion and no governed
 * inventory. Its archive entries represent the historical installable
 * content emitted by the legacy builder.
 * @param options
 */
export const createLegacyReleaseArchive = (
  options: ReleaseArchiveFixtureOptions = {}
): ExtractedFiles => {
  const id = options.id ?? 'legacy-bundle';
  const version = options.version ?? '1.0.0';
  const knowledgePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
  const archiveFiles = {
    'prompts/hello.prompt.md': '# Hello Prompt\n',
    ...(options.includeKnowledge === true ? { [knowledgePath]: '# SBB B2P\n' } : {})
  };
  const manifest = `id: ${id}\nversion: ${version}\nname: Legacy Bundle\nprompts:\n  - id: hello\n    file: prompts/hello.prompt.md\n    type: prompt\n${options.includeKnowledge === true
    ? `  - id: sbb-b2p\n    file: ${knowledgePath}\n    type: knowledge\n`
    : ''}`;

  return new Map([
    ['deployment-manifest.yml', bytes(manifest)],
    ...Object.entries(archiveFiles).map(([filePath, content]) => [filePath, bytes(content)] as const)
  ]);
};

/**
 * Fully governed archive shape: canonical items, complete file inventory,
 * immutable provenance, embedded source/license evidence, and explicit
 * metadata-only and ignored classifications.
 * @param options
 */
export const createGovernedReleaseArchive = (
  options: ReleaseArchiveFixtureOptions = {}
): ExtractedFiles => {
  const id = options.id ?? 'governed-bundle';
  const version = options.version ?? '1.0.0';
  const sourceSnapshotPath = 'metadata/source/collections/governed.collection.yml';
  const knowledgePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
  const secondKnowledgePath = 'specifications/alternate/SBB_B2P.md';
  const skillPath = 'skills/knowledge-skill/SKILL.md';
  const skillKnowledgePath = 'skills/knowledge-skill/knowledge/guide.md';
  const archiveFiles = {
    'prompts/hello.prompt.md': '# Hello Prompt\n',
    ...(options.includeKnowledge === true || options.includeKnowledgePair === true ? { [knowledgePath]: '# SBB B2P\n' } : {}),
    ...(options.includeKnowledgePair === true ? { [secondKnowledgePath]: '# Alternate SBB B2P\n' } : {}),
    ...(options.includeSkillKnowledge === true
      ? {
        [skillPath]: '# Knowledge Skill\n',
        [skillKnowledgePath]: '# Embedded skill knowledge\n'
      }
      : {}),
    [sourceSnapshotPath]: `id: ${id}\n`,
    'README.md': '# Governed bundle\n',
    LICENSE: 'Governed license text\n',
    'ignored/build/cache.pyc': 'cache bytes\n'
  };
  const files = Object.entries(archiveFiles).map(([filePath, content]) => ({
    path: filePath,
    role: filePath.startsWith('prompts/') || filePath === knowledgePath || filePath === secondKnowledgePath
      || filePath === skillPath || filePath === skillKnowledgePath
      ? 'installable'
      : (filePath.startsWith('ignored/') ? 'ignored' : 'metadata'),
    size: bytes(content).byteLength,
    sha256: sha256(content)
  }));
  const manifest = {
    formatVersion: 1,
    id,
    version,
    name: 'Governed Bundle',
    readme: 'README.md',
    items: [
      { id: 'hello', path: 'prompts/hello.prompt.md', kind: 'prompt' },
      ...(options.includeKnowledge === true || options.includeKnowledgePair === true
        ? [{ id: 'sbb-b2p', path: knowledgePath, kind: 'knowledge' }]
        : []),
      ...(options.includeKnowledgePair === true
        ? [{ id: 'sbb-b2p-alternate', path: secondKnowledgePath, kind: 'knowledge' }]
        : []),
      ...(options.includeSkillKnowledge === true
        ? [
          { id: 'knowledge-skill', path: skillPath, kind: 'skill' },
          { id: 'knowledge-skill-guide', path: skillKnowledgePath, kind: 'knowledge' }
        ]
        : [])
    ],
    ...(options.includeLegacyProjection === false
      ? {}
      : {
        prompts: [
          { id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' },
          ...(options.includeKnowledge === true || options.includeKnowledgePair === true
            ? [{ id: 'sbb-b2p', file: knowledgePath, type: 'knowledge' }]
            : []),
          ...(options.includeKnowledgePair === true
            ? [{ id: 'sbb-b2p-alternate', file: secondKnowledgePath, type: 'knowledge' }]
            : []),
          ...(options.includeSkillKnowledge === true
            ? [
              { id: 'knowledge-skill', file: skillPath, type: 'skill' },
              { id: 'knowledge-skill-guide', file: skillKnowledgePath, type: 'knowledge' }
            ]
            : [])
        ]
      }),
    provenance: {
      source: 'https://github.com/example/governed-bundle',
      revision: '0123456789abcdef0123456789abcdef01234567',
      collectionPath: 'collections/governed.collection.yml',
      sourceSnapshotPath,
      license: 'Governed-License',
      licensePath: 'LICENSE'
    },
    files
  };

  return new Map([
    ['deployment-manifest.yml', bytes(dumpYaml(manifest, { lineWidth: -1 }))],
    ...Object.entries(archiveFiles).map(([filePath, content]) => [filePath, bytes(content)] as const)
  ]);
};
