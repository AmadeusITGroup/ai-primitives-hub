// Mock vscode module for unit tests
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// Set test environment flag to prevent UpdateScheduler from running
process.env.NODE_ENV = 'test';

// Ensure this is running in Mocha context
if (typeof global.suite === 'undefined' && typeof global.describe === 'undefined') {
  console.warn('[mocha.setup.js] Warning: Mocha test functions not available yet. This file should be loaded via --require flag.');
}

// Clear module cache to ensure fresh mocks
Object.keys(require.cache).forEach(key => {
  if (key.includes('vscode') || key.includes('logger')) {
    delete require.cache[key];
  }
});

// Intercept vscode module loading
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
  if (request === 'vscode') {
    return path.resolve(__dirname, 'mocha.setup.js');
  }
  return originalResolveFilename.call(this, request, parent, isMain);
};

// Mock vscode API
const vscode = {
  FileType: {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64
  },
  workspace: {
    fs: {
      createDirectory: (uri) => {
          if (uri.scheme === 'file') {
              return fs.promises.mkdir(uri.fsPath, { recursive: true });
          }
          return Promise.resolve();
      },
      writeFile: (uri, content) => {
          if (uri.scheme === 'file') {
              return fs.promises.writeFile(uri.fsPath, content);
          }
          return Promise.resolve();
      },
      readFile: (uri) => {
          if (uri.scheme === 'file') {
              return fs.promises.readFile(uri.fsPath);
          }
          return Promise.resolve(new Uint8Array());
      },
      stat: (uri) => {
          if (uri.scheme === 'file') {
              return fs.promises.stat(uri.fsPath).then(stats => {
                  return {
                      type: stats.isDirectory() ? 2 : (stats.isFile() ? 1 : 0),
                      ctime: stats.ctimeMs,
                      mtime: stats.mtimeMs,
                      size: stats.size
                  };
              });
          }
          return Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: 0 });
      },
      readDirectory: (uri) => {
          if (uri.scheme === 'file') {
              return fs.promises.readdir(uri.fsPath, { withFileTypes: true }).then(entries => {
                  return entries.map(e => [e.name, e.isDirectory() ? 2 : 1]);
              });
          }
          return Promise.resolve([]);
      }
    },
    createFileSystemWatcher: (pattern) => {
      // Return a mock FileSystemWatcher
      return {
        onDidChange: (listener) => ({ dispose: () => {} }),
        onDidCreate: (listener) => ({ dispose: () => {} }),
        onDidDelete: (listener) => ({ dispose: () => {} }),
        dispose: () => {}
      };
    },
    getConfiguration: (section) => ({
      get: (key, defaultValue) => {
        // Return mock configuration values for testing
        if (section === 'promptregistry') {
          const config = {
            'githubToken': 'test-token'
          };
          return config[key] || defaultValue;
        }
        // Mock promptregistry.updateCheck configuration to prevent UpdateScheduler errors
        if (section === 'promptregistry.updateCheck') {
          const config = {
            'enabled': false, // Disable update checks during tests
            'frequency': 'manual',
            'cacheTTL': 300000, // 5 minutes
            'notificationPreference': 'all'
          };
          return config[key] || defaultValue;
        }
        // Mock promptregistry configuration
        if (section === 'promptregistry') {
          const config = {
            'githubToken': '',
            'autoCheckUpdates': false, // Disable auto updates during tests
            'installationScope': 'user'
          };
          return config[key] || defaultValue;
        }
        return defaultValue;
      },
      update: async (key, value, target) => undefined
    }),
    workspaceFolders: [
        {
            uri: { fsPath: '/mock/workspace' },
            name: 'workspace',
            index: 0
        }
    ]
  },
  window: {
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    showInputBox: (options) => Promise.resolve(undefined),
    showQuickPick: (items, options) => Promise.resolve(undefined),
    showSaveDialog: (options) => Promise.resolve(undefined),
    showOpenDialog: (options) => Promise.resolve(undefined),
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
    createOutputChannel: (name) => {
      const channel = {
        appendLine: function() { return undefined; },
        clear: function() { return undefined; },
        show: function() { return undefined; },
        dispose: function() { return undefined; }
      };
      return channel;
    },
    withProgress: async (options, task) => {
      const progress = { report: () => undefined };
      return await task(progress);
    }
  },
  ProgressLocation: {
    Notification: 15,
    Window: 10,
    SourceControl: 1
  },
  commands: {
    registerCommand: (command, callback) => ({ dispose: () => {} }),
    executeCommand: (command, ...args) => Promise.resolve(undefined),
    getCommands: () => Promise.resolve([])
  },
  authentication: {
    // Mock authentication API for GitHub tests
    getSession: async () => undefined,
    onDidChangeSessions: () => ({ dispose: () => {} })
  },
  Uri: {
    file: (path) => ({
      fsPath: path,
      scheme: 'file',
      authority: '',
      path: path,
      query: '',
      fragment: '',
      toString: () => `file://${path}`
    }),
    joinPath: (base, ...segments) => {
        const pathModule = require('path');
        const joined = pathModule.join(base.path, ...segments);
        return {
            fsPath: joined,
            scheme: base.scheme,
            authority: base.authority,
            path: joined,
            query: '',
            fragment: '',
            toString: () => `${base.scheme}://${joined}`
        };
    },
    parse: (value) => {
        let scheme = 'file';
        let path = value;
        let query = '';
        if (value.startsWith('http')) {
            scheme = value.split('://')[0];
        }
        const qIdx = value.indexOf('?');
        if (qIdx !== -1) {
            query = value.substring(qIdx + 1);
            path = value.substring(0, qIdx);
        }
        return {
            fsPath: value,
            scheme,
            path,
            query,
            fragment: '',
            toString: () => value
        };
    }
  },
  EventEmitter: class EventEmitter {
    constructor() {
      this.listeners = [];
    }
    get event() {
      return (listener) => {
        this.listeners.push(listener);
        return { 
          dispose: () => {
            const index = this.listeners.indexOf(listener);
            if (index !== -1) {
              this.listeners.splice(index, 1);
            }
          }
        };
      };
    }
    fire(data) {
      this.listeners.forEach(listener => listener(data));
    }
    dispose() {
      this.listeners = [];
    }
  },
  env: {
    appName: 'Visual Studio Code',
    appRoot: '/mock/app/root',
    language: 'en',
    machineId: 'mock-machine-id',
    sessionId: 'mock-session-id',
    remoteName: undefined,
    uriScheme: 'vscode',
    shell: '/bin/bash',
    isTelemetryEnabled: true,
    openExternal: (uri) => Promise.resolve(true),
    createTelemetryLogger: (sender, options) => {
      let _isUsageEnabled = true;
      return {
        get isUsageEnabled() { return _isUsageEnabled; },
        set isUsageEnabled(v) { _isUsageEnabled = v; },
        get isErrorsEnabled() { return _isUsageEnabled; },
        onDidChangeEnableStates: () => ({ dispose: () => {} }),
        logUsage: (eventName, data) => {
          if (_isUsageEnabled) {
            sender.sendEventData(eventName, data);
          }
        },
        logError: (eventNameOrError, data) => {
          if (_isUsageEnabled) {
            if (eventNameOrError instanceof Error) {
              sender.sendErrorData(eventNameOrError, data);
            } else {
              sender.sendEventData(eventNameOrError, data);
            }
          }
        },
        dispose: () => {
          if (sender.flush) { sender.flush(); }
        }
      };
    }
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  ProgressLocation: {
    SourceControl: 1,
    Window: 10,
    Notification: 15
  },
  QuickPickItemKind: {
    Separator: -1,
    Default: 0
  },
  TreeItem: class TreeItem {
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
  ThemeIcon: class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  extensions: {
    getExtension: () => undefined,
    all: []
  },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  }
};

module.exports = vscode;

// Also set it globally
global.vscode = vscode;
