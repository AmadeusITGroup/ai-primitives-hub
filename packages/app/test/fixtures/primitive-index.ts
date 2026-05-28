/**
 * Test fixtures for primitive-index tests.
 */

import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '@prompt-registry/core';

/**
 * Fake bundle provider for tests.
 */
export class FakeBundleProvider implements BundleProvider {
  public constructor(private readonly bundles: BundleRef[]) {}

  private getManifestItems(bundleId: string): { path: string; kind: string }[] {
    switch (bundleId) {
      case 'rust-onboarding': {
        return [
          { path: 'prompts/rust-setup.prompt.md', kind: 'prompt' },
          { path: 'skills/rust-linter.skill.ts', kind: 'skill' },
          { path: 'prompts/rust-debugging.prompt.md', kind: 'prompt' },
          { path: 'chat-modes/rust-expert.chat.md', kind: 'chat-mode' }
        ];
      }
      case 'code-review-kit': {
        return [
          { path: 'prompts/terraform-module.prompt.md', kind: 'prompt' },
          { path: 'skills/code-review.skill.ts', kind: 'skill' },
          { path: 'prompts/security-check.prompt.md', kind: 'prompt' }
        ];
      }
      case 'python-helper': {
        return [
          { path: 'prompts/python-helper.prompt.md', kind: 'prompt' },
          { path: 'skills/python-debugger.skill.ts', kind: 'skill' }
        ];
      }
    // No default
    }
    return [];
  }

  public async getBundle(_ref: BundleRef): Promise<BundleManifest | null> {
    const bundle = this.bundles.find((b) => b.sourceId === _ref.sourceId && b.bundleId === _ref.bundleId);
    if (!bundle) {
      return null;
    }
    // Return a manifest with realistic items
    return {
      id: bundle.bundleId,
      version: bundle.bundleVersion,
      name: bundle.bundleId,
      items: this.getManifestItems(bundle.bundleId)
    };
  }

  public async* listBundles(): AsyncIterable<BundleRef> {
    for (const bundle of this.bundles) {
      yield bundle;
    }
  }

  public async readManifest(_ref: BundleRef): Promise<BundleManifest> {
    const manifest = await this.getBundle(_ref);
    if (!manifest) {
      throw new Error(`Manifest not found for ${_ref.bundleId}`);
    }
    return manifest;
  }

  public async readFile(_ref: BundleRef, relPath: string): Promise<string> {
    // Return realistic file content based on the path
    if (relPath.includes('terraform-module')) {
      return `---
kind: prompt
title: Terraform Module Generator
description: Generate Terraform modules from natural language
tags: [terraform, infrastructure, cloud]
---
# Terraform Module Generator

This prompt helps you generate Terraform modules from natural language descriptions.
`;
    } else if (relPath.includes('code-review')) {
      return `---
kind: skill
name: code-review
description: Automated code review assistant
tags: [review, code-quality, analysis]
---
# Code Review Skill

This skill provides automated code review capabilities.
`;
    } else if (relPath.includes('python')) {
      return `---
kind: prompt
title: Python Helper
description: Python coding assistant
tags: [python, coding, assistant]
---
# Python Helper

This prompt helps with Python coding tasks.
`;
    } else if (relPath.includes('chat-mode')) {
      return `---
kind: chat-mode
name: expert-coder
description: Expert coding assistant
tags: [coding, assistant, expert]
---
# Expert Coder

This is an expert coding assistant chat mode.
`;
    }
    return '';
  }
}

/**
 * Create fixture bundles for testing.
 */
export function createFixtureBundles(): BundleRef[] {
  return [
    {
      sourceId: 'github-abc',
      sourceType: 'github',
      bundleId: 'rust-onboarding',
      bundleVersion: '1.0.0',
      installed: false
    },
    {
      sourceId: 'github-abc',
      sourceType: 'github',
      bundleId: 'code-review-kit',
      bundleVersion: '2.0.0',
      installed: false
    },
    {
      sourceId: 'github-def',
      sourceType: 'github',
      bundleId: 'python-helper',
      bundleVersion: '1.5.0',
      installed: false
    },
    {
      sourceId: 'github-abc',
      sourceType: 'github',
      bundleId: 'terraform-bundle',
      bundleVersion: '1.0.0',
      installed: true
    },
    {
      sourceId: 'github-def',
      sourceType: 'github',
      bundleId: 'devops-tools',
      bundleVersion: '2.0.0',
      installed: false
    },
    {
      sourceId: 'github-abc',
      sourceType: 'github',
      bundleId: 'web-development',
      bundleVersion: '1.0.0',
      installed: false
    },
    {
      sourceId: 'github-def',
      sourceType: 'github',
      bundleId: 'database-helper',
      bundleVersion: '1.0.0',
      installed: false
    }
  ];
}
