# Data Model: Extension and CLI Migration

## Bundle

- **Purpose**: Installable unit containing primitive resources and metadata.
- **Key Fields**: id, name, version, source, manifest, resources, checksum or integrity metadata when available.
- **Relationships**: Installed into one or more Targets; recorded in storage or lockfile depending on scope.

## Resource

- **Purpose**: File-like primitive such as prompt, instruction, agent, skill, or manifest.
- **Key Fields**: relativePath, category, content, metadata, source bundle id.
- **Relationships**: Routed by Target Layout and optionally modified by Resource Transformer.

## Target

- **Purpose**: Destination environment for installation.
- **Key Fields**: type, scope, workspaceRoot, userHome, variant-specific metadata.
- **Relationships**: Has Target Capabilities and Target Layout.

## Target Scope

- **Purpose**: Defines ownership and persistence boundary.
- **Values**: user, repository.
- **Rules**: Repository scope requires workspace root and lockfile handling. User scope requires platform-aware home/config path resolution.

## Target Layout

- **Purpose**: Declarative route table from Resource categories to target filesystem paths.
- **Key Fields**: target type, scope, base path, category routes, conflict policy.
- **Rules**: Layout routes must be deterministic and testable with golden output fixtures.

## Target Capability

- **Purpose**: Explicit statement of supported resources and operations for a target.
- **Key Fields**: supported categories, scopes, lockfile support, transform requirements, unsupported reason metadata.
- **Rules**: Unsupported resources must produce actionable errors or be skipped only when the command explicitly allows partial installs.

## Resource Transformer

- **Purpose**: Converts resource content or metadata for a target-specific format.
- **Key Fields**: target type, supported categories, transform function, diagnostics.
- **Rules**: Must be idempotent, deterministic, and fail-safe. Failed optional transforms must not corrupt source resources.

## Install Operation

- **Purpose**: Shared application use case for installing bundle resources.
- **Key Fields**: bundle reference, target, scope, source options, dry-run flag, output mode, diagnostics.
- **Relationships**: Uses adapters for source resolution, validators for manifests, writers for target output, storage/lockfile for records.

## Cherry-Pick Cluster

- **Purpose**: Migration planning unit for porting work from `feat/cli-backup`.
- **Key Fields**: name, commits, prerequisites, expected conflicts, validation command, outcome.
- **Rules**: A cluster is not ready to apply until it has a validation command and a rollback point.