/**
 * Domain layer — Hub validation.
 *
 * Pure, side-effect-free validators ported from `src/types/hub.ts`
 * (`validateHubReference`, `sanitizeHubId`, `hasPathTraversal`,
 * `isValidProtocol`). These operate on already-typed values.
 *
 * `validateHubConfig` (main's version validates a raw, untrusted, just-
 * parsed YAML node typed `any`) is deliberately **not** ported here — that
 * kind of "parse, don't validate blindly" boundary check belongs next to
 * wherever the untrusted YAML is actually parsed, i.e. `infra`'s hub-config
 * parser (Phase 3), not in `core`'s pure domain layer.
 * @module domain/hub/validate
 */
import type {
  HubReference,
} from './types';

/**
 * Check whether a path contains directory-traversal sequences, including
 * the URL-encoded form.
 * @param path - Path to inspect.
 */
export function hasPathTraversal(path: string): boolean {
  if (!path) {
    return false;
  }
  if (path.includes('..')) {
    return true;
  }
  const decoded = decodeURIComponent(path);
  return decoded.includes('..');
}

/**
 * Only HTTPS is an acceptable protocol for a hub `url` reference.
 * @param protocol - Protocol string, e.g. `https:`.
 */
export function isValidProtocol(protocol: string): boolean {
  return protocol === 'https:';
}

/**
 * Validate a hub ID: non-empty, ≤255 chars, no path separators or
 * traversal, alphanumeric/dash/underscore only.
 * @param hubId - Hub ID to validate.
 * @throws {Error} if the ID is invalid.
 */
export function sanitizeHubId(hubId: string): void {
  if (!hubId) {
    throw new Error('Invalid hub ID: cannot be empty');
  }
  if (hubId.length > 255) {
    throw new Error('Invalid hub ID: too long (max 255 characters)');
  }
  if (hubId.includes('..') || hubId.includes('/') || hubId.includes('\\')) {
    throw new Error('Invalid hub ID: path traversal detected');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(hubId)) {
    throw new Error('Invalid hub ID: only alphanumeric characters, dash, and underscore allowed');
  }
}

/**
 * Validate a hub reference's `location` against its `type`.
 * @param ref - Hub reference to validate.
 * @throws {Error} if validation fails.
 */
export function validateHubReference(ref: HubReference): void {
  if (ref.location === null || ref.location === undefined) {
    throw new Error('Location is required');
  }
  if (ref.location === '') {
    throw new Error('Location cannot be empty');
  }

  switch (ref.type) {
    case 'github': {
      if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref.location)) {
        throw new Error('Invalid GitHub repository format. Expected: owner/repo');
      }
      break;
    }
    case 'local': {
      if (hasPathTraversal(ref.location)) {
        throw new Error('Path traversal detected in local path');
      }
      break;
    }
    case 'url': {
      let url: URL;
      try {
        url = new URL(ref.location);
      } catch {
        throw new Error('Invalid URL format');
      }
      if (!isValidProtocol(url.protocol)) {
        throw new Error('Only HTTPS URLs are allowed for security');
      }
      break;
    }
  }
}
