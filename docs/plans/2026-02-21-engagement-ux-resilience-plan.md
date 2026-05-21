# Engagement UX & Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the engagement system with network resilience, optimistic rating updates, interactive stars, and several UX fixes.

**Architecture:** The engagement system uses a layered approach: `FeedbackCommands` → `EngagementService` → backends (`FileBackend`/`GitHubDiscussionsBackend`). UI displays ratings via `RatingCache` (synchronous) in both TreeView and Marketplace webview. Changes span the storage layer (pending feedback), the cache layer (optimistic updates), the webview (interactive stars, sort fix, confidence removal), and commands (retry, report/request links).

**Tech Stack:** TypeScript, VS Code Extension API, Mocha/Sinon for tests, webview HTML/CSS/JS

**Design doc:** `docs/plans/2026-02-21-engagement-ux-resilience-design.md`

---

## Task 1: Fix Rating Sort

**Files:**
- Modify: `src/ui/webview/marketplace/marketplace.js:343-357`

**Step 1: Fix the sort comparators**

Replace the `wilsonScore`-based sorting with `starRating` + `voteCount` tiebreaker:

```javascript
case 'rating-desc':
    filteredBundles.sort((a, b) => {
        const ratingA = a.rating?.starRating ?? 0;
        const ratingB = b.rating?.starRating ?? 0;
        if (ratingB !== ratingA) return ratingB - ratingA;
        return (b.rating?.voteCount ?? 0) - (a.rating?.voteCount ?? 0);
    });
    break;
case 'rating-asc':
    filteredBundles.sort((a, b) => {
        const ratingA = a.rating?.starRating ?? 0;
        const ratingB = b.rating?.starRating ?? 0;
        if (ratingA !== ratingB) return ratingA - ratingB;
        return (a.rating?.voteCount ?? 0) - (b.rating?.voteCount ?? 0);
    });
    break;
```

**Step 2: Verify compilation**

Run: `npm run compile`
Expected: Success

**Step 3: Commit**

```bash
git add src/ui/webview/marketplace/marketplace.js
git commit -m "fix(ui): sort by starRating instead of wilsonScore

Use starRating as primary sort key with voteCount as tiebreaker.
Previously used wilsonScore (0-1 range) which produced unintuitive ordering."
```

---

## Task 2: Remove Confidence Display

**Files:**
- Modify: `src/ui/webview/marketplace/marketplace.js:424-431`
- Modify: `src/services/engagement/RatingCache.ts:138-145`

**Step 1: Remove confidence from marketplace rating badge**

In `marketplace.js`, change the rating badge tooltip and remove confidence text.

Before (line ~427):
```javascript
title="${bundle.rating.voteCount} votes (${bundle.rating.confidence} confidence)">
```

After:
```javascript
title="${bundle.rating.voteCount} votes">
```

**Step 2: Remove confidence from RatingCache tooltip**

In `RatingCache.ts:138-145`, remove the confidence line from `formatTooltip`:

```typescript
private formatTooltip(rating: CachedRating): string {
    const lines = [
        `Rating: ${rating.starRating.toFixed(1)} / 5`,
        `Votes: ${rating.voteCount}`
    ];
    return lines.join('\n');
}
```

**Step 3: Verify compilation**

Run: `npm run compile`
Expected: Success

**Step 4: Run existing RatingCache tests**

Run: `LOG_LEVEL=ERROR npm run test:one -- test/services/engagement/RatingCache.test.ts`
Expected: All tests pass (update any tests asserting on confidence in tooltip if they exist)

**Step 5: Commit**

```bash
git add src/ui/webview/marketplace/marketplace.js src/services/engagement/RatingCache.ts
git commit -m "fix(ui): remove confidence display from ratings

Keep vote count but remove confidence text (low/medium/high/very_high)
from both marketplace badges and TreeView tooltips."
```

---

## Task 3: Zero Rating Consistency

**Files:**
- Modify: `src/ui/webview/marketplace/marketplace.js:424-432`
- Modify: `src/services/engagement/RatingCache.ts:112-122`

**Step 1: Ensure marketplace shows nothing for unrated bundles**

The current code already checks `bundle.rating` before rendering the badge (line 424: `${bundle.rating ? ...`). Verify this handles `voteCount === 0` correctly. If `bundle.rating` exists but has `voteCount === 0` or `starRating === 0`, also hide the badge:

```javascript
${bundle.rating && bundle.rating.voteCount > 0 && bundle.rating.starRating > 0 ? `
    <button class="rating-badge clickable"
            data-action="showFeedbacks" data-bundle-id="${bundle.id}"
            title="${bundle.rating.voteCount} votes">
        <span class="rating-stars">${renderStars(bundle.rating.starRating)}</span>
        <span class="rating-score">${bundle.rating.starRating?.toFixed(1) || '0.0'}</span>
        <span class="rating-votes">(${bundle.rating.voteCount})</span>
    </button>
