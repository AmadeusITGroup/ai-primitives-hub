/**
 * How to report a default hub that could not be reached during first-run
 * setup.
 *
 * The distinction this module exists for: an account with no access to a
 * hub *we* ship by default (an open-source contributor outside the owning
 * organization) is an **expected** condition — `info`, no notification —
 * while a rejected credential, a missing scope or an unauthorized SSO
 * session is a real fault that must be named loudly. Kept out of
 * `extension.ts` so the decision can be tested without standing up the
 * whole activation path.
 * @module utils/first-run-hub-report
 */
import type {
  HubAvailability,
} from '@ai-primitives-hub/app';
import type {
  HubReference,
} from '@ai-primitives-hub/core';
import {
  isDefaultHub,
} from '@ai-primitives-hub/infra';

/** Minimal view of a default hub entry, so tests need no full config. */
export interface FirstRunHub {
  name: string;
  reference: HubReference;
}

export interface FirstRunHubReport {
  /** Level every line of this report must be logged at. */
  level: 'info' | 'warn';
  /** Lines to write, in order. */
  lines: string[];
  /** True when the failure is an expected condition, not a fault. */
  expected: boolean;
}

/** What, if anything, to tell the user when no hub could be reached. */
export interface FirstRunSummary {
  notification: 'none' | 'information' | 'warning';
  message?: string;
}

const PREFIX = '[FirstRun]';

/**
 * Whether a failure is the expected "this account cannot see one of our own
 * default hubs" case: a *valid* credential (`no-access` only happens when
 * `/user` succeeded) against a hub we ship.
 * @param hub - The hub that was probed.
 * @param availability - Result of probing it.
 */
export function isExpectedNoAccess(hub: FirstRunHub, availability: HubAvailability): boolean {
  return !availability.available
    && availability.reason === 'no-access'
    && isDefaultHub(hub.reference);
}

/**
 * Build the log report for one probed default hub.
 * @param hub - The hub that was probed.
 * @param availability - Result of probing it.
 * @returns Level + lines to log.
 */
export function describeHubAvailability(hub: FirstRunHub, availability: HubAvailability): FirstRunHubReport {
  const target = `${hub.name} (${hub.reference.type}:${hub.reference.location})`;

  if (availability.available) {
    return { level: 'info', expected: false, lines: [`${PREFIX} ✓ Hub verified: ${target}`] };
  }

  const facts: string[] = [];
  if (availability.credential !== undefined) {
    facts.push(`${PREFIX}   Credential: ${availability.credential}`);
  }
  if (availability.detail !== undefined) {
    facts.push(`${PREFIX}   ${availability.detail}`);
  }

  if (isExpectedNoAccess(hub, availability)) {
    return {
      level: 'info',
      expected: true,
      lines: [
        `${PREFIX} ⓘ Hub not available to this account: ${target}`,
        ...facts,
        `${PREFIX}   Expected for accounts outside the owning organization. This is not an error.`
      ]
    };
  }

  return {
    level: 'warn',
    expected: false,
    lines: [
      `${PREFIX} ✗ Hub unavailable: ${target}`,
      ...facts,
      `${PREFIX}   Run "AI Primitives Hub: Diagnose GitHub Authentication", then "Force GitHub Authentication".`
    ]
  };
}

/**
 * Decide what to tell the user after probing every default hub.
 *
 * Nothing at all while at least one hub is usable; information when every
 * failure was expected (the picker still offers Custom URL and Skip); a
 * warning only when something is genuinely broken.
 * @param results - One entry per probed hub.
 * @returns The notification to show, if any.
 */
export function summarizeFirstRunHubs(
  results: readonly { hub: FirstRunHub; availability: HubAvailability }[]
): FirstRunSummary {
  if (results.some(({ availability }) => availability.available)) {
    return { notification: 'none' };
  }
  if (results.length > 0 && results.every(({ hub, availability }) => isExpectedNoAccess(hub, availability))) {
    return {
      notification: 'information',
      message: 'No default hub is available to your GitHub account. You can import a custom hub or skip for now.'
    };
  }
  return {
    notification: 'warning',
    message: 'Default hubs are currently unavailable. You can import a custom hub or skip for now.'
  };
}
