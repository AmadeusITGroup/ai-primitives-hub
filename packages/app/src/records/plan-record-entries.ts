/**
 * The plan of a record replay or update (W5 steps 2–3, W6 steps 1–3; BR6.4,
 * BR6.5, NFR4.10, NFR4.11).
 *
 * Every (bundle, tool) entry of the selected record is narrowed to one tool
 * only by an explicit `--target`, its tool is mapped to the configured target
 * that writes it, the file that holds it is found, and its source goes through
 * the trust gate, all before anything contacts a source (also under
 * `--dry-run`). Entries that must be reinstalled are returned apart: replay
 * lists them, update ignores them.
 * @module records/plan-record-entries
 */
import type {
  RecordFs,
  RecordLocation,
  RegistrySource,
  SourceRecord,
  Target,
  ToolEntry,
} from '@ai-primitives-hub/core';
import type {
  InstallRecordService,
  StatusRow,
} from './install-record-service';
import {
  mapToolToTarget,
  type TargetMapping,
} from './map-tool-to-target';
import type {
  RecordStore,
} from './record-store';
import {
  resolveRecordSource,
} from './resolve-record-source';
import type {
  RecordSelection,
} from './select-record';

/** One (bundle, tool) entry to write again, with its mapped target and decided source. */
export interface RecordPlanEntry {
  bundleId: string;
  tool: string;
  /** The file that holds the entry; it is re-recorded there (BR6.5). */
  location: RecordLocation;
  entry: ToolEntry;
  /** Source decided by the trust gate; `sourceId` is the record key (NFR4.11). */
  source: SourceRecord & { sourceId: string };
  /** Configured target the tool maps to (BR6.4); the caller applies its own overrides. */
  target: Target;
  /** `true` when no configured source has the entry's id, so the source came from the record and is fetched without credentials (NFR4.11). */
  fromRecordOnly: boolean;
}

/** A (bundle, tool) entry the plan left out, and why. */
export interface RecordPlanSkip {
  bundleId: string;
  tool: string;
  reason: string;
}

/** Outcome of {@link planRecordEntries}. */
export interface RecordPlan {
  /** Entries to write, in `listEntries` order. */
  items: RecordPlanEntry[];
  /** Entries with no target or an untrusted source, in `listEntries` order. */
  skipped: RecordPlanSkip[];
  /** Entries under `unknown` (or marked) that only a reinstall can restore; never planned. */
  needsReinstall: StatusRow[];
  /** Entries considered after the `--target` narrowing, needs-reinstall rows left out. */
  considered: number;
  /** Why a target was picked when several matched, once per tool. */
  notes: string[];
  /** The cached tool-to-target mapping the plan used, for sibling tools. */
  mapTool: (tool: string) => Promise<TargetMapping>;
}

/**
 * How the plan finds the file an entry is re-recorded in:
 * - `first-holding`: the first selected file holding the (bundle, tool) entry (replay);
 * - `listed`: the file the `listEntries` row came from (update).
 */
export type HoldingFileRule = 'first-holding' | 'listed';

/** Inputs of {@link planRecordEntries}. */
export interface PlanRecordEntriesOptions {
  /** Service that lists the entries and finds the holding file. */
  service: InstallRecordService;
  /** Store the selected files were loaded with. */
  store: RecordStore;
  /** Filesystem port, for the mapping and the `local` source check. */
  fs: RecordFs;
  /** The selected record. */
  selection: RecordSelection;
  /** Configured targets. */
  targets: readonly Target[];
  /** Configured sources by id, in lookup order (the trust gate's map). */
  configured: ReadonlyMap<string, RegistrySource>;
  /** The target named by `--target`; only it narrows the plan to one tool. */
  explicit?: Target;
  /** Current folder: the root of a target without `rootPath`. */
  cwd: string;
  /** How to find the file an entry is re-recorded in. */
  holdingFile: HoldingFileRule;
}

/**
 * Plan a record replay or update: narrow, map, locate and gate every entry
 * of the selected record before any lookup or download (NFR4.10, NFR4.11).
 * @param options - The record, the configured targets and sources, the explicit target and the holding-file rule.
 * @returns The entries to write, the skipped and needs-reinstall entries, the notes and the mapping cache.
 * @throws {RegistryError} Any `RECORD.*` error from loading a selected file.
 */
export const planRecordEntries = async (options: PlanRecordEntriesOptions): Promise<RecordPlan> => {
  const { service, store, fs, selection, targets, configured, explicit, cwd } = options;
  const mappings = new Map<string, TargetMapping>();
  const mapTool = async (tool: string): Promise<TargetMapping> => {
    let mapping = mappings.get(tool);
    if (mapping === undefined) {
      mapping = await mapToolToTarget({ fs, tool, level: selection.level, gitRoot: selection.root, targets, explicit, cwd });
      mappings.set(tool, mapping);
    }
    return mapping;
  };
  const plan: RecordPlan = { items: [], skipped: [], needsReinstall: [], considered: 0, notes: [], mapTool };
  const notes = new Set<string>();

  for (const row of await service.listEntries(selection.locations)) {
    const { bundleId, tool } = row;
    if (row.needsReinstall) {
      plan.needsReinstall.push(row);
      continue;
    }
    if (explicit !== undefined && tool !== explicit.type) {
      continue;
    }
    plan.considered++;
    const mapping = await mapTool(tool);
    if ('skip' in mapping) {
      plan.skipped.push({ bundleId, tool, reason: mapping.skip });
      continue;
    }
    if (mapping.note !== undefined) {
      notes.add(mapping.note);
    }
    const location = options.holdingFile === 'first-holding'
      ? await service.holdingLocation(selection.locations, bundleId, tool)
      : selection.locations.find((candidate) => candidate.path === row.record);
    if (location === undefined) {
      continue;
    }
    const { record } = await store.load(location);
    const entry = record.bundles[bundleId].tools[tool];
    const fromRecord = Object.hasOwn(record.sources, entry.sourceId) ? record.sources[entry.sourceId] : undefined;
    if (fromRecord === undefined) {
      plan.skipped.push({ bundleId, tool, reason: `source ${entry.sourceId} is not in the record` });
      continue;
    }
    // Trust gate before any lookup or download (NFR4.11).
    const decision = await resolveRecordSource(entry.sourceId, fromRecord, configured, selection.root, fs);
    if ('skip' in decision) {
      plan.skipped.push({ bundleId, tool, reason: decision.skip });
      continue;
    }
    plan.items.push({
      bundleId,
      tool,
      location,
      entry,
      source: decision.use,
      target: mapping.target,
      fromRecordOnly: !configured.has(entry.sourceId)
    });
  }
  plan.notes = [...notes];
  return plan;
};
