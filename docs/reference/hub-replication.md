# Hub replication reference

`hub replicate` copies selected bundles from a GitHub-backed hub into a unified Artifactory-hosted hub tree.

## Scope

The replication source processes enabled sources of type `github`. A release is a candidate only when its release name is `<collectionid>-v<X.Y.Z>`, it contains one `deployment-manifest.yml` and one `<collectionid>.bundle.zip` (other differently named assets are allowed), and the manifest `id`/`version` match the release name. Noncompliant releases are excluded with a warning that identifies the repository, source, tag/name, and failed asset or manifest check. Other source types are reported and omitted; they are not silently converted through another provider.

The generated tree is:

```text
<target-root>/hub-config.yml
<target-root>/sources/replicated/index-v1.json
<target-root>/sources/replicated/indexes/<catalog-sha256>/index-v1.json
<target-root>/sources/replicated/bundles/<stable-id>/<version>/deployment-manifest.yml
<target-root>/sources/replicated/bundles/<stable-id>/<version>/<stable-id>-<version>.zip
```

GitHub remains provenance metadata only. Consumers of the generated hub use Artifactory URLs and do not need access to the source GitHub organization.

## Command

```bash
ai-primitives-hub hub replicate \
  --source-hub Amadeus-xDLC/genai.prompt-registry-config \
  --source-ref main \
  --target-root https://artifactory.example.com/artifactory/repo/team-hub \
  --mode latest \
  --cache-dir "$HOME/.cache/ai-primitives-hub-replication"
```

Important options:

| Option | Default | Meaning |
|---|---|---|
| `--source-hub` | required | GitHub `owner/repository` containing `hub-config.yml` |
| `--source-ref` | `main` | GitHub branch/tag/commit |
| `--target-root` | required | Credential-free Artifactory hub-tree root; loopback HTTP is allowed for local testing with a warning |
| `--mode` | `latest` | Select profile-resolved latest versions or every available version |
| `--cache-dir` | local cache | Persistent manifest/archive download cache keyed by asset URL |
| `--workers` | `4` | Bounded source-processing concurrency |
| `--request-budget` | `600` | Maximum uncached GitHub API requests; every page of a repository's release list counts as one request |
| `--target-auth` | `bearer` | Authentication mode recorded for the generated target source |
| `--target-credential-ref` | `ARTIFACTORY_READER_TOKEN` | Consumer credential reference recorded in generated hub config |
| `--publisher-credential-ref` | `ARTIFACTORY_PUBLISHER_TOKEN` | Environment variable used only for publication |
| `--dry-run` | false | Explicitly request metadata-only behavior |
| `--publish` | false | Enable Artifactory writes; requires `--review` |
| `--review` | false | Acknowledges the publication review gate |
| `--apm-transition` | false | Temporary migration mode; requires `--publish --review`, accepts structurally APM-ready ZIPs unchanged, and translates other supported ZIPs before publication |
| `--allow-unverified-existing` | false | Skip unverified bundle objects with warnings; omit them from the generated index and profiles |

The command is metadata-only unless both `--publish` and `--review` are provided. `--dry-run` and `--publish` cannot be combined.

### Temporary Agent Packages transition

`--apm-transition` is an explicit, temporary exception to immutable promotion. The normal mode promotes the release ZIP byte-for-byte into the Generic `sources/replicated` tree. Transition mode instead checks each selected ZIP: an archive with a matching root `apm.yml` and `.apm/` payload is passed through unchanged; otherwise, the CLI creates an APM-compatible ZIP from supported file-backed `prompt`, `instruction`, `agent`, `chat-mode`, and `skill` entries. The translation retains the original APH files and deployment manifest, adds their APM paths, and generates `apm.yml`. The uploaded bytes may therefore differ from the immutable GitHub release asset.

This transition does not translate APH dependencies or MCP server declarations into native APM dependencies, and it does not run the stock APM validator. Releases with no APM-supported primitives, unsupported primitive types, duplicate ZIP paths, or symbolic links are skipped with warnings; profiles requiring skipped bundles are excluded as a whole. Missing declared files, unsafe ZIP paths, malformed ZIPs, or conflicting content for a shared package coordinate stop the run before any artifact is published. Identical ZIP and manifest bytes sharing a package coordinate are stored once and may be referenced by multiple stable Hub IDs. Warnings identify path conventions that may not be discovered by native APM tooling and metadata that is preserved but not translated. Treat this as a temporary compatibility bridge, not a substitute for authors publishing APM-ready release assets.

Transition mode publishes bundle ZIPs at Agent Packages coordinates and keeps Hub metadata in the repository's `__CONFIG__` area:

```text
<target-root>/<lowercase-github-owner>/<package-name>/<package-name>-<version>.zip
<target-root>/__CONFIG__/manifests/<stable-id>/<version>/deployment-manifest.yml
<target-root>/__CONFIG__/indexes/<sha256>-index-v1.json
<target-root>/__CONFIG__/index-v1.json
<target-root>/__CONFIG__/hub-config/<sha256>-hub-config.yml
<target-root>/__CONFIG__/hub-config.yml
```

The generated hub source URL is `<target-root>` and its `indexFile` refers to the immutable hash-named index. Only `__CONFIG__/index-v1.json` and `__CONFIG__/hub-config.yml` are refreshed as mutable aliases; hash-named generations and versioned package objects remain immutable. The output explicitly reports `temporary-apm`, and translated archives produce a warning. Do not use this flag for ordinary promotion or after all selected releases publish APM-ready assets.

## Selection semantics

