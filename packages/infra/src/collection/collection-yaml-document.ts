/**
 * Comment-preserving YAML line/range indexer and surgical CRUD mutator for
 * `.collection.yml` files.
 *
 * Designed so the Visual Collection Editor, Collections Tree View, and YAML
 * CodeActions can perform CRUD operations and range-accurate diagnostics
 * without stripping top-of-file `$schema` directives or user comments.
 * @module collection/collection-yaml-document
 */
import {
  bumpCollectionVersion,
  type CollectionChangeSummary,
  type CollectionCursorNodeContext,
  type CollectionDisplayConfig,
  type CollectionItemDefinition,
  type CollectionManifest,
  type CollectionMcpInput,
  type CollectionMcpServerConfig,
  type CollectionValidationQuickFix,
  generateSanitizedId,
  type SourceRange,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';

export type CollectionYamlMutation =
  | {
    kind: 'update-metadata';
    metadata: {
      id?: string;
      name?: string;
      description?: string;
      version?: string;
      author?: string;
      tags?: string[];
    };
  }
  | {
    kind: 'bump-version';
    bump: 'patch' | 'minor' | 'major';
  }
  | {
    kind: 'update-readme';
    path?: string | null;
  }
  | {
    kind: 'update-display';
    display: CollectionDisplayConfig | null;
  }
  | {
    kind: 'add-item';
    item: CollectionItemDefinition;
  }
  | {
    kind: 'update-item';
    index: number;
    item: CollectionItemDefinition;
  }
  | {
    kind: 'remove-item';
    index: number;
  }
  | {
    kind: 'move-item';
    fromIndex: number;
    toIndex: number;
  }
  | {
    kind: 'sort-items';
  }
  | {
    kind: 'upsert-mcp-input';
    index?: number;
    input: CollectionMcpInput;
  }
  | {
    kind: 'remove-mcp-input';
    index: number;
  }
  | {
    kind: 'upsert-mcp-server';
    key: string;
    previousKey?: string;
    server: CollectionMcpServerConfig;
  }
  | {
    kind: 'remove-mcp-server';
    key: string;
  }
  | {
    kind: 'apply-quick-fix';
    quickFix: CollectionValidationQuickFix;
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
 * `.collection.yml` document.
 *
 * Keys in the returned map use dot notation (e.g. `id`, `name`, `readme.path`,
 * `display.ordering`, `items.0`, `items.0.path`, `mcp.inputs.0`, `mcp.items.my-server`)
 * as well as JSON Pointer notation (`/items/0/path`) for AJV error mapping.
 * @param content Raw YAML document string.
 * @returns Map from path key to `SourceRange`.
 */
export function indexCollectionYamlRanges(content: string): Map<string, SourceRange> {
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

  type TopSection = 'none' | 'scalar' | 'tags' | 'readme' | 'display' | 'items' | 'mcp';
  let topSection: TopSection = 'none';
  let lastScalarKey: string | undefined;

  let itemIndex = -1;
  let itemDashIndent: number | undefined;
  let itemPropIndent: number | undefined;

  let mcpSubSection: 'none' | 'inputs' | 'items' = 'none';
  let mcpSubIndent = 0;
  let mcpInputIndex = -1;
  let mcpInputDashIndent: number | undefined;
  let mcpInputPropIndent: number | undefined;
  let mcpServerKey: string | undefined;
  let mcpServerIndent: number | undefined;

  const extendEnd = (dotPath: string, endLine: number, endColumn: number): void => {
    const existing = ranges.get(dotPath);
    if (!existing) {
      return;
    }
    setRange(dotPath, {
      ...existing,
      endLine,
      endColumn
    });
  };

  const metadataScalars = new Set(['id', 'name', 'description', 'version', 'author', 'tags']);

  for (const [lineIdx, line] of lines.entries()) {
    if (isBlankOrComment(line)) {
      continue;
    }

    const indent = countLeadingSpaces(line);
    const trimmed = line.trim();

    if (indent === 0 && !trimmed.startsWith('-')) {
      const topMatch = /^([a-zA-Z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
      if (topMatch) {
        const key = topMatch[1];
        const lineRange = makeLineRange(lineIdx, line);
        setRange(key, lineRange);

        if (metadataScalars.has(key)) {
          if (ranges.has('metadata')) {
            extendEnd('metadata', lineIdx, line.length);
          } else {
            setRange('metadata', lineRange);
          }
        }

        switch (key) {
          case 'tags': {
            topSection = 'tags';
            break;
          }
          case 'readme': {
            topSection = 'readme';
            break;
          }
          case 'display': {
            topSection = 'display';
            break;
          }
          case 'items': {
            topSection = 'items';
            itemIndex = -1;
            itemDashIndent = undefined;
            itemPropIndent = undefined;
            break;
          }
          case 'mcp': {
            topSection = 'mcp';
            mcpSubSection = 'none';
            mcpInputIndex = -1;
            mcpInputDashIndent = undefined;
            mcpInputPropIndent = undefined;
            mcpServerKey = undefined;
            mcpServerIndent = undefined;
            break;
          }
          default: {
            topSection = 'scalar';
            lastScalarKey = key;
            break;
          }
        }
        continue;
      }
    }

    if (topSection === 'scalar' && indent > 0 && lastScalarKey) {
      extendEnd(lastScalarKey, lineIdx, line.length);
      if (metadataScalars.has(lastScalarKey)) {
        extendEnd('metadata', lineIdx, line.length);
      }
      continue;
    }

    if (topSection === 'tags' && indent > 0) {
      extendEnd('tags', lineIdx, line.length);
      extendEnd('metadata', lineIdx, line.length);
      continue;
    }

    if ((topSection === 'readme' || topSection === 'display') && indent > 0) {
      const propMatch = /^([a-zA-Z0-9_-]+):/.exec(trimmed);
      if (propMatch) {
        setRange(`${topSection}.${propMatch[1]}`, makeLineRange(lineIdx, line));
      }
      extendEnd(topSection, lineIdx, line.length);
      continue;
    }

    if (topSection === 'items') {
      const isDash = /^-(?:\s|$)/.test(trimmed);
      const seqKeyMatch = isDash ? /^-\s+["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed) : null;
      if (isDash && (itemDashIndent === undefined || indent === itemDashIndent)) {
        itemDashIndent = indent;
        itemPropIndent = indent + 2;
        itemIndex++;
        const itemPath = `items.${itemIndex}`;
        setRange(itemPath, makeLineRange(lineIdx, line));
        extendEnd('items', lineIdx, line.length);
        if (seqKeyMatch?.[1]) {
          setRange(`${itemPath}.${seqKeyMatch[1]}`, makeLineRange(lineIdx, line));
        }
        continue;
      }

      if (itemIndex >= 0 && itemPropIndent !== undefined && indent >= itemPropIndent) {
        const itemPath = `items.${itemIndex}`;
        extendEnd(itemPath, lineIdx, line.length);
        extendEnd('items', lineIdx, line.length);

        const propMatch = /^["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed);
        if (propMatch && indent === itemPropIndent) {
          setRange(`${itemPath}.${propMatch[1]}`, makeLineRange(lineIdx, line));
        }
      }
      continue;
    }

    if (topSection === 'mcp' && indent > 0) {
      extendEnd('mcp', lineIdx, line.length);

      const propMatch = /^["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed);
      if (
        propMatch
        && (propMatch[1] === 'inputs' || propMatch[1] === 'items')
        && (mcpSubSection === 'none' || indent === mcpSubIndent)
      ) {
        mcpSubSection = propMatch[1];
        mcpSubIndent = indent;
        setRange(`mcp.${mcpSubSection}`, makeLineRange(lineIdx, line));
        mcpInputIndex = -1;
        mcpInputDashIndent = undefined;
        mcpInputPropIndent = undefined;
        mcpServerKey = undefined;
        mcpServerIndent = undefined;
        continue;
      }

      if (mcpSubSection === 'inputs' && indent >= mcpSubIndent) {
        const isDash = /^-(?:\s|$)/.test(trimmed);
        const seqKeyMatch = isDash ? /^-\s+["']?([a-zA-Z0-9_-]+)["']?\s*:/.exec(trimmed) : null;
        if (isDash && (mcpInputDashIndent === undefined || indent === mcpInputDashIndent)) {
          mcpInputDashIndent = indent;
          mcpInputPropIndent = indent + 2;
          mcpInputIndex++;
          const inputPath = `mcp.inputs.${mcpInputIndex}`;
          setRange(inputPath, makeLineRange(lineIdx, line));
          extendEnd('mcp.inputs', lineIdx, line.length);
          if (seqKeyMatch?.[1]) {
            setRange(`${inputPath}.${seqKeyMatch[1]}`, makeLineRange(lineIdx, line));
          }
          continue;
        }
        if (mcpInputIndex >= 0 && mcpInputPropIndent !== undefined && indent >= mcpInputPropIndent) {
          const inputPath = `mcp.inputs.${mcpInputIndex}`;
          extendEnd(inputPath, lineIdx, line.length);
          extendEnd('mcp.inputs', lineIdx, line.length);
          if (propMatch && indent === mcpInputPropIndent) {
            setRange(`${inputPath}.${propMatch[1]}`, makeLineRange(lineIdx, line));
          }
        }
        continue;
      }

      if (mcpSubSection === 'items' && indent > mcpSubIndent) {
        extendEnd('mcp.items', lineIdx, line.length);
        if (propMatch && (mcpServerIndent === undefined || indent === mcpServerIndent)) {
          mcpServerIndent = indent;
          mcpServerKey = propMatch[1];
          setRange(`mcp.items.${mcpServerKey}`, makeLineRange(lineIdx, line));
          continue;
        }
        if (mcpServerKey && mcpServerIndent !== undefined && indent > mcpServerIndent) {
          const srvPath = `mcp.items.${mcpServerKey}`;
          extendEnd(srvPath, lineIdx, line.length);
          if (propMatch && indent === mcpServerIndent + 2) {
            setRange(`${srvPath}.${propMatch[1]}`, makeLineRange(lineIdx, line));
          }
        }
      }
    }
  }

  return ranges;
}

/**
 * Resolve the semantic entity enclosing a 0-based line number in `.collection.yml`.
 * @param content Raw YAML content.
 * @param line 0-based line number.
 * @returns Enclosing cursor context.
 */
export function locateCollectionYamlCursor(content: string, line: number): CollectionCursorNodeContext {
  const ranges = indexCollectionYamlRanges(content);
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = yaml.load(content);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors during cursor lookup
  }

  const readmeRange = ranges.get('readme');
  if (readmeRange && line >= readmeRange.startLine && line <= readmeRange.endLine) {
    return { section: 'readme' };
  }

  const displayRange = ranges.get('display');
  if (displayRange && line >= displayRange.startLine && line <= displayRange.endLine) {
    return { section: 'display' };
  }

  const items = Array.isArray(parsed?.items) ? (parsed.items as Record<string, unknown>[]) : [];
  for (let i = 0; ; i++) {
    const itemRange = ranges.get(`items.${i}`);
    if (!itemRange) {
      break;
    }
    if (line >= itemRange.startLine && line <= itemRange.endLine) {
      return {
        section: 'item',
        index: i,
        path: typeof items[i]?.path === 'string' ? (items[i].path as string) : undefined,
        kind: typeof items[i]?.kind === 'string' ? (items[i].kind as string) : undefined
      };
    }
  }

  const itemsHeader = ranges.get('items');
  if (itemsHeader && line === itemsHeader.startLine) {
    return { section: 'items-header' };
  }

  const mcpObj = parsed?.mcp && typeof parsed.mcp === 'object' ? (parsed.mcp as Record<string, unknown>) : undefined;
  const mcpInputs = Array.isArray(mcpObj?.inputs) ? (mcpObj.inputs as Record<string, unknown>[]) : [];
  for (let i = 0; ; i++) {
    const inRange = ranges.get(`mcp.inputs.${i}`);
    if (!inRange) {
      break;
    }
    if (line >= inRange.startLine && line <= inRange.endLine) {
      return {
        section: 'mcp-input',
        index: i,
        id: typeof mcpInputs[i]?.id === 'string' ? (mcpInputs[i].id as string) : undefined
      };
    }
  }

  const mcpItems = mcpObj?.items && typeof mcpObj.items === 'object'
    ? Object.keys(mcpObj.items)
    : [];
  for (const srvKey of mcpItems) {
    const srvRange = ranges.get(`mcp.items.${srvKey}`);
    if (srvRange && line >= srvRange.startLine && line <= srvRange.endLine) {
      return { section: 'mcp-server', key: srvKey };
    }
  }

  const mcpRange = ranges.get('mcp');
  if (mcpRange && line >= mcpRange.startLine && line <= mcpRange.endLine) {
    return { section: 'mcp-header' };
  }

  const metadataRange = ranges.get('metadata');
  if (metadataRange && line >= metadataRange.startLine && line <= metadataRange.endLine) {
    return { section: 'metadata' };
  }

  return { section: 'root' };
}

const serializeItemBlock = (item: CollectionItemDefinition, dashIndent = 2): string[] => {
  const ordered: Record<string, unknown> = {
    path: item.path,
    kind: item.kind,
    ...(item.title ? { title: item.title } : (item.name ? { title: item.name } : {})),
    ...(item.description ? { description: item.description } : {}),
    ...(Array.isArray(item.tags) && item.tags.length > 0 ? { tags: item.tags } : {})
  };
  const dumped = yaml.dump([ordered], {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).trimEnd();
  const prefix = ' '.repeat(dashIndent);
  return dumped.split('\n').map((l) => `${prefix}${l}`);
};

const serializeItemsSection = (items: CollectionItemDefinition[], dashIndent = 2): string[] => {
  if (items.length === 0) {
    return ['items: []'];
  }
  return ['items:', ...items.flatMap((it) => serializeItemBlock(it, dashIndent))];
};

const serializeSectionMapping = (topKey: string, value: Record<string, unknown>): string[] => {
  const dumped = yaml.dump({ [topKey]: value }, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).trimEnd();
  return dumped.split('\n');
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
  value: string | undefined,
  options: { quote?: boolean; afterKeys?: string[] } = {}
): void => {
  const ranges = indexCollectionYamlRanges(lines.join('\n'));
  const existing = ranges.get(key);
  if (value === undefined || value === '') {
    if (existing) {
      lines.splice(existing.startLine, existing.endLine - existing.startLine + 1);
    }
    return;
  }

  const isThreePartSemver = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value);
  const needsQuotes = Boolean(options.quote)
    || /[:#{}[\]&*!|>'"%@`\r\n\t]/.test(value)
    || /^[\s\-?,]|\s$/.test(value)
    || (!isThreePartSemver && /^(?:~|null|true|false|yes|no|on|off|[-+]?(?:\.\d|\d))/i.test(value));
  const formatted = needsQuotes ? JSON.stringify(value) : value;
  if (existing) {
    lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, `${key}: ${formatted}`);
    return;
  }

  let insertLine = 0;
  while (insertLine < lines.length && lines[insertLine].trim().startsWith('#')) {
    insertLine++;
  }
  for (const prevKey of (options.afterKeys ?? [])) {
    const prevRange = ranges.get(prevKey);
    if (prevRange && prevRange.endLine + 1 > insertLine) {
      insertLine = prevRange.endLine + 1;
    }
  }
  lines.splice(insertLine, 0, `${key}: ${formatted}`);
};

const upsertTopLevelTags = (lines: string[], tags: string[] | undefined): void => {
  const ranges = indexCollectionYamlRanges(lines.join('\n'));
  const existing = ranges.get('tags');
  const cleanTags = (tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);

  if (cleanTags.length === 0) {
    if (existing) {
      lines.splice(existing.startLine, existing.endLine - existing.startLine + 1);
    }
    return;
  }

  const block = serializeSectionMapping('tags', cleanTags as unknown as Record<string, unknown>);
  if (existing) {
    lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...block);
    return;
  }

  let insertLine = 0;
  for (const prevKey of ['id', 'name', 'description', 'version', 'author']) {
    const prevRange = ranges.get(prevKey);
    if (prevRange && prevRange.endLine + 1 > insertLine) {
      insertLine = prevRange.endLine + 1;
    }
  }
  lines.splice(insertLine, 0, ...block);
};

const upsertMcpSection = (
  lines: string[],
  mcp: { inputs?: CollectionMcpInput[]; items?: Record<string, CollectionMcpServerConfig> } | undefined
): void => {
  const ranges = indexCollectionYamlRanges(lines.join('\n'));
  const existing = ranges.get('mcp');
  const hasInputs = Array.isArray(mcp?.inputs) && mcp.inputs.length > 0;
  const hasItems = Boolean(mcp?.items && Object.keys(mcp.items).length > 0);

  if (!hasInputs && !hasItems) {
    if (existing) {
      lines.splice(existing.startLine, existing.endLine - existing.startLine + 1);
    }
    return;
  }

  const orderedMcp: Record<string, unknown> = {
    ...(hasInputs ? { inputs: mcp.inputs } : {}),
    ...(hasItems ? { items: mcp!.items } : {})
  };
  const block = serializeSectionMapping('mcp', orderedMcp);
  if (existing) {
    lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...block);
  } else {
    lines.push(...block);
  }
};

/**
 * Apply a surgical CRUD or quick-fix mutation to a `.collection.yml` string
 * while preserving top-of-file `$schema` directives and comments.
 * @param content Current YAML content.
 * @param mutation Mutation descriptor.
 * @returns Updated YAML content.
 */
export function applyCollectionYamlMutation(
  content: string,
  mutation: CollectionYamlMutation
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const ranges = indexCollectionYamlRanges(content);
  const parsed = (yaml.load(content) ?? {}) as Partial<CollectionManifest>;
  const parsedItems = Array.isArray(parsed.items) ? [...parsed.items] : [];

  switch (mutation.kind) {
    case 'update-metadata': {
      const m = mutation.metadata;
      if (m.id !== undefined) {
        upsertTopLevelScalar(lines, 'id', m.id, { afterKeys: [] });
      }
      if (m.name !== undefined) {
        upsertTopLevelScalar(lines, 'name', m.name, { afterKeys: ['id'] });
      }
      if (m.description !== undefined) {
        upsertTopLevelScalar(lines, 'description', m.description, { afterKeys: ['id', 'name'] });
      }
      if (m.version !== undefined) {
        upsertTopLevelScalar(lines, 'version', m.version, { afterKeys: ['id', 'name', 'description'] });
      }
      if (m.author !== undefined) {
        upsertTopLevelScalar(lines, 'author', m.author, { afterKeys: ['id', 'name', 'description', 'version'] });
      }
      if (m.tags !== undefined) {
        upsertTopLevelTags(lines, m.tags);
      }
      return lines.join(eol);
    }

    case 'bump-version': {
      const nextVersion = bumpCollectionVersion(
        typeof parsed.version === 'string' ? parsed.version : undefined,
        mutation.bump
      );
      upsertTopLevelScalar(lines, 'version', nextVersion, { afterKeys: ['id', 'name', 'description'] });
      return lines.join(eol);
    }

    case 'update-readme': {
      const existing = ranges.get('readme');
      const pathVal = mutation.path?.trim();
      if (!pathVal) {
        if (existing) {
          lines.splice(existing.startLine, existing.endLine - existing.startLine + 1);
        }
        return lines.join(eol);
      }
      const block = serializeSectionMapping('readme', { path: pathVal });
      if (existing) {
        lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...block);
      } else {
        lines.push(...block);
      }
      return lines.join(eol);
    }

    case 'update-display': {
      const existing = ranges.get('display');
      const d = mutation.display;
      const cleaned: Record<string, unknown> = {};
      if (d) {
        if (d.color) {
          cleaned.color = d.color;
        }
        if (d.icon) {
          cleaned.icon = d.icon;
        }
        if (d.ordering) {
          cleaned.ordering = d.ordering;
        }
        if (d.show_badge !== undefined) {
          cleaned.show_badge = d.show_badge;
        }
      }
      if (Object.keys(cleaned).length === 0) {
        if (existing) {
          lines.splice(existing.startLine, existing.endLine - existing.startLine + 1);
        }
        return lines.join(eol);
      }
      const block = serializeSectionMapping('display', cleaned);
      if (existing) {
        lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...block);
      } else {
        lines.push(...block);
      }
      return lines.join(eol);
    }

    case 'add-item': {
      const dashIndent = ranges.get('items.0')
        ? countLeadingSpaces(lines[ranges.get('items.0')!.startLine] ?? '  ')
        : 2;
      const block = serializeItemBlock(mutation.item, dashIndent);
      const itemsRange = ranges.get('items');
      if (itemsRange) {
        const itemsLine = lines[itemsRange.startLine] ?? '';
        if (/^items:\s*\[\s*\]/.test(itemsLine.trim())) {
          lines.splice(itemsRange.startLine, 1, 'items:', ...block);
        } else {
          lines.splice(itemsRange.endLine + 1, 0, ...block);
        }
      } else {
        lines.push('items:', ...block);
      }
      return lines.join(eol);
    }

    case 'update-item': {
      const targetRange = ranges.get(`items.${mutation.index}`);
      if (!targetRange) {
        throw new Error(`Item at index ${mutation.index} not found in .collection.yml`);
      }
      const dashIndent = countLeadingSpaces(lines[targetRange.startLine] ?? '  ');
      const block = serializeItemBlock(mutation.item, dashIndent);
      lines.splice(targetRange.startLine, targetRange.endLine - targetRange.startLine + 1, ...block);
      return lines.join(eol);
    }

    case 'remove-item': {
      const targetRange = ranges.get(`items.${mutation.index}`);
      if (!targetRange) {
        throw new Error(`Item at index ${mutation.index} not found in .collection.yml`);
      }
      if (parsedItems.length <= 1) {
        const itemsRange = ranges.get('items');
        if (itemsRange) {
          lines.splice(itemsRange.startLine, itemsRange.endLine - itemsRange.startLine + 1, 'items: []');
          return lines.join(eol);
        }
      }
      lines.splice(targetRange.startLine, targetRange.endLine - targetRange.startLine + 1);
      return lines.join(eol);
    }

    case 'move-item': {
      const { fromIndex, toIndex } = mutation;
      if (
        fromIndex < 0
        || fromIndex >= parsedItems.length
        || toIndex < 0
        || toIndex >= parsedItems.length
        || fromIndex === toIndex
      ) {
        return content;
      }
      const reordered = [...parsedItems];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      const itemsRange = ranges.get('items');
      const dashIndent = ranges.get('items.0')
        ? countLeadingSpaces(lines[ranges.get('items.0')!.startLine] ?? '  ')
        : 2;
      const sectionLines = serializeItemsSection(reordered, dashIndent);
      if (itemsRange) {
        lines.splice(itemsRange.startLine, itemsRange.endLine - itemsRange.startLine + 1, ...sectionLines);
      }
      return lines.join(eol);
    }

    case 'sort-items': {
      if (parsedItems.length <= 1) {
        return content;
      }
      const sorted = [...parsedItems].toSorted((a, b) =>
        (a.title ?? a.name ?? a.path).localeCompare(b.title ?? b.name ?? b.path)
      );
      const itemsRange = ranges.get('items');
      const dashIndent = ranges.get('items.0')
        ? countLeadingSpaces(lines[ranges.get('items.0')!.startLine] ?? '  ')
        : 2;
      const sectionLines = serializeItemsSection(sorted, dashIndent);
      if (itemsRange) {
        lines.splice(itemsRange.startLine, itemsRange.endLine - itemsRange.startLine + 1, ...sectionLines);
      }
      return lines.join(eol);
    }

    case 'upsert-mcp-input': {
      const currentMcp = parsed.mcp ?? {};
      const inputs = Array.isArray(currentMcp.inputs) ? [...currentMcp.inputs] : [];
      if (typeof mutation.index === 'number' && mutation.index >= 0 && mutation.index < inputs.length) {
        inputs[mutation.index] = mutation.input;
      } else {
        const existingIdx = inputs.findIndex((i) => i.id === mutation.input.id);
        if (existingIdx === -1) {
          inputs.push(mutation.input);
        } else {
          inputs[existingIdx] = mutation.input;
        }
      }
      upsertMcpSection(lines, { ...currentMcp, inputs });
      return lines.join(eol);
    }

    case 'remove-mcp-input': {
      const currentMcp = parsed.mcp ?? {};
      const inputs = Array.isArray(currentMcp.inputs) ? [...currentMcp.inputs] : [];
      if (mutation.index >= 0 && mutation.index < inputs.length) {
        inputs.splice(mutation.index, 1);
      }
      upsertMcpSection(lines, { ...currentMcp, inputs });
      return lines.join(eol);
    }

    case 'upsert-mcp-server': {
      const currentMcp = parsed.mcp ?? {};
      const itemsMap: Record<string, CollectionMcpServerConfig> = { ...currentMcp.items };
      if (mutation.previousKey && mutation.previousKey !== mutation.key) {
        delete itemsMap[mutation.previousKey];
      }
      itemsMap[mutation.key] = mutation.server;
      upsertMcpSection(lines, { ...currentMcp, items: itemsMap });
      return lines.join(eol);
    }

    case 'remove-mcp-server': {
      const currentMcp = parsed.mcp ?? {};
      const itemsMap: Record<string, CollectionMcpServerConfig> = { ...currentMcp.items };
      delete itemsMap[mutation.key];
      upsertMcpSection(lines, { ...currentMcp, items: itemsMap });
      return lines.join(eol);
    }

    case 'apply-quick-fix': {
      const qf = mutation.quickFix;
      switch (qf.kind) {
        case 'fix-deprecated-kind':
        case 'fix-kind-route': {
          const itemIdx = Number(qf.jsonPath[1] ?? 0);
          const kindRange = ranges.get(`items.${itemIdx}.kind`) ?? ranges.get(`items.${itemIdx}`);
          const replacementKind = typeof qf.replacementValue === 'string' ? qf.replacementValue : 'agent';
          updateScalarLine(lines, kindRange, 'kind', replacementKind, false);
          return lines.join(eol);
        }
        case 'sanitize-collection-id': {
          const sanitizedId = typeof qf.replacementValue === 'string'
            ? qf.replacementValue
            : generateSanitizedId(String(parsed.id ?? parsed.name ?? 'my-collection'));
          upsertTopLevelScalar(lines, 'id', sanitizedId, { afterKeys: [] });
          return lines.join(eol);
        }
        case 'fix-version': {
          const nextVer = typeof qf.replacementValue === 'string' ? qf.replacementValue : '1.0.0';
          upsertTopLevelScalar(lines, 'version', nextVer, { afterKeys: ['id', 'name', 'description'] });
          return lines.join(eol);
        }
        case 'scaffold-missing-readme': {
          const readmePath = typeof qf.filePath === 'string' && qf.filePath.length > 0
            ? qf.filePath
            : `docs/${String(parsed.id ?? 'collection')}/README.md`;
          return applyCollectionYamlMutation(content, {
            kind: 'update-readme',
            path: readmePath
          });
        }
        case 'scaffold-missing-item': {
          return content;
        }
      }
    }
  }
}

/**
 * Summarize structural changes between a base `.collection.yml` and an edited
 * `.collection.yml` to generate commit messages and pull request descriptions.
 * @param baseContent Original YAML content (undefined when creating a new collection).
 * @param currentContent Current YAML content.
 * @returns Change summary and suggested commit/PR strings.
 */
export function summarizeCollectionYamlChanges(
  baseContent: string | undefined,
  currentContent: string
): CollectionChangeSummary {
  const safeParse = (raw?: string): Partial<CollectionManifest> => {
    if (!raw) {
      return {};
    }
    try {
      const p = yaml.load(raw);
      return (p && typeof p === 'object' && !Array.isArray(p)) ? (p) : {};
    } catch {
      return {};
    }
  };

  const base = safeParse(baseContent);
  const curr = safeParse(currentContent);
  const collectionId = curr.id ?? base.id ?? 'collection';

  const metadataChanged = Boolean(baseContent)
    && (
      base.id !== curr.id
      || base.name !== curr.name
      || base.description !== curr.description
      || base.version !== curr.version
      || base.author !== curr.author
      || JSON.stringify(base.tags ?? []) !== JSON.stringify(curr.tags ?? [])
      || JSON.stringify(base.display ?? {}) !== JSON.stringify(curr.display ?? {})
      || JSON.stringify(base.readme ?? {}) !== JSON.stringify(curr.readme ?? {})
    );

  const baseItemsByPath = new Map<string, CollectionItemDefinition>();
  for (const item of (base.items ?? [])) {
    if (item?.path) {
      baseItemsByPath.set(item.path, item);
    }
  }

  const currItemsByPath = new Map<string, CollectionItemDefinition>();
  for (const item of (curr.items ?? [])) {
    if (item?.path) {
      currItemsByPath.set(item.path, item);
    }
  }

  const itemsAdded: string[] = [];
  const itemsModified: string[] = [];
  const itemsRemoved: string[] = [];

  for (const [p, item] of currItemsByPath.entries()) {
    const prev = baseItemsByPath.get(p);
    if (!prev) {
      itemsAdded.push(p);
    } else if (JSON.stringify(prev) !== JSON.stringify(item)) {
      itemsModified.push(p);
    }
  }
  for (const p of baseItemsByPath.keys()) {
    if (!currItemsByPath.has(p)) {
      itemsRemoved.push(p);
    }
  }

  const baseServers = base.mcp?.items ?? {};
  const currServers = curr.mcp?.items ?? {};
  const mcpServersAdded = Object.keys(currServers).filter((k) => !(k in baseServers));
  const mcpServersModified = Object.keys(currServers).filter(
    (k) => k in baseServers && JSON.stringify(baseServers[k]) !== JSON.stringify(currServers[k])
  );
  const mcpServersRemoved = Object.keys(baseServers).filter((k) => !(k in currServers));

  const baseInputs = new Set((base.mcp?.inputs ?? []).map((i) => i.id));
  const currInputs = new Set((curr.mcp?.inputs ?? []).map((i) => i.id));
  const mcpInputsAdded = [...currInputs].filter((id) => !baseInputs.has(id));
  const mcpInputsRemoved = [...baseInputs].filter((id) => !currInputs.has(id));

  const parts: string[] = [];
  if (baseContent) {
    if (itemsAdded.length > 0) {
      parts.push(`add ${itemsAdded.length} item(s)`);
    }
    if (itemsModified.length > 0) {
      parts.push(`update ${itemsModified.length} item(s)`);
    }
    if (itemsRemoved.length > 0) {
      parts.push(`remove ${itemsRemoved.length} item(s)`);
    }
    if (mcpServersAdded.length + mcpServersModified.length + mcpServersRemoved.length > 0) {
      parts.push('update MCP configuration');
    }
    if (metadataChanged && parts.length === 0) {
      parts.push('update metadata');
    }
  } else {
    parts.push(`add collection ${collectionId}`);
  }

  const summaryPhrase = parts.length > 0 ? parts.join(', ') : `update collection ${collectionId}`;
  const suggestedCommitMessage = `feat(collection): ${summaryPhrase} in ${collectionId}`;
  const suggestedPrTitle = `feat(collection): ${summaryPhrase} (${collectionId})`;

  const bullets: string[] = [];
  if (!baseContent) {
    bullets.push(`- Created collection \`${collectionId}\` (${curr.name ?? collectionId})`);
  }
  if (metadataChanged) {
    bullets.push(`- Updated metadata/display configuration for \`${collectionId}\``);
  }
  for (const p of itemsAdded) {
    bullets.push(`- Added primitive item \`${p}\``);
  }
  for (const p of itemsModified) {
    bullets.push(`- Updated primitive item \`${p}\``);
  }
  for (const p of itemsRemoved) {
    bullets.push(`- Removed primitive item \`${p}\``);
  }
  for (const s of mcpServersAdded) {
    bullets.push(`- Added MCP server \`${s}\``);
  }
  for (const s of mcpServersModified) {
    bullets.push(`- Updated MCP server \`${s}\``);
  }
  for (const s of mcpServersRemoved) {
    bullets.push(`- Removed MCP server \`${s}\``);
  }

  const suggestedPrBody = [
    `## Summary`,
    ``,
    ...(bullets.length > 0 ? bullets : [`- Updated collection \`${collectionId}\``])
  ].join('\n');

  return {
    collectionId,
    metadataChanged,
    itemsAdded,
    itemsModified,
    itemsRemoved,
    mcpServersAdded,
    mcpServersModified,
    mcpServersRemoved,
    mcpInputsAdded,
    mcpInputsRemoved,
    suggestedCommitMessage,
    suggestedPrTitle,
    suggestedPrBody
  };
}
