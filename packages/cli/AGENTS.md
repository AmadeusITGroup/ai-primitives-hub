# cli — Clipanion CLI (`prompt-registry` binary)

Depends on `app` + `core` + `infra`. Thin delivery layer — no business logic here.

## Structure

```
src/
├── commands/     → One file per command (see list below)
├── framework/
│   ├── context.ts          → getCommandContext() — provides services to commands
│   ├── production-context.ts
│   ├── output.ts           → formatOutput() — honors -o/--output flag
│   ├── error.ts            → failWith(), RegistryError
│   ├── parsers.ts          → Option parsers
│   ├── command-class.ts    → Base command class
│   ├── hub-manager.ts
│   ├── target.ts
│   ├── config.ts
│   ├── cli.ts              → runCli() entry point
│   └── ...
└── main.ts       → Registers ALL commands (commandClasses + commands arrays)
```

## Build & Test

```bash
pnpm --filter=@prompt-registry/cli run build
pnpm --filter=@prompt-registry/cli run test
```

Uses **Vitest**.

## Adding a Command

1. Create `src/commands/<name>.ts`:
   ```typescript
   export class MyCommand extends Command {
     static paths = [['my', 'command']];
     static usage = Command.Usage({ description: '...' });
     flag = Option.Boolean('--flag');
     async execute() {
       const ctx = getCommandContext(this);
       // ...
       formatOutput(this, result, ctx.outputFormat);
     }
   }
   ```
2. **Import and register in `src/main.ts`** — both `commandClasses` and `commands` arrays. Easy to forget; a new command file that isn't registered is unreachable.
3. **Never write to stdout directly** — use `formatOutput(...)` and `failWith(...)` from `src/framework/`
4. **Honor `-o/--output`** format: `text` | `json` | `yaml` | `ndjson`
5. **No `process.exit` in commands** — use `ctx.exit()` or throw via `failWith(...)`

## Existing Commands (reference)

`install`, `uninstall`, `update`, `status`, `discover`, `explain`, `init`, `apply`, `doctor`, `completion`, `hub`, `source`, `target-add`, `target-list`, `target-remove`, `target-types`, `profile`, `config-get`, `config-list`, `collection-create`, `collection-list`, `collection-validate`, `collection-affected`, `bundle-build`, `bundle-manifest`, `prompt-create`, `skill-create`, `skill-new`, `skill-validate`, `agent-create`, `hook-create`, `instruction-create`, `plugin-create`, `plugins-list`, `version-compute`, `index-*` (bench, build, eval, export, harvest, report, search, shortlist, stats)
