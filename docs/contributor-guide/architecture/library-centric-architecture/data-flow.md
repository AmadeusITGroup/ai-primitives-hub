# Key Data Flows

Sequence diagrams showing how data flows through the system for key operations.

## 1. Collection Validation Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI Command
    participant Val as Validation Engine
    participant FS as File System

    User->>CLI: ai-primitives-hub collection validate
    CLI->>FS: Read collection YAML
    FS-->>CLI: YAML content

    CLI->>Val: validateCollectionFile(content)

    Val->>Val: Parse YAML
    Val->>Val: Validate schema
    Val->>Val: Check item kinds
    Val->>Val: Verify file references

    alt Valid
        Val-->>CLI: { valid: true }
        CLI-->>User: ✓ Collection is valid
    else Invalid
        Val-->>CLI: { valid: false, errors[] }
        CLI-->>User: ✗ Error details
    end
```

## 2. Bundle Build Flow

Release planning lives in `packages/`: the `planBundleRelease` use case (`app`) runs the core planner (`core/domain/collection/release-manifest-plan.ts`) over the `ReleaseSourceReader` port, implemented by `NodeReleaseSourceReader` (`infra`). The legacy `lib/` package keeps its own copy of this logic for its publisher and is not used by the CLI.

```mermaid
sequenceDiagram
    participant User
    participant CLI as Build Command
    participant App as planBundleRelease (app)
    participant Plan as Release Planner (core)
    participant Src as NodeReleaseSourceReader (infra)
    participant Zip as ZIP Builder
    participant FS as File System

    User->>CLI: ai-primitives-hub bundle build
    CLI->>App: planBundleRelease(repoRoot, collectionFile, version)
    App->>Plan: createReleaseManifestPlan(options, sources)
    Plan->>Src: openRevision(HEAD)
    Src-->>Plan: Committed tree at an immutable revision
    Plan->>Plan: Items, integrity inventory, provenance

    alt Root LICENSE, COPYING, or NOTICE committed
        Plan-->>App: Governed plan (formatVersion 1)
    else No license evidence
        Plan-->>App: Missing source license error
        App->>Plan: createLegacyReleaseManifestPlan(options, sources)
        Plan->>Src: openWorkingTree()
        Plan-->>App: Legacy plan
        App->>App: Add legacy release warning
    end
    App-->>CLI: Plan and warnings

    CLI->>CLI: serializeReleaseManifest(manifest)
    CLI->>Zip: createDeterministicZip(manifest, entries)
    Zip->>Zip: Sort entries, set fixed timestamps
    Zip->>FS: Write ZIP file
    Zip-->>CLI: ZIP path
    CLI->>CLI: validateBuiltArchive(zip)

    CLI-->>User: Built path/to/bundle.zip (bundle id, version)
```

Any planning failure other than missing license evidence (unknown item kind, missing file at the revision, unresolvable source repository) fails the command with exit code 1.

## 3. Primitive Index Harvest Flow

```mermaid
sequenceDiagram
    participant CLI as Hub Harvest Command
    participant Harvester as Harvester
    participant Provider as SourceAdapter
    participant GitHub as GitHubApiClient
    participant Cache as BlobCache
    participant Extract as Extractor
    participant Index as PrimitiveIndex

    CLI->>Harvester: harvest(sources)

    loop For each source
        Harvester->>Provider: enumerateBundles()
        Provider->>GitHub: getTree() / getContents()
        GitHub-->>Provider: Bundle list
        Provider-->>Harvester: Bundle refs

        loop For each bundle
            Harvester->>GitHub: fetchManifest(ref)
            GitHub->>Cache: get(blobSha)
            alt Cache hit
                Cache-->>GitHub: Cached content
            else Cache miss
                GitHub->>GitHub: HTTP GET
                GitHub->>Cache: set(blobSha, content)
            end
            GitHub-->>Harvester: Manifest

            Harvester->>Provider: fetchBundleFiles(ref)
            Provider->>GitHub: Download files
            GitHub-->>Provider: File contents
            Provider-->>Harvester: Files map

            Harvester->>Extract: extractFromFile(file)
            Extract->>Extract: Parse frontmatter
            Extract-->>Harvester: Primitive objects
        end
    end

    Harvester->>Index: add(primitives)
    Index->>Index: Build BM25 index
    Index->>Index: Build facet indices
    Index-->>Harvester: Confirm

    Harvester-->>CLI: HarvestResult
    CLI-->>User: Indexed N primitives from M bundles
