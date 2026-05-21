# Engagement API Reference

API documentation for the engagement system components.

---

## RatingCache

In-memory cache for bundle ratings. Provides synchronous access for UI components that cannot use async methods in their render path.

### Getting Ratings

#### `getRating(sourceId: string, bundleId: string): CachedRating | undefined`

Get aggregate rating for a bundle.

**Parameters:**
- `sourceId`: Extension source ID (adapterId)
- `bundleId`: Bundle identifier

**Returns:**
```typescript
interface CachedRating {
  sourceId: string;
  bundleId: string;
  starRating: number;      // 0.0 - 5.0
  wilsonScore: number;     // Statistical confidence score
  voteCount: number;       // Total number of votes
  confidence: 'low' | 'medium' | 'high';
  cachedAt: number;        // Timestamp
}
```

**Example:**
```typescript
const rating = RatingCache.getInstance().getRating('source-abc', 'my-bundle');
if (rating) {
  console.log(`${rating.starRating} stars (${rating.voteCount} votes)`);
}
```

---

#### `getUserRating(sourceId: string, bundleId: string): RatingScore | undefined`

Get the user's own rating for a bundle.

**Returns:** `1 | 2 | 3 | 4 | 5` or `undefined` if user hasn't rated

**Use case:** Detect if user has already rated (to show different UI or prevent double-voting).

**Example:**
```typescript
const userRating = RatingCache.getInstance().getUserRating('source-abc', 'my-bundle');
if (userRating) {
  console.log(`You rated this ${userRating} stars`);
}
```

---

#### `getRatingDisplay(sourceId: string, bundleId: string): RatingDisplay | undefined`

Get formatted rating for display in UI.

**Returns:**
```typescript
interface RatingDisplay {
  text: string;      // e.g., "★ 4.2"
  tooltip: string;   // e.g., "Rating: 4.2 / 5\nVotes: 42"
}
```

---

### Managing Cache

#### `refreshFromHub(hubId: string, ratingsUrl: string, sourceIdMap?: Map<string, string>, accessToken?: string): Promise<void>`

Fetch ratings.json from a hub and update cache.

**Parameters:**
- `hubId`: Hub identifier (for indexing)
- `ratingsUrl`: URL to ratings.json file
- `sourceIdMap`: Optional map from configId (ratings.json) to adapterId (extension)
- `accessToken`: Optional GitHub token for private repos

**Example:**
```typescript
const sourceIdMap = new Map([
  ['awesome-copilot', 'github-owner-repo-abc123']
]);

await RatingCache.getInstance().refreshFromHub(
  'my-hub',
  'https://example.com/ratings.json',
  sourceIdMap,
  accessToken
);
```

---

#### `hydrateUserRatings(ratings: UserRating[], options?: { overwrite?: boolean }): void`

Load user ratings into cache (for cross-session persistence).

**Parameters:**
```typescript
interface UserRating {
  sourceId: string;
  bundleId: string;
  score: 1 | 2 | 3 | 4 | 5;
}
```
- `options.overwrite`: If true, replace existing entries (except optimistic ones)

**Use case:** Called by HubManager during hydration flow.

**Example:**
```typescript
const localRatings = [
  { sourceId: 'source-abc', bundleId: 'bundle-1', score: 5 },
  { sourceId: 'source-abc', bundleId: 'bundle-2', score: 4 }
];

RatingCache.getInstance().hydrateUserRatings(localRatings);
```

---

#### `reapplyHydratedVotes(): void`

Update aggregate ratings to reflect user's hydrated votes.

**Why needed:** ratings.json may not include the user's latest vote yet (compute hasn't re-run). This swaps the user's old contribution for their current one.

**Order:** Call after `hydrateUserRatings()`, before UI renders.

**Example:**
```typescript
RatingCache.getInstance().hydrateUserRatings(localRatings);
RatingCache.getInstance().reapplyHydratedVotes();
// Now aggregates reflect user's current votes
```

