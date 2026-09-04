# Hub replication reference

`hub replicate` copies selected bundles from a GitHub-backed hub into a unified Artifactory-hosted hub tree.

## Scope

The initial implementation processes enabled sources of type `github` and GitHub release assets containing both `deployment-manifest.yml` (or JSON/YAML equivalent) and a `.zip` archive. Other source types are reported or omitted; they are not silently converted through another provider.

The generated tree is:

```text
<target-root>/hub-config.yml
<target-root>/sources/replicated/index-v1.json
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
| `--cache-dir` | local cache | Persistent release/manifest/archive cache |
| `--workers` | `4` | Bounded source-processing concurrency |
| `--request-budget` | `600` | Maximum uncached GitHub API requests |
| `--target-auth` | `bearer` | Authentication mode recorded for the generated target source |
| `--target-credential-ref` | `ARTIFACTORY_READER_TOKEN` | Consumer credential reference recorded in generated hub config |
| `--publisher-credential-ref` | `ARTIFACTORY_PUBLISHER_TOKEN` | Environment variable used only for publication |
| `--dry-run` | false | Explicitly request metadata-only behavior |
| `--publish` | false | Enable Artifactory writes; requires `--review` |
| `--review` | false | Acknowledges the publication review gate |
| `--allow-unverified-existing` | false | Allows skipping existing objects whose remote checksum cannot be verified; never overwrites them |

The command is metadata-only unless both `--publish` and `--review` are provided. `--dry-run` and `--publish` cannot be combined.

## Selection semantics

`latest` reads bundle references from source profiles and selects the highest stable SemVer for each requested stable bundle ID. An explicitly pinned profile version is selected exactly. `all` selects every valid GitHub release candidate and deduplicates by stable bundle ID/version.

Stable IDs have the form `<owner>-<repository>-<manifest.id>` when the manifest declares an ID, or `<owner>-<repository>` otherwise. The version remains a separate index coordinate. Unresolved profile references are warnings and are not emitted into generated profiles.

## Publication and resume

Publication is ordered to avoid advertising incomplete content:

1. download and verify each manifest/archive;
2. publish bundle objects;
3. publish `index-v1.json`;
4. publish `hub-config.yml`.

Before each write, the publisher uses `HEAD` and Artifactory checksum metadata. An existing object with the same SHA-256 is skipped. A conflicting or unverifiable object stops the operation by default. Re-running with the same cache and target root resumes completed work.

Transient Artifactory failures may be retried with a bounded budget. Authentication, permission, conflict, schema, and integrity failures are not retried or redirected to GitHub.

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
