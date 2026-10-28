/**
 * Source sanitizer for install records (NFR4.5, BR3.2; security-design "Secrets").
 *
 * A recorded `SourceRecord` carries only the fields contract C1 lists, copied
 * one by one into a prototype-free object, so a token, password or header on
 * the hub's source definition can never reach the record. The `url` is always
 * recorded (C1 requires it) but is cleaned first:
 * - standard URLs (`scheme://…`): the user name, the password and query
 *   parameters named like a token are removed;
 * - scp-style SSH URLs (`user@host:path`): kept as they are when the user is
 *   `git`; any other user part is removed, leaving `host:path`;
 * - anything else: everything up to and including the last `@` of the
 *   authority (before the first `/`, `?` or `#`) is removed.
 * @module records/sanitize-source
 */
import {
  recordError,
  type SourceRecord,
} from '@ai-primitives-hub/core';

/** Optional C1 string fields copied from a source, in addition to `type` and `url`. */
const OPTIONAL_SOURCE_FIELDS = ['branch', 'collectionsPath', 'indexFile', 'authMode', 'credentialRef'] as const;

/** Query parameter names that look like a credential. */
const TOKEN_PARAM_PATTERN = /token|^sig$|^signature$|^key$|^api[-_]?key$|secret|password/i;

/** A `scheme://` prefix. */
const SCHEME_PATTERN = /^[a-z][\d+.a-z-]*:\/\//i;

/** scp-style SSH address: `user@host:path`, with no scheme. */
const SCP_PATTERN = /^([^\s/:@]+)@([^\s/:@]+):(.*)$/;

/** The only scp-style user kept, because it is not a secret. */
const SCP_PUBLIC_USER = 'git';

/**
 * Clean a standard `scheme://` URL; `undefined` when it does not parse.
 * @param url - URL text.
 */
const sanitizeStandardUrl = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  let changed = false;
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  for (const name of new Set(parsed.searchParams.keys())) {
    if (TOKEN_PARAM_PATTERN.test(name)) {
      parsed.searchParams.delete(name);
      changed = true;
    }
  }
  // Keep the text exactly as given when nothing secret was in it.
  return changed ? parsed.toString() : url;
};

/**
 * Fallback for text that does not parse: drop the user part of the authority.
 * @param url - URL text.
 */
const stripAuthorityUser = (url: string): string => {
  const schemeEnd = url.indexOf('://');
  const start = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const rest = url.slice(start);
  const authorityEnd = rest.search(/[#/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  return at === -1 ? url : `${url.slice(0, start)}${rest.slice(at + 1)}`;
};

/**
 * Remove credentials from a source URL before it is recorded (NFR4.5).
 * @param url - Source URL or path as configured.
 * @returns The URL without a user name, password or token-like query parameter.
 */
export const sanitizeSourceUrl = (url: string): string => {
  if (SCHEME_PATTERN.test(url)) {
    return sanitizeStandardUrl(url) ?? stripAuthorityUser(url);
  }
  const scp = SCP_PATTERN.exec(url);
  if (scp !== null) {
    const [, user, host, rest] = scp;
    return user === SCP_PUBLIC_USER ? url : `${host}:${rest}`;
  }
  return stripAuthorityUser(url);
};

/**
 * Copy the C1 fields of a source into a prototype-free `SourceRecord`, with
 * its URL cleaned (BR3.2, NFR4.5). Any other field, such as a token, is dropped.
 * @param source - Source details the caller passes to `recordInstall`.
 * @returns The record-ready source.
 * @throws {RegistryError} `RECORD.MALFORMED` when `type` or `url` is missing or not a string.
 */
export const sanitizeSource = (source: Readonly<Record<string, unknown>>): SourceRecord => {
  const { type, url } = source;
  if (typeof type !== 'string' || type === '' || typeof url !== 'string' || url === '') {
    throw recordError('RECORD.MALFORMED', { detail: 'a source needs a type and a url' });
  }
  const sanitized = Object.create(null) as SourceRecord;
  sanitized.type = type;
  sanitized.url = sanitizeSourceUrl(url);
  for (const field of OPTIONAL_SOURCE_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') {
      sanitized[field] = value;
    }
  }
  return sanitized;
};
