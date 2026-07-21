import * as assert from 'node:assert';
import {
  BundleIdentityMatcher,
  extractGitHubMetadata,
} from '../../src/utils/bundle-identity-matcher';

suite('BundleIdentityMatcher', () => {
  suite('matchesAwesomeCopilotToGithub()', () => {
    const sourceMetadata = { owner: 'owner', repo: 'repo' };

    test('matches awesome-copilot ID against github collection ID with source metadata', () => {
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'azure-development',
        'owner-repo-azure-development-1.0.0',
        sourceMetadata
      );
      assert.strictEqual(result, true);
    });

    test('matches github bundle ID with v prefix version', () => {
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'azure-development',
        'owner-repo-azure-development-v1.0.0',
        sourceMetadata
      );
      assert.strictEqual(result, true);
    });

    test('does not match when awesome-copilot ID differs from collection ID', () => {
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'python-tools',
        'owner-repo-azure-development-1.0.0',
        sourceMetadata
      );
      assert.strictEqual(result, false);
    });

    test('matches hyphenated collection IDs with precise owner/repo', () => {
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'my-cool-bundle',
        'org-repo-my-cool-bundle-2.0.0',
        { owner: 'org', repo: 'repo' }
      );
      assert.strictEqual(result, true);
    });

    test('does NOT match without source metadata', () => {
      // Without metadata the matcher refuses to match — partial-suffix
      // heuristics risk data corruption.
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'azure-development',
        'owner-repo-azure-development-1.0.0',
        undefined
      );
      assert.strictEqual(result, false);
    });

    test('does NOT match partial suffix even with source metadata', () => {
      // 'development' must not be matched to a github bundle whose collection
      // is 'azure-development' — only exact collection-id equality matches.
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'development',
        'owner-repo-azure-development-1.0.0',
        sourceMetadata
      );
      assert.strictEqual(result, false);
    });

    test('does not match when github ID does not start with owner-repo prefix', () => {
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'azure-development',
        'other-org-repo-azure-development-1.0.0',
        sourceMetadata
      );
      assert.strictEqual(result, false);
    });

    test('does not match single-collection github bundle IDs (no collection segment)', () => {
      // Single-collection repos: `{owner}-{repo}-{tagName}` with no collection
      const result = BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
        'azure-development',
        'owner-repo-v1.0.0',
        sourceMetadata
      );
      assert.strictEqual(result, false);
    });
  });

  suite('extractGitHubMetadata()', () => {
    test('extracts owner and repo from canonical https URL', () => {
      const result = extractGitHubMetadata('https://github.com/octocat/hello-world');
      assert.deepStrictEqual(result, { owner: 'octocat', repo: 'hello-world' });
    });

    test('strips .git suffix from repo name', () => {
      const result = extractGitHubMetadata('https://github.com/octocat/hello-world.git');
      assert.deepStrictEqual(result, { owner: 'octocat', repo: 'hello-world' });
    });

    test('is case-insensitive for host', () => {
      const result = extractGitHubMetadata('https://GitHub.com/Octocat/Hello-World');
      assert.deepStrictEqual(result, { owner: 'Octocat', repo: 'Hello-World' });
    });

    test('returns undefined for non-GitHub URLs', () => {
      const result = extractGitHubMetadata('https://example.com/foo/bar');
      assert.strictEqual(result, undefined);
    });
  });
});
