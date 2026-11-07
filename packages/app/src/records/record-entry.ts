/**
 * The 3.0.0 entry builders shared by the record service and migration, so the
 * record bytes do not depend on which writer made the entry.
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

/** The fields of a tool entry {@link putToolEntry} writes; any other own field is copied as it is. */
export interface ToolEntryFields {
  version: string;
  sourceId: string;
  sourceType: string;
  installedAt: string;
  files: readonly RecordedFile[];
  /** Only under the `unknown` tool key. */
  needsReinstall?: true;
}

/** An empty, prototype-free bundle record. */
export const createBundle = (): BundleRecord => {
  const bundle = Object.create(null) as BundleRecord;
  bundle.tools = Object.create(null) as BundleRecord['tools'];
  return bundle;
};

/**
 * The recorded file for a confined path, with the checksum of the bytes on disk.
 * @param fs - Filesystem port.
 * @param root - Level root.
 * @param relative - Path already confined to `root`, forward slashes.
 */
export const hashRecordedFile = async (fs: RecordFs, root: string, relative: string): Promise<RecordedFile> => {
  const file = Object.create(null) as RecordedFile;
  file.path = relative;
  file.checksum = await fs.hashFile(path.join(root, ...relative.split('/')));
  return file;
};

/**
 * Put a prototype-free tool entry, files sorted, under `bundles.<bundleId>.tools.<tool>`.
 * @param record - Record to change.
 * @param bundleId - Bundle id.
 * @param tool - Tool key.
 * @param fields - The entry's fields; a whole `ToolEntry` to move one unchanged.
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
