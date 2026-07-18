# Service Layer Guide

## Purpose

Services contain business logic, separated from UI and commands.

## Key Services

| Service | Responsibility |
|---------|----------------|
| `RegistryManager` | Orchestrates sources, bundles, installations |
| `BundleInstaller` | Extraction, validation, installation |
| `UserScopeService` | Syncs to Copilot directories (user/workspace scope) |
| `RepositoryScopeService` | Syncs to `.github/` directories (repository scope) |
| `LockfileManager` | Manages `prompt-registry.lock.json` for repository scope |
| `ScopeConflictResolver` | Prevents same bundle at both user and repository scope |
| `RepositoryActivationService` | Handles lockfile detection on workspace open |
| `MigrationRegistry` | Tracks completed data migrations via `context.globalState` |
| `LocalModificationWarningService` | Detects local file changes before updates |
| `HubManager` | Hub configurations and profiles |
| `McpServerManager` | MCP server lifecycle |
| `UpdateChecker` | Detects bundle updates |

## Patterns

### Singleton Pattern
```typescript
private static instance: MyService;
static getInstance(context?: vscode.ExtensionContext): MyService {
    if (!MyService.instance) {
        if (!context) throw new Error('Context required on first call');
        MyService.instance = new MyService(context);
    }
    return MyService.instance;
}
```

### Event-Driven
```typescript
private _onBundleInstalled = new vscode.EventEmitter<InstalledBundle>();
readonly onBundleInstalled = this._onBundleInstalled.event;
```

## Adding a New Service

1. Create class in `src/services/`
2. Follow singleton pattern if needed
3. Use `Logger.getInstance()` for logging
4. Emit events for state changes
5. Create test file in `test/services/`

## Checklist

- [ ] Single responsibility
- [ ] Uses Logger, not console.log
- [ ] Proper error handling with clear messages
- [ ] Events for state changes
- [ ] Corresponding test file exists
