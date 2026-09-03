import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Collection,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createM365Manifests,
} from '../../src/commands/bundle-export-m365';

describe('Microsoft 365 declarative-agent export', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'm365-export-'));
    await mkdir(path.join(workspace, 'instructions'), { recursive: true });
    await writeFile(path.join(workspace, 'instructions', 'review.md'), 'Review changes safely.');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('maps instructions and prompt descriptions without treating SKILL.md as an M365 skill', () => {
    const collection: Collection = {
      id: 'review-kit',
      name: 'Review Kit',
      description: 'Review code changes',
      items: [
        { path: 'instructions/review.md', kind: 'instruction' },
        { path: 'prompts/security.md', kind: 'prompt', name: 'Security review', description: 'Review this change for security issues' },
        { path: 'skills/reviewer/SKILL.md', kind: 'skill' }
      ]
    };
    const result = createM365Manifests(collection, workspace, {
      appId: '00000000-0000-4000-8000-000000000000',
      version: '1.0.0',
      developerName: 'Contoso',
      websiteUrl: 'https://example.com',
      privacyUrl: 'https://example.com/privacy',
      termsUrl: 'https://example.com/terms'
    });

    expect(result.agentManifest).toMatchObject({
      version: 'v1.8',
      name: 'Review Kit',
      instructions: 'Review changes safely.',
      conversation_starters: [{ title: 'Security review', text: 'Review this change for security issues' }]
    });
    expect(result.appManifest).toMatchObject({
      manifestVersion: '1.29',
      copilotAgents: { declarativeAgents: [{ file: 'declarativeAgent.json' }] }
    });
    expect(result.warnings.join(' ')).toContain('SKILL.md items are not embedded');
    expect(result.warnings.join(' ')).toContain('at least three prompt items');
  });

  it('rejects instructions beyond the Microsoft 365 limit', async () => {
    await writeFile(path.join(workspace, 'instructions', 'review.md'), 'x'.repeat(8001));
    const collection: Collection = {
      id: 'review-kit', name: 'Review Kit', items: [{ path: 'instructions/review.md', kind: 'instruction' }]
    };

    expect(() => createM365Manifests(collection, workspace, {
      appId: '00000000-0000-4000-8000-000000000000',
      version: '1.0.0',
      developerName: 'Contoso',
      websiteUrl: 'https://example.com',
      privacyUrl: 'https://example.com/privacy',
      termsUrl: 'https://example.com/terms'
    })).toThrow(/8,000 character limit/);
  });
});