` : ''}
```

**Step 2: Verify RatingCache.getRatingDisplay handles zero correctly**

In `RatingCache.ts:112-122`, `getRatingDisplay` already returns `undefined` when `voteCount === 0`. Add a check for `starRating === 0`:

```typescript
getRatingDisplay(sourceId: string, bundleId: string): RatingDisplay | undefined {
    const rating = this.getRating(sourceId, bundleId);
    if (!rating || rating.voteCount === 0 || rating.starRating === 0) {
        return undefined;
    }

    return {
        text: this.formatRating(rating.starRating, rating.voteCount),
        tooltip: this.formatTooltip(rating)
    };
}
```

**Step 3: Verify compilation and tests**

Run: `npm run compile && LOG_LEVEL=ERROR npm run test:one -- test/services/engagement/RatingCache.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add src/ui/webview/marketplace/marketplace.js src/services/engagement/RatingCache.ts
git commit -m "fix(ui): show nothing for bundles with no ratings

Hide rating badge entirely when voteCount is 0 or starRating is 0.
Previously could show empty stars or '0.0' for unrated bundles."
```

---

## Task 4: Pending Feedback Storage

**Files:**
- Modify: `src/storage/EngagementStorage.ts`
- Create: `src/types/pendingFeedback.ts`
- Test: `test/storage/EngagementStorage.test.ts`

**Step 1: Create the PendingFeedback type**

Create `src/types/pendingFeedback.ts`:

```typescript
import { RatingScore, EngagementResourceType } from './engagement';

/**
 * Feedback that has been submitted locally but may not yet be synced to the remote backend.
 */
export interface PendingFeedback {
    /** Unique ID for this pending entry */
    id: string;
    /** Bundle ID */
    bundleId: string;
    /** Source ID for routing */
    sourceId: string;
    /** Hub ID for backend selection */
    hubId: string;
    /** Resource type */
    resourceType: EngagementResourceType;
    /** User's rating (1-5) */
    rating: RatingScore;
    /** Optional comment */
    comment?: string;
    /** ISO timestamp of submission */
    timestamp: string;
    /** Whether this feedback has been synced to the remote backend */
    synced: boolean;
}
```

**Step 2: Write the failing test for pending feedback CRUD**

Add to `test/storage/EngagementStorage.test.ts`:

```typescript
suite('Pending Feedback Operations', () => {
    test('should save and retrieve pending feedback', async () => {
        const pending: PendingFeedback = {
            id: 'pf-1',
            bundleId: 'test-bundle',
            sourceId: 'test-source',
            hubId: 'test-hub',
            resourceType: 'bundle',
            rating: 4 as RatingScore,
            comment: 'Great bundle!',
            timestamp: new Date().toISOString(),
            synced: false,
        };

        await storage.savePendingFeedback(pending);
        const result = await storage.getPendingFeedback();
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pf-1');
        assert.strictEqual(result[0].synced, false);
    });

    test('should retrieve only unsynced pending feedback', async () => {
        const synced: PendingFeedback = {
            id: 'pf-synced', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
            resourceType: 'bundle', rating: 5 as RatingScore,
            timestamp: new Date().toISOString(), synced: true,
        };
        const unsynced: PendingFeedback = {
            id: 'pf-unsynced', bundleId: 'b2', sourceId: 's2', hubId: 'h2',
            resourceType: 'bundle', rating: 3 as RatingScore,
            timestamp: new Date().toISOString(), synced: false,
        };

        await storage.savePendingFeedback(synced);
        await storage.savePendingFeedback(unsynced);
        const result = await storage.getUnsyncedFeedback();
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pf-unsynced');
    });

    test('should update synced status', async () => {
        const pending: PendingFeedback = {
            id: 'pf-1', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
            resourceType: 'bundle', rating: 4 as RatingScore,
            timestamp: new Date().toISOString(), synced: false,
        };

        await storage.savePendingFeedback(pending);
        await storage.markFeedbackSynced('pf-1');
        const result = await storage.getPendingFeedback();
        assert.strictEqual(result[0].synced, true);
    });

    test('should delete pending feedback by id', async () => {
        const pending: PendingFeedback = {
            id: 'pf-1', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
            resourceType: 'bundle', rating: 4 as RatingScore,
            timestamp: new Date().toISOString(), synced: false,
        };

        await storage.savePendingFeedback(pending);
        await storage.deletePendingFeedback('pf-1');
        const result = await storage.getPendingFeedback();
        assert.strictEqual(result.length, 0);
    });
});
```

**Step 3: Run test to verify it fails**

Run: `npm run test:one -- test/storage/EngagementStorage.test.ts`
Expected: FAIL — `savePendingFeedback` is not a function

**Step 4: Implement pending feedback CRUD in EngagementStorage**

