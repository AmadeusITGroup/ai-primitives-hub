/**
 * Tests for GitHubDiscussionsBackend
 * GitHub Discussions-based engagement backend
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  GitHubDiscussionsBackend,
} from '../../../../src/services/engagement/backends/github-discussions-backend';
import {
  Feedback,
  GitHubDiscussionsBackendConfig,
  Rating,
} from '../../../../src/types/engagement';

suite('GitHubDiscussionsBackend', () => {
  let sandbox: sinon.SinonSandbox;
  let backend: GitHubDiscussionsBackend;
  let tempDir: string;

  const mockConfig: GitHubDiscussionsBackendConfig = {
    type: 'github-discussions',
    repository: 'test-owner/test-repo',
    category: 'Feedback'
  };

  const mockSession = {
    accessToken: 'mock-token',
    account: { id: '123', label: 'testuser' },
    id: 'session-id',
    scopes: ['repo']
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-discussions-test-'));
    backend = new GitHubDiscussionsBackend(tempDir);

    // Mock VS Code authentication
    sandbox.stub(vscode.authentication, 'getSession').resolves(mockSession);
  });

  teardown(() => {
    sandbox.restore();
    nock.cleanAll();
    if (backend.initialized) {
      backend.dispose();
    }
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('initialize()', () => {
    test('should initialize with valid config', async () => {
      await backend.initialize(mockConfig);
      assert.strictEqual(backend.initialized, true);
    });

    test('should throw error for invalid config type', async () => {
      await assert.rejects(
        backend.initialize({ type: 'file', storagePath: '/tmp' } as any),
        /Invalid config type/
      );
    });

    test('should throw error for invalid repository format', async () => {
      await assert.rejects(
        backend.initialize({ ...mockConfig, repository: 'invalid' }),
        /Invalid repository format/
      );
    });
  });

  suite('dispose()', () => {
    test('should clean up resources', async () => {
      await backend.initialize(mockConfig);
      backend.dispose();
      assert.strictEqual(backend.initialized, false);
    });
  });

  suite('setDiscussionMapping()', () => {
    test('should set mapping for resource', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42);
      // Mapping is internal, but we can verify it works via submitRating
    });

    test('should set mapping with comment ID', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42, 101);
    });
  });

  suite('Rating Operations', () => {
    test('should fall back to local storage when no mapping exists', async () => {
      await backend.initialize(mockConfig);

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'unmapped-bundle',
        score: 4,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);
      const retrieved = await backend.getRating('bundle', 'unmapped-bundle');
      assert.ok(retrieved);
      assert.strictEqual(retrieved.score, 4);
    });

    test('should submit rating via GitHub API when mapping exists', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42);

      // Mock GraphQL: getDiscussionNodeId
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: { repository: { discussion: { id: 'D_kwDOTest42' } } }
        });

      // Mock GraphQL: removeExistingReaction (2 calls: THUMBS_UP + THUMBS_DOWN)
      nock('https://api.github.com')
        .post('/graphql')
        .times(2)
        .reply(200, {
          data: { removeReaction: { reaction: null } }
        });

      // Mock GraphQL: addReaction
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: { addReaction: { reaction: { content: 'THUMBS_UP' } } }
        });

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'bundle-1',
        score: 5,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);

      // Verify vote is cached in memory
      const retrieved = await backend.getRating('bundle', 'bundle-1');
      assert.ok(retrieved);
      assert.strictEqual(retrieved.score, 5);
    });

    test('should persist rating to local storage on successful GitHub submit', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42);

      // Mock all 4 GraphQL calls in sequence (nock matches in order for same endpoint)
      nock('https://api.github.com')
        .post('/graphql').reply(200, { data: { repository: { discussion: { id: 'D_kwDOTest42' } } } })
        .post('/graphql').reply(200, { data: { removeReaction: { reaction: null } } })
        .post('/graphql').reply(200, { data: { removeReaction: { reaction: null } } })
        .post('/graphql').reply(200, { data: { addReaction: { reaction: { content: 'THUMBS_UP' } } } });

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'bundle-1',
        score: 4,
        sourceId: 'otter',
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);

      // Verify the GitHub path succeeded (not the error fallback)
      assert.ok(nock.isDone(), 'All GraphQL mocks must have been consumed (success path, not error fallback)');

      // Create a fresh backend reading from the same temp dir to verify persistence
      const freshBackend = new GitHubDiscussionsBackend(tempDir);
      await freshBackend.initialize(mockConfig);

      const persisted = await freshBackend.getRating('bundle', 'bundle-1');
      assert.ok(persisted, 'Rating must be persisted to local storage after successful GitHub submit');
      assert.strictEqual(persisted.score, 4);
      assert.strictEqual(persisted.sourceId, 'otter');

      freshBackend.dispose();
    });

    test('should handle GitHub API errors gracefully', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42);

      // Mock GitHub API error
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/discussions/42/reactions')
        .reply(500, { message: 'Internal Server Error' });

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'bundle-1',
        score: 4,
        timestamp: new Date().toISOString()
      };

      // Should not throw - falls back to local storage
      await backend.submitRating(rating);
    });

    test('should delete rating', async () => {
      await backend.initialize(mockConfig);

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'test-bundle',
        score: 3,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);
      await backend.deleteRating('bundle', 'test-bundle');
      const retrieved = await backend.getRating('bundle', 'test-bundle');
      assert.strictEqual(retrieved, undefined);
    });

    test('should post a rating comment to the discussion on successful submit', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42);

      let capturedCommentBody = '';

      nock('https://api.github.com')
        // getDiscussionNodeId
        .post('/graphql').reply(200, { data: { repository: { discussion: { id: 'D_kwDOTest42' } } } })
        // removeExistingReaction x2
        .post('/graphql').reply(200, { data: { removeReaction: { reaction: null } } })
        .post('/graphql').reply(200, { data: { removeReaction: { reaction: null } } })
        // addReaction
        .post('/graphql').reply(200, { data: { addReaction: { reaction: { content: 'THUMBS_UP' } } } })
        // findViewerComment (no existing)
        .post('/graphql').reply(200, { data: { repository: { discussion: { comments: { nodes: [] } } } } })
        // getDiscussionNodeId (for addDiscussionComment)
        .post('/graphql').reply(200, { data: { repository: { discussion: { id: 'D_kwDOTest42' } } } })
        // addDiscussionComment
        .post('/graphql', (body: any) => {
          capturedCommentBody = body.variables?.body || '';
          return true;
        }).reply(200, { data: { addDiscussionComment: { comment: { id: 'DC_new', body: '' } } } });

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'bundle-1',
        score: 4,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);

      assert.ok(nock.isDone(), 'All mocks consumed (comment was posted)');
      assert.ok(capturedCommentBody.includes('⭐⭐⭐⭐'), 'Comment body should contain 4 stars');
      assert.ok(capturedCommentBody.startsWith('Rating:'), 'Comment should start with Rating:');
    });

    test('should edit existing comment when re-rating', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('bundle-1', 42);

      let capturedUpdateBody = '';

      nock('https://api.github.com')
        // getDiscussionNodeId
        .post('/graphql').reply(200, { data: { repository: { discussion: { id: 'D_kwDOTest42' } } } })
        // removeExistingReaction x2
        .post('/graphql').reply(200, { data: { removeReaction: { reaction: null } } })
        .post('/graphql').reply(200, { data: { removeReaction: { reaction: null } } })
        // addReaction
        .post('/graphql').reply(200, { data: { addReaction: { reaction: { content: 'THUMBS_UP' } } } })
        // findViewerComment (found existing rating comment by testuser)
        .post('/graphql').reply(200, {
          data: {
            repository: {
              discussion: {
                comments: {
                  nodes: [{ id: 'DC_existing', author: { login: 'testuser' }, body: 'Rating: ⭐⭐⭐' }]
                }
              }
            }
          }
        })
        // updateDiscussionComment (edit in place)
        .post('/graphql', (body: any) => {
          capturedUpdateBody = body.variables?.body || '';
          return true;
        }).reply(200, { data: { updateDiscussionComment: { comment: { id: 'DC_existing', body: '' } } } });

      const rating: Rating = {
        id: 'rating-2',
        resourceType: 'bundle',
        resourceId: 'bundle-1',
        score: 5,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);

      assert.ok(nock.isDone(), 'All mocks consumed (comment was edited, not new one created)');
      assert.ok(capturedUpdateBody.includes('⭐⭐⭐⭐⭐'), 'Updated body should contain 5 stars');
    });
  });

  suite('Feedback Operations', () => {
    test('should submit and retrieve feedback locally when no mapping exists', async () => {
      await backend.initialize(mockConfig);

      const feedback: Feedback = {
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'test-bundle',
        comment: 'Great bundle!',
        timestamp: new Date().toISOString()
      };

      await backend.submitFeedback(feedback);
      const retrieved = await backend.getFeedback('bundle', 'test-bundle');
      assert.strictEqual(retrieved.length, 1);
      assert.strictEqual(retrieved[0].comment, 'Great bundle!');
    });

    test('should delete feedback', async () => {
      await backend.initialize(mockConfig);

      const feedback: Feedback = {
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'test-bundle',
        comment: 'Test feedback',
        timestamp: new Date().toISOString()
      };

      await backend.submitFeedback(feedback);
      await backend.deleteFeedback('feedback-1');
      const retrieved = await backend.getFeedback('bundle', 'test-bundle');
      assert.strictEqual(retrieved.length, 0);
    });

    test('should post feedback as GitHub Discussion comment when mapping exists', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('source-1:bundle-1', 42);

      // Mock GraphQL API for getting discussion node ID
      const graphqlScope = nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                id: 'D_kwDOTest123'
              }
            }
          }
        });

      // Mock GraphQL API for adding comment
      const commentScope = nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            addDiscussionComment: {
              comment: {
                id: 'DC_kwDOComment456',
                body: '**Feedback** (5 ⭐)\n\nGreat bundle!'
              }
            }
          }
        });

      const feedback: Feedback = {
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'source-1:bundle-1',
        comment: 'Great bundle!',
        rating: 5,
        timestamp: new Date().toISOString()
      };

      await backend.submitFeedback(feedback);

      // Verify GraphQL calls were made
      assert.ok(graphqlScope.isDone(), 'Should have called GraphQL to get discussion ID');
      assert.ok(commentScope.isDone(), 'Should have called GraphQL to add comment');

      // Should also store locally
      const retrieved = await backend.getFeedback('bundle', 'source-1:bundle-1');
      assert.strictEqual(retrieved.length, 1);
    });

    test('should fall back to local storage when GitHub API fails', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('source-1:bundle-1', 42);

      // Mock GraphQL API failure
      nock('https://api.github.com')
        .post('/graphql')
        .reply(500, { message: 'Internal Server Error' });

      const feedback: Feedback = {
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'source-1:bundle-1',
        comment: 'Great bundle!',
        rating: 4,
        timestamp: new Date().toISOString()
      };

      // Should not throw - falls back to local storage
      await backend.submitFeedback(feedback);

      // Should still be stored locally
      const retrieved = await backend.getFeedback('bundle', 'source-1:bundle-1');
      assert.strictEqual(retrieved.length, 1);
      assert.strictEqual(retrieved[0].comment, 'Great bundle!');
    });

    test('should format feedback comment with rating stars', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('source-1:bundle-1', 42);

      let capturedBody = '';

      // Mock GraphQL API for finding existing comment (none found)
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                comments: {
                  nodes: []
                }
              }
            }
          }
        });

      // Mock GraphQL API for getting discussion node ID
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                id: 'D_kwDOTest123'
              }
            }
          }
        });

      // Mock GraphQL API for adding comment - capture the body
      nock('https://api.github.com')
        .post('/graphql', (body: any) => {
          capturedBody = body.variables?.body || '';
          return true;
        })
        .reply(200, {
          data: {
            addDiscussionComment: {
              comment: {
                id: 'DC_kwDOComment456',
                body: capturedBody
              }
            }
          }
        });

      const feedback: Feedback = {
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'source-1:bundle-1',
        comment: '[+1] Works great!',
        rating: 5,
        timestamp: new Date().toISOString()
      };

      await backend.submitFeedback(feedback);

      // Verify the comment body contains rating stars
      assert.ok(capturedBody.includes('⭐'), 'Comment should include star rating');
      assert.ok(capturedBody.includes('Works great!'), 'Comment should include feedback text');
    });

    test('should handle feedback without rating', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('source-1:bundle-1', 42);

      // Mock GraphQL API for finding existing comment (none found)
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                comments: {
                  nodes: []
                }
              }
            }
          }
        });

      // Mock GraphQL API for getting discussion node ID
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                id: 'D_kwDOTest123'
              }
            }
          }
        });

      // Mock GraphQL API for adding comment
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            addDiscussionComment: {
              comment: {
                id: 'DC_kwDOComment456',
                body: '**Feedback**\n\nJust a comment'
              }
            }
          }
        });

      const feedback: Feedback = {
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'source-1:bundle-1',
        comment: 'Just a comment',
        // No rating
        timestamp: new Date().toISOString()
      };

      await backend.submitFeedback(feedback);

      // Should store locally
      const retrieved = await backend.getFeedback('bundle', 'source-1:bundle-1');
      assert.strictEqual(retrieved.length, 1);
    });
  });

  suite('getResourceEngagement()', () => {
    test('should aggregate engagement data', async () => {
      await backend.initialize(mockConfig);

      await backend.submitFeedback({
        id: 'feedback-1',
        resourceType: 'bundle',
        resourceId: 'test-bundle',
        comment: 'Nice!',
        timestamp: new Date().toISOString()
      });

      const engagement = await backend.getResourceEngagement('bundle', 'test-bundle');

      assert.strictEqual(engagement.resourceId, 'test-bundle');
      assert.strictEqual(engagement.resourceType, 'bundle');
      assert.ok(engagement.recentFeedback);
      assert.strictEqual(engagement.recentFeedback.length, 1);
    });
  });

  suite('loadCollectionsMappings()', () => {
    test('should load mappings from collections.yaml URL', async () => {
      await backend.initialize(mockConfig);

      const collectionsYaml = `
repository: test-owner/test-repo
collections:
  - id: bundle-1
    source_id: source-1
    discussion_number: 10
  - id: bundle-2
    source_id: source-2
    discussion_number: 20
`;

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-repo/main/collections.yaml')
        .reply(200, collectionsYaml);

      await backend.loadCollectionsMappings('https://raw.githubusercontent.com/test-owner/test-repo/main/collections.yaml');

      // Verify mappings were set by attempting to submit ratings
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/discussions/10/reactions')
        .reply(200, []);
      nock('https://api.github.com')
        .post('/repos/test-owner/test-repo/discussions/10/reactions')
        .reply(201, { id: 1, content: '+1' });

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'source-1:bundle-1',
        score: 5,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);
      const retrieved = await backend.getRating('bundle', 'source-1:bundle-1');
      assert.ok(retrieved);
      assert.strictEqual(retrieved.score, 5);
    });

    test('should handle HTTP errors when fetching collections.yaml', async () => {
      await backend.initialize(mockConfig);

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-repo/main/collections.yaml')
        .reply(404, 'Not Found');

      await assert.rejects(
        backend.loadCollectionsMappings('https://raw.githubusercontent.com/test-owner/test-repo/main/collections.yaml'),
        /Failed to load collections mappings/
      );
    });

    test('should handle invalid YAML format', async () => {
      await backend.initialize(mockConfig);

      const invalidYaml = 'invalid: yaml: content:';

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-repo/main/collections.yaml')
        .reply(200, invalidYaml);

      await assert.rejects(
        backend.loadCollectionsMappings('https://raw.githubusercontent.com/test-owner/test-repo/main/collections.yaml'),
        /Failed to parse collections mappings/
      );
    });

    test('should require backend to be initialized', async () => {
      await assert.rejects(
        backend.loadCollectionsMappings('https://example.com/collections.yaml'),
        /not initialized/
      );
    });

    test('should handle collections with comment IDs', async () => {
      await backend.initialize(mockConfig);

      const collectionsYaml = `
repository: test-owner/test-repo
collections:
  - id: bundle-1
    source_id: source-1
    discussion_number: 10
    comment_id: 100
`;

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-repo/main/collections.yaml')
        .reply(200, collectionsYaml);

      await backend.loadCollectionsMappings('https://raw.githubusercontent.com/test-owner/test-repo/main/collections.yaml');

      // Verify mapping with comment ID
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/discussions/comments/100/reactions')
        .reply(200, []);
      nock('https://api.github.com')
        .post('/repos/test-owner/test-repo/discussions/comments/100/reactions')
        .reply(201, { id: 1, content: '+1' });

      const rating: Rating = {
        id: 'rating-1',
        resourceType: 'bundle',
        resourceId: 'source-1:bundle-1',
        score: 5,
        timestamp: new Date().toISOString()
      };

      await backend.submitRating(rating);
    });
  });

  suite('getDiscussionMapping()', () => {
    test('should return discussion mapping for valid resource ID', async () => {
      await backend.initialize(mockConfig);

      // Set a discussion mapping
      backend.setDiscussionMapping('source-1:bundle-1', 123);

      // Get the mapping
      const mapping = backend.getDiscussionMapping('source-1:bundle-1');

      assert.ok(mapping);
      assert.strictEqual(mapping.resourceId, 'source-1:bundle-1');
      assert.strictEqual(mapping.discussionNumber, 123);
      assert.strictEqual(mapping.commentId, undefined);
    });

    test('should return discussion mapping with comment ID', async () => {
      await backend.initialize(mockConfig);

      // Set a discussion mapping with comment ID
      backend.setDiscussionMapping('source-1:bundle-1', 123, 456);

      // Get the mapping
      const mapping = backend.getDiscussionMapping('source-1:bundle-1');

      assert.ok(mapping);
      assert.strictEqual(mapping.resourceId, 'source-1:bundle-1');
      assert.strictEqual(mapping.discussionNumber, 123);
      assert.strictEqual(mapping.commentId, 456);
    });

    test('should return undefined for non-existent resource ID', async () => {
      await backend.initialize(mockConfig);

      const mapping = backend.getDiscussionMapping('non-existent:bundle');

      assert.strictEqual(mapping, undefined);
    });

    test('should return updated mapping after overwrite', async () => {
      await backend.initialize(mockConfig);

      // Set initial mapping
      backend.setDiscussionMapping('source-1:bundle-1', 123);

      // Overwrite with new mapping
      backend.setDiscussionMapping('source-1:bundle-1', 456, 789);

      // Get the mapping
      const mapping = backend.getDiscussionMapping('source-1:bundle-1');

      assert.ok(mapping);
      assert.strictEqual(mapping.discussionNumber, 456);
      assert.strictEqual(mapping.commentId, 789);
    });
  });

  suite('getRepository()', () => {
    test('should return repository owner and name', async () => {
      await backend.initialize(mockConfig);

      const repo = backend.getRepository();

      assert.strictEqual(repo.owner, 'test-owner');
      assert.strictEqual(repo.repo, 'test-repo');
    });

    test('should throw when not initialized', () => {
      assert.throws(
        () => backend.getRepository(),
        /not initialized/
      );
    });
  });

  suite('fetchViewerRatings()', () => {
    test('should return ratings parsed from viewer comments across discussions', async () => {
      await backend.initialize(mockConfig);
      backend.setDiscussionMapping('otter:otter-bundle', 9);
      backend.setDiscussionMapping('otter:fox-bundle', 10);

      // Mock: GraphQL search for viewer's discussions
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            search: {
              nodes: [
                { number: 9 },
                { number: 10 },
                { number: 99 }
              ]
            }
          }
        });

      // Mock: fetch comments for discussion #9
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                comments: {
                  nodes: [
                    { id: 'DC_1', author: { login: 'testuser' }, body: 'Rating: ⭐⭐⭐' },
                    { id: 'DC_other', author: { login: 'otheruser' }, body: 'Rating: ⭐⭐⭐⭐⭐' }
                  ]
                }
              }
            }
          }
        });

      // Mock: fetch comments for discussion #10
      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              discussion: {
                comments: {
                  nodes: [
                    { id: 'DC_2', author: { login: 'testuser' }, body: 'Rating: ⭐⭐⭐⭐⭐' }
                  ]
                }
              }
            }
          }
        });

      const results = await backend.fetchViewerRatings();

      assert.strictEqual(results.length, 2);
      assert.deepStrictEqual(results[0], { resourceId: 'otter:otter-bundle', score: 3 });
      assert.deepStrictEqual(results[1], { resourceId: 'otter:fox-bundle', score: 5 });
    });

    test('should return empty array when search finds no discussions', async () => {
      await backend.initialize(mockConfig);

      nock('https://api.github.com')
        .post('/graphql')
        .reply(200, { data: { search: { nodes: [] } } });

      const results = await backend.fetchViewerRatings();
      assert.deepStrictEqual(results, []);
    });

    test('should return empty array on API error', async () => {
      await backend.initialize(mockConfig);

      nock('https://api.github.com')
        .post('/graphql')
        .reply(500, { message: 'Internal Server Error' });

      const results = await backend.fetchViewerRatings();
      assert.deepStrictEqual(results, []);
    });
  });

  suite('Error Handling', () => {
    test('should throw when not initialized', async () => {
      await assert.rejects(
        backend.getRating('bundle', 'test'),
        /not initialized/
      );
    });
  });
});
