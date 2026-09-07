import type {
  ExtractedFiles,
} from '@ai-primitives-hub/core';

const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

const manifest = `id: foursight-pr-review
version: 1.0.0
name: FourSight PR Review
prompts:
  - id: code-review
    file: foursight-pr-review/agents/code-review.agent.md
    type: agent
  - id: security-review
    file: foursight-pr-review/agents/security-review.agent.md
    type: agent
  - id: test-review
    file: foursight-pr-review/agents/test-review.agent.md
    type: agent
  - id: docs-review
    file: foursight-pr-review/agents/docs-review.agent.md
    type: agent
  - id: architecture-review
    file: foursight-pr-review/agents/architecture-review.agent.md
    type: agent
  - id: foursight-code-review
    file: foursight-pr-review/skills/foursight-code-review/SKILL.md
    type: skill
`;

const archiveEntries = {
  'foursight-pr-review/agents/code-review.agent.md': '# Code review\n',
  'foursight-pr-review/agents/security-review.agent.md': '# Security review\n',
  'foursight-pr-review/agents/test-review.agent.md': '# Test review\n',
  'foursight-pr-review/agents/docs-review.agent.md': '# Docs review\n',
  'foursight-pr-review/agents/architecture-review.agent.md': '# Architecture review\n',
  'foursight-pr-review/skills/foursight-code-review/SKILL.md': '# Foursight skill\n',
  'foursight-pr-review/skills/foursight-code-review/assets/rubric.json': '{"severity":"high"}\n',
  'foursight-pr-review/skills/foursight-code-review/references/checklist.md': '# Checklist\n',
  'foursight-pr-review/skills/foursight-code-review/scripts/check.sh': '#!/bin/sh\nexit 0\n'
} as const;

export const createFoursightBundle = (): ExtractedFiles => new Map([
  ['deployment-manifest.yml', bytes(manifest)],
  ...Object.entries(archiveEntries).map(([filePath, content]) => [filePath, bytes(content)] as const)
]);

export const foursightArchiveEntries = archiveEntries;
