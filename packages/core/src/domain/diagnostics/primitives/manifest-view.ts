/**
 * Domain layer — tolerant view of `deployment-manifest.yml`.
 *
 * Parsed once by the I0 evaluator and read by I1, I2 and the archived
 * item files. Unlike `validateManifest`, it never throws: malformed fields
 * read as `null` so the evaluators can report what the build produced.
 * @module domain/diagnostics/primitives/manifest-view
 */
import {
  load as parseYaml,
} from 'js-yaml';

/** One `items[]` entry; a field is null when absent or not a string. */
export interface ManifestViewItem {
  path: string | null;
  kind: string | null;
  id: string | null;
}

/** One `files[]` entry; a field is null when absent or of the wrong type. */
export interface ManifestViewFile {
  role: string | null;
  size: number | null;
  sha256: string | null;
}

/** What the evaluators read from a deployment manifest. */
export interface ManifestView {
  formatVersion: unknown;
  id: unknown;
  version: unknown;
  items: readonly ManifestViewItem[];
  /** By `files[].path`; entries without a string path are skipped. */
  files: ReadonlyMap<string, ManifestViewFile>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Read a deployment manifest tolerantly.
 * @param bytes - Raw `deployment-manifest.yml` bytes.
 * @returns The view, or undefined unless the YAML is a mapping. Never throws.
 */
export function readManifestView(bytes: Uint8Array): ManifestView | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const items = Array.isArray(parsed.items)
    ? parsed.items.map((entry: unknown): ManifestViewItem => (isRecord(entry)
      ? { path: str(entry.path), kind: str(entry.kind), id: str(entry.id) }
      : { path: null, kind: null, id: null }))
    : [];
  const files = new Map<string, ManifestViewFile>();
  if (Array.isArray(parsed.files)) {
    for (const entry of parsed.files as unknown[]) {
      if (isRecord(entry) && typeof entry.path === 'string') {
        files.set(entry.path, {
          role: str(entry.role),
          size: typeof entry.size === 'number' ? entry.size : null,
          sha256: str(entry.sha256)
        });
      }
    }
  }
  return { formatVersion: parsed.formatVersion, id: parsed.id, version: parsed.version, items, files };
}
