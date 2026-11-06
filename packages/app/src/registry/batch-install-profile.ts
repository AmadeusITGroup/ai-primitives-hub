/**
 * Install a hub profile's bundles as a batch of ordinary installs,
 * without activating the profile: no activation state is saved, other
 * profiles stay active, and nothing records the profile as the bundles'
 * owner. The lockfile tracks the installed versions, as for any install.
 *
 * `required: true` is enforced like profile activation does: when a
 * required bundle is not installed, the bundles this batch newly
 * installed are removed again and the batch fails. Bundles that were
 * already installed before the batch are left alone.
 * @module registry/batch-install-profile
 */
import {
  findMissingRequiredBundles,
  type HubProfileBundle,
  type LogEvent,
  type OnLogEvent,
} from '@ai-primitives-hub/core';

/** What a delivery's installer did for a batch of profile bundles. */
export interface BatchInstallReport {
  /**
   * Bundles installed after the batch, by the id the profile names.
   * `newlyInstalled` is false for a bundle that was already installed
   * before the batch (and so must survive a rollback).
   */
  installed: { bundleId: string; version: string; newlyInstalled: boolean }[];
  /** Bundles that could not be installed, with the reason. */
  failed: { bundleId: string; reason: string }[];
}

/** Delivery-provided install and removal of profile bundles. */
export interface BatchInstallProfilePorts {
  installBundles(bundles: HubProfileBundle[]): Promise<BatchInstallReport>;
  /** Remove bundles this batch installed (used to undo a failed batch). */
  removeBundles(bundleIds: string[]): Promise<void>;
}

/** Outcome of {@link batchInstallProfile}. */
export interface BatchInstallProfileResult {
  success: boolean;
  /** Bundles this batch installed and that remain installed. */
  installed: { bundleId: string; version: string }[];
  /** Bundles that were already installed before the batch. */
  alreadyInstalled: { bundleId: string; version: string }[];
  failed: { bundleId: string; reason: string }[];
  /** Ids of `required: true` bundles that were not installed; set when the batch failed because of them. */
  missingRequiredBundles?: string[];
  error?: string;
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Install a profile's bundles without activating the profile.
 * @param ports Delivery installer/remover.
 * @param bundles Bundles declared by the profile.
 * @param onLog Optional sink for diagnostic log events.
 * @returns The batch outcome. Never throws for a bundle failure; a
 * failure of `installBundles` itself propagates.
 */
export async function batchInstallProfile(
  ports: BatchInstallProfilePorts,
  bundles: HubProfileBundle[],
  onLog?: OnLogEvent
): Promise<BatchInstallProfileResult> {
  log(onLog, 'info', `Installing ${bundles.length} profile bundles without activating the profile`);
  const report = await ports.installBundles(bundles);
  const strip = ({ bundleId, version }: { bundleId: string; version: string }) => ({ bundleId, version });
  const newlyInstalled = report.installed.filter((b) => b.newlyInstalled).map((b) => strip(b));
  const alreadyInstalled = report.installed.filter((b) => !b.newlyInstalled).map((b) => strip(b));

  const missingRequiredBundles = findMissingRequiredBundles(bundles, report.installed.map((b) => b.bundleId));
  if (missingRequiredBundles.length === 0) {
    return { success: true, installed: newlyInstalled, alreadyInstalled, failed: report.failed };
  }

  let error = `Required bundles were not installed: ${missingRequiredBundles.join(', ')}.`;
  let remaining = newlyInstalled;
  if (newlyInstalled.length > 0) {
    try {
      await ports.removeBundles(newlyInstalled.map((b) => b.bundleId));
      remaining = [];
      error += ' The bundles this install added were removed again.';
    } catch (removeError) {
      const message = removeError instanceof Error ? removeError.message : String(removeError);
      log(onLog, 'error', 'Failed to remove the bundles of a failed profile install', removeError instanceof Error ? removeError : new Error(message));
      error += ` Removing the bundles this install added failed (${message}); uninstall them manually: `
        + `${newlyInstalled.map((b) => b.bundleId).join(', ')}.`;
    }
  }
  error += ' Check each bundle\'s install error (source configured, reachable, and authenticated), then install the profile again.';
  log(onLog, 'error', error);
  return {
    success: false,
    installed: remaining,
    alreadyInstalled,
    failed: report.failed,
    missingRequiredBundles,
    error
  };
}
