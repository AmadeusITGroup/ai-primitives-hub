/**
 * Shared constants for the Prompt Registry extension
 * Centralizes configuration values to maintain consistency across services
 */

/**
 * Installation scope constants
 */
export const INSTALLATION_SCOPES = {
  USER: 'user',
  WORKSPACE: 'workspace',
  REPOSITORY: 'repository'
} as const;

/**
 * Modification warning dialog result constants
 */
export const WARNING_RESULTS = {
  CONTRIBUTE: 'contribute',
  OVERRIDE: 'override',
  CANCEL: 'cancel'
} as const;

/**
 * Concurrency and batch processing constants
 */
export const CONCURRENCY_CONSTANTS = {
  /**
   * Optimal batch size for concurrent update operations
   * - Balances performance with VS Code UI responsiveness
   * - Prevents overwhelming progress indicators
   * - Tested to work well with GitHub API rate limits (5000 requests/hour)
   * - Empirically determined through testing with 10-50 bundle updates
   * - Values tested: 1 (too slow), 5 (UI lag), 10 (rate limit issues)
   * - Batch size 3 provides optimal balance of speed and stability
   */
  BATCH_SIZE: 3,

  /**
   * Batch size for RegistryManager bulk operations (install/uninstall/profile activation)
   * - Higher than BATCH_SIZE because these are typically internal operations
   * - Less UI-intensive than update checks with progress dialogs
   * - Tested with profile activations containing 10-20 bundles
   */
  REGISTRY_BATCH_LIMIT: 5,

  /**
   * Concurrency limit for parallel source synchronization
   * - Controls how many sources are synced simultaneously
   * - Balances speed with network/API rate limits
   * - Higher values = faster sync but more concurrent requests
   */
  SOURCE_SYNC_CONCURRENCY: 5,

  /**
   * Concurrency limit for parallel manifest downloads in GitHub adapter
   * - Controls how many deployment manifests are downloaded simultaneously
   * - Higher values = faster bundle discovery but more concurrent requests
   * - GitHub API rate limit is 5000 requests/hour for authenticated users
   */
  MANIFEST_DOWNLOAD_CONCURRENCY: 10,

  /**
   * Maximum number of popular bundles to display in quick pick
   * - Prevents UI overflow in bundle selection dialogs
   * - Maintains reasonable response times for bundle loading
   */
  POPULAR_BUNDLES_LIMIT: 20
} as const;

/**
 * Update system constants
 */
export const UPDATE_CONSTANTS = {
  /**
   * Cache TTL for update check results (in milliseconds)
   * - 5 minutes to balance freshness with performance
   */
  CACHE_TTL: 5 * 60 * 1000,

  /**
   * Default update check interval (in hours)
   * - Daily checks for reasonable update frequency
   */
  DEFAULT_CHECK_INTERVAL: 24,

  /**
   * Startup delay before running the first automatic update check (in milliseconds)
   * - 5 seconds per requirements to avoid impacting startup performance
   */
  STARTUP_CHECK_DELAY_MS: 5000,

  /**
   * Interval for daily update checks (in milliseconds)
   */
  DAILY_INTERVAL_MS: 24 * 60 * 60 * 1000,

  /**
   * Interval for weekly update checks (in milliseconds)
   */
  WEEKLY_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,

  /**
   * Timeout for update check operations (in milliseconds)
   */
  UPDATE_CHECK_TIMEOUT_MS: 30_000
} as const;

/**
 * UI constants
 */
export const UI_CONSTANTS = {
  /**
   * Maximum length for bundle descriptions in UI
   */
  MAX_DESCRIPTION_LENGTH: 200,

  /**
   * Timeout for progress operations (in milliseconds)
   */
  PROGRESS_TIMEOUT: 30_000,

  /**
   * Debounce delay for reacting to source sync events (in milliseconds)
   * - Used by tree and marketplace views to avoid excessive refreshes
   */
  SOURCE_SYNC_DEBOUNCE_MS: 500,

  /**
   * Delay before loading bundles after webview resolves (in milliseconds)
   * - Ensures webview JavaScript is ready to receive messages
   * - The webview also sends a refresh request as a backup
   */
  WEBVIEW_READY_DELAY_MS: 100
} as const;
