# Security Scanner Architecture

The security scanner is a cohesive bounded context inside the existing AI Primitives Hub packages. It is not a delivery-specific linter and it does not introduce a fifth architectural layer.

## Dependency direction

```mermaid
flowchart LR
    CLI["CLI: security scan"] --> APP["app: SecurityScanUseCase"]
    EXT["VS Code commands and service"] --> APP
    APP --> CORE["core: security domain and ports"]
    APP --> INFRA["infra: filesystem and report adapters"]
    INFRA --> CORE
    GHA["GitHub Actions"] --> CLI
```

The existing package dependency direction remains authoritative:

```text
CLI / Extension → app → infra → core
```

`core` does not import `vscode`, `node:fs`, process execution, or network clients. `infra` implements external capabilities. `app` composes and orchestrates. Delivery layers translate user interaction and presentation only.

## Components

```mermaid
flowchart TB
    subgraph Delivery["Delivery"]
        CLI["Clipanion command"]
        EXT["VS Code service, commands, diagnostics"]
    end

    subgraph Application["@ai-primitives-hub/app"]
        UC["SecurityScanUseCase"]
        RESULT["Normalized scan result"]
    end

    subgraph Domain["@ai-primitives-hub/core"]
        PORT_ENGINE["SecurityScanEngine port"]
        PORT_INPUT["SecurityScanInput port"]
        PORT_REPORT["SecurityReportStore port"]
        RULES["Pure rule engine and rule families"]
        POLICY["Fingerprints, suppression, policy, redaction"]
    end

    subgraph Infrastructure["@ai-primitives-hub/infra"]
        INPUT["NodeSecurityScanInput"]
        WORKER["IsolatedSecurityScanEngine"]
        STORE["SecureAtomicSecurityReportStore"]
        FS[("Local filesystem")]
    end

    CLI --> UC
    EXT --> UC
    UC --> PORT_INPUT
    UC --> PORT_ENGINE
    UC --> PORT_REPORT
    UC --> POLICY
    PORT_ENGINE -. implemented by .-> RULES
    PORT_INPUT -. implemented by .-> INPUT
    PORT_ENGINE -. wrapped by .-> WORKER
    PORT_REPORT -. implemented by .-> STORE
    INPUT --> FS
    STORE --> FS
    RULES --> RESULT
    POLICY --> RESULT
```

## Scan flow

```mermaid
sequenceDiagram
    participant D as Delivery adapter
    participant A as App use case
    participant I as Input port
    participant E as Engine port
    participant P as Core policy
    participant R as Report store

    D->>A: run(request, dependencies)
    A->>I: collect roots, extensions, excludes, trust mode
    I-->>A: candidates, ignored/skipped/errors, declarations
    loop each bounded candidate
        A->>I: read(candidate, limits)
        I-->>A: document and metadata
        A->>E: scanDocument(document, options, cancellation)
        E-->>A: normalized findings
    end
    A->>P: fingerprint, suppress, select, redact, evaluate policy
    P-->>A: active findings, suppression summary, completeness
    opt report requested
        A->>R: atomic redacted report write
    end
    A-->>D: immutable SecurityScanResult
```

The input adapter never executes candidate content. Directory traversal uses `lstat`, rejects symbolic links/special files, enforces containment and size/depth limits, and sorts candidates deterministically. Report storage uses owner-only temporary files and atomic replacement.

## Ports and responsibilities

### `SecurityScanInput`

Core owns the interface. The Node adapter supplies bounded filesystem discovery and reads. An editor-buffer adapter can be added later without changing rule logic. The input result partitions candidates into scanned, ignored, skipped, and error states.

### `SecurityScanEngine`

Core owns the engine contract and the pure built-in rule behavior. The engine descriptor reports its ID, implementation version, rule-pack version, and digest. Alternative engines must normalize into the same finding model and explicitly declare capabilities.

The CLI composes the built-in engine behind `IsolatedSecurityScanEngine`. The worker boundary is required because synchronous JavaScript regular expressions cannot be interrupted from the calling thread. A timeout or cancellation produces an incomplete scan.

### `SecurityReportStore`

Core owns a narrow persistence intent contract. Infra enforces no-follow destination checks, bounded writes, exclusive owner-only temporary creation, atomic rename, and overwrite policy. Report rendering must not leak raw secret evidence.

## Domain model

```mermaid
classDiagram
    class SecurityDocument {
        +string id
        +string rootId
        +string displayPath
        +string content
        +FileMetadata metadata
    }
    class SecurityFinding {
        +string ruleId
        +string title
        +SecuritySeverity severity
        +SecurityConfidence confidence
        +string category
        +string file
        +number line
        +string fingerprint
        +string canonicalFingerprint
        +string vulnerableContent
    }
    class SecurityScanResult {
        +boolean complete
        +EngineDescriptor engine
        +Coverage coverage
        +Summary summary
        +SecurityFinding[] findings
        +Timing timing
    }
    class SecurityRulePack {
        +string id
        +string version
        +string digest
        +RuleDescriptor[] rules
    }
    SecurityDocument --> SecurityFinding : evaluated into
    SecurityFinding --> SecurityScanResult : collected by
    SecurityRulePack --> SecurityFinding : describes
```

Legacy fingerprints remain compatible with MD Security Scanner. A stronger identity may be added as a new field, but cannot silently replace `.markdown.ignore` compatibility keys.

## Delivery boundaries

### CLI

`packages/cli/src/commands/security-scan.ts` parses flags, composes the built-in engine/input/report adapters, invokes app once, serializes output, and maps complete/policy/incomplete outcomes to exit codes. It does not contain detection rules.

### VS Code

`apps/vscode-extension/src/services/security-scan-service.ts` delegates to app. Extension code owns command registration, settings, trusted-workspace checks, save debounce, scan cancellation, diagnostics, and notifications. New command IDs use the established lowercase `promptregistry.*` machine identity; existing historical IDs are unchanged.

### GitHub Actions

Actions consume the published CLI. The scanner itself needs no token or network access. Workflows select changed files safely, invoke `--ci --ignore-trust none`, use least-privilege permissions, and upload only redacted reports through separately reviewed artifact/reporting steps.

## Security design constraints

- artifact text, paths, frontmatter, and ignore files are untrusted data;
- no artifact execution, dynamic imports, network lookup, or repository plugin loading;
- no symbolic-link traversal by default;
- bounded files, bytes, depth, findings, report size, and duration;
- worker isolation for blocking evaluation;
- fixed `[REDACTED]` secret evidence in default sinks;
- no raw source content in errors, logs, or telemetry;
- repository ignore trust is explicit in CI;
- report/webview output is destination-escaped;
- incomplete scans cannot be reported as clean.

## Testing and maintenance

Core tests cover pure behavior and fingerprint vectors. Infra tests cover path safety and atomic persistence. App tests cover orchestration and policy. CLI tests cover argv, output, and exit contracts. Extension tests cover registration, trust, diagnostics, debounce, and cancellation.

Rule updates are made one family at a time, with a frozen reference commit, positive/negative cases, adversarial long-input cases, differential results, mapping/remediation review, and a rule-pack digest update. See the [Security Scanner Maintenance](../security-scanner-maintenance.md) guide.

## See also

- [Clean Architecture](./library-centric-architecture/clean-architecture.md)
- [Ports & Adapters ADR](./adr/0001-ports-and-adapters-for-cli-and-extension.md)
- [Security Scanner Maintenance](../security-scanner-maintenance.md)
- [Security Scanner Reference](../../reference/security-scanner.md)
