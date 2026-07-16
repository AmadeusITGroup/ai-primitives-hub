/**
 * Update-outcome notification port — the narrow slice of the extension's
 * `BundleUpdateNotifications` (`src/notifications/bundle-update-notifications.ts`)
 * that the auto-update use case needs to report outcomes through. A CLI
 * implementation would print to stdout instead of showing a VS Code
 * notification; `BundleUpdateNotifications` already exposes exactly this
 * shape, so it satisfies this port with zero changes.
 * @module ports/update-notifier
 */

/**
 * Reports auto-update outcomes to the user, however the host chooses to
 * surface them (VS Code notification, CLI stdout, ...).
 */
export interface UpdateNotifier {
  showAutoUpdateComplete(bundleId: string, previousVersion: string, targetVersion: string): Promise<void>;
  showUpdateFailure(bundleId: string, error: string): Promise<void>;
  showBatchUpdateSummary(successful: string[], failed: { bundleId: string; error: string }[]): Promise<void>;
}
