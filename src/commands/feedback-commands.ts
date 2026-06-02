/**
 * FeedbackCommands - VS Code commands for collecting user feedback
 *
 * Provides a unified dialog for users to submit feedback on bundles and profiles.
 * The dialog includes:
 * - Star rating (1-5)
 * - Binary feedback (+1 Works great / -1 Couldn't make it work)
 * - Optional redirect to GitHub issues for bug reports/suggestions
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  EngagementService,
} from '../services/engagement/engagement-service';
import {
  RatingCache,
} from '../services/engagement/rating-cache';
import {
  EngagementResourceType,
  Feedback,
  RatingScore,
} from '../types/engagement';
import {
  PendingFeedback,
} from '../types/pending-feedback';
import {
  Logger,
} from '../utils/logger';

/**
 * Item that can receive feedback
 */
export interface FeedbackableItem {
  /** Resource ID (bundle ID, profile ID, etc.) */
  resourceId: string;
  /** Resource type */
  resourceType: EngagementResourceType;
  /** Display name for the resource */
  name?: string;
  /** Version of the resource */
  version?: string;
  /** Source repository URL for issue redirect */
  sourceUrl?: string;
  /** Source type (github, awesome-copilot, etc.) for terminology */
  sourceType?: string;
  /** Hub ID for routing feedback to correct backend */
  hubId?: string;
  /** Source ID for cache key matching */
  sourceId?: string;
  /** Pre-filled rating from webview (skips QuickPick) */
  prefilledRating?: RatingScore;
  /** Pre-filled comment from webview (skips InputBox) */
  prefilledComment?: string;
}

/**
 * Feedback submission result
 */
export interface FeedbackResult {
  success: boolean;
  feedback?: Feedback;
  error?: string;
}

/**
 * Commands for feedback collection
 */
export class FeedbackCommands {
  private readonly logger = Logger.getInstance();
  private engagementService?: EngagementService;
  private readonly maxCommentLength: number;

  constructor(engagementService?: EngagementService, maxCommentLength = 1000) {
    this.engagementService = engagementService;
    this.maxCommentLength = maxCommentLength;
  }

  /**
   * Normalize various input types to FeedbackableItem
   * Handles TreeView items, direct FeedbackableItem, or bundleId strings
   * @param item
   */
  private normalizeFeedbackItem(item: unknown): FeedbackableItem {
    // If it's already a FeedbackableItem
    if (item !== null && typeof item === 'object' && 'resourceId' in item && 'resourceType' in item) {
      return item as FeedbackableItem;
    }

    // If it's a TreeView item with data (InstalledBundle)
    if (item !== null && typeof item === 'object' && 'data' in item) {
      const obj = item as Record<string, unknown>;
      const data = obj.data as Record<string, unknown> | undefined;
      if (data?.bundleId) {
        return {
          resourceId: data.bundleId as string,
          resourceType: 'bundle',
          name: (obj.label as string | undefined) || (data.bundleId as string),
          version: data.version as string | undefined
        };
      }
    }

    // If it's a direct InstalledBundle or Bundle object
    if (item !== null && typeof item === 'object' && 'bundleId' in item) {
      const obj = item as Record<string, unknown>;
      return {
        resourceId: obj.bundleId as string,
        resourceType: 'bundle',
        name: (obj.name as string | undefined) || (obj.bundleId as string),
        version: obj.version as string | undefined
      };
    }

    // If it's just a string (bundleId)
    if (typeof item === 'string') {
      return {
        resourceId: item,
        resourceType: 'bundle',
        name: item
      };
    }

    // Default fallback - prompt user to select
    return {
      resourceId: 'unknown',
      resourceType: 'bundle',
      name: 'Unknown Resource'
    };
  }