---

### Optimistic Updates

#### `applyOptimisticRating(sourceId: string, bundleId: string, userRating: RatingScore): void`

Apply rating immediately for responsive UI, before backend confirms.

**Behavior:**
- If entry exists: updates starRating, adjusts voteCount if new vote
- If entry doesn't exist: creates new entry with 1 vote
- Fires `onCacheUpdated` event

**Example:**
```typescript
// User clicks 5 stars
RatingCache.getInstance().applyOptimisticRating('source-abc', 'my-bundle', 5);
// UI updates immediately
```

---

#### `rollbackOptimisticRating(sourceId: string, bundleId: string, appliedRating: RatingScore, previousUserRating?: RatingScore): void`

Undo optimistic update after backend failure.

**Parameters:**
- `appliedRating`: The rating that was optimistically applied
- `previousUserRating`: User's prior rating, or `undefined` if first-time vote

**Example:**
```typescript
const previous = RatingCache.getInstance().getUserRating('source-abc', 'my-bundle');
RatingCache.getInstance().applyOptimisticRating('source-abc', 'my-bundle', 5);

try {
  await backend.submitRating(rating);
} catch (error) {
  // Backend failed, roll back
  RatingCache.getInstance().rollbackOptimisticRating('source-abc', 'my-bundle', 5, previous);
}
```

---

### Source ID Mapping

#### `getConfigSourceId(adapterSourceId: string): string`

Get the stable config source ID for an adapter source ID.

**Use case:** When persisting ratings locally, use configId (survives source hash changes).

**Returns:** configId if mapping exists, otherwise returns adapterSourceId unchanged.

**Example:**
```typescript
const adapterId = 'github-owner-repo-abc123';
const configId = RatingCache.getInstance().getConfigSourceId(adapterId);
// Returns: 'awesome-copilot'
```

---

### Events

#### `onCacheUpdated: Event<void>`

Fired when cache is updated (refresh, optimistic update, rollback).

**Use case:** UI components subscribe to refresh their views.

**Example:**
```typescript
RatingCache.getInstance().onCacheUpdated(() => {
  this.refreshView();
});
```

---

## GitHubDiscussionsBackend

Backend implementation using GitHub Discussions for ratings/feedback.

### Configuration

#### `initialize(config: GitHubDiscussionsBackendConfig): Promise<void>`

Initialize the backend.

**Config shape:**
```typescript
interface GitHubDiscussionsBackendConfig {
  type: 'github-discussions';
  repository: string;        // 'owner/repo'
  collectionsUrl?: string;   // URL to collections.yaml
}
```

---

### Mapping Management

#### `loadCollectionsMappings(collectionsUrl: string): Promise<void>`

Load bundle → Discussion number mappings from collections.yaml.

**collections.yaml format:**
```yaml
repository: owner/repo
collections:
  - id: bundle-1
    source_id: awesome-copilot
    discussion_number: 42
  - id: bundle-2
    source_id: awesome-copilot
    discussion_number: 43
```

**Fallback:** If direct URL fetch fails (private repo), tries GitHub API contents endpoint.

**Example:**
```typescript
await backend.loadCollectionsMappings(
  'https://raw.githubusercontent.com/owner/repo/main/collections.yaml'
);
```

---

#### `getDiscussionMapping(resourceId: string): DiscussionMapping | undefined`

Get Discussion number for a bundle.

**Parameters:**
- `resourceId`: Format `"sourceId:bundleId"` (e.g., `"awesome-copilot:bundle-1"`)

**Returns:**
```typescript
interface DiscussionMapping {
  resourceId: string;
  discussionNumber: number;
  commentId?: number;
}
```

---

### Rating Operations

#### `submitRating(rating: Rating): Promise<void>`

Submit a rating via GitHub Discussions.

