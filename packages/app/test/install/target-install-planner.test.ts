import * as path from 'node:path';
import type {
  BundleInstallFile,
  BundleInstallItem,
  BundleInstallPlan,
  PrimitiveKind,
  Target,
  TargetLayout,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createTargetWritePlan,
} from '../../src/install/target-install-planner';

const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

const file = (sourcePath: string, relativePath = sourcePath.split('/').pop()!): BundleInstallFile => ({
  sourcePath,
  relativePath,
  bytes: bytes(sourcePath),
  sourceChecksum: `sha256:${sourcePath}`
});

const item = (id: string, kind: PrimitiveKind, entryPath: string, files = [file(entryPath)]): BundleInstallItem => ({
  id,
  kind,
  entryPath,
  files
});

const plan = (items: readonly BundleInstallItem[]): BundleInstallPlan => ({
  bundleId: 'foursight-pr-review',
  bundleVersion: '1.0.0',
  manifest: { id: 'foursight-pr-review', version: '1.0.0', name: 'FourSight' },
  items,
  legacyInferredPaths: []
});

const target = (type: Target['type'], scope: Target['scope'] = 'user'): Target => ({
  name: `${type}-${scope}`,
  type,
  scope,
  rootPath: scope === 'user' ? undefined : '/workspace'
});

const layout = (routes: Partial<Record<PrimitiveKind, string>>, baseDir = path.resolve('/target')): TargetLayout => ({
  baseDir,
  routes
});

describe('createTargetWritePlan', () => {
  it.each([
    ['vscode', 'agents/', 'review.agent.md'],
    ['copilot-cli', 'agents/', 'review.agent.md'],
    ['kiro', 'agents/', 'review.agent.md'],
    ['claude-code', 'agents/', 'review.agent.md']
  ] as const)('plans an agent destination for %s', (type, route, fileName) => {
    const result = createTargetWritePlan(
      plan([item('review', 'agent', 'foursight-pr-review/arbitrary/review.md')]),
      target(type),
      layout({ agent: route })
    );

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      itemId: 'review',
      kind: 'agent',
      sourcePath: 'foursight-pr-review/arbitrary/review.md',
      destinationPath: path.join(path.resolve('/target'), route, fileName),
      destinationRelativePath: `${route}${fileName}`
    });
  });

  it('uses item identity for single-file names and preserves the complete skill tree', () => {
    const result = createTargetWritePlan(
      plan([
        item('code-review', 'agent', 'foursight-pr-review/arbitrary/reviewer.md'),
        item('foursight-code-review', 'skill', 'foursight-pr-review/skills/source/SKILL.md', [
          file('foursight-pr-review/skills/source/SKILL.md', 'SKILL.md'),
          file('foursight-pr-review/skills/source/assets/rubric.json', 'assets/rubric.json'),
          file('foursight-pr-review/skills/source/scripts/check.sh', 'scripts/check.sh')
        ])
      ]),
      target('vscode'),
      layout({ agent: 'agents/', skill: 'skills/' })
    );

    expect(result.operations.map((operation) => operation.destinationRelativePath)).toEqual([
      'agents/code-review.agent.md',
      'skills/foursight-code-review/assets/rubric.json',
      'skills/foursight-code-review/scripts/check.sh',
      'skills/foursight-code-review/SKILL.md'
    ]);
  });

  it('rejects unsupported kinds before producing write operations', () => {
    expect(() => createTargetWritePlan(
      plan([item('review', 'agent', 'review.agent.md')]),
      { ...target('vscode'), allowedKinds: ['prompt'] },
      layout({ agent: 'agents/' })
    )).toThrowError(expect.objectContaining({
      code: 'BUNDLE.UNSUPPORTED_CONTENT',
      message: expect.stringContaining('review')
    }));
  });

  it('rejects absent routes, destination collisions, invalid bases, and escapes', () => {
    expect(() => createTargetWritePlan(
      plan([item('review', 'agent', 'review.agent.md')]),
      target('vscode'),
      layout({})
    )).toThrowError(expect.objectContaining({ code: 'BUNDLE.UNSUPPORTED_CONTENT' }));

    expect(() => createTargetWritePlan(
      plan([
        item('same', 'agent', 'one.agent.md'),
        item('same', 'agent', 'two.agent.md')
      ]),
      target('vscode'),
      layout({ agent: 'agents/' })
    )).toThrowError(expect.objectContaining({ code: 'BUNDLE.DESTINATION_COLLISION' }));

    expect(() => createTargetWritePlan(
      plan([item('review', 'agent', 'review.agent.md')]),
      target('vscode'),
      layout({ agent: 'agents/' }, '')
    )).toThrowError(expect.objectContaining({ code: 'BUNDLE.INVALID_TARGET_PATH' }));

    expect(() => createTargetWritePlan(
      plan([item('review', 'skill', 'skills/review/SKILL.md', [file('skills/review/SKILL.md', '../escape.md')])]),
      target('vscode'),
      layout({ skill: 'skills/' })
    )).toThrowError(expect.objectContaining({ code: 'BUNDLE.INVALID_TARGET_PATH' }));
  });
});