Add to `src/storage/EngagementStorage.ts`:

1. Add `pendingFeedback` path to `EngagementStoragePaths`:
```typescript
interface EngagementStoragePaths {
    root: string;
    telemetry: string;
    ratings: string;
    feedback: string;
    pendingFeedback: string;
}
```

2. Add the path in constructor:
```typescript
this.paths = {
    // ...existing
    pendingFeedback: path.join(engagementDir, 'pending-feedback.json'),
};
```

3. Add storage format:
```typescript
interface PendingFeedbackStore {
    version: string;
    entries: PendingFeedback[];
}
```

4. Add cache field:
```typescript
private pendingFeedbackCache?: PendingFeedbackStore;
```

5. Implement CRUD methods:
```typescript
async savePendingFeedback(entry: PendingFeedback): Promise<void> {
    const store = await this.loadPendingFeedbackStore();
    const existingIndex = store.entries.findIndex(e => e.id === entry.id);
    if (existingIndex >= 0) {
        store.entries[existingIndex] = entry;
    } else {
        store.entries.push(entry);
    }
    await this.savePendingFeedbackStore(store);
}

async getPendingFeedback(): Promise<PendingFeedback[]> {
    const store = await this.loadPendingFeedbackStore();
    return store.entries;
}

async getUnsyncedFeedback(): Promise<PendingFeedback[]> {
    const store = await this.loadPendingFeedbackStore();
    return store.entries.filter(e => !e.synced);
}

async markFeedbackSynced(id: string): Promise<void> {
    const store = await this.loadPendingFeedbackStore();
    const entry = store.entries.find(e => e.id === id);
    if (entry) {
        entry.synced = true;
        await this.savePendingFeedbackStore(store);
    }
}

async deletePendingFeedback(id: string): Promise<void> {
    const store = await this.loadPendingFeedbackStore();
    store.entries = store.entries.filter(e => e.id !== id);
    await this.savePendingFeedbackStore(store);
}

private async loadPendingFeedbackStore(): Promise<PendingFeedbackStore> {
    if (this.pendingFeedbackCache) {
        return this.pendingFeedbackCache;
    }
    try {
        const data = await readFile(this.paths.pendingFeedback, 'utf-8');
        this.pendingFeedbackCache = JSON.parse(data) as PendingFeedbackStore;
        return this.pendingFeedbackCache;
    } catch {
        return { version: EngagementStorage.STORAGE_VERSION, entries: [] };
    }
}

private async savePendingFeedbackStore(store: PendingFeedbackStore): Promise<void> {
    await this.initialize();
    await writeFile(this.paths.pendingFeedback, JSON.stringify(store, null, 2), 'utf-8');
    this.pendingFeedbackCache = store;
}
```

6. Update `clearCache()` and `clearAll()` to include pending feedback.

**Step 5: Run test to verify it passes**

Run: `npm run test:one -- test/storage/EngagementStorage.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/types/pendingFeedback.ts src/storage/EngagementStorage.ts test/storage/EngagementStorage.test.ts
git commit -m "feat(storage): add pending feedback storage

Add PendingFeedback type and CRUD operations to EngagementStorage for
tracking feedback that may not yet be synced to GitHub."
```

---

## Task 5: Network Resilience in Feedback Submission

**Files:**
- Modify: `src/commands/FeedbackCommands.ts`
- Modify: `src/services/engagement/EngagementService.ts`
- Test: `test/commands/FeedbackCommands.test.ts`

**Step 1: Write the failing test for network error handling**

Add to `test/commands/FeedbackCommands.test.ts`:

```typescript
test('should save feedback locally when GitHub submission fails', async () => {
    // Arrange: mock EngagementService.submitFeedback to throw network error
    const mockEngagement = {
        submitFeedback: sandbox.stub().rejects(new Error('Network error')),
        getStorage: sandbox.stub().returns(mockStorage),
    };
    const commands = new FeedbackCommands(mockEngagement as any);

    // ... set up item and mock quickpick/input to auto-select

    // Act
    const result = await commands.submitFeedback(item);

    // Assert: feedback was saved locally
    assert.strictEqual(result.success, true); // locally saved = success
    assert.ok(mockStorage.savePendingFeedback.calledOnce);
});

test('should show error message when GitHub submission fails', async () => {
    // Assert: vscode.window.showWarningMessage called with network error message
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:one -- test/commands/FeedbackCommands.test.ts`
Expected: FAIL

**Step 3: Implement network resilience in FeedbackCommands.saveFeedback**

Modify `src/commands/FeedbackCommands.ts:346-389` — the `saveFeedback` method:

