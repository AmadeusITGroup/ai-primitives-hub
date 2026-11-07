/**
 * Plans a record replay or update: maps each entry to a target, finds its file
 * and gates its source before anything contacts a source, also under `--dry-run`.
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
  /** The file that holds the entry; it is re-recorded there. */
  location: RecordLocation;
  entry: ToolEntry;
  /** Source decided by the trust gate. */
  source: SourceRecord & { sourceId: string };
  target: Target;
  /** `true` when the source came from the record only and is fetched without credentials. */
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
  items: RecordPlanEntry[];
  /** Entries with no target or an untrusted source. */
  skipped: RecordPlanSkip[];
  /** Entries only a reinstall can restore; never planned. */
  needsReinstall: StatusRow[];
  /** Entries considered after the `--target` narrowing. */
  considered: number;
  /** Why a target was picked when several matched. */
  notes: string[];
  /** The cached tool-to-target mapping, for sibling tools. */
  mapTool: (tool: string) => Promise<TargetMapping>;
}

/** Where an entry is re-recorded: the first file holding it (replay) or the file it was listed from (update). */
export type HoldingFileRule = 'first-holding' | 'listed';

/** Inputs of {@link planRecordEntries}. */
export interface PlanRecordEntriesOptions {
  service: InstallRecordService;
  store: RecordStore;
  fs: RecordFs;
  selection: RecordSelection;
  targets: readonly Target[];
  /** Configured sources by id, in lookup order. */
  configured: ReadonlyMap<string, RegistrySource>;
  /** The target named by `--target`; only it narrows the plan to one tool. */
  explicit?: Target;
  /** Root of a target without `rootPath`. */
  cwd: string;
  holdingFile: HoldingFileRule;
}

/**
 * Plan a record replay or update before any lookup or download.
 * @param options - Plan inputs.
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
    // Trust gate before any lookup or download.
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
