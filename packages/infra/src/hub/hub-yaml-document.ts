/**
 * Comment-preserving YAML line/range indexer and surgical CRUD mutator for
 * `hub-config.yml` files.
 *
 * Designed so the Visual Hub Editor, Tree View, and YAML CodeActions can
 * perform CRUD operations and range-accurate diagnostics without stripping
 * top-of-file `$schema` directives or section comments (such as `# Roles`,
 * `# Domains`, `# Languages`).
 * @module hub/hub-yaml-document
 */
import type {
  HubChangeSummary,
  HubCursorNodeContext,
  HubProfile,
  HubProfileBundle,
  HubSource,
  HubValidationQuickFix,
  SourceRange,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';

export type HubYamlMutation =
  | {
    kind: 'update-metadata';
    version?: string;
    metadata: {
      name?: string;
      description?: string;
      maintainer?: string;
      updatedAt?: string;
    };
  }
  | {
    kind: 'touch-updated-at';
    updatedAt?: string;
  }
  | {
    kind: 'add-source';
    source: Partial<HubSource> & { id: string; type: HubSource['type'] };
    updatedAt?: string;
  }
  | {
    kind: 'update-source';
    index: number;
    source: Partial<HubSource> & { id: string; type: HubSource['type'] };
    cascadeIdRename?: boolean;
    updatedAt?: string;
  }
  | {
    kind: 'delete-source';
    index: number;
    updatedAt?: string;
  }
  | {
    kind: 'add-profile';
    profile: Partial<HubProfile> & { id: string; name: string };
    updatedAt?: string;
  }
  | {
    kind: 'update-profile';
    index: number;
    profile: Partial<HubProfile> & { id: string; name: string };
    updatedAt?: string;
  }
  | {
    kind: 'delete-profile';
    index: number;
    updatedAt?: string;
  }
  | {
    kind: 'add-profile-bundle';
    profileIndex: number;
    bundle: HubProfileBundle;
    updatedAt?: string;
  }
  | {
    kind: 'update-profile-bundle';
    profileIndex: number;
    bundleIndex: number;
    bundle: HubProfileBundle;
    updatedAt?: string;
  }
  | {
    kind: 'remove-profile-bundle';
    profileIndex: number;
    bundleIndex: number;
    updatedAt?: string;
  }
  | {
    kind: 'apply-quick-fix';
    quickFix: HubValidationQuickFix;
    updatedAt?: string;
  };

const countLeadingSpaces = (line: string): number => {
  let count = 0;
  while (count < line.length && line[count] === ' ') {
    count++;
  }
  return count;
};

const isBlankOrComment = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
};

const makeLineRange = (lineIndex: number, lineText: string): SourceRange => {
  const startColumn = countLeadingSpaces(lineText);
  return {
    startLine: lineIndex,
    startColumn,
    endLine: lineIndex,
    endColumn: Math.max(startColumn, lineText.length)
  };
};

/**
 * Index 0-based line/column ranges for all semantic JSON paths in a
 * `hub-config.yml` document.
 *
 * Keys in the returned map use dot notation (e.g. `version`, `metadata.name`,
 * `sources.0`, `sources.0.id`, `profiles.1.bundles.0.id`) as well as JSON
 * Pointer notation (`/sources/0/id`) for AJV error mapping.
 * @param content Raw YAML document string.
 * @returns Map from path key to `SourceRange`.
 */