```typescript
private async saveFeedback(
    item: FeedbackableItem,
    comment: string,
    rating?: RatingScore
): Promise<FeedbackResult> {
    const feedback: Feedback = {
        id: crypto.randomUUID(),
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        comment,
        rating,
        version: item.version,
        timestamp: new Date().toISOString(),
    };

    // Always save locally as pending feedback
    const pendingEntry: PendingFeedback = {
        id: feedback.id,
        bundleId: item.resourceId,
        sourceId: item.resourceId,
        hubId: item.hubId || '',
        resourceType: item.resourceType,
        rating: rating || 3,
        comment: comment || undefined,
        timestamp: feedback.timestamp,
        synced: false,
    };

    try {
        if (this.engagementService) {
            this.logger.info(`[FeedbackCommands] Submitting feedback for ${item.resourceId}`);
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

    if (pendingEntry.synced) {
        vscode.window.showInformationMessage('Thank you for your feedback!');
    }

    return { success: true, feedback };
}
```

Note: `EngagementService` will need a `getStorage()` accessor method. Add it:

```typescript
// In EngagementService.ts
getStorage(): EngagementStorage | undefined {
    return this.storage;
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:one -- test/commands/FeedbackCommands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/FeedbackCommands.ts src/services/engagement/EngagementService.ts test/commands/FeedbackCommands.test.ts
git commit -m "feat(engagement): add network resilience to feedback submission

Save feedback locally regardless of GitHub API success. Show warning
on network failure with instructions to retry. Feedback is marked as
synced/unsynced for future retry support."
```

---

## Task 6: Optimistic Rating Update in RatingCache

**Files:**
- Modify: `src/services/engagement/RatingCache.ts`
- Test: `test/services/engagement/RatingCache.test.ts`

**Step 1: Write the failing test for optimistic update**

Add to `test/services/engagement/RatingCache.test.ts`:

```typescript
suite('Optimistic Updates', () => {
    test('should apply optimistic rating and update cache', () => {
        // Arrange: set an existing rating
        cache.setRating({
            sourceId: 'src-1', bundleId: 'bundle-1',
            starRating: 4.0, wilsonScore: 0.8, voteCount: 10,
            confidence: 'medium', cachedAt: Date.now()
        });

        // Act: apply optimistic update with user rating of 5
        cache.applyOptimisticRating('src-1', 'bundle-1', 5);

        // Assert: rating should be recalculated
        const rating = cache.getRating('src-1', 'bundle-1');
        assert.ok(rating);
        // (4.0 * 10 + 5) / 11 ≈ 4.09
        assert.ok(Math.abs(rating!.starRating - 4.09) < 0.1);
        assert.strictEqual(rating!.voteCount, 11);
    });

    test('should create new rating entry for unrated bundle', () => {
        cache.applyOptimisticRating('src-1', 'new-bundle', 4);

        const rating = cache.getRating('src-1', 'new-bundle');
        assert.ok(rating);
        assert.strictEqual(rating!.starRating, 4.0);
        assert.strictEqual(rating!.voteCount, 1);
    });

    test('should fire onCacheUpdated event after optimistic update', () => {
        let fired = false;
        cache.onCacheUpdated(() => { fired = true; });

        cache.applyOptimisticRating('src-1', 'bundle-1', 3);
        assert.ok(fired);
    });

    test('should overwrite optimistic entries on refresh', async () => {
        // Arrange: apply optimistic
        cache.applyOptimisticRating('src-1', 'bundle-1', 5);

        // Act: refresh from hub (mocked RatingService)
        // ... mock RatingService to return real data
        // Assert: optimistic value is replaced by real data
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:one -- test/services/engagement/RatingCache.test.ts`
Expected: FAIL — `applyOptimisticRating` is not a function

**Step 3: Implement applyOptimisticRating in RatingCache**

Add to `src/services/engagement/RatingCache.ts`:

```typescript
import { RatingScore } from '../../types/engagement';

/**
 * Apply an optimistic rating update after user submits feedback.
 * Recalculates the displayed rating client-side.
 * Will be silently overwritten on next ratings.json fetch.
 */
applyOptimisticRating(sourceId: string, bundleId: string, userRating: RatingScore): void {
    const key = this.makeKey(sourceId, bundleId);
    const existing = this.cache.get(key);

    if (existing) {
        const newVoteCount = existing.voteCount + 1;
        const newStarRating = (existing.starRating * existing.voteCount + userRating) / newVoteCount;

        this.cache.set(key, {
            ...existing,
            starRating: Math.round(newStarRating * 10) / 10,
            voteCount: newVoteCount,
            cachedAt: Date.now(),
        });
    } else {
        this.cache.set(key, {
            sourceId,
            bundleId,
            starRating: userRating,
            wilsonScore: 0,
            voteCount: 1,
            confidence: 'low',
            cachedAt: Date.now(),
        });
    }

    this._onCacheUpdated.fire();
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:one -- test/services/engagement/RatingCache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/engagement/RatingCache.ts test/services/engagement/RatingCache.test.ts
git commit -m "feat(engagement): add optimistic rating updates to RatingCache

After user submits a rating, immediately update the cache with a
recalculated average. Silently overwritten on next ratings.json fetch."
```