  /**
   * Resolve a GitHub issues URL from a source repository URL.
   * Strips .git suffix and extracts the base GitHub repo URL, then appends /issues/new.
   * @param sourceUrl
   */
  private resolveIssueUrl(sourceUrl: string): string {
    let issueUrl = sourceUrl;
    if (issueUrl.endsWith('.git')) {
      issueUrl = issueUrl.slice(0, -4);
    }
    const githubMatch = issueUrl.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)/);
    if (githubMatch) {
      return `${githubMatch[1]}/issues/new`;
    }
    if (!issueUrl.includes('/issues')) {
      return `${issueUrl}/issues/new`;
    }
    return issueUrl;
  }

  /**
   * Open the issue tracker for the bundle's source repository
   * @param item
   */
  private async openIssueTracker(item: FeedbackableItem): Promise<void> {
    try {
      this.logger.debug(`Opening issue tracker for ${item.resourceId}`);

      if (item.sourceUrl) {
        // Extract skill path from original URL (before resolving .git/base URL)
        let skillPath: string | undefined;
        const skillsMatch = item.sourceUrl.match(/\/skills\/([^/]+)/);
        if (skillsMatch) {
          skillPath = `skills/${skillsMatch[1]}`;
          this.logger.debug(`Extracted skill path: ${skillPath}`);
        }

        // Resolve the GitHub issues URL
        const issueUrl = this.resolveIssueUrl(item.sourceUrl);

        this.logger.debug(`Issue URL: ${issueUrl}`);

        // Use correct terminology based on source type
        // awesome-copilot sources ARE collections, others are bundles
        const isAwesomeCopilot = item.sourceType === 'awesome-copilot';
        const itemType = isAwesomeCopilot ? 'Collection' : 'Bundle';

        // Build issue body
        const title = `[Feedback] ${item.name || item.resourceId}`;

        // Build body parts
        const bodyParts: string[] = [
          '<!-- This is an example issue template. Feel free to modify the content to fit your needs -->',
          `${itemType} Information`,
          `- **${itemType} ID:** ${item.resourceId}`
        ];

        // Add skill path if present
        if (skillPath) {
          bodyParts.push(`- **Skill Path:** ${skillPath}`);
        }

        if (!isAwesomeCopilot && item.version) {
          bodyParts.push(`- **Version:** ${item.version}`);
        }

        bodyParts.push(
          '',
          'Issue Type:',
          '_Select one: Bug Report / Feature Request / Question / Other_',
          '',
          '- [ ] Bug Report',
          '- [ ] Feature Request',
          '- [ ] Question',
          '- [ ] Other',
          '',
          'Description:',
          '_Please describe your issue, suggestion, or question in detail_',
          '',
          '',
          'Steps to Reproduce (for bugs):',
          '_If reporting a bug, please list the steps to reproduce it_',
          '',
          '1. ',
          '2. ',
          '3. ',
          '',
          'Expected Behavior:',
          '_What did you expect to happen?_',
          '',
          '',
          'Additional Context:',
          '_Any other information that might be helpful_',
          ''
        );

        const body = bodyParts.join('\n');

        const params = new URLSearchParams({
          title,
          body
        });

        const uri = vscode.Uri.parse(
          `${issueUrl}?${params.toString()}`, true
        );

        await vscode.env.openExternal(uri);
      } else {
        // Fallback: try to open via the existing command
        await vscode.commands.executeCommand('promptregistry.openItemRepository', {
          type: 'bundle',
          data: { bundleId: item.resourceId, sourceId: item.resourceId }
        });
        vscode.window.showInformationMessage('Please navigate to the Issues tab to report your feedback.');
      }
    } catch (error) {
      this.logger.warn('Could not open issue tracker', error);
      vscode.window.showWarningMessage('Could not open issue tracker. Please visit the repository manually.');
    }
  }

  private async openIssueTrackerWithTemplate(
    item: FeedbackableItem,
    type: 'bug' | 'feature'
  ): Promise<void> {
    try {
      if (!item.sourceUrl) {
        vscode.window.showWarningMessage('No source repository URL available for this bundle.');
        return;
      }

      const issueUrl = this.resolveIssueUrl(item.sourceUrl);

      const isAwesomeCopilot = item.sourceType === 'awesome-copilot';
      const itemType = isAwesomeCopilot ? 'Collection' : 'Bundle';
      const name = item.name || item.resourceId;

      let title: string;
      let bodyParts: string[];

      if (type === 'bug') {
        title = `[Bug Report] ${name}`;
        bodyParts = [
          `${itemType} Information`,
          `- **${itemType} ID:** ${item.resourceId}`,
          ...(item.version ? [`- **Version:** ${item.version}`] : []),
          '',
          '## Bug Description',
          '_Describe the bug clearly and concisely_',
          '',
          '## Steps to Reproduce',
          '1. ',
          '2. ',
          '3. ',
          '',
          '## Expected Behavior',
          '_What did you expect to happen?_',
          '',
          '## Actual Behavior',
          '_What actually happened?_',
          '',
          '## Additional Context',
          '_Any other information that might be helpful_'
        ];
      } else {
        title = `[Feature Request] ${name}`;
        bodyParts = [
          `${itemType} Information`,
          `- **${itemType} ID:** ${item.resourceId}`,
          ...(item.version ? [`- **Version:** ${item.version}`] : []),
          '',
          '## Feature Description',
          '_Describe the feature you would like_',
          '',
          '## Use Case',
          '_Why would this feature be useful?_',
          '',
          '## Additional Context',
          '_Any other information or examples_'
        ];
      }

      const body = bodyParts.join('\n');
      const url = `${issueUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
      this.logger.warn('Could not open issue tracker', error);
      vscode.window.showWarningMessage('Could not open issue tracker. Please visit the repository manually.');
    }
  }

  /**
   * Save feedback to the engagement service
   * @param item
   * @param comment
   * @param rating
   */
  private async saveFeedback(
    item: FeedbackableItem,
    comment: string,
    rating?: RatingScore
  ): Promise<FeedbackResult> {
    if (!rating) {
      this.logger.debug(`No rating provided for ${item.resourceId}, skipping feedback save`);
      return { success: false, error: 'No rating provided' };
    }

    const feedback: Feedback = {
      id: crypto.randomUUID(),
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      comment,
      rating,
      version: item.version,
      timestamp: new Date().toISOString()
    };

    const pendingEntry: PendingFeedback = {
      id: feedback.id,
      bundleId: item.resourceId,
      sourceId: item.sourceId || item.resourceId,
      hubId: item.hubId || '',
      resourceType: item.resourceType,
      rating,
      comment: comment || undefined,
      timestamp: feedback.timestamp,
      synced: false
    };

    try {
      if (this.engagementService) {
        this.logger.debug(`Submitting feedback for ${item.resourceId}, hubId: "${item.hubId || 'none'}"`);
        await this.engagementService.submitFeedback(
          item.resourceType,
          item.resourceId,
          comment,
          { version: item.version, rating, hubId: item.hubId || undefined }
        );
        pendingEntry.synced = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to submit feedback to remote: ${message}`);
      vscode.window.showWarningMessage(
        'Feedback saved locally. Retry from the bundle menu when connectivity is restored.'
      );
    }

    // Save pending feedback locally (synced or not)
    try {
      const storage = this.engagementService?.getStorage?.();
      if (storage) {
        await storage.savePendingFeedback(pendingEntry);
      }
    } catch (storageError) {
      this.logger.error('Failed to save pending feedback locally', storageError as Error);
    }

    // Apply optimistic rating update to cache.
    // Skip if this feedback came from the webview fast-path (prefilledRating), because
    // handleRateBundle already applied the optimistic update before opening the feedback modal.
    if (!item.prefilledRating) {
      try {
        const ratingCache = RatingCache.getInstance();
        const cacheSourceId = item.sourceId || item.resourceId;
        ratingCache.applyOptimisticRating(cacheSourceId, item.resourceId, rating);
      } catch {
        this.logger.debug('Failed to apply optimistic rating update');
      }
    }

    if (pendingEntry.synced) {
      vscode.window.showInformationMessage('Thank you for your feedback!');
    }

    return { success: true, feedback };
  }

  /**
   * Parse rating from description string
   * @param description
   */
  private parseRating(description: string): RatingScore {
    const match = description.match(/^(\d)/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num >= 1 && num <= 5) {
        return num as RatingScore;
      }
    }
    return 3; // Default to average
  }

  /**
   * Set the engagement service (for lazy initialization)
   * @param service
   */
  public setEngagementService(service: EngagementService): void {
    this.engagementService = service;
  }

  /**
   * Register feedback commands with VS Code
   * @param context
   */
  public registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      // Main feedback command
      vscode.commands.registerCommand(
        'promptRegistry.feedback',
        (item: unknown) => this.submitFeedback(this.normalizeFeedbackItem(item))
      ),
      vscode.commands.registerCommand(
        'promptRegistry.reportIssue',
        (item: unknown) => this.reportIssue(this.normalizeFeedbackItem(item))
      ),
      vscode.commands.registerCommand(
        'promptRegistry.requestFeature',
        (item: unknown) => this.requestFeature(this.normalizeFeedbackItem(item))
      )
    );

    this.logger.debug('FeedbackCommands registered');
  }

  /**
   * Submit feedback for a resource
   *
   * Flow:
   * 1. Star rating (1-5)
   * 2. Optional quick comment
   * 3. Action: Report Issue or Skip (just submit rating)
   * @param item
   */
  public async submitFeedback(item: FeedbackableItem): Promise<FeedbackResult> {
    const resourceName = item.name || item.resourceId;

    // Fast path: pre-filled from webview interactive stars
    if (item.prefilledRating) {
      const prefilledComment = item.prefilledComment || `Rated ${item.prefilledRating} stars`;
      return this.saveFeedback(item, prefilledComment, item.prefilledRating);
    }

    // Step 1: Star Rating (1-5)
    const ratingOptions: vscode.QuickPickItem[] = [
      { label: '⭐⭐⭐⭐⭐', description: '5 stars - Excellent!' },
      { label: '⭐⭐⭐⭐☆', description: '4 stars - Very good' },
      { label: '⭐⭐⭐☆☆', description: '3 stars - Good' },
      { label: '⭐⭐☆☆☆', description: '2 stars - Fair' },
      { label: '⭐☆☆☆☆', description: '1 star - Poor' }
    ];

    const selectedRating = await vscode.window.showQuickPick(ratingOptions, {
      title: `Rate "${resourceName}"`,
      placeHolder: 'Select your rating (1-5 stars)'
    });

    if (!selectedRating) {
      return { success: false, error: 'Cancelled' };
    }

    const rating = this.parseRating(selectedRating.description || '');

    // Step 2: Optional quick comment
    const quickComment = await vscode.window.showInputBox({
      title: `Feedback for "${resourceName}"`,
      prompt: 'Optional short message',
      placeHolder: 'e.g., Works great! or Needs better documentation',
      validateInput: (value) => {
        if (value.length > this.maxCommentLength) {
          return `Comment must be ${this.maxCommentLength} characters or less`;
        }
        return null;
      }
    });

    if (quickComment === undefined) {
      // User cancelled - still save the rating
      return this.saveFeedback(item, `Rated ${rating} stars`, rating);
    }

    // Step 3: Action options
    const actionOptions: vscode.QuickPickItem[] = [
      { label: '📝 Report issue / suggestion', description: 'Provide detailed feedback by opening an issue in the repository' },
      { label: '⏭️ Skip', description: 'Just submit the star rating' }
    ];

    const selectedAction = await vscode.window.showQuickPick(actionOptions, {
      title: `Feedback for "${resourceName}"`,
      placeHolder: 'Optional: Report an issue or skip'
    });

    // Prepare comment
    const comment = quickComment.trim() || `Rated ${rating} stars`;

    // Save the feedback first
    const result = await this.saveFeedback(item, comment, rating);

    // If user wants to report an issue, open the repository issues page
    if (selectedAction?.label.includes('Report issue') && result.success) {
      this.logger.info(`Opening issue tracker for ${item.resourceId}`);
      await this.openIssueTracker(item);
    } else if (selectedAction?.label.includes('Report issue')) {
      this.logger.warn(`Issue tracker not opened - feedback save failed for ${item.resourceId}`);
    }

    return result;
  }

  /**
   * Report an issue for a bundle (opens issue tracker with bug template)
   * @param item
   */
  public async reportIssue(item: FeedbackableItem): Promise<void> {
    await this.openIssueTrackerWithTemplate(item, 'bug');
  }

  /**
   * Request a feature for a bundle (opens issue tracker with feature template)
   * @param item
   */
  public async requestFeature(item: FeedbackableItem): Promise<void> {
    await this.openIssueTrackerWithTemplate(item, 'feature');
  }

  /**
   * Attempt to resubmit ALL unsynced pending feedback entries across all bundles.
   * Called once during extension activation so feedback saved offline is eventually delivered.
   * Non-fatal: individual failures are logged and the entry stays pending for the next activation.
   * @returns Number of entries successfully synced during this drain pass.
   */
  public async drainUnsyncedFeedback(): Promise<number> {
    const storage = this.engagementService?.getStorage?.();
    if (!storage || !this.engagementService) {
      return 0;
    }

    const unsynced = await storage.getUnsyncedFeedback();
    if (unsynced.length === 0) {
      return 0;
    }

    this.logger.info(`Draining ${unsynced.length} unsynced feedback entr${unsynced.length === 1 ? 'y' : 'ies'}`);

    let successCount = 0;
    for (const entry of unsynced) {
      try {
        await this.engagementService.submitFeedback(
          entry.resourceType,
          entry.bundleId,
          entry.comment || `Rated ${entry.rating} stars`,
          { rating: entry.rating, hubId: entry.hubId || undefined }
        );
        await storage.markFeedbackSynced(entry.id);
        successCount++;
      } catch (error) {
        // Leave as unsynced; next activation will try again
        this.logger.debug(`Drain failed for feedback ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (successCount > 0) {
      this.logger.info(`Drained ${successCount} of ${unsynced.length} unsynced feedback entries`);
    }
    return successCount;
  }
}