**What it does:**
1. Removes existing reaction (👍/👎) via GraphQL
2. Adds new reaction: 👍 for 4-5 stars, 👎 for 1-2 stars
3. Posts or edits comment with exact star count: `Rating: ⭐⭐⭐⭐⭐`
4. Falls back to local storage on failure

**Rating format:**
```typescript
interface Rating {
  id: string;
  resourceType: 'bundle' | 'prompt';
  resourceId: string;
  score: 1 | 2 | 3 | 4 | 5;
  timestamp: string;
  version?: string;
  sourceId?: string;
}
```

---

#### `fetchViewerRatings(): Promise<{ resourceId: string; score: RatingScore }[]>`

Fetch the viewer's own ratings from GitHub Discussions.

**What it does:**
1. Searches for discussions the viewer commented on
2. Parses `Rating: ⭐⭐⭐⭐⭐` lines from comments
3. Returns resourceId + score pairs

**Use case:** Cross-machine hydration (authoritative source).

**Example:**
```typescript
const remoteRatings = await backend.fetchViewerRatings();
// [{ resourceId: 'awesome-copilot:bundle-1', score: 5 }, ...]

RatingCache.getInstance().hydrateUserRatings(
  remoteRatings.map(r => ({
    sourceId: r.resourceId.split(':')[0],
    bundleId: r.resourceId.split(':')[1],
    score: r.score
  })),
  { overwrite: true }
);
```

---

### Feedback Operations

#### `submitFeedback(feedback: Feedback): Promise<void>`

Submit feedback as a Discussion comment.

**Comment format:**
```
Rating: ⭐⭐⭐⭐⭐
Feedback: This bundle is great!
---
Version: 1.0.0
```

**Behavior:**
- If viewer has an existing rating comment: updates it
- Otherwise: posts new comment
- Always stores locally as backup

**Feedback shape:**
```typescript
interface Feedback {
  id: string;
  resourceType: 'bundle' | 'prompt';
  resourceId: string;
  comment: string;
  timestamp: string;
  version?: string;
  rating?: RatingScore;
}
```

---

## Comment Format

### Rating Comment

User's own rating comment (posted/edited by extension):

```
Rating: ⭐⭐⭐⭐⭐
```

Or with feedback:

```
Rating: ⭐⭐⭐⭐⭐
Feedback: This bundle is amazing!
---
Version: 1.0.0
```

### Parsing

Extract star count from comment body:

```typescript
function parseRatingFromComment(body: string): RatingScore | undefined {
  const match = body.match(/^Rating:\s*(⭐+)/m);
  const starCount = match?.[1]?.length;
  if (starCount >= 1 && starCount <= 5) {
    return starCount as RatingScore;
  }
  return undefined;
}
```

---

## compute-ratings CLI

Standalone CLI that reads Discussion comments and produces ratings.json.

### Usage

```bash
GITHUB_TOKEN=$(gh auth token) node lib/bin/compute-ratings.js \
  --config path/to/collections.yaml \
  --output path/to/ratings.json
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `--config` | Path to collections.yaml | `collections.yaml` |
| `--output` | Path to output ratings.json | `ratings.json` |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub personal access token |

### Output Format

**ratings.json:**
```json
{
  "generatedAt": "2024-01-15T10:30:00Z",
  "bundles": {
    "bundle-1": {
      "sourceId": "awesome-copilot",
      "starRating": 4.5,
      "wilsonScore": 0.82,
      "totalVotes": 42
    }
  }
}
```

### Integration

1. Run compute-ratings.js manually or via CI/CD
2. Upload ratings.json to hub repository
3. Extension fetches pre-computed file via `RatingCache.refreshFromHub()`

**Why offline?** GitHub API rate limits + performance. Extension reads cached aggregates, doesn't compute live.

---

## See Also

- [Engagement Architecture](../contributor-guide/architecture/engagement.md) — System overview
- [Hub Schema](./hub-schema.md) — Hub configuration format
