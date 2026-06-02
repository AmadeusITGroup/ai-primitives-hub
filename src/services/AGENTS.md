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
| `UpdateScheduler` | Periodic update checking |
| `HubSyncScheduler` | Periodic hub sync |
| `ScopeServiceFactory` | Creates scope services by type |
| `SetupStateManager` | Tracks extension setup progress |
| `ApmRuntimeManager` | APM runtime lifecycle |
| `ApmCliWrapper` | APM CLI invocation |
| `TelemetryService` | Usage telemetry |
| `SchemaValidator` | JSON schema validation |
| `TemplateEngine` | Prompt template rendering |
| `PromptLoader` | Loads prompt files |
| `PromptExecutor` | Executes prompts |
| `McpConfigService` | MCP configuration |
| `NotificationManager` | User-facing notifications |
| `EngagementHydrator` | Hydrates bundles with engagement data |
| `EngagementService` | Engagement orchestration |
| `RatingService` / `RatingCache` | Rating logic and optimistic cache |
| `FeedbackService` / `FeedbackCache` | Feedback submission and cache |

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

## Linting Rules

### Method Ordering (@typescript-eslint/member-ordering)

ESLint enforces this order for class members:
1. **Static fields**
2. **Instance fields**
3. **Constructor**
4. **Decorated methods**
5. **Private instance methods**
6. **Protected instance methods**
7. **Public instance methods**

```typescript
export class Example {
  private static count = 0;     // 1. static fields
  private field: string;        // 2. instance fields

  constructor() { }             // 3. constructor

  private privateMethod() { }   // 5. private methods
  protected helperMethod() { }  // 6. protected methods
  public publicMethod() { }     // 7. public methods
}
```

### JSDoc Requirements (eslint-plugin-jsdoc)

- Every function/method needs `/** */` comment (`jsdoc/require-jsdoc`)
- Document all parameters: `@param name Description` (`jsdoc/require-param`)
- Provide full description, not empty comments (`jsdoc/require-description`)
- For object parameters with nested properties, document each property:
  ```typescript
  /**
   * Function description
   * @param options Object with settings
   * @param options.status HTTP status code
   * @param options.data The response data
   */
  function example(options: { status: number; data: unknown }) { }
  ```

## Checklist

- [ ] Single responsibility
- [ ] Uses Logger, not console.log
- [ ] Proper error handling with clear messages
- [ ] Events for state changes
- [ ] Corresponding test file exists
- [ ] Method ordering correct (static fields → instance fields → constructor → private → protected → public)
- [ ] All functions have JSDoc with @param documentation (eslint-plugin-jsdoc)