---

## Task 7: Wire Optimistic Update into FeedbackCommands

**Files:**
- Modify: `src/commands/FeedbackCommands.ts`
- Test: `test/commands/FeedbackCommands.test.ts`

**Step 1: Write the failing test**

Add to `test/commands/FeedbackCommands.test.ts`:

```typescript
test('should apply optimistic rating update after submission', async () => {
    const ratingCache = RatingCache.getInstance();
    const applyStub = sandbox.stub(ratingCache, 'applyOptimisticRating');

    // ... set up mock quickpick/input to auto-select rating 4
    const result = await commands.submitFeedback(item);

    assert.ok(applyStub.calledOnce);
    assert.strictEqual(applyStub.firstCall.args[2], 4); // rating score
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:one -- test/commands/FeedbackCommands.test.ts`
Expected: FAIL

**Step 3: Add optimistic update call in saveFeedback**

In `FeedbackCommands.ts`, after saving pending feedback, trigger the optimistic update:

```typescript
// After saving pending feedback, apply optimistic rating update
if (rating) {
    try {
        const ratingCache = RatingCache.getInstance();
        // Use sourceId from the item (need to resolve the actual source ID)
        ratingCache.applyOptimisticRating(
            item.resourceId, // sourceId (best available)
            item.resourceId,
            rating
        );
    } catch (cacheError) {
        this.logger.debug('Failed to apply optimistic rating update', cacheError as Error);
    }
}
```

Note: The `sourceId` used here needs to match the key format used in `RatingCache`. Investigate how `MarketplaceViewProvider` maps bundle data to cache keys and use the same format. The item may need a `sourceId` field added to `FeedbackableItem`.

**Step 4: Run test to verify it passes**

Run: `npm run test:one -- test/commands/FeedbackCommands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/FeedbackCommands.ts test/commands/FeedbackCommands.test.ts
git commit -m "feat(engagement): wire optimistic rating into feedback submission

After submitting feedback, immediately update RatingCache so the user
sees their rating reflected in the UI without waiting for workflow."
```

---

## Task 8: Interactive Stars in Marketplace Webview

**Files:**
- Modify: `src/ui/webview/marketplace/marketplace.js`
- Modify: `src/ui/webview/marketplace/marketplace.css`
- Modify: `src/ui/webview/marketplace/marketplace.html`
- Modify: `src/ui/MarketplaceViewProvider.ts`

This is the largest task. It replaces the display-only rating badge with interactive stars.

**Step 1: Add interactive star CSS**

Add to `marketplace.css`:

```css
/* Interactive star rating */
.interactive-stars {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    cursor: pointer;
}

.interactive-stars .star {
    font-size: 16px;
    color: var(--vscode-descriptionForeground);
    transition: color 0.1s ease;
    cursor: pointer;
    user-select: none;
}

.interactive-stars .star.filled {
    color: #ffa500;
}

.interactive-stars .star.hovered {
    color: #ffc966;
}

.interactive-stars .star.user-rated {
    color: #ff8c00;
}

/* Feedback inline form */
.inline-feedback-form {
    display: none;
    margin-top: 8px;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
}

.inline-feedback-form.visible {
    display: block;
}

.inline-feedback-form textarea {
    width: 100%;
    min-height: 60px;
    padding: 6px;
    font-family: inherit;
    font-size: 12px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    resize: vertical;
}

.inline-feedback-form textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
}

.inline-feedback-form .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
}
```

**Step 2: Replace rating badge HTML in marketplace.js**

Replace the existing rating badge rendering (lines ~424-432) with an interactive star component:

```javascript
${bundle.rating && bundle.rating.voteCount > 0 && bundle.rating.starRating > 0 ? `
    <div class="interactive-stars" data-bundle-id="${bundle.id}" data-current-rating="${bundle.rating.starRating}">
        ${[1,2,3,4,5].map(i => `<span class="star ${i <= Math.round(bundle.rating.starRating) ? 'filled' : ''}"
            data-star="${i}"
            data-action="starHover"
            title="${i} star${i > 1 ? 's' : ''}">★</span>`).join('')}
        <span class="rating-score">${bundle.rating.starRating.toFixed(1)}</span>
        <span class="rating-votes">(${bundle.rating.voteCount})</span>
    </div>
` : ''}
```

**Step 3: Add star interaction handlers in marketplace.js**

Add hover and click event handlers:

