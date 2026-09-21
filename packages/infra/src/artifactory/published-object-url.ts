/* eslint-disable no-control-regex, jsdoc/require-description -- security validation is deliberately explicit */
import {
  RegistryError,
} from '@ai-primitives-hub/core';

const invalid = (message: string): RegistryError => new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message });
const hasControl = (value: string): boolean => /[\u0000-\u001F\u007F]/.test(value);

/**
 *
 * @param raw
 */
export function normalizeSourceRoot(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: 'Artifactory source URL is invalid.', cause });
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || hasControl(raw) || raw.includes('\\')) {
    throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: 'Artifactory source URL must be a credential-free HTTPS URL, or loopback HTTP for local development.' });
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

/**
 *
 * @param root
 * @param candidate
 */
export function isWithinSourceRoot(root: URL, candidate: URL): boolean {
  return root.protocol === candidate.protocol && root.hostname === candidate.hostname && root.port === candidate.port && candidate.pathname.startsWith(root.pathname);
}

/**
 *
 * @param root
 * @param relativePath
 */
export function resolveConfinedObject(root: URL, relativePath: string): URL {
  if (!relativePath || hasControl(relativePath) || relativePath.includes('\\') || relativePath.includes('%') || relativePath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(relativePath)) {
    throw invalid('Published object path is not confined to the source root.');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid('Published object path contains unsafe segments.');
  }
  const candidate = new URL(relativePath, root);
  if (candidate.search || candidate.hash || !isWithinSourceRoot(root, candidate)) {
    throw invalid('Published object path escapes the source root.');
  }
  return candidate;
}
