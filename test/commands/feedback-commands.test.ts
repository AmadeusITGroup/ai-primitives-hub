/**
 * Tests for FeedbackCommands
 * VS Code commands for collecting user feedback
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  FeedbackableItem,
  FeedbackCommands,
} from '../../src/commands/feedback-commands';
import {
  EngagementService,
} from '../../src/services/engagement/engagement-service';
import {
  RatingCache,
} from '../../src/services/engagement/rating-cache';
import {
  Feedback,
} from '../../src/types/engagement';

suite('FeedbackCommands', () => {
  let sandbox: sinon.SinonSandbox;
  let commands: FeedbackCommands;
  let mockEngagementService: sinon.SinonStubbedInstance<EngagementService>;
  let showInputBoxStub: sinon.SinonStub;
  let showQuickPickStub: sinon.SinonStub;
  let showInformationMessageStub: sinon.SinonStub;
  let showWarningMessageStub: sinon.SinonStub;

  const createMockItem = (overrides: Partial<FeedbackableItem> = {}): FeedbackableItem => ({
    resourceId: 'test-bundle',
    resourceType: 'bundle',
    name: 'Test Bundle',
    version: '1.0.0',
    ...overrides
  });

  const createMockFeedback = (comment: string, rating?: 1 | 2 | 3 | 4 | 5): Feedback => ({
    id: 'feedback-123',
    resourceType: 'bundle',
    resourceId: 'test-bundle',
    comment,
    rating,
    timestamp: new Date().toISOString()
  });

  setup(() => {
    sandbox = sinon.createSandbox();

    // Mock VS Code window methods
    showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
    showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick');
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
    showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');
    sandbox.stub(vscode.window, 'showErrorMessage');

    // Mock EngagementService
    mockEngagementService = {
      submitFeedback: sandbox.stub(),
      getStorage: sandbox.stub().returns({
        savePendingFeedback: sandbox.stub().resolves()
      })
    } as unknown as sinon.SinonStubbedInstance<EngagementService>;

    commands = new FeedbackCommands(mockEngagementService);
  });

  teardown(() => {
    sandbox.restore();
    RatingCache.resetInstance();
  });

  suite('submitFeedback()', () => {
    test('should submit feedback with rating and comment', async () => {
      const item = createMockItem();
      const feedback = createMockFeedback('Great bundle!', 5);

      // Mock rating selection
      showQuickPickStub.onFirstCall().resolves({
        label: '⭐⭐⭐⭐⭐',
        description: '5 stars - Excellent!'
      });
      // Mock comment input
      showInputBoxStub.onFirstCall().resolves('Great bundle!');
      // Mock action selection (Skip)
      showQuickPickStub.onSecondCall().resolves({
        label: '⏭️ Skip',
        description: 'Just submit the star rating'
      });
      mockEngagementService.submitFeedback.resolves(feedback);

      const result = await commands.submitFeedback(item);

      assert.strictEqual(result.success, true);
      assert.ok(result.feedback);
      assert.ok(showInformationMessageStub.calledOnce);
    });

    test('should return cancelled when user cancels rating selection', async () => {
      const item = createMockItem();
      showQuickPickStub.resolves(undefined);

      const result = await commands.submitFeedback(item);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Cancelled');
    });

    test('should save rating when user cancels comment input', async () => {
      const item = createMockItem();
      const feedback = createMockFeedback('Rated 4 stars', 4);

      showQuickPickStub.resolves({
        label: '⭐⭐⭐⭐☆',
        description: '4 stars - Very good'
      });
      showInputBoxStub.resolves(undefined);
      mockEngagementService.submitFeedback.resolves(feedback);

      const result = await commands.submitFeedback(item);

      assert.strictEqual(result.success, true);
      const callArgs = mockEngagementService.submitFeedback.firstCall.args;
      assert.strictEqual(callArgs[3]?.rating, 4);
    });

    test('should work without engagement service', async () => {
      const commandsWithoutService = new FeedbackCommands();
      const item = createMockItem();

      showQuickPickStub.resolves({
        label: '⭐⭐⭐☆☆',
        description: '3 stars - Good'
      });
      showInputBoxStub.resolves('Test feedback');
      showQuickPickStub.onSecondCall().resolves({
        label: '⏭️ Skip'
      });

      const result = await commandsWithoutService.submitFeedback(item);

      assert.strictEqual(result.success, true);
      assert.ok(result.feedback);
      assert.strictEqual(result.feedback.comment, 'Test feedback');
      assert.strictEqual(result.feedback.rating, 3);
    });
  });

  suite('Network Resilience', () => {
    test('should save feedback locally when remote submission fails', async () => {
      const item = createMockItem({ hubId: 'test-hub' });

      showQuickPickStub.onFirstCall().resolves({
        label: '⭐⭐⭐☆☆',
        description: '3 stars - Good'
      });
      showInputBoxStub.resolves('Test feedback');
      showQuickPickStub.onSecondCall().resolves({
        label: '⏭️ Skip'
      });
      mockEngagementService.submitFeedback.rejects(new Error('Network error'));

      const result = await commands.submitFeedback(item);

      // Feedback saved locally = success
      assert.strictEqual(result.success, true);
      assert.ok(result.feedback);
      // Warning shown instead of error
      assert.ok(showWarningMessageStub.calledOnce);
      assert.ok(showWarningMessageStub.firstCall.args[0].includes('saved locally'));
      // Pending feedback was saved
      const mockStorage = (mockEngagementService as any).getStorage();
      assert.ok(mockStorage.savePendingFeedback.calledOnce);
    });

    test('should apply optimistic rating update after submission', async () => {
      const item = createMockItem({ hubId: 'test-hub', sourceId: 'test-source' });
      const feedback = createMockFeedback('Nice!', 4);

      const ratingCache = RatingCache.getInstance();
      const applyStub = sandbox.stub(ratingCache, 'applyOptimisticRating');

      showQuickPickStub.onFirstCall().resolves({
        label: '⭐⭐⭐⭐☆',
        description: '4 stars - Very good'
      });
      showInputBoxStub.resolves('Nice!');
      showQuickPickStub.onSecondCall().resolves({
        label: '⏭️ Skip'
      });
      mockEngagementService.submitFeedback.resolves(feedback);

      await commands.submitFeedback(item);

      assert.ok(applyStub.calledOnce);
      assert.strictEqual(applyStub.firstCall.args[0], 'test-source');
      assert.strictEqual(applyStub.firstCall.args[1], 'test-bundle');
      assert.strictEqual(applyStub.firstCall.args[2], 4);
    });

    test('should mark feedback as synced when remote submission succeeds', async () => {
      const item = createMockItem({ hubId: 'test-hub' });
      const feedback = createMockFeedback('Great!', 5);

      showQuickPickStub.onFirstCall().resolves({
        label: '⭐⭐⭐⭐⭐',
        description: '5 stars - Excellent!'
      });
      showInputBoxStub.resolves('Great!');
      showQuickPickStub.onSecondCall().resolves({
        label: '⏭️ Skip'
      });
      mockEngagementService.submitFeedback.resolves(feedback);

      const result = await commands.submitFeedback(item);

      assert.strictEqual(result.success, true);
      assert.ok(showInformationMessageStub.calledOnce);
      // Pending feedback was saved with synced=true
      const mockStorage = (mockEngagementService as any).getStorage();
      assert.ok(mockStorage.savePendingFeedback.calledOnce);
      const savedEntry = mockStorage.savePendingFeedback.firstCall.args[0];
      assert.strictEqual(savedEntry.synced, true);
    });
  });

  suite('registerCommands()', () => {
    test('should register feedback commands', () => {
      const mockContext = {
        subscriptions: [] as vscode.Disposable[]
      } as vscode.ExtensionContext;

      const registerCommandStub = sandbox.stub(vscode.commands, 'registerCommand').returns({
        dispose: () => {}
      });

      commands.registerCommands(mockContext);

      assert.strictEqual(registerCommandStub.callCount, 3);
      assert.ok(registerCommandStub.calledWith('promptRegistry.feedback'));
      assert.ok(registerCommandStub.calledWith('promptRegistry.reportIssue'));
      assert.ok(registerCommandStub.calledWith('promptRegistry.requestFeature'));
    });
  });

  suite('Issue Tracker URL Encoding', () => {
    let openExternalStub: sinon.SinonStub;

    setup(() => {
      openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);
    });

    test('reportIssue URL should not double-encode markdown characters', async () => {
      const item = createMockItem({
        sourceUrl: 'https://github.com/org/repo',
        sourceType: 'github'
      });

      await commands.reportIssue(item);

      assert.ok(openExternalStub.calledOnce, 'openExternal should be called');
      const uri: vscode.Uri = openExternalStub.firstCall.args[0];
      const url = uri.toString();

      // The final URL query should contain properly encoded values
      // that decode to markdown with ## headers
      const queryString = url.split('?')[1];
      assert.ok(queryString, 'URL should have query string');

      // Decode the query once — it should produce clean markdown
      const params = new URLSearchParams(queryString);
      const body = params.get('body');
      assert.ok(body, 'body param should exist');
      assert.ok(body.includes('## Bug Description'), `body should contain "## Bug Description" after single decode, got: ${body.substring(0, 200)}`);
      assert.ok(body.includes('## Steps to Reproduce'), 'body should contain "## Steps to Reproduce"');
      assert.ok(!body.includes('%23'), `body should not contain literal %23 after decode, got: ${body.substring(0, 200)}`);
    });

    test('requestFeature URL should not double-encode markdown characters', async () => {
      const item = createMockItem({
        sourceUrl: 'https://github.com/org/repo',
        sourceType: 'github'
      });

      await commands.requestFeature(item);

      assert.ok(openExternalStub.calledOnce);
      const uri: vscode.Uri = openExternalStub.firstCall.args[0];
      const url = uri.toString();

      const queryString = url.split('?')[1];
      const params = new URLSearchParams(queryString);
      const body = params.get('body');
      assert.ok(body, 'body param should exist');
      assert.ok(body.includes('## Feature Description'), `body should contain "## Feature Description" after single decode, got: ${body.substring(0, 200)}`);
      assert.ok(!body.includes('%23'), `body should not contain literal %23 after decode`);
      assert.ok(!body.includes('%3F'), `body should not contain literal %3F after decode`);
    });
  });

  suite('drainUnsyncedFeedback()', () => {
    test('returns 0 and does not submit when storage is empty', async () => {
      const mockStorage = {
        savePendingFeedback: sandbox.stub().resolves(),
        getUnsyncedFeedback: sandbox.stub().resolves([]),
        markFeedbackSynced: sandbox.stub().resolves()
      };
      (mockEngagementService.getStorage as sinon.SinonStub).returns(mockStorage);

      const result = await commands.drainUnsyncedFeedback();

      assert.strictEqual(result, 0);
      assert.strictEqual(mockEngagementService.submitFeedback.callCount, 0);
      assert.strictEqual(mockStorage.markFeedbackSynced.callCount, 0);
    });

    test('submits and marks all entries synced when all succeed', async () => {
      const entries = [
        { id: 'e1', bundleId: 'b1', sourceId: 'b1', hubId: 'h1', resourceType: 'bundle', rating: 5, comment: 'one', timestamp: 't1', synced: false },
        { id: 'e2', bundleId: 'b2', sourceId: 'b2', hubId: 'h2', resourceType: 'bundle', rating: 4, comment: undefined, timestamp: 't2', synced: false },
        { id: 'e3', bundleId: 'b3', sourceId: 'b3', hubId: '', resourceType: 'bundle', rating: 3, comment: 'three', timestamp: 't3', synced: false }
      ];
      const mockStorage = {
        savePendingFeedback: sandbox.stub().resolves(),
        getUnsyncedFeedback: sandbox.stub().resolves(entries),
        markFeedbackSynced: sandbox.stub().resolves()
      };
      (mockEngagementService.getStorage as sinon.SinonStub).returns(mockStorage);
      mockEngagementService.submitFeedback.resolves(createMockFeedback('ok', 5));

      const result = await commands.drainUnsyncedFeedback();

      assert.strictEqual(result, 3);
      assert.strictEqual(mockEngagementService.submitFeedback.callCount, 3);

      const firstArgs = mockEngagementService.submitFeedback.firstCall.args;
      assert.strictEqual(firstArgs[0], 'bundle');
      assert.strictEqual(firstArgs[1], 'b1');
      assert.strictEqual(firstArgs[2], 'one');
      assert.deepStrictEqual(firstArgs[3], { rating: 5, hubId: 'h1' });

      // Entry 2 has no comment → fallback string
      const secondArgs = mockEngagementService.submitFeedback.secondCall.args;
      assert.strictEqual(secondArgs[2], 'Rated 4 stars');

      // Entry 3 has empty hubId → undefined
      const thirdArgs = mockEngagementService.submitFeedback.thirdCall.args;
      assert.deepStrictEqual(thirdArgs[3], { rating: 3, hubId: undefined });

      assert.strictEqual(mockStorage.markFeedbackSynced.callCount, 3);
      assert.ok(mockStorage.markFeedbackSynced.calledWith('e1'));
      assert.ok(mockStorage.markFeedbackSynced.calledWith('e2'));
      assert.ok(mockStorage.markFeedbackSynced.calledWith('e3'));
    });

    test('returns success count and leaves failed entries unsynced on partial failure', async () => {
      const entries = [
        { id: 'e1', bundleId: 'b1', sourceId: 'b1', hubId: 'h1', resourceType: 'bundle', rating: 5, comment: 'one', timestamp: 't1', synced: false },
        { id: 'e2', bundleId: 'b2', sourceId: 'b2', hubId: 'h2', resourceType: 'bundle', rating: 4, comment: 'two', timestamp: 't2', synced: false },
        { id: 'e3', bundleId: 'b3', sourceId: 'b3', hubId: 'h3', resourceType: 'bundle', rating: 3, comment: 'three', timestamp: 't3', synced: false }
      ];
      const mockStorage = {
        savePendingFeedback: sandbox.stub().resolves(),
        getUnsyncedFeedback: sandbox.stub().resolves(entries),
        markFeedbackSynced: sandbox.stub().resolves()
      };
      (mockEngagementService.getStorage as sinon.SinonStub).returns(mockStorage);

      // Fail only entry 2 (by bundleId b2)
      mockEngagementService.submitFeedback.callsFake(async (_rt: any, resourceId: string) => {
        if (resourceId === 'b2') {
          throw new Error('Network error');
        }
        return createMockFeedback('ok', 5);
      });

      const result = await commands.drainUnsyncedFeedback();

      assert.strictEqual(result, 2);
      assert.strictEqual(mockStorage.markFeedbackSynced.callCount, 2);
      assert.ok(mockStorage.markFeedbackSynced.calledWith('e1'));
      assert.ok(!mockStorage.markFeedbackSynced.calledWith('e2'));
      assert.ok(mockStorage.markFeedbackSynced.calledWith('e3'));
    });
  });

  suite('setEngagementService()', () => {
    test('should allow setting engagement service after construction', async () => {
      const commandsWithoutService = new FeedbackCommands();
      const item = createMockItem();
      const feedback = createMockFeedback('Test', 3);

      // First call without service
      showQuickPickStub.onFirstCall().resolves({
        label: '⭐⭐⭐☆☆',
        description: '3 stars - Good'
      });
      showInputBoxStub.onFirstCall().resolves('Test');
      showQuickPickStub.onSecondCall().resolves({
        label: '⏭️ Skip'
      });
      const result1 = await commandsWithoutService.submitFeedback(item);
      assert.strictEqual(result1.success, true);

      // Set service and call again
      commandsWithoutService.setEngagementService(mockEngagementService);
      showQuickPickStub.onThirdCall().resolves({
        label: '⭐⭐⭐☆☆',
        description: '3 stars - Good'
      });
      showInputBoxStub.onSecondCall().resolves('Test 2');
      showQuickPickStub.onCall(3).resolves({
        label: '⏭️ Skip'
      });
      mockEngagementService.submitFeedback.resolves(feedback);

      const result2 = await commandsWithoutService.submitFeedback(item);
      assert.strictEqual(result2.success, true);
      assert.ok(mockEngagementService.submitFeedback.calledOnce);
    });
  });
});