```javascript
// Star hover preview
function handleStarHover(starElement) {
    const container = starElement.closest('.interactive-stars');
    const starValue = parseInt(starElement.dataset.star);
    const stars = container.querySelectorAll('.star');
    stars.forEach(s => {
        const val = parseInt(s.dataset.star);
        s.classList.toggle('hovered', val <= starValue);
    });
}

function handleStarLeave(container) {
    const currentRating = parseFloat(container.dataset.currentRating) || 0;
    const stars = container.querySelectorAll('.star');
    stars.forEach(s => {
        s.classList.remove('hovered');
        const val = parseInt(s.dataset.star);
        s.classList.toggle('filled', val <= Math.round(currentRating));
    });
}

// Star click — confirm rating, show comment form
function handleStarClick(starElement) {
    const container = starElement.closest('.interactive-stars');
    const bundleId = container.dataset.bundleId;
    const rating = parseInt(starElement.dataset.star);

    // Show inline feedback form
    let form = container.parentElement.querySelector('.inline-feedback-form');
    if (!form) {
        form = createFeedbackForm(bundleId, rating);
        container.parentElement.appendChild(form);
    } else {
        form.dataset.rating = rating;
    }

    // Update star display to show selected rating
    const stars = container.querySelectorAll('.star');
    stars.forEach(s => {
        const val = parseInt(s.dataset.star);
        s.classList.toggle('filled', val <= rating);
        s.classList.remove('hovered');
    });

    form.classList.add('visible');
    form.querySelector('textarea')?.focus();
}

function createFeedbackForm(bundleId, rating) {
    const form = document.createElement('div');
    form.className = 'inline-feedback-form visible';
    form.dataset.rating = rating;
    form.innerHTML = `
        <textarea placeholder="Optional: share your experience..." maxlength="1000"></textarea>
        <div class="form-actions">
            <button class="btn btn-secondary btn-small" data-action="cancelFeedback" data-bundle-id="${bundleId}">Cancel</button>
            <button class="btn btn-primary btn-small" data-action="submitInlineFeedback" data-bundle-id="${bundleId}">Submit</button>
        </div>
    `;
    return form;
}

function submitInlineFeedback(bundleId, element) {
    const form = element.closest('.inline-feedback-form');
    const rating = parseInt(form.dataset.rating);
    const comment = form.querySelector('textarea').value.trim();

    vscode.postMessage({
        type: 'submitFeedback',
        bundleId: bundleId,
        rating: rating,
        comment: comment || undefined,
    });

    form.classList.remove('visible');
}

function cancelFeedback(bundleId, element) {
    const form = element.closest('.inline-feedback-form');
    form.classList.remove('visible');
}
```

**Step 4: Wire hover events with event delegation**

Add to the existing event delegation in `marketplace.js` (around line 740+):

```javascript
// Add mouseover/mouseout for star hover
document.addEventListener('mouseover', (e) => {
    const star = e.target.closest('.interactive-stars .star');
    if (star) handleStarHover(star);
});

document.addEventListener('mouseout', (e) => {
    const container = e.target.closest('.interactive-stars');
    if (container && !container.contains(e.relatedTarget)) {
        handleStarLeave(container);
    }
});
```

Add to the existing click delegation switch:

```javascript
case 'submitInlineFeedback':
    if (bundleId) submitInlineFeedback(bundleId, actionElement);
    break;
case 'cancelFeedback':
    if (bundleId) cancelFeedback(bundleId, actionElement);
    break;
```

**Step 5: Handle submitFeedback message in MarketplaceViewProvider**

Add `'submitFeedback'` to the `WebviewMessage` type and handle it:

```typescript
// In WebviewMessage type, add:
type: '...' | 'submitFeedback';
rating?: number;
comment?: string;

// In handleMessage:
case 'submitFeedback':
    if (message.bundleId && message.rating) {
        await this.handleWebviewFeedback(message.bundleId, message.rating, message.comment);
    }
    break;
```

Implement `handleWebviewFeedback`:

```typescript
private async handleWebviewFeedback(bundleId: string, rating: number, comment?: string): Promise<void> {
    try {
        const bundles = await this.registryManager.searchBundles({ text: bundleId });
        const bundle = bundles.find(b => b.id === bundleId);
        const sources = await this.registryManager.listSources();
        const source = bundle ? sources.find(s => s.id === bundle.sourceId) : undefined;

        await vscode.commands.executeCommand('promptRegistry.feedback', {
            resourceId: bundleId,
            resourceType: 'bundle',
            name: bundle?.name || bundleId,
            version: bundle?.version,
            sourceUrl: source?.url,
            sourceType: source?.type,
            hubId: bundle?.hubId,
            // Pre-filled rating and comment from webview
            prefilledRating: rating,
            prefilledComment: comment,
        });
    } catch (error) {
        this.logger.error(`Failed to process webview feedback: ${error}`);
    }
}
```

Note: `FeedbackCommands.submitFeedback` needs to accept pre-filled rating/comment from the `FeedbackableItem` to skip the QuickPick dialogs when called from the webview. Add optional `prefilledRating` and `prefilledComment` fields to `FeedbackableItem` and check them in `submitFeedback` to bypass the VS Code input dialogs.

