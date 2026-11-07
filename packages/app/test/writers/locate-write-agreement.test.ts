/**
 * Every built-in writer locates a recorded file where it wrote it.
 *
 * For each target type at user and repository scope, a bundle covering
 * every Copilot type, a nested prompt, an item whose type differs from its
 * directory, a skill and a plugin whose id differs from its directory is
 * installed through the shared writer factory. Locating the recorded files
 * (bundle path plus `installedPath`, as a lockfile entry records them)
 * must return exactly the paths the write reported.
 */
import * as path from 'node:path';
import type {
  InstallationScope,
  Target,
} from '@ai-primitives-hub/core';
import {
  TARGET_TYPES,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  writeBundleForInstall,
} from '../../src/install/partial-target-write';
import {
  TargetWriteRejectedError,
} from '../../src/install/target-write';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const MANIFEST = `id: agreement
version: 1.0.0
name: Agreement
prompts:
  - id: top
    name: Top
    file: prompts/top.prompt.md
    type: prompt
  - id: nested
    name: Nested
    file: prompts/sub/nested.prompt.md
    type: prompt
  - id: rules
    name: Rules
    file: instructions/rules.instructions.md
    type: instructions
  - id: mode
    name: Mode
    file: chatmodes/mode.chatmode.md
    type: chatmode
  - id: helper
    name: Helper
    file: agents/helper.agent.md
    type: agent
  - id: misplaced
    name: Misplaced
    file: prompts/misplaced.agent.md
    type: agent
  - id: demo-skill
    name: Demo skill
    file: skills/demo-skill/SKILL.md
    type: skill
  - id: renamed-plugin
    name: Plugin
    file: plugins/source-plugin/plugin.json
    type: plugin
`;

const bundle = (): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text(MANIFEST)],
  ['prompts/top.prompt.md', text('# Top')],
  ['prompts/sub/nested.prompt.md', text('# Nested')],
  ['instructions/rules.instructions.md', text('# Rules')],
  ['chatmodes/mode.chatmode.md', text('# Mode')],
  ['agents/helper.agent.md', text('---\ndescription: Helps\n---\n# Helper')],
  ['prompts/misplaced.agent.md', text('# Misplaced')],
  ['skills/demo-skill/SKILL.md', text('---\nname: demo-skill\n---\n# Skill')],
  ['skills/demo-skill/references/notes.md', text('# Notes')],
  ['plugins/source-plugin/plugin.json', text('{"name":"renamed-plugin"}')],
  ['plugins/source-plugin/scripts/run.sh', text('#!/bin/sh\necho run\n')]
]);

const SCOPES: InstallationScope[] = ['user', 'repository'];
const CASES = TARGET_TYPES.flatMap((type) => SCOPES.flatMap((scope) => [false, true].map((skipUnsupported) => ({
  type,
  scope,
  skipUnsupported
}))));

describe('locate agrees with write for every built-in writer', () => {
  it.each(CASES)('$type at $scope scope (skipUnsupported: $skipUnsupported)', async ({ type, scope, skipUnsupported }) => {
    const fs = new InMemoryFileSystem();
    const factory = createTargetWriterFactory({
      fs,
      env: { HOME: '/home/u' },
      projectDir: null,
      userConfigDir: null,
      writerOwnsExclusion: false
    });
    const target = { name: 't', type, scope, ...(scope === 'repository' ? { rootPath: '/ws', commitMode: 'commit' } : {}) } as Target;
    const writer = factory(target);
    const files = bundle();

    let written: string[];
    let recorded: { path: string; installedPath?: string }[];
    try {
      const write = await writeBundleForInstall(writer, target, files, validateManifest(files, {}), { skipUnsupported });
      written = write.result.written;
      recorded = (write.result.writtenBundlePaths ?? []).map((bundlePath) => {
        const installedPath = write.result.installedPaths?.[bundlePath];
        return installedPath === undefined ? { path: bundlePath } : { path: bundlePath, installedPath };
      });
    } catch (err) {
      expect(err).toBeInstanceOf(TargetWriteRejectedError);
      return;
    }

    if (writer.locate === undefined) {
      throw new Error(`${type} writer cannot locate files`);
    }
    const located = await writer.locate(target, recorded);

    expect(recorded).toHaveLength(written.length);
    expect(located.paths).toEqual(written);
    for (const location of located.paths) {
      expect((location as string).startsWith(`${located.root}${path.sep}`), location as string).toBe(true);
    }
  });

  it('places the whole fixture on the Copilot-like targets at both scopes', async () => {
    for (const type of ['vscode', 'vscode-insiders', 'copilot-cli'] as const) {
      for (const scope of SCOPES) {
        const fs = new InMemoryFileSystem();
        const target = { name: 't', type, scope, ...(scope === 'repository' ? { rootPath: '/ws' } : {}) } as Target;
        const writer = createTargetWriterFactory({
          fs, env: { HOME: '/home/u' }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
        })(target);
        const files = bundle();

        const write = await writeBundleForInstall(writer, target, files, validateManifest(files, {}));

        expect(write.result.written.length, `${type} ${scope}`).toBe(files.size - 1);
      }
    }
  });
});
