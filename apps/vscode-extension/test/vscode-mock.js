// Mock vscode API for unit tests
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  workspace: {
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
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    showQuickPick: () => Promise.resolve(),
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
    constructor(id) {
      this.id = id;
    }
  },
  Uri: {
    file: (path) => ({ fsPath: path, scheme: 'file' }),
    parse: (path) => ({ fsPath: path, scheme: 'file' }),
    joinPath: (base, ...segments) => ({ fsPath: base.fsPath + '/' + segments.join('/'), scheme: 'file' })
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