```

## 4. Search Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as Search Command
    participant Index as PrimitiveIndex
    participant BM25 as BM25Engine
    participant Facets as FacetIndex
    participant Store as JSON Index Store

    User->>CLI: ai-primitives-hub index search -q "query"
    CLI->>Store: loadIndex(path)
    Store-->>CLI: PrimitiveIndex instance

    CLI->>Index: search({ q, kinds, limit })

    Index->>BM25: scoreQuery(query)
    BM25->>BM25: Tokenize query
    BM25->>BM25: Calculate IDF/TF scores
    BM25-->>Index: Scored doc IDs

    Index->>Facets: filter(kinds, tags, sources)
    Facets->>Facets: Intersect filter sets
    Facets-->>Index: Filtered IDs

    Index->>Index: Merge & sort results
    Index->>Index: Apply offset/limit

    Index-->>CLI: SearchResult { hits[], total }
    CLI->>CLI: Format output (text/json)
    CLI-->>User: Search results
```

## 5. Bundle Installation Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as Install Command
    participant Targets as TargetStore
    participant Source as SourceDispatcher
    participant Downloader as BundleDownloader
    participant Extractor as BundleExtractor
    participant Validator as ManifestValidator
    participant Layout as LayoutResolver
    participant Transform as TransformerRegistry
    participant Writer as FileTreeTargetWriter
    participant RepoWriter as RepositoryScopeWriter
    participant Lockfile as LockfileStore
    participant State as TargetStateStore
    participant FS as File System

    User->>CLI: ai-primitives-hub install my-bundle --target my-vscode
    CLI->>Targets: load target
    Targets->>FS: Read ai-primitives-hub.yml
    FS-->>Targets: Target config
    Targets-->>CLI: Target object

    CLI->>Source: resolveBundle(bundleId, sources)
    Source->>GitHub: List releases / contents
    GitHub-->>Source: Bundle reference
    Source-->>CLI: Bundle reference

    CLI->>Downloader: download(downloadUrl)
    Downloader->>FS: Write bundle zip
    Downloader-->>CLI: Zip path

    CLI->>Extractor: extract(zipPath)
    Extractor->>FS: Read zip
    Extractor-->>CLI: Extracted files

    CLI->>Validator: validateManifest(files)
    Validator->>FS: Read deployment-manifest.yml
    Validator->>Validator: Check schema
    Validator-->>CLI: Valid manifest

    CLI->>Layout: resolveLayout(target)
    Layout-->>CLI: Target layout

    CLI->>Transform: getTransformer(target.type)
    Transform-->>CLI: Content transformer

    alt target.scope == user
        CLI->>Writer: write(target, files, transformer)
        Writer->>FS: Write prompt/instruction/agent/skill files
        Writer-->>CLI: Written paths
    else target.scope == repository
        CLI->>RepoWriter: write(target, files)
        RepoWriter->>FS: Write files under .github/prompts/, .github/agents/, .github/instructions/, .github/skills/
        RepoWriter-->>CLI: Written paths
    end

    CLI->>Lockfile: upsertBundle(bundleId, manifest)
    Lockfile->>FS: Read prompt-registry.lock.json
    Lockfile->>Lockfile: Add entry
    Lockfile->>FS: Write lockfile
    Lockfile-->>CLI: Updated lockfile

    CLI->>State: updateTargetState(targetName, bundleId)
    State->>FS: Write .ai-primitives-hub/target-state.json
    State-->>CLI: Confirm

    CLI-->>User: ✓ Installed to my-vscode
