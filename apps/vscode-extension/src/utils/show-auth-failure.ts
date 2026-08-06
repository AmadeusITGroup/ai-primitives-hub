/**
 * Fatal-auth-failure notification: show it, name the cause, and offer the
 * two things that actually fix it.
 *
 * Auth failures used to surface as a bare `Failed to …: HTTP 404`, or — when
 * a diagnosis ran — as diagnostics in the output channel with no
 * notification at all, so the user saw nothing. Every auth failure now
 * produces one notification carrying the original message plus the
 * credential verdict, with *Diagnose* and *Reset GitHub Token* actions.
 * @module utils/show-auth-failure
 */
import {
  isRegistryError,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  NotificationManager,
} from '../services/notification-manager';
import {
  Logger,
} from './logger';

/** What the failing operation was talking to, for a targeted diagnosis. */
export interface AuthFailureTarget {
  /** URL that failed, used to derive `owner/repo` for the repo probe. */
  url?: string;
  /** Human-readable label for the thing that failed (bundle id, hub name). */
  label?: string;
}

const DIAGNOSE = 'Diagnose';
const RESET_TOKEN = 'Reset GitHub Token';
const SHOW_LOGS = 'Show Logs';

/**
 * Report an authentication failure and offer the actions that resolve it.
 * @param message - What failed, in the caller's own words (kept verbatim so
 * "Failed to install bundle: …" still reads as an install failure).
 * @param error - The thrown error. A `RegistryError`'s `hint` carries the
 * credential verdict and is appended.
 * @param target - Optional target passed to the diagnose command so it
 * probes the repository that actually failed.
 */
export async function showAuthFailure(
  message: string,
  error: unknown,
  target?: AuthFailureTarget
): Promise<void> {
  const logger = Logger.getInstance();
  const verdict = isRegistryError(error) ? error.hint : undefined;
  const full = verdict === undefined ? message : `${message} — ${verdict}`;

  logger.error(full, error instanceof Error ? error : undefined);

  const action = await NotificationManager.getInstance().showError(full, DIAGNOSE, RESET_TOKEN, SHOW_LOGS);
  switch (action) {
    case DIAGNOSE: {
      await vscode.commands.executeCommand('promptregistry.diagnoseGitHubAuth', diagnosisTarget(error, target));
      break;
    }
    case RESET_TOKEN: {
      await vscode.commands.executeCommand('promptregistry.forceGitHubAuth');
      break;
    }
    case SHOW_LOGS: {
      logger.show();
      break;
    }
    default: {
      break;
    }
  }
}

/**
 * Prefer the caller's target, but fall back to the URL the error itself
 * recorded — the failing request always knows it, so the diagnosis probes
 * the repository that actually failed rather than a generic one.
 * @param error - The thrown error.
 * @param target - Target supplied by the caller, if any.
 * @returns The target to hand the diagnose command.
 */
function diagnosisTarget(error: unknown, target?: AuthFailureTarget): AuthFailureTarget {
  if (target?.url !== undefined) {
    return target;
  }
  const contextUrl = isRegistryError(error) ? error.context?.url : undefined;
  return typeof contextUrl === 'string' ? { ...target, url: contextUrl } : { ...target };
}

/**
 * Whether a thrown error is an authentication problem, as classified by the
 * layer that produced it. Code-based, never message matching.
 * @param error - The thrown error.
 */
export function isAuthFailure(error: unknown): boolean {
  return isRegistryError(error) && error.code.startsWith('AUTH.');
}

/**
 * Report a failed operation: an authentication problem gets the
 * Diagnose* / *Reset GitHub Token* treatment, anything else gets a plain
 * error notification. Both are shown — the failure is never swallowed in
 * favour of a diagnostic.
 * @param message - What failed, in the caller's own words.
 * @param error - The thrown error.
 * @param target - Optional target for a diagnosis.
 */
export async function showOperationFailure(
  message: string,
  error: unknown,
  target?: AuthFailureTarget
): Promise<void> {
  if (isAuthFailure(error)) {
    await showAuthFailure(message, error, target);
    return;
  }
  await NotificationManager.getInstance().showError(message);
}
