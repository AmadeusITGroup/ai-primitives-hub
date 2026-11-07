/**
 * The 3.0.0 entry builders every record writer uses (BR1.5, BR1.6, BR1.11,
 * NFR4.4): a prototype-free bundle, a checksummed recorded file, and a tool
 * entry put under `bundles.<id>.tools.<tool>` with its files in the
 * serializer's code-unit order. `InstallRecordService` (install, commit-mode
 * move) and record migration both build entries through these, so the
 * canonical bytes do not depend on which writer made the entry.
 * @module records/record-entry
 */
import * as path from 'node:path';
import {
  type BundleRecord,
  compareCodeUnits,
  type InstallRecord,
  type RecordedFile,
  type RecordFs,
  type ToolEntry,
} from '@ai-primitives-hub/core';

/** The fields of a tool entry {@link putToolEntry} writes; any other own field is copied as it is (BR1.10). */
export interface ToolEntryFields {
  version: string;
  sourceId: string;
  sourceType: string;
  /** ISO 8601 UTC time (BR3.7). */
  installedAt: string;
  files: readonly RecordedFile[];
  /** Only under the `unknown` tool key (BR21.1). */
  needsReinstall?: true;
}

/**
 * An empty, prototype-free bundle record.
 * @returns The bundle, with no tool yet.
 */
export const createBundle = (): BundleRecord => {
  const bundle = Object.create(null) as BundleRecord;
  bundle.tools = Object.create(null) as BundleRecord['tools'];
  return bundle;
};

/**
 * The recorded file for a confined path: prototype-free, with the checksum
 * of the bytes on disk (BR1.6).
 * @param fs - Filesystem port.
 * @param root - Level root.
 * @param relative - Path already confined to `root`, forward slashes.
 * @returns The recorded file.
 * @throws {Error} When the file cannot be read.
 */
export const hashRecordedFile = async (fs: RecordFs, root: string, relative: string): Promise<RecordedFile> => {
  const file = Object.create(null) as RecordedFile;
  file.path = relative;
  file.checksum = await fs.hashFile(path.join(root, ...relative.split('/')));
  return file;
};

/**
 * Put a tool entry under `bundles.<bundleId>.tools.<tool>`, creating the
 * bundle when the record has none, and replacing an entry of the same tool.
 * The entry is a prototype-free copy of `fields` (unknown fields kept) with
 * its files sorted by path in code-unit order (BR1.11).
 * @param record - Record to change.
 * @param bundleId - Bundle id.
 * @param tool - Tool key.
 * @param fields - The entry's fields; a whole `ToolEntry` to move one unchanged.
 * @returns The entry put into the record.
 */
export const putToolEntry = (record: InstallRecord, bundleId: string, tool: string, fields: ToolEntryFields): ToolEntry => {
  const entry = Object.assign(Object.create(null) as ToolEntry, fields);
  entry.files = [...fields.files].toSorted((left, right) => compareCodeUnits(left.path, right.path));
  if (!Object.hasOwn(record.bundles, bundleId)) {
    record.bundles[bundleId] = createBundle();
  }
  record.bundles[bundleId].tools[tool] = entry;
  return entry;
};