```

## 6. Profile Publish Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as Profile Publish Command
    participant HubMgr as HubManager
    participant HubStore as HubStore
    participant FS as File System

    User->>CLI: ai-primitives-hub profile publish my-profile --hub default-local
    CLI->>CLI: Validate --hub and <profile-id>

    CLI->>HubMgr: loadHub(hubId)
    HubMgr->>HubStore: read hub config
    HubStore->>FS: Read <app-storage>/hubs/<hub-id>.yml
    FS-->>HubStore: Hub config
    HubStore-->>HubMgr: Hub
    HubMgr-->>CLI: Hub

    CLI->>FS: Read profile YAML
    FS-->>CLI: Profile content

    CLI->>HubMgr: publishProfile(profileId, profile, hubId)
    HubMgr->>HubStore: update hub config with profile
    HubStore->>FS: Write hub config
    FS-->>HubStore: Confirm
    HubStore-->>HubMgr: Updated hub
    HubMgr-->>CLI: Success

    CLI-->>User: ✓ Published profile "my-profile" to hub "default-local"
```

## 7. Token Resolution Flow

```mermaid
sequenceDiagram
    participant Client as GitHubApiClient
    participant Token as TokenProvider
    participant Env as Environment
    participant Gh as gh CLI
    participant File as Token File

    Client->>Token: getToken(host)

    Token->>Env: Check GITHUB_TOKEN
    alt GITHUB_TOKEN exists
        Env-->>Token: Return token
    else
        Token->>Env: Check GH_TOKEN
        alt GH_TOKEN exists
            Env-->>Token: Return token
        else
            Token->>Gh: gh auth token
            alt gh authenticated
                Gh-->>Token: Return token
            else
                Token->>File: Read ~/.github/token
                File-->>Token: Return token or undefined
            end
        end
    end

    Token-->>Client: Token or undefined
```

## 8. Error Handling Flow

```mermaid
sequenceDiagram
    participant CLI as CLI Command
    participant Code as Library Code
    participant Error as RegistryError
    participant Formatter as ErrorFormatter
    participant User as User

    CLI->>Code: Call library function

    alt Error occurs
        Code->>Error: throw new RegistryError({...})
        Error-->>CLI: Error thrown

        CLI->>Formatter: renderError(err, ctx)
        Formatter->>Formatter: Format by output type

        alt Text output
            Formatter-->>CLI: Human-readable message
        else JSON output
            Formatter-->>CLI: { error: {...} }
        else YAML output
            Formatter-->>CLI: yaml formatted error
        end

        CLI-->>User: Display error
        CLI-->>User: Exit code 1
    else Success
        Code-->>CLI: Result
        CLI-->>User: Success output
        CLI-->>User: Exit code 0
    end
```

## Performance Characteristics

| Flow | Typical Duration | Bottleneck |
|------|-----------------|------------|
| Collection validation | `<100ms` | YAML parsing |
| Bundle build | 1-5s | File I/O + ZIP compression |
| Cold index harvest | 7-30s | GitHub API calls |
| Warm index harvest | 1-3s | ETag 304 responses |
| Search query | `<10ms` | BM25 scoring (in-memory) |
| Bundle install | `<1s` | File writes |
| Profile publish | `<1s` | Hub config file I/O |
| Token resolution | `<100ms` | `gh` CLI / env reads |

## Error Recovery

| Flow | Failure Mode | Recovery |
|------|--------------|----------|
| Harvest | Network error | Retry with exponential backoff |
| Harvest | Partial failure | Resume from progress log |
| Install | Target not found | Suggest running `ai-primitives-hub target add` |
| Install | Validation fail | Report specific errors |
| Profile publish | Hub not found or profile file missing | Report specific errors |
| Search | Index missing | Suggest running `ai-primitives-hub index harvest` |

## See Also

- [System Context](./system-context.md) — External view
- [Container Diagram](./container.md) — High-level containers
- [Component Diagrams](./component.md) — Detailed internals