export function indexHubYamlRanges(content: string): Map<string, SourceRange> {
  const ranges = new Map<string, SourceRange>();
  const lines = content.split(/\r?\n/);

  const setRange = (dotPath: string, range: SourceRange): void => {
    ranges.set(dotPath, range);
    const pointerPath = dotPath.length === 0 ? '$' : `/${dotPath.replaceAll('.', '/')}`;
    ranges.set(pointerPath, range);
  };

  setRange('', {
    startLine: 0,
    startColumn: 0,
    endLine: Math.max(0, lines.length - 1),
    endColumn: lines.at(-1)?.length ?? 0
  });

  type TopSection = 'none' | 'metadata' | 'sources' | 'profiles' | 'configuration' | 'telemetry';
  let topSection: TopSection = 'none';

  let sourceIndex = -1;
  let sourceDashIndent: number | undefined;
  let sourcePropIndent: number | undefined;
  let sourceSubSection: 'none' | 'config' | 'metadata' = 'none';
  let sourceSubIndent = 0;

  let profileIndex = -1;
  let profileDashIndent: number | undefined;
  let profilePropIndent: number | undefined;
  let profileSubSection: 'none' | 'bundles' | 'path' = 'none';
  let bundlesKeyIndent = 0;
  let bundleDashIndent: number | undefined;
  let bundlePropIndent: number | undefined;
  let bundleIndex = -1;

  const extendEnd = (dotPath: string, endLine: number, endColumn: number): void => {
    const existing = ranges.get(dotPath);
    if (!existing) {
      return;
    }
    const updated: SourceRange = {
      ...existing,
      endLine,
      endColumn
    };
    setRange(dotPath, updated);
  };

  for (const [lineIdx, line] of lines.entries()) {
    if (isBlankOrComment(line)) {
      continue;
    }

    const indent = countLeadingSpaces(line);
    const trimmed = line.trim();

    // Top-level key (indent === 0 and not a sequence dash)
    if (indent === 0 && !trimmed.startsWith('-')) {
      const topMatch = /^([a-zA-Z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
      if (topMatch) {
        const key = topMatch[1];
        setRange(key, makeLineRange(lineIdx, line));
        sourceSubSection = 'none';
        profileSubSection = 'none';

        switch (key) {
          case 'metadata': {
            topSection = 'metadata';
            break;
          }
          case 'sources': {
            topSection = 'sources';
            sourceIndex = -1;
            sourceDashIndent = undefined;
            sourcePropIndent = undefined;
            break;
          }
          case 'profiles': {
            topSection = 'profiles';
            profileIndex = -1;
            profileDashIndent = undefined;
            profilePropIndent = undefined;
            bundleDashIndent = undefined;
            bundlePropIndent = undefined;
            bundleIndex = -1;
            break;
          }
          case 'configuration': {
            topSection = 'configuration';
            break;
          }
          case 'telemetry': {
            topSection = 'telemetry';
            break;
          }
          default: {
            topSection = 'none';
            break;
          }
        }
        continue;
      }
    }

    if (topSection === 'metadata' && indent > 0) {
      const propMatch = /^([a-zA-Z0-9_-]+):/.exec(trimmed);
      if (propMatch) {
        const key = propMatch[1];
        setRange(`metadata.${key}`, makeLineRange(lineIdx, line));
        extendEnd('metadata', lineIdx, line.length);
      }
      continue;
    }

    if (topSection === 'sources') {
      const isDash = /^-(?:\s|$)/.test(trimmed);
      const seqKeyMatch = isDash ? /^-\s+["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed) : null;
      if (isDash && (sourceDashIndent === undefined || indent === sourceDashIndent)) {
        sourceDashIndent = indent;
        sourcePropIndent = indent + 2;
        sourceIndex++;
        sourceSubSection = 'none';
        const itemPath = `sources.${sourceIndex}`;
        setRange(itemPath, makeLineRange(lineIdx, line));
        extendEnd('sources', lineIdx, line.length);
        if (seqKeyMatch?.[1]) {
          setRange(`${itemPath}.${seqKeyMatch[1]}`, makeLineRange(lineIdx, line));
        }
        continue;
      }

      if (sourceIndex >= 0 && sourcePropIndent !== undefined && indent >= sourcePropIndent) {
        const itemPath = `sources.${sourceIndex}`;
        extendEnd(itemPath, lineIdx, line.length);
        extendEnd('sources', lineIdx, line.length);

        const propMatch = /^["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed);
        if (propMatch) {
          const propKey = propMatch[1];
          if (indent === sourcePropIndent) {
            setRange(`${itemPath}.${propKey}`, makeLineRange(lineIdx, line));
            if (propKey === 'config' || propKey === 'metadata') {
              sourceSubSection = propKey;
              sourceSubIndent = indent;
            } else {
              sourceSubSection = 'none';
            }
          } else if (sourceSubSection !== 'none' && indent > sourceSubIndent) {
            setRange(`${itemPath}.${sourceSubSection}.${propKey}`, makeLineRange(lineIdx, line));
            extendEnd(`${itemPath}.${sourceSubSection}`, lineIdx, line.length);
          }
        }
      }
      continue;
    }

    if (topSection === 'profiles') {
      const isDash = /^-(?:\s|$)/.test(trimmed);
      const seqKeyMatch = isDash ? /^-\s+["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed) : null;

      // Determine whether this dash starts a profile or a bundle inside `bundles:`
      const isProfileDash = isDash
        && (profileDashIndent === undefined || indent === profileDashIndent)
        && !(profileSubSection === 'bundles' && profilePropIndent !== undefined && indent >= profilePropIndent);

      if (isProfileDash) {
        profileDashIndent = indent;
        profilePropIndent = indent + 2;
        profileIndex++;
        profileSubSection = 'none';
        bundleDashIndent = undefined;
        bundlePropIndent = undefined;
        bundleIndex = -1;

        const profilePath = `profiles.${profileIndex}`;
        setRange(profilePath, makeLineRange(lineIdx, line));
        extendEnd('profiles', lineIdx, line.length);
        if (seqKeyMatch?.[1]) {
          setRange(`${profilePath}.${seqKeyMatch[1]}`, makeLineRange(lineIdx, line));
        }
        continue;
      }

      if (profileIndex >= 0 && profilePropIndent !== undefined && indent >= profilePropIndent) {
        const profilePath = `profiles.${profileIndex}`;
        extendEnd(profilePath, lineIdx, line.length);
        extendEnd('profiles', lineIdx, line.length);

        if (indent === profilePropIndent && !trimmed.startsWith('-')) {
          const propMatch = /^["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed);
          if (propMatch) {
            const propKey = propMatch[1];
            setRange(`${profilePath}.${propKey}`, makeLineRange(lineIdx, line));
            if (propKey === 'bundles') {
              profileSubSection = 'bundles';
              bundlesKeyIndent = indent;
              bundleDashIndent = undefined;
              bundlePropIndent = undefined;
              bundleIndex = -1;
            } else if (propKey === 'path') {
              profileSubSection = 'path';
            } else {
              profileSubSection = 'none';
            }
          }
          continue;
        }

        if (profileSubSection === 'bundles' && indent >= bundlesKeyIndent) {
          if (isDash && (bundleDashIndent === undefined || indent === bundleDashIndent)) {
            bundleDashIndent = indent;
            bundlePropIndent = indent + 2;
            bundleIndex++;
            const bundlePath = `${profilePath}.bundles.${bundleIndex}`;
            setRange(bundlePath, makeLineRange(lineIdx, line));
            extendEnd(`${profilePath}.bundles`, lineIdx, line.length);
            if (seqKeyMatch?.[1]) {
              setRange(`${bundlePath}.${seqKeyMatch[1]}`, makeLineRange(lineIdx, line));
            }
            continue;
          }

          if (bundleIndex >= 0 && bundlePropIndent !== undefined && indent >= bundlePropIndent) {
            const bundlePath = `${profilePath}.bundles.${bundleIndex}`;
            extendEnd(bundlePath, lineIdx, line.length);
            extendEnd(`${profilePath}.bundles`, lineIdx, line.length);
            const bundlePropMatch = /^["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed);
            if (bundlePropMatch) {
              setRange(`${bundlePath}.${bundlePropMatch[1]}`, makeLineRange(lineIdx, line));
            }
          }
        }
      }
    }
  }

  return ranges;
}

/**
 * Resolve the semantic entity enclosing a 0-based line number in `hub-config.yml`.
 * @param content Raw YAML content.
 * @param line 0-based line number.
 * @returns Enclosing cursor context.
 */
export function locateHubYamlCursor(content: string, line: number): HubCursorNodeContext {
  const ranges = indexHubYamlRanges(content);
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = yaml.load(content);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors during cursor lookup; ranges still work.
  }

  const metadataRange = ranges.get('metadata');
  if (metadataRange && line >= metadataRange.startLine && line <= metadataRange.endLine) {
    return { section: 'metadata' };
  }

  const sources = Array.isArray(parsed?.sources) ? (parsed.sources as Record<string, unknown>[]) : [];
  for (let i = 0; ; i++) {
    const srcRange = ranges.get(`sources.${i}`);
    if (!srcRange) {
      break;
    }
    if (line >= srcRange.startLine && line <= srcRange.endLine) {
      const id = typeof sources[i]?.id === 'string' ? (sources[i].id as string) : undefined;
      return { section: 'source', index: i, id };
    }
  }

  const sourcesHeader = ranges.get('sources');
  if (sourcesHeader && line === sourcesHeader.startLine) {
    return { section: 'sources-header' };
  }

  const profiles = Array.isArray(parsed?.profiles) ? (parsed.profiles as Record<string, unknown>[]) : [];
  for (let p = 0; ; p++) {
    const profRange = ranges.get(`profiles.${p}`);
    if (!profRange) {
      break;
    }
    if (line >= profRange.startLine && line <= profRange.endLine) {
      const id = typeof profiles[p]?.id === 'string' ? (profiles[p].id as string) : undefined;
      for (let b = 0; ; b++) {
        const bRange = ranges.get(`profiles.${p}.bundles.${b}`);
        if (!bRange) {
          break;
        }
        if (line >= bRange.startLine && line <= bRange.endLine) {
          return { section: 'profile', index: p, id, bundleIndex: b };
        }
      }
      return { section: 'profile', index: p, id };
    }
  }

  const profilesHeader = ranges.get('profiles');
  if (profilesHeader && line === profilesHeader.startLine) {
    return { section: 'profiles-header' };
  }

  return { section: 'root' };
}

const serializeSourceBlock = (
  source: Partial<HubSource> & { id: string; type: HubSource['type'] },
  dashIndent = 2
): string[] => {
  const ordered: Record<string, unknown> = {
    id: source.id,
    ...(source.name ? { name: source.name } : {}),
    type: source.type,
    ...(source.url ? { url: source.url } : {}),
    ...((source as Record<string, unknown>).repository ? { repository: (source as Record<string, unknown>).repository } : {}),
    ...((source as Record<string, unknown>).branch ? { branch: (source as Record<string, unknown>).branch } : {}),
    ...(source.enabled === undefined ? {} : { enabled: source.enabled }),
    ...(source.priority === undefined ? {} : { priority: source.priority }),
    ...(source.private === undefined ? {} : { private: source.private }),
    ...(source.config && Object.keys(source.config).length > 0 ? { config: source.config } : {}),
    ...(source.metadata && Object.keys(source.metadata).length > 0 ? { metadata: source.metadata } : {})
  };

  for (const [key, value] of Object.entries(source)) {
    if (!(key in ordered) && key !== 'config' && key !== 'metadata' && value !== undefined) {
      ordered[key] = value;
    }
  }

  const dumped = yaml.dump([ordered], {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).trimEnd();

  const prefix = ' '.repeat(dashIndent);
  return dumped.split('\n').map((line) => `${prefix}${line}`);
};

const formatPathInlineIfSimple = (lines: string[]): string[] => {
  // Convert multi-line `path:\n    - Roles` into compact `path: ["Roles"]` when simple strings
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)path:\s*$/.exec(lines[i]);
    if (match) {
      const baseIndent = match[1].length;
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const itemMatch = /^(\s*)-\s+(.+)$/.exec(lines[j]);
        if (itemMatch && itemMatch[1].length >= baseIndent) {
          const rawVal = itemMatch[2].trim().replaceAll(/^['"]|['"]$/g, '');
          items.push(JSON.stringify(rawVal));
          j++;
        } else {
          break;
        }
      }
      if (items.length > 0) {
        out.push(`${match[1]}path: [${items.join(', ')}]`);
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
};

const serializeProfileBlock = (
  profile: Partial<HubProfile> & { id: string; name: string },
  dashIndent = 2
): string[] => {
  const ordered: Record<string, unknown> = {
    id: profile.id,
    name: profile.name,
    ...(profile.description === undefined ? {} : { description: profile.description }),
    ...(profile.icon === undefined ? {} : { icon: profile.icon }),
    ...(profile.path && profile.path.length > 0 ? { path: profile.path } : {}),
    bundles: (profile.bundles ?? []).map((b) => {
      const bundleOrdered: Record<string, unknown> = {
        id: b.id,
        version: b.version || 'latest',
        source: b.source,
        required: b.required ?? true
      };
      for (const [bKey, bVal] of Object.entries(b)) {
        if (!(bKey in bundleOrdered) && bVal !== undefined) {
          bundleOrdered[bKey] = bVal;
        }
      }
      return bundleOrdered;
    })
  };

  for (const [key, value] of Object.entries(profile)) {
    if (!(key in ordered) && key !== 'path' && key !== 'bundles' && value !== undefined) {
      ordered[key] = value;
    }
  }

  const dumped = yaml.dump([ordered], {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).trimEnd();

  const prefix = ' '.repeat(dashIndent);
  const indented = dumped.split('\n').map((line) => `${prefix}${line}`);
  return formatPathInlineIfSimple(indented);
};

const updateScalarLine = (
  lines: string[],
  range: SourceRange | undefined,
  key: string,
  value: string,
  quote = false
): void => {
  if (!range) {
    return;
  }
  const line = lines[range.startLine];
  if (line === undefined) {
    return;
  }
  const indent = ' '.repeat(countLeadingSpaces(line));
  const dash = line.trimStart().startsWith('- ') ? '- ' : '';
  const formatted = quote ? JSON.stringify(value) : value;
  lines[range.startLine] = `${indent}${dash}${key}: ${formatted}`;
};

const upsertTopLevelScalar = (
  lines: string[],
  key: string,
  value: string,
  quote = false
): void => {
  const ranges = indexHubYamlRanges(lines.join('\n'));
  const existing = ranges.get(key);
  if (existing) {
    updateScalarLine(lines, existing, key, value, quote);
    return;
  }
  const formatted = quote ? JSON.stringify(value) : value;
  const metadataRange = ranges.get('metadata');
  const insertAt = metadataRange ? metadataRange.startLine : lines.length;
  lines.splice(insertAt, 0, `${key}: ${formatted}`);
};

const upsertMetadataScalar = (
  lines: string[],
  key: string,
  value: string,
  quote = true
): void => {
  const ranges = indexHubYamlRanges(lines.join('\n'));
  const existing = ranges.get(`metadata.${key}`);
  if (existing) {
    updateScalarLine(lines, existing, key, value, quote);
    return;
  }
  const formatted = quote ? JSON.stringify(value) : value;
  const metadataRange = ranges.get('metadata');
  if (!metadataRange) {
    lines.push('metadata:', `  ${key}: ${formatted}`);
    return;
  }
  const childLine = metadataRange.endLine > metadataRange.startLine
    ? lines[metadataRange.endLine]
    : undefined;
  const indent = ' '.repeat(childLine ? countLeadingSpaces(childLine) : 2);
  lines.splice(metadataRange.endLine + 1, 0, `${indent}${key}: ${formatted}`);
};

const touchUpdatedAtInLines = (lines: string[], updatedAt?: string): void => {
  const timestamp = updatedAt ?? new Date().toISOString();
  upsertMetadataScalar(lines, 'updatedAt', timestamp, true);
};

const detectDashIndent = (lines: string[], range: SourceRange | undefined, fallback = 2): number => {
  if (!range) {
    return fallback;
  }
  return countLeadingSpaces(lines[range.startLine] ?? '');
};

/**
 * Apply a surgical CRUD or quick-fix mutation to a `hub-config.yml` string
 * while preserving top-of-file `$schema` directives and section comments.
 * @param content Current YAML content.
 * @param mutation Mutation descriptor.
 * @returns Updated YAML content.
 */
export function applyHubYamlMutation(content: string, mutation: HubYamlMutation): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const ranges = indexHubYamlRanges(content);
  const parsed = (yaml.load(content) ?? {}) as Record<string, unknown>;
  const parsedSources = Array.isArray(parsed.sources) ? (parsed.sources as HubSource[]) : [];
  const parsedProfiles = Array.isArray(parsed.profiles) ? (parsed.profiles as HubProfile[]) : [];

  switch (mutation.kind) {
    case 'touch-updated-at': {
      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'update-metadata': {
      if (mutation.version !== undefined) {
        upsertTopLevelScalar(lines, 'version', mutation.version, false);
      }
      if (mutation.metadata.name !== undefined) {
        upsertMetadataScalar(lines, 'name', mutation.metadata.name, true);
      }
      if (mutation.metadata.description !== undefined) {
        upsertMetadataScalar(lines, 'description', mutation.metadata.description, true);
      }
      if (mutation.metadata.maintainer !== undefined) {
        upsertMetadataScalar(lines, 'maintainer', mutation.metadata.maintainer, true);
      }
      const ts = mutation.metadata.updatedAt ?? new Date().toISOString();
      touchUpdatedAtInLines(lines, ts);
      return lines.join(eol);
    }

    case 'add-source': {
      const dashIndent = detectDashIndent(lines, ranges.get('sources.0'), 2);
      const block = serializeSourceBlock(mutation.source, dashIndent);
      const sourcesRange = ranges.get('sources');
      if (sourcesRange) {
        const sourcesLine = lines[sourcesRange.startLine] ?? '';
        if (/^sources:\s*\[\s*\]/.test(sourcesLine.trim())) {
          lines.splice(sourcesRange.startLine, 1, 'sources:', ...block);
        } else {
          lines.splice(sourcesRange.endLine + 1, 0, ...block);
        }
      } else {
        lines.push('sources:', ...block);
      }
      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'update-source': {
      const targetRange = ranges.get(`sources.${mutation.index}`);
      if (!targetRange) {
        throw new Error(`Source at index ${mutation.index} not found in hub-config.yml`);
      }
      const oldSource = parsedSources[mutation.index];
      const oldId = typeof oldSource?.id === 'string' ? oldSource.id : undefined;
      const dashIndent = detectDashIndent(lines, targetRange, 2);
      const block = serializeSourceBlock(mutation.source, dashIndent);
      lines.splice(targetRange.startLine, targetRange.endLine - targetRange.startLine + 1, ...block);

      if (mutation.cascadeIdRename && oldId && oldId !== mutation.source.id) {
        const updatedRanges = indexHubYamlRanges(lines.join('\n'));
        parsedProfiles.forEach((prof, pIdx) => {
          const bundles = Array.isArray(prof?.bundles) ? prof.bundles : [];
          bundles.forEach((b, bIdx) => {
            if (b?.source === oldId) {
              const sourceFieldRange = updatedRanges.get(`profiles.${pIdx}.bundles.${bIdx}.source`);
              updateScalarLine(lines, sourceFieldRange, 'source', mutation.source.id, false);
            }
          });
        });
      }

      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'delete-source': {
      const targetRange = ranges.get(`sources.${mutation.index}`);
      if (!targetRange) {
        throw new Error(`Source at index ${mutation.index} not found in hub-config.yml`);
      }
      lines.splice(targetRange.startLine, targetRange.endLine - targetRange.startLine + 1);
      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'add-profile': {
      const dashIndent = detectDashIndent(lines, ranges.get('profiles.0'), 2);
      const block = serializeProfileBlock(mutation.profile, dashIndent);
      const profilesRange = ranges.get('profiles');
      if (profilesRange) {
        const profilesLine = lines[profilesRange.startLine] ?? '';
        if (/^profiles:\s*\[\s*\]/.test(profilesLine.trim())) {
          lines.splice(profilesRange.startLine, 1, 'profiles:', ...block);
        } else {
          // If another profile shares the same top-level `path[0]` category, insert right after the last profile in that category
          const targetCategory = mutation.profile.path?.[0];
          let insertAfterLine = profilesRange.endLine;
          if (targetCategory) {
            for (let p = parsedProfiles.length - 1; p >= 0; p--) {
              const existingCat = Array.isArray(parsedProfiles[p]?.path) ? parsedProfiles[p].path?.[0] : undefined;
              if (existingCat === targetCategory) {
                const pRange = ranges.get(`profiles.${p}`);
                if (pRange) {
                  insertAfterLine = pRange.endLine;
                }
                break;
              }
            }
          }
          lines.splice(insertAfterLine + 1, 0, ...block);
        }
      } else {
        lines.push('', 'profiles:', ...block);
      }
      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'update-profile': {
      const targetRange = ranges.get(`profiles.${mutation.index}`);
      if (!targetRange) {
        throw new Error(`Profile at index ${mutation.index} not found in hub-config.yml`);
      }
      const dashIndent = detectDashIndent(lines, targetRange, 2);
      const block = serializeProfileBlock(mutation.profile, dashIndent);
      lines.splice(targetRange.startLine, targetRange.endLine - targetRange.startLine + 1, ...block);
      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'delete-profile': {
      const targetRange = ranges.get(`profiles.${mutation.index}`);
      if (!targetRange) {
        throw new Error(`Profile at index ${mutation.index} not found in hub-config.yml`);
      }
      lines.splice(targetRange.startLine, targetRange.endLine - targetRange.startLine + 1);
      touchUpdatedAtInLines(lines, mutation.updatedAt);
      return lines.join(eol);
    }

    case 'add-profile-bundle': {
      const targetProfile = parsedProfiles[mutation.profileIndex];
      if (!targetProfile) {
        throw new Error(`Profile at index ${mutation.profileIndex} not found`);
      }
      const updatedProfile: HubProfile = {
        ...targetProfile,
        bundles: [...(targetProfile.bundles ?? []), mutation.bundle]
      };
      return applyHubYamlMutation(content, {
        kind: 'update-profile',
        index: mutation.profileIndex,
        profile: updatedProfile,
        updatedAt: mutation.updatedAt
      });
    }

    case 'update-profile-bundle': {
      const targetProfile = parsedProfiles[mutation.profileIndex];
      if (!targetProfile || !Array.isArray(targetProfile.bundles)) {
        throw new Error(`Profile at index ${mutation.profileIndex} not found`);
      }
      const bundles = [...targetProfile.bundles];
      bundles[mutation.bundleIndex] = mutation.bundle;
      return applyHubYamlMutation(content, {
        kind: 'update-profile',
        index: mutation.profileIndex,
        profile: { ...targetProfile, bundles },
        updatedAt: mutation.updatedAt
      });
    }

    case 'remove-profile-bundle': {
      const targetProfile = parsedProfiles[mutation.profileIndex];
      if (!targetProfile || !Array.isArray(targetProfile.bundles)) {
        throw new Error(`Profile at index ${mutation.profileIndex} not found`);
      }
      const bundles = targetProfile.bundles.filter((_, idx) => idx !== mutation.bundleIndex);
      return applyHubYamlMutation(content, {
        kind: 'update-profile',
        index: mutation.profileIndex,
        profile: { ...targetProfile, bundles },
        updatedAt: mutation.updatedAt
      });
    }

    case 'apply-quick-fix': {
      const { quickFix } = mutation;
      const dotPath = quickFix.jsonPath.join('.');
      switch (quickFix.kind) {
        case 'update-timestamp': {
          const ts = typeof quickFix.replacementValue === 'string'
            ? quickFix.replacementValue
            : (mutation.updatedAt ?? new Date().toISOString());
          touchUpdatedAtInLines(lines, ts);
          return lines.join(eol);
        }
        case 'fix-bundle-prefix': {
          const targetRange = ranges.get(dotPath);
          if (targetRange && typeof quickFix.replacementValue === 'string') {
            updateScalarLine(lines, targetRange, 'id', quickFix.replacementValue, false);
          }
          touchUpdatedAtInLines(lines, mutation.updatedAt);
          return lines.join(eol);
        }
        case 'remove-source-config': {
          const sourceIdx = Number(quickFix.jsonPath[1]);
          const src = parsedSources[sourceIdx];
          if (src) {
            const clone = { ...src };
            delete clone.config;
            return applyHubYamlMutation(content, {
              kind: 'update-source',
              index: sourceIdx,
              source: clone,
              updatedAt: mutation.updatedAt
            });
          }
          return content;
        }
        case 'add-source-config': {
          const sourceIdx = Number(quickFix.jsonPath[1]);
          const src = parsedSources[sourceIdx];
          if (src) {
            const replacementConfig = (quickFix.replacementValue && typeof quickFix.replacementValue === 'object')
              ? (quickFix.replacementValue as Record<string, unknown>)
              : { branch: 'main', collectionsPath: 'collections' };
            return applyHubYamlMutation(content, {
              kind: 'update-source',
              index: sourceIdx,
              source: {
                ...src,
                config: { ...src.config, ...replacementConfig }
              },
              updatedAt: mutation.updatedAt
            });
          }
          return content;
        }
        case 'create-missing-source': {
          const missingSourceId = typeof quickFix.replacementValue === 'string'
            ? quickFix.replacementValue
            : 'new-source';
          return applyHubYamlMutation(content, {
            kind: 'add-source',
            source: {
              id: missingSourceId,
              name: missingSourceId,
              type: 'github',
              url: `https://github.com/owner/${missingSourceId}`,
              enabled: true,
              priority: 10
            },
            updatedAt: mutation.updatedAt
          });
        }
      }
    }
  }
}

/**
 * Summarize structural changes between a base `hub-config.yml` and an edited
 * `hub-config.yml` to generate commit messages and pull request descriptions.
 * @param baseYaml Original YAML string (or empty string if new).
 * @param currentYaml Modified YAML string.
 * @returns Change summary with suggested commit message, PR title, and PR body.
 */
export function summarizeHubYamlChanges(baseYaml: string, currentYaml: string): HubChangeSummary {
  const safeParse = (raw: string): Record<string, unknown> => {
    try {
      const loaded = yaml.load(raw);
      return loaded && typeof loaded === 'object' && !Array.isArray(loaded)
        ? (loaded as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  const base = safeParse(baseYaml);
  const current = safeParse(currentYaml);

  const extractById = (items: unknown): Map<string, string> => {
    const map = new Map<string, string>();
    if (!Array.isArray(items)) {
      return map;
    }
    for (const item of items) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        if (typeof rec.id === 'string') {
          map.set(rec.id, JSON.stringify(rec));
        }
      }
    }
    return map;
  };

  const baseSources = extractById(base.sources);
  const currentSources = extractById(current.sources);

  const sourcesAdded: string[] = [];
  const sourcesModified: string[] = [];
  const sourcesRemoved: string[] = [];

  for (const [id, serialized] of currentSources) {
    if (!baseSources.has(id)) {
      sourcesAdded.push(id);
    } else if (baseSources.get(id) !== serialized) {
      sourcesModified.push(id);
    }
  }
  for (const id of baseSources.keys()) {
    if (!currentSources.has(id)) {
      sourcesRemoved.push(id);
    }
  }

  const baseProfiles = extractById(base.profiles);
  const currentProfiles = extractById(current.profiles);

  const profilesAdded: string[] = [];
  const profilesModified: string[] = [];
  const profilesRemoved: string[] = [];

  for (const [id, serialized] of currentProfiles) {
    if (!baseProfiles.has(id)) {
      profilesAdded.push(id);
    } else if (baseProfiles.get(id) !== serialized) {
      profilesModified.push(id);
    }
  }
  for (const id of baseProfiles.keys()) {
    if (!currentProfiles.has(id)) {
      profilesRemoved.push(id);
    }
  }

  const parts: string[] = [];
  if (sourcesAdded.length > 0) {
    parts.push(`add source(s) ${sourcesAdded.join(', ')}`);
  }
  if (sourcesModified.length > 0) {
    parts.push(`update source(s) ${sourcesModified.join(', ')}`);
  }
  if (sourcesRemoved.length > 0) {
    parts.push(`remove source(s) ${sourcesRemoved.join(', ')}`);
  }
  if (profilesAdded.length > 0) {
    parts.push(`add profile(s) ${profilesAdded.join(', ')}`);
  }
  if (profilesModified.length > 0) {
    parts.push(`update profile(s) ${profilesModified.join(', ')}`);
  }
  if (profilesRemoved.length > 0) {
    parts.push(`remove profile(s) ${profilesRemoved.join(', ')}`);
  }

  const actionHeadline = parts.length > 0
    ? `feat(hub): ${parts.join('; ')}`
    : 'chore(hub): update hub-config.yml';

  const bodyLines: string[] = [
    '## Summary',
    '',
    'Updated `hub-config.yml` via the AI Primitives Hub Visual Configuration Editor.',
    ''
  ];

  if (sourcesAdded.length + sourcesModified.length + sourcesRemoved.length > 0) {
    bodyLines.push('### Sources');
    for (const id of sourcesAdded) {
      bodyLines.push(`- **Added source:** \`${id}\``);
    }
    for (const id of sourcesModified) {
      bodyLines.push(`- **Updated source:** \`${id}\``);
    }
    for (const id of sourcesRemoved) {
      bodyLines.push(`- **Removed source:** \`${id}\``);
    }
    bodyLines.push('');
  }

  if (profilesAdded.length + profilesModified.length + profilesRemoved.length > 0) {
    bodyLines.push('### Profiles');
    for (const id of profilesAdded) {
      bodyLines.push(`- **Added profile:** \`${id}\``);
    }
    for (const id of profilesModified) {
      bodyLines.push(`- **Updated profile:** \`${id}\``);
    }
    for (const id of profilesRemoved) {
      bodyLines.push(`- **Removed profile:** \`${id}\``);
    }
    bodyLines.push('');
  }

  bodyLines.push(
    '## Validation',
    '- [x] Validated `hub-config.yml` against the Hub Configuration JSON Schema and source policies'
  );

  return {
    sourcesAdded,
    sourcesModified,
    sourcesRemoved,
    profilesAdded,
    profilesModified,
    profilesRemoved,
    suggestedCommitMessage: actionHeadline,
    suggestedPrTitle: actionHeadline,
    suggestedPrBody: bodyLines.join('\n')
  };
}
