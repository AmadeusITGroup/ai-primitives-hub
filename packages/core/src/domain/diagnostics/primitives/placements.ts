/**
 * Domain layer — primitive diagnostics placement oracle.
 *
 * Where an installed archive file is expected to land, as a sandbox label
 * (`$HOME/…` at user scope, `<workspace>/…` at repository scope). Declared
 * here from the placements observed after #532, deliberately independent
 * of infra's writer layouts, so a route regression there fails I13.
 *
 * Gapped cells keep their route (chat-mode on copilot-cli, hook on kiro,
 * copilot-cli at repository scope), so a fix PR only deletes the gap entry.
 * @module domain/diagnostics/primitives/placements
 */
import type {
  TargetType,
} from '../../install/target';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import type {
  FixtureItem,
} from './catalogue';
import type {
  DiagnosticScope,
} from './types';

/** Placement root label per target and scope. */
export const PLACEMENT_ROOTS: Readonly<Record<TargetType, Readonly<Record<DiagnosticScope, string>>>> = {
  vscode: { user: '$HOME/.copilot', repository: '<workspace>/.github' },
  'vscode-insiders': { user: '$HOME/.copilot', repository: '<workspace>/.github' },
  'copilot-cli': { user: '$HOME/.copilot', repository: '<workspace>/.github' },
  kiro: { user: '$HOME/.kiro', repository: '<workspace>/.kiro' },
  'kiro-cli': { user: '$HOME/.kiro', repository: '<workspace>/.kiro' },
  windsurf: { user: '$HOME/.codeium/windsurf', repository: '<workspace>/.windsurf' },
  'claude-code': { user: '$HOME/.claude', repository: '<workspace>/.claude' },
  cursor: { user: '$HOME/.cursor', repository: '<workspace>/.cursor' },
  opencode: { user: '$HOME/.opencode', repository: '<workspace>/.opencode' },
  devin: { user: '$HOME/.devin', repository: '<workspace>/.devin' },
  'devin-cli': { user: '$HOME/.devin', repository: '<workspace>/.devin' }
};

type Routes = Readonly<Partial<Record<PrimitiveKind, string>>>;

/** Routes every target has; `config` = merged into a host config file (MCP). */
const COMMON: Routes = { 'chat-mode': 'agents/', agent: 'agents/', skill: 'skills/', hook: 'hooks/', 'mcp-server': 'config' };
const COPILOT: Routes = { ...COMMON, prompt: 'prompts/', instruction: 'instructions/' };
const KIRO: Routes = { ...COMMON, prompt: 'steering/', instruction: 'steering/', steering: 'steering/', spec: 'specs/', power: 'powers/' };
const DEVIN: Routes = { ...COMMON, prompt: 'prompts/', instruction: 'instructions/', power: 'powers/', knowledge: 'knowledge/', playbook: 'playbooks/' };

/** Destination prefix under the root, per supported cell; the literal 'config' = merged into a config file (MCP). */
export const PLACEMENT_ROUTES: Readonly<Record<TargetType, Routes>> = {
  vscode: COPILOT,
  'vscode-insiders': COPILOT,
  'copilot-cli': COPILOT,
  kiro: KIRO,
  'kiro-cli': KIRO,
  windsurf: { ...COMMON, prompt: 'rules/', instruction: 'rules/' },
  'claude-code': { ...COMMON, prompt: 'commands/', instruction: 'instructions/', command: 'commands/', 'output-style': 'output-styles/' },
  cursor: { ...COMMON, prompt: 'rules/', instruction: 'rules/', rule: 'rules/' },
  opencode: { ...COMMON, prompt: 'commands/', instruction: 'rules/', tool: 'tools/' },
  devin: DEVIN,
  'devin-cli': DEVIN
};

/** Expected destination of one archived file. */
export type ExpectedDestination = { kind: 'file'; label: string } | { kind: 'config' } | { kind: 'none' };

/**
 * Expected destination of an archived item file.
 * @param target - Target type.
 * @param scope - Effective scope of the install.
 * @param item - Collection item the file belongs to.
 * @param archivePath - Archive-relative path of the file (starts with `item.sourcePrefix`).
 * @returns The label `${root}/${route}${archivePath minus sourcePrefix}`, `config` for merged
 * config items, or `none` for an unsupported cell.
 */
export function expectedDestination(
  target: TargetType,
  scope: DiagnosticScope,
  item: FixtureItem,
  archivePath: string
): ExpectedDestination {
  const route = PLACEMENT_ROUTES[target][item.kind];
  if (route === undefined) {
    return { kind: 'none' };
  }
  if (route === 'config') {
    return { kind: 'config' };
  }
  return { kind: 'file', label: `${PLACEMENT_ROOTS[target][scope]}/${route}${archivePath.slice(item.sourcePrefix.length)}` };
}
