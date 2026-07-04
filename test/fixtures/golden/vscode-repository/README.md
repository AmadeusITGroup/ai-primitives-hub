# VS Code Repository-Scope Golden Fixture

This fixture captures the current repository-scope filesystem layout before the extension/CLI migration.

Repository-scope installs write Copilot resources under `.github/` directories and track installed files in `prompt-registry.lock.json`. The lockfile fixture uses stable placeholder checksums so path and shape expectations remain deterministic.