**Step 6: Verify compilation**

Run: `npm run compile`
Expected: Success

**Step 7: Commit**

```bash
git add src/ui/webview/marketplace/marketplace.js src/ui/webview/marketplace/marketplace.css src/ui/MarketplaceViewProvider.ts src/commands/FeedbackCommands.ts
git commit -m "feat(ui): add interactive star rating in marketplace

Replace display-only rating badge with hover-preview + click-confirm
stars. Shows inline comment form after clicking a star. Submits
feedback through existing engagement pipeline."
```

---

## Task 9: Fix Feedback Modal

**Files:**
- Modify: `src/ui/webview/marketplace/marketplace.js:584-658`
- Modify: `src/ui/MarketplaceViewProvider.ts`

**Step 1: Investigate the current bug**

Read the `handleGetFeedbacks` method in `MarketplaceViewProvider.ts` and the `renderFeedbackModal` function in `marketplace.js` to identify what's broken. The modal currently works but may have issues with:
- Data not reaching the webview
- Rating distribution calculation errors
- Missing feedback entries

Trace the data flow:
1. `marketplace.js` sends `getFeedbacks` message
2. `MarketplaceViewProvider.handleGetFeedbacks` fetches from `FeedbackCache`
3. Data posted back as `feedbacksLoaded` message
4. `renderFeedbackModal` renders the data

**Step 2: Fix identified issues**

Fix based on investigation. Common issues:
- Ensure `feedbacksLoaded` message includes both `feedbacks` array and `rating` object
- Ensure `calculateRatingDistribution` handles the feedback format correctly
- Ensure modal renders quickly (no re-fetching from network)

**Step 3: Verify the feedback modal works**

Manual testing — open the extension, click on a rated bundle's stars, verify modal appears with rating breakdown and comments.

**Step 4: Commit**

```bash
git add src/ui/webview/marketplace/marketplace.js src/ui/MarketplaceViewProvider.ts
git commit -m "fix(ui): fix feedback modal display

Ensure feedback modal correctly renders rating breakdown and comment
list when clicking on a bundle's rating."
```

---

## Task 10: Report Issue / Request Feature Links

**Files:**
- Modify: `src/ui/webview/marketplace/marketplace.js`
- Modify: `src/ui/RegistryTreeProvider.ts`
- Modify: `src/commands/FeedbackCommands.ts`
- Modify: `package.json`

**Step 1: Add commands to package.json**

Add two new commands:

```json
{
  "command": "promptRegistry.reportIssue",
  "title": "Report Issue",
  "category": "Prompt Registry",
  "icon": "$(bug)"
},
{
  "command": "promptRegistry.requestFeature",
  "title": "Request Feature",
  "category": "Prompt Registry",
  "icon": "$(lightbulb)"
}
```

Add to `view/item/context` menus:

```json
{
  "command": "promptRegistry.reportIssue",
  "when": "view == promptRegistryExplorer && viewItem =~ /^(bundle|installed_bundle)$/",
  "group": "feedback@1"
},
{
  "command": "promptRegistry.requestFeature",
  "when": "view == promptRegistryExplorer && viewItem =~ /^(bundle|installed_bundle)$/",
  "group": "feedback@2"
}
```

**Step 2: Implement command handlers**

In `FeedbackCommands.ts`, add two new methods that reuse `openIssueTracker` with different templates:

```typescript
async reportIssue(item: FeedbackableItem): Promise<void> {
    await this.openIssueTrackerWithTemplate(item, 'bug');
}

async requestFeature(item: FeedbackableItem): Promise<void> {
    await this.openIssueTrackerWithTemplate(item, 'feature');
}

private async openIssueTrackerWithTemplate(
    item: FeedbackableItem,
    type: 'bug' | 'feature'
): Promise<void> {
    // Similar to existing openIssueTracker but with pre-selected type
    // For 'bug': title "[Bug Report] <name>", body with bug template
    // For 'feature': title "[Feature Request] <name>", body with feature template
    // ... reuse URL construction logic from openIssueTracker
}
```

Register the commands in `registerCommands`:

```typescript
vscode.commands.registerCommand('promptRegistry.reportIssue',
    (item: any) => this.reportIssue(this.normalizeFeedbackItem(item))
),
vscode.commands.registerCommand('promptRegistry.requestFeature',
    (item: any) => this.requestFeature(this.normalizeFeedbackItem(item))
),
```

**Step 3: Add links to marketplace bundle detail panel**

In `marketplace.js`, add "Report Issue" and "Request Feature" buttons to the bundle card's action row (near line 513):

