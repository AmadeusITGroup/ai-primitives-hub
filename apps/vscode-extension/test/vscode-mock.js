// Mock vscode API for unit tests
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  secrets: {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined
  },
  workspace: {
    workspaceFolders: undefined,
    textDocuments: [],
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    openTextDocument: async (uriOrOptions) => ({
      uri: uriOrOptions?.fsPath ? uriOrOptions : { fsPath: '/mock/hub-config.yml', scheme: 'file' },
      fileName: uriOrOptions?.fsPath || '/mock/hub-config.yml',
      languageId: uriOrOptions?.language || 'yaml',
      lineCount: 1,
      getText: () => uriOrOptions?.content || '',
      lineAt: (line) => ({ text: '', range: { start: { line, character: 0 }, end: { line, character: 0 } } }),
      positionAt: () => ({ line: 0, character: 0 }),
      save: async () => true
    }),
    applyEdit: async () => true,
    getConfiguration: (section) => ({
      get: (key, defaultValue) => {
        // Return mock configuration values for testing
        if (section === 'promptregistry') {
          const config = {
            'githubToken': 'test-token'
          };
          return config[key] || defaultValue;
        }
        return defaultValue;
      },
      update: async (key, value, target) => undefined
    }),
    fs: {
      writeFile: async (uri, content) => {
        const filePath = uri.fsPath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content);
      },
      readFile: async (uri) => {
        const filePath = uri.fsPath;
        return fs.readFileSync(filePath);
      },
      createDirectory: async (uri) => {
        const dirPath = uri.fsPath;
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      },
      delete: async (uri, options) => {
        const filePath = uri.fsPath;
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { recursive: options?.recursive || false });
        }
      },
      stat: async (uri) => {
        const filePath = uri.fsPath;
        const stats = fs.statSync(filePath);
        return {
          type: stats.isDirectory() ? 2 : 1, // FileType.Directory = 2, FileType.File = 1
          ctime: stats.ctimeMs,
          mtime: stats.mtimeMs,
          size: stats.size
        };
      },
      readDirectory: async (uri) => {
        const dirPath = uri.fsPath;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map(entry => [
          entry.name,
          entry.isDirectory() ? 2 : 1 // FileType.Directory = 2, FileType.File = 1
        ]);
      }
    }
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose: () => {} }),
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    showQuickPick: () => Promise.resolve(),
    showInputBox: () => Promise.resolve(),
    showOpenDialog: () => Promise.resolve(),
    showTextDocument: () => Promise.resolve(),
    createTextEditorDecorationType: () => ({ key: 'mock-decoration', dispose: () => {} }),
    registerCustomEditorProvider: () => ({ dispose: () => {} }),
    createTreeView: () => ({ dispose: () => {} }),
    createQuickPick: () => {
      const quickPick = {
        items: [],
        selectedItems: [],
        title: '',
        placeholder: '',
        ignoreFocusOut: false,
        onDidChangeSelection: () => ({ dispose: () => {} }),
        onDidAccept: () => ({ dispose: () => {} }),
        onDidHide: () => ({ dispose: () => {} }),
        show: () => {},
        hide: () => {},
        dispose: () => {}
      };
      return quickPick;
    },
    createOutputChannel: (name) => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined
    }),
    withProgress: async (options, task) => {
      const progress = { report: () => undefined };
      return await task(progress);
    },
    createTerminal: (options) => ({
      show: () => undefined,
      sendText: () => undefined,
      dispose: () => undefined,
      name: options?.name || 'terminal',
      processId: Promise.resolve(12345),
      creationOptions: options || {},
      exitStatus: undefined,
      state: { isInteractedWith: false }
    })
  },
  // Add missing TreeView related mocks
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  EventEmitter: class {
    constructor() {
      this.event = (listener) => ({ dispose: () => {} });
    }
    fire(data) {}
    dispose() {}
  },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(startLineOrPos, startCharOrEndPos, endLine, endChar) {
      if (typeof startLineOrPos === 'number') {
        this.start = { line: startLineOrPos, character: startCharOrEndPos };
        this.end = { line: endLine, character: endChar };
      } else {
        this.start = startLineOrPos;
        this.end = startCharOrEndPos;
      }
    }
    intersection(other) {
      if (!other) return undefined;
      if (other.end.line < this.start.line || other.start.line > this.end.line) {
        return undefined;
      }
      return this;
    }
  },
  Selection: class {
    constructor(anchorLine, anchorChar, activeLine, activeChar) {
      this.start = { line: anchorLine, character: anchorChar };
      this.end = { line: activeLine, character: activeChar };
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
  },
  Diagnostic: class {
    constructor(range, message, severity = 0) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  CodeLens: class {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  CodeActionKind: {
    QuickFix: { value: 'quickfix' }
  },
  CodeAction: class {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
    }
  },
  WorkspaceEdit: class {
    constructor() {
      this.edits = [];
    }
    replace(uri, range, newText) {
      this.edits.push({ uri, range, newText });
    }
  },
  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2
  },
  languages: {
    createDiagnosticCollection: (name) => {
      const store = new Map();
      return {
        name,
        set: (uri, diags) => store.set(uri.fsPath || String(uri), diags),
        get: (uri) => store.get(uri.fsPath || String(uri)),
        delete: (uri) => store.delete(uri.fsPath || String(uri)),
        clear: () => store.clear(),
        dispose: () => store.clear()
      };
    },
    registerCodeLensProvider: () => ({ dispose: () => {} }),
    registerCodeActionsProvider: () => ({ dispose: () => {} })
  },
  Uri: {
    file: (path) => ({ fsPath: path, scheme: 'file', toString: () => `file://${path}` }),
    parse: (path) => ({ fsPath: path, scheme: 'file', toString: () => path }),
    joinPath: (base, ...segments) => ({
      fsPath: base.fsPath + '/' + segments.join('/'),
      scheme: 'file',
      toString: () => `file://${base.fsPath}/${segments.join('/')}`
    })
  },
  env: {
    appName: 'Visual Studio Code',
    appRoot: '/mock/app/root',
    language: 'en',
    machineId: 'mock-machine-id',
    sessionId: 'mock-session-id',
    remoteName: undefined,
    shell: '/bin/bash',
    openExternal: () => Promise.resolve(true)
  },
  authentication: {
    getSession: () => Promise.resolve(undefined)
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve()
  },
  ProgressLocation: {
    Notification: 15,
    Window: 10,
    SourceControl: 1
  },
  extensions: {
    getExtension: () => undefined,
    all: []
  }
};
