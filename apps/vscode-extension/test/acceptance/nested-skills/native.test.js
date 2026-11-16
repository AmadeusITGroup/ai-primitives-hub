/* global require, process, setTimeout, suite, test, suiteSetup, suiteTeardown -- Mocha suite inside the real extension host */
/**
 * Native side of the nested skill layout acceptance (issue #701), run in a
 * real VS Code extension host. Only user-input APIs are scripted: a source is
 * added and bundles installed / uninstalled through the extension's commands,
 * then the installed skill trees are checked against the oracle.
 *
 * Phase (APH_NESTED_PHASE) = `<scope>:<source type>`, e.g. `user:local`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const pkg = require('../../../package.json');
const { COLLECTIONS, assertSkills, listTree, skillMarkers } = require('./model');

const ROOT = process.env.APH_NESTED_ROOT;
const [SCOPE, SOURCE_TYPE] = process.env.APH_NESTED_PHASE.split(':');
const SOURCE_DIR = process.env.APH_NESTED_SOURCE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const skillsRoot = () => (SCOPE === 'user' ? path.join(process.env.HOME, '.copilot', 'skills') : path.join(ws(), '.github', 'skills'));

const prompts = [];
const errors = [];
const observed = {};
const failures = [];

/** Scripted answers: { kind, match: RegExp, answer }. Unscripted prompts are recorded and cancelled. */
const script = [];
function answer(kind, text) {
  prompts.push({ kind, text });
  const i = script.findIndex((s) => s.kind === kind && s.match.test(text));
  return i === -1 ? undefined : script.splice(i, 1)[0].answer;
}

function installInputBoundary() {
  const w = vscode.window;
  w.showQuickPick = async (items, options = {}) => {
    const choose = answer('quickPick', `${options.placeHolder ?? ''} ${options.title ?? ''}`);
    if (choose === undefined) {
      return undefined;
    }
    const hit = (await items).filter((item) => choose(item));
    assert.equal(hit.length, 1, `QuickPick "${options.placeHolder}": expected one match`);
    return hit[0];
  };
  w.createQuickPick = () => {
    const accept = new vscode.EventEmitter();
    const hide = new vscode.EventEmitter();
    const change = new vscode.EventEmitter();
    const qp = {
      items: [], selectedItems: [], title: '', placeholder: '', ignoreFocusOut: false,
      onDidAccept: accept.event, onDidHide: hide.event, onDidChangeSelection: change.event,
      show: () => {
        const choose = answer('scopePicker', `${qp.title} ${qp.placeholder}`);
        if (choose === undefined) {
          setTimeout(() => hide.fire(), 0);
          return;
        }
        const hit = qp.items.filter((item) => choose(item));
        assert.equal(hit.length, 1, 'scope picker: expected one matching item');
        qp.selectedItems = hit;
        setTimeout(() => accept.fire(), 0);
      },
      hide: () => hide.fire(),
      dispose: () => {}
    };
    return qp;
  };
  w.showInputBox = async (options = {}) => answer('input', options.prompt ?? options.title ?? '');
  w.showOpenDialog = async (options = {}) => answer('dialog', options.title ?? options.openLabel ?? '');
  w.showWarningMessage = async (message, ...rest) => {
    const items = rest.filter((r) => typeof r === 'string' || r?.title !== undefined).map((r) => r.title ?? r);
    return items.length === 0 ? (prompts.push({ kind: 'warning', text: message }), undefined) : answer('warning', `${message} [${items.join('|')}]`);
  };
  w.showErrorMessage = async (message) => {
    errors.push(String(message));
    return undefined;
  };
  w.showInformationMessage = async (message) => {
    prompts.push({ kind: 'info', text: String(message) });
    return undefined;
  };
}

/** Record a soft check failure so later steps still run and get observed. */
function check(label, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

async function addSource() {
  const typeMatch = (item) => item.value === SOURCE_TYPE;
  script.push(
    { kind: 'quickPick', match: /Select source type/, answer: typeMatch },
    { kind: 'input', match: /source name/i, answer: 'Nested Skills Fixture' },
    { kind: 'dialog', match: /./, answer: [vscode.Uri.file(SOURCE_DIR)] },
    { kind: 'input', match: /collections directory/i, answer: 'collections' },
    { kind: 'input', match: /priority/i, answer: '1' }
  );
  await vscode.commands.executeCommand('promptRegistry.addSource');
  script.splice(0);
  await vscode.commands.executeCommand('promptRegistry.syncAllSources');
}

/** Install through the command palette flow, retrying until the source has synced. */
async function install(bundleId) {
  const deadline = Date.now() + 30000;
  for (;;) {
    errors.splice(0);
    script.splice(0);
    script.push(
      {
        kind: 'scopePicker', match: /Select Scope/,
        answer: (item) => item._scope === SCOPE && (SCOPE === 'user' || item._commitMode === 'commit')
      },
      { kind: 'quickPick', match: /auto-update/i, answer: (item) => item.value === false }
    );
    await vscode.commands.executeCommand('promptRegistry.installBundle', bundleId);
    if (script.length === 0 && errors.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`install ${bundleId}: unanswered=${JSON.stringify(script.map((s) => s.match.source))} errors=${errors.join(' | ')}`);
    }
    await sleep(500);
  }
}

async function uninstall(bundleId) {
  errors.splice(0);
  script.push({ kind: 'warning', match: /Are you sure/, answer: 'Uninstall' });
  await vscode.commands.executeCommand('promptRegistry.uninstallBundle', bundleId);
  assert.deepEqual(errors, [], `uninstall ${bundleId}`);
}

suite(`nested skills acceptance (${SCOPE} via ${SOURCE_TYPE} source)`, () => {
  suiteSetup(async () => {
    installInputBoundary();
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    await ext.activate();
    await addSource();
  });

  suiteTeardown(() => {
    fs.writeFileSync(path.join(ROOT, 'native-observed.json'), JSON.stringify({
      phase: process.env.APH_NESTED_PHASE, skillsRoot: skillsRoot(), observed, failures, errors, prompts
    }, null, 2));
  });

  test('installs each nested skill under its own leaf folder', async () => {
    const installed = [];
    for (const bundleId of Object.keys(COLLECTIONS)) {
      await install(bundleId);
      installed.push(bundleId);
      observed[`after install ${bundleId}`] = skillMarkers(skillsRoot());
    }
    check('install', () => assertSkills(skillsRoot(), installed, `vscode ${SCOPE}/${SOURCE_TYPE}`));
    if (SCOPE === 'user') {
      for (const bundleId of Object.keys(COLLECTIONS)) {
        await uninstall(bundleId);
        installed.splice(installed.indexOf(bundleId), 1);
        observed[`after uninstall ${bundleId}`] = skillMarkers(skillsRoot());
        check(`uninstall ${bundleId}`, () => assertSkills(skillsRoot(), installed, `vscode ${SCOPE}/${SOURCE_TYPE} uninstall ${bundleId}`));
      }
      check('uninstall', () => assert.deepEqual(listTree(skillsRoot()), [], 'uninstall leaves no skill files'));
    }
    assert.deepEqual(failures, [], failures.join('\n---\n'));
  });
});
