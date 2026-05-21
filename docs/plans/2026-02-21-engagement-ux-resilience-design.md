# Engagement UX & Resilience Design

**Date**: 2026-02-21
**Source**: [Issue #98](https://github.com/AmadeusITGroup/prompt-registry/issues/98) (last 2 comments)
**Branch**: `feature/telemetry-feedback-rating-clean`

## Scope

This design covers:
- Network resilience for feedback submission (Problem 2)
- Immediate rating visibility after submission (Problem 1)
- UX improvements: interactive stars, sort fix, confidence removal, zero-rating consistency, report/request links, feedback modal fix

**Deferred**: Reactive rating single workflow, telemetry (VS Code ecosystem integration).

---

## 1. Network Resilience (Problem 2)

### Decision: Wait for GitHub acknowledgement + local save with manual retry

### Submission Flow

1. User submits rating + feedback via interactive stars
2. Extension calls GitHub API with configurable timeout (default: 10s)
3. **On success**: Show confirmation, save locally with `synced: true`
4. **On timeout/error**: Show error ("Feedback saved locally. Retry from the bundle menu when connectivity is restored."), save locally with `synced: false`
5. User can retry unsynced feedback via context menu action ("Retry feedback submission")

### Local Storage

Extend `EngagementStorage` with `pending-feedback.json`:

```typescript
interface PendingFeedback {
  bundleId: string;
  sourceId: string;
  hubId: string;
  rating: RatingScore;  // 1-5
  comment?: string;
  timestamp: string;
  synced: boolean;
}
```

### Files to Modify

- `src/storage/EngagementStorage.ts` — add pending feedback CRUD
- `src/services/engagement/EngagementService.ts` — save locally on submit, update sync status
- `src/services/engagement/backends/GitHubDiscussionsBackend.ts` — explicit timeout handling
- `src/commands/FeedbackCommands.ts` — error messaging, retry action

---

## 2. Immediate Rating Visibility (Problem 1)

### Decision: Client-side optimistic update, silently overwritten on next ratings.json fetch

### Flow

1. After submission (regardless of sync success), read current rating from `RatingCache`
2. Compute new average: `(currentAvg * voteCount + userRating) / (voteCount + 1)`
3. Store optimistic entry in `RatingCache` marked as `optimistic: true`
4. Fire cache update event — UI refreshes immediately
5. When next `ratings.json` fetch occurs, silently overwrite optimistic values

### Data Model

```typescript
interface OptimisticRating {
  bundleKey: string;      // sourceId:bundleId
  userRating: RatingScore;
  computedStarRating: number;
  computedVoteCount: number;
}
```

### Files to Modify

- `src/services/engagement/RatingCache.ts` — add optimistic entry support, overwrite on refresh
- `src/services/engagement/RatingService.ts` — clear optimistic entries on fetch
- `src/commands/FeedbackCommands.ts` — trigger optimistic update after submission

---

## 3. Interactive Stars (Hover + Click)

### Decision: Hover preview with click confirm, then comment field appears

### Behavior

- **Default state**: Filled/empty stars based on current rating (read-only appearance)
- **On hover**: Stars highlight progressively (1-5) as cursor moves across
- **On click**: Rating confirmed, comment text field slides open below with "Submit" button
- **On submit**: Triggers feedback flow (section 1 above)
- **No ratings**: Show nothing (no stars, no placeholder)
- **Already rated**: Show user's rating with visual indicator (different color or "Your rating" tooltip)

### Scope

- **Marketplace webview**: Full interactive implementation
- **TreeView**: Remains display-only (`★ 4.2 (42)`)

### Files to Modify

- `src/ui/webview/marketplace/marketplace.js` — interactive star component
- `src/ui/webview/marketplace/marketplace.css` — hover/active styles
- `src/ui/MarketplaceViewProvider.ts` — handle new message types from webview
- `src/commands/FeedbackCommands.ts` — accept submissions from webview

---

## 4. Remove Confidence Display

Remove confidence text from rating display. Keep vote count.

- Before: `★ 4.2 (42 votes, high confidence)`
- After: `★ 4.2 (42)`

Confidence data remains in `ratings.json` but is not shown in UI.

### Files to Modify

- `src/ui/webview/marketplace/marketplace.js` — remove confidence from rating badge
- `src/ui/MarketplaceViewProvider.ts` — remove confidence from TreeView tooltip

---

## 5. Fix Rating Sort

### Decision: Sort by `starRating` first, `voteCount` as tiebreaker

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

### Files to Modify

- `src/ui/webview/marketplace/marketplace.js` — update sort comparators

---

## 6. Fix Feedback Modal

Fix the existing modal triggered by clicking stars to properly display comments and rating breakdown. Data is already cached in `FeedbackCache` — the issue is rendering, not data fetching.

### Files to Modify

- `src/ui/webview/marketplace/marketplace.js` — fix modal rendering
- `src/ui/MarketplaceViewProvider.ts` — verify data passed to webview

---

## 7. Zero Rating Consistency

- **No ratings at all**: Show nothing (no stars, no badge, no text)
- **Has ratings but low**: Show actual star rating (e.g., `★ 1.2 (3)`)
- Eliminate any display of "0 stars" or empty star rows for rated bundles

### Files to Modify

- `src/ui/webview/marketplace/marketplace.js` — conditional rendering
- `src/ui/RegistryTreeProvider.ts` — conditional rating display

---

## 8. Report Issue / Request Feature Links

Add two separate links ("Report Issue", "Request Feature") in:
- Bundle detail panel in the Marketplace webview
- Right-click context menu on bundles in TreeView and Marketplace

Links point to the bundle's source repository issues page (derived from adapter source URL).

### Files to Modify

- `src/ui/webview/marketplace/marketplace.js` — add links to detail panel
- `src/ui/RegistryTreeProvider.ts` — add context menu items
- `src/commands/` — new command handlers for opening issue/feature URLs
- `package.json` — register new commands and menu contributions

---

## Deferred Items

- **Reactive rating with single workflow**: Redesign of compute-ratings pipeline with single inbox discussion
- **Telemetry**: VS Code telemetry ecosystem integration, separate config section