```javascript
<button class="btn btn-link" data-action="reportIssue" data-bundle-id="${bundle.id}" title="Report Issue">
    🐛 Report Issue
</button>
<button class="btn btn-link" data-action="requestFeature" data-bundle-id="${bundle.id}" title="Request Feature">
    💡 Request Feature
</button>
```

Add message handlers in MarketplaceViewProvider and marketplace.js action delegation:

```javascript
case 'reportIssue':
    if (bundleId) vscode.postMessage({ type: 'reportIssue', bundleId });
    break;
case 'requestFeature':
    if (bundleId) vscode.postMessage({ type: 'requestFeature', bundleId });
    break;
```

Handle in MarketplaceViewProvider:

```typescript
case 'reportIssue':
case 'requestFeature':
    if (message.bundleId) {
        const command = message.type === 'reportIssue' ? 'promptRegistry.reportIssue' : 'promptRegistry.requestFeature';
        // Build FeedbackableItem from bundle and execute command
        const bundles = await this.registryManager.searchBundles({ text: message.bundleId });
        const bundle = bundles.find(b => b.id === message.bundleId);
        if (bundle) {
            await vscode.commands.executeCommand(command, {
                resourceId: bundle.id,
                resourceType: 'bundle',
                name: bundle.name,
                version: bundle.version,
                sourceUrl: /* derive from source */,
                sourceType: /* derive from source */,
            });
        }
    }
    break;
```

**Step 4: Verify compilation**

Run: `npm run compile`
Expected: Success

**Step 5: Commit**

```bash
git add package.json src/commands/FeedbackCommands.ts src/ui/webview/marketplace/marketplace.js src/ui/MarketplaceViewProvider.ts src/ui/RegistryTreeProvider.ts
git commit -m "feat(ui): add Report Issue and Request Feature links

Add separate links in bundle detail panel and TreeView context menu.
Opens the source repository issues page with pre-filled template."
```

---

## Task 11: Retry Unsynced Feedback (Context Menu)

**Files:**
- Modify: `src/commands/FeedbackCommands.ts`
- Modify: `package.json`

**Step 1: Add retry command to package.json**

```json
{
  "command": "promptRegistry.retryFeedback",
  "title": "Retry Feedback Submission",
  "category": "Prompt Registry",
  "icon": "$(sync)"
}
```

Add to `view/item/context`:
```json
{
  "command": "promptRegistry.retryFeedback",
  "when": "view == promptRegistryExplorer && viewItem =~ /^(bundle|installed_bundle)$/",
  "group": "feedback@3"
}
```

**Step 2: Implement retry logic**

In `FeedbackCommands.ts`:

```typescript
async retryFeedback(item: FeedbackableItem): Promise<void> {
    const storage = this.engagementService?.getStorage?.();
    if (!storage) return;

    const unsynced = await storage.getUnsyncedFeedback();
    const pending = unsynced.filter(f => f.bundleId === item.resourceId);

    if (pending.length === 0) {
        vscode.window.showInformationMessage('No pending feedback to retry.');
        return;
    }

    for (const entry of pending) {
        try {
            if (this.engagementService) {
                await this.engagementService.submitFeedback(
                    entry.resourceType,
                    entry.bundleId,
                    entry.comment || `Rated ${entry.rating} stars`,
                    { rating: entry.rating, hubId: entry.hubId || undefined }
                );
                await storage.markFeedbackSynced(entry.id);
            }
        } catch (error) {
            this.logger.warn(`Retry failed for ${entry.id}: ${error}`);
        }
    }

    const synced = (await storage.getUnsyncedFeedback()).filter(f => f.bundleId === item.resourceId);
    if (synced.length === 0) {
        vscode.window.showInformationMessage('Feedback submitted successfully!');
    } else {
        vscode.window.showWarningMessage(`${synced.length} feedback(s) still pending. Please try again later.`);
    }
}
```

Register in `registerCommands`:

```typescript
vscode.commands.registerCommand('promptRegistry.retryFeedback',
    (item: any) => this.retryFeedback(this.normalizeFeedbackItem(item))
),
```

**Step 3: Verify compilation**

Run: `npm run compile`
Expected: Success

**Step 4: Commit**

```bash
git add src/commands/FeedbackCommands.ts package.json
git commit -m "feat(engagement): add retry command for unsynced feedback

Adds 'Retry Feedback Submission' to context menu. Attempts to re-submit
locally saved feedback that failed due to network issues."
```

---

## Task 12: Final Integration Test

**Step 1: Run full test suite**

Run: `LOG_LEVEL=ERROR npm test 2>&1 | tee test.log | tail -30`
Expected: All tests pass

**Step 2: Fix any failures**

If any tests fail due to the changes (e.g., tests asserting on old wilsonScore sort, confidence display, etc.), update them to match the new behavior.

**Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: update tests for engagement UX changes

Align test assertions with new rating sort, confidence removal,
and zero-rating display behavior."
```