`latest` reads bundle references from source profiles and selects the highest stable SemVer for each requested stable bundle ID. If no stable candidate exists, it selects the highest prerelease. An explicitly pinned profile version, including a prerelease, is selected exactly. `all` selects every valid GitHub release candidate, including prereleases, and deduplicates by stable bundle ID/version.

Candidates sharing a bundle ID/version are published once only when their repository, release tag, archive URL/size, and manifest bytes/name agree. All selected source aliases are retained for pinned and `latest` profile references after verified publication. Conflicting candidates stop replication before publication; an unverified object excludes every alias for that coordinate.

Stable IDs have the form `<owner>-<repository>-<manifest.id>` when the manifest declares an ID, or `<owner>-<repository>` otherwise. The version remains a separate index coordinate. Warnings identify unresolved or unsupported profile bundle references and the profile containing them; the entire offending profile is excluded from the generated hub config, rather than publishing a partial profile.

## Publication and resume

Publication is ordered to avoid advertising incomplete content:

1. download each selected archive and reject zero-byte archives;
2. publish bundle objects;
3. publish an immutable content-addressed catalog generation under `indexes/<catalog-sha256>/index-v1.json`;
4. refresh the compatibility/latest projection `index-v1.json`;
5. publish `hub-config.yml` with its source `indexFile` pointing to that exact immutable generation.

The release-name collection ID and SemVer must match the parsed manifest `id` and `version`. Replication does not otherwise validate manifests against the deployment-manifest schema or verify downloaded archives against upstream checksums.

Before each write, the publisher uses `HEAD` and Artifactory checksum metadata. An existing object with the same SHA-256 is skipped. Versioned bundle objects remain immutable: conflicting or unverifiable bytes stop publication by default. Re-running with the same cache and target root resumes matching bundle objects.

In normal mode, only `sources/replicated/index-v1.json` and `hub-config.yml` are mutable metadata. In `--apm-transition` mode, only `__CONFIG__/index-v1.json` and `__CONFIG__/hub-config.yml` are mutable aliases. After verified bundle publication, the application explicitly permits their refresh. New metadata uses `If-None-Match: *`; changed existing metadata requires a strong ETag from `HEAD` and uses `If-Match`. Missing, weak, or malformed ETags stop the refresh. A concurrent-write precondition failure stops publication without retries, and a failed index write prevents the hub-config write. Servers must honor conditional PUTs; qualify this behavior on the intended Artifactory deployment before production sign-off.

The generated hub references its immutable catalog generation, not the mutable compatibility projection. Overlapping runs may leave the projection from a different run, but the final hub always resolves the catalog for its own profiles. Catalog generations are retained and never overwritten or deleted by replication. Because source identity includes `indexFile`, successive generations are distinct source snapshots; historical lockfiles retain their original catalog reference. Retention/cleanup is a separate administrative policy.

With `--allow-unverified-existing`, an unverified existing manifest or archive produces a warning and its bundle is omitted from the generated index. Any profile that references that bundle is excluded as a whole, not partially rewritten. The flag never overwrites or repairs bundle objects and does not bypass metadata preconditions. The index and hub config must themselves be conditionally uploaded/refreshed or match a verified existing checksum; if either metadata object is skipped unverified, publication fails. An unverified index prevents hub-config publication. The CLI returns exit code `2` for excluded-release, excluded-profile, or bundle-omission warnings and `1` for publication failures. JSON output exposes these messages in top-level `warnings` and `data.diagnostics`; legacy `data.unresolvedProfiles` remains an alias, although it now includes release diagnostics too.

Each run fetches the source hub config and every release-list page again so branch updates and newly published releases are discovered. These metadata requests count against `--request-budget`; only manifest and archive downloads are reused from the cache by asset URL. The budget must cover the metadata requests even when reusing a cache directory.

Artifactory publication does not automatically retry failed `HEAD` or upload requests and rejects redirect responses instead of following them. Re-run the command with the same cache and target root to resume completed work; publication failures do not trigger a GitHub fallback.

## Credentials

Source GitHub credentials are supplied through the CLI token provider and are never copied into the target. Artifactory publication uses the environment variable named by `--publisher-credential-ref`. The generated consumer hub config contains only `--target-credential-ref`, never its token value.

For the CLI, each credential reference is an environment-variable name and must be present before the CLI process starts. For VS Code, the same-looking reference is only a SecretStorage label; the extension prompts for the token and stores it in VS Code SecretStorage, so the environment variable does not need to be set before launching VS Code. Artifactory supplies the opaque access-token value through its Administration UI or release-specific Access token API. Pass the complete value without a `Bearer ` prefix; the clients send it as `Authorization: Bearer <token>`. There is no portable token regex or fixed prefix to validate against.

For example:

```bash
read -r -s -p 'Publisher token: ' ARTIFACTORY_PUBLISHER_TOKEN
printf '\n' >&2
export ARTIFACTORY_PUBLISHER_TOKEN
ai-primitives-hub hub replicate ... --publish --review
unset ARTIFACTORY_PUBLISHER_TOKEN
```

Do not place credentials in command arguments, URLs, cache keys, generated YAML/JSON, logs, or lockfiles.

## Failure and review gates

Before publication, review the dry-run output, unresolved references, expected archive count/bytes, GitHub request budget, target prefix, publisher permissions, and target consumer credential reference. A failed run must not publish a new index or hub config advertising unverified objects.

After publication, import the generated hub using `hub add --type artifactory`, verify the catalog and profiles, install a bundle, and replay its lockfile with only the Artifactory consumer credential. Compare source/target IDs, versions, bytes, SHA-256 values, provenance, and profile selections.

The command does not delete or mutate source GitHub releases. Target cleanup and publisher-role hardening are separate administrative operations.
