# PR Review Report — PR #261

**PR**: [feat: expose docs as GitHub Pages with Docusaurus](https://github.com/AmadeusITGroup/prompt-registry/pull/261)
**Author**: sufiyan-ahmed
**Base**: `main` ← `feature/gh-docs-docusaurus`
**Reviewed**: 2026-05-20

## Executive Summary

This PR adds a self-contained Docusaurus-based GitHub Pages docs site under `website/`, using a runtime `SmartLink` component to resolve markdown links without modifying the source documentation. The implementation is architecturally clean and well-isolated. No blocking issues found. Two major findings relate to documentation that references a non-existent file and missing component-level tests. Several minor findings address edge cases in link resolution and CI configuration.

**Verdict**: ✅ Ready to merge

| Criticality | Count | Blocking |
|-------------|-------|----------|
| 🔴 Critical | 0 | — |
| 🟠 Major    | 2 | No — highly recommended |
| 🟡 Minor    | 6 | No |
| 🟢 Suggestion | 3 | No |

---

## Blocking Issues (Critical only)

No blocking issues found.

---

## Risk Assessment & Manual Testing Guidance

### Blast Radius

**Impact scope**: 🔵 Isolated

All changes are additive. No extension source, test, or build files are modified in ways that affect runtime behavior. The only non-`website/` modifications are `.gitignore` (additive lines), `docs/AGENTS.md` (documentation guidance), `README.md` (badge addition), and a broken-link fix in `docs/author-guide/`.

### High-Risk Areas

| Risk Area | Risk Level | Why | Files |
|-----------|-----------|-----|-------|
| Stale docs misleading contributors | 🟠 Medium | AGENTS.md describes a non-existent plugin; contributors will follow wrong instructions | `docs/AGENTS.md` |
| Silent link breakage on new sections | 🟡 Low | Adding a docs section without updating `DOC_SECTIONS` produces broken links with no build error | `website/src/components/resolveLink.ts` |
| Trailing-slash inconsistency | 🟡 Low | Default `trailingSlash: undefined` may cause different resolution depending on arrival path | `website/docusaurus.config.ts`, `resolveLink.ts` |

### Manual Testing Recommendations

**Non-regression scope**: Targeted — only the docs site is affected.

| # | Scenario | Priority | Related Risk Area | Steps / Focus |
|---|----------|----------|-------------------|---------------|
| 1 | Build site and verify all sidebar links | 🔴 Must-test | Link resolution | `cd website && npm run build && npm run serve` — click through all nav items, verify no 404s |
| 2 | Verify README links on homepage | 🟠 Should-test | Homepage rendering | Check each link in the rendered README routes correctly (internal docs → site, CONTRIBUTING.md → GitHub) |
| 3 | Cross-section link navigation | 🟠 Should-test | DOC_SECTIONS routing | Navigate from user-guide to reference, from author-guide to contributor-guide — verify all resolve |
| 4 | Test browser back/forward after navigation | 🟡 Nice-to-test | SPA routing | Ensure `<Link>` produces proper history entries |

---

## Non-Blocking Findings

### 🟠 Major (highly recommended)

> **TD1** 🟠 Major — `docs/AGENTS.md` — Documentation references non-existent remark plugin
>
> Two references to `website/src/plugins/remark-rewrite-links.ts` and its `EXCLUDED_FILES` constant, but no such file exists in this PR. The actual link adaptation uses `SmartLink` at runtime (`website/src/components/resolveLink.ts`), not a remark plugin at build time. Contributors following AGENTS.md guidance will be actively misled — e.g., trying to add exclusions to a non-existent constant.
>
> *[Flagged independently by Technical Debt, Functional, and Architecture agents — merged into single finding]*
>
> **Recommendation:** Replace references with actual implementation paths. Line ~90: change "remark plugin in `website/src/plugins/remark-rewrite-links.ts`" to the `SmartLink` component. Line ~102: change `EXCLUDED_FILES` instruction to reference the `exclude` array in `website/docusaurus.config.ts` and/or the extension regex + `DOC_SECTIONS` set in `resolveLink.ts`.

---

> **QA1** 🟠 Major — `website/src/components/SmartLink.tsx` — No tests for the SmartLink component
>
> `SmartLink` is the runtime integration point that bridges `resolveLink` logic to actual DOM rendering. There are zero tests verifying it renders `<Link>` for internal routes, `<a>` for external, or passes props correctly. A typo in the switch or a missed prop forwarding would go undetected until manual testing.
>
> **Recommendation:** Add a thin component test (vitest + @testing-library/react or similar) with 3 cases covering the switch branches. The logic is already well-tested in `resolveLink.test.ts`, so this just validates the React wiring.

---

### 🟡 Minor

> **AR1** 🟡 Minor — `.github/workflows/docs.yml` — CI concurrency group is overly broad
>
> `concurrency: group: pages` is a flat string — it will cancel in-progress builds across all branches/PRs touching docs simultaneously. Two PRs modifying docs will cancel each other's validation builds.
>
> **Recommendation:** Use `group: ${{ github.workflow }}-${{ github.ref }}` to scope per-branch.

---

> **FN1** 🟡 Minor — `website/docusaurus.config.ts`, `website/src/components/resolveLink.ts` — No `trailingSlash` configured; link resolution may behave inconsistently
>
> Docusaurus's `trailingSlash` defaults to `undefined`. `location.pathname` could return paths with or without trailing slash depending on how the user arrived. When `currentPath` has a trailing slash, `new URL(href, base)` treats it as a directory — producing different resolved paths. Additionally, directory-path links like `./contributor-guide/` pass through `stripMarkdownExtension` unchanged, potentially producing inconsistent routes.
>
> **Recommendation:** Set `trailingSlash: false` in `docusaurus.config.ts` to ensure consistent URL forms, or normalize `currentPath` before resolution.

---

> **TD2** 🟡 Minor — `website/src/components/resolveLink.ts`, `website/sidebars.ts` — `DOC_SECTIONS` requires manual sync with sidebars
>
> `DOC_SECTIONS` must match the top-level doc routes in `sidebars.ts`. Adding a new section to sidebars without updating `DOC_SECTIONS` causes links to silently fall through to passthrough (broken relative links in the browser). No build-time or test-time assertion catches this drift.
>
> *[Flagged by Technical Debt, Functional, and Architecture agents — merged]*
>
> **Recommendation:** Add a test assertion that validates `DOC_SECTIONS` entries against sidebar keys, or derive one from the other.

---

> **FN2** 🟡 Minor — `website/src/components/resolveLink.ts` — Query parameters silently dropped
>
> `resolveLink` extracts `pathname` and `hash` but ignores `search`. Any link with query params (e.g., `getting-started.md?tab=advanced`) loses them in the result. Rare in practice for docs, but a silent failure if encountered.
>
> **Recommendation:** Capture `resolved.search` and append alongside `hash`, or document that query params are intentionally unsupported.

---

> **QA2** 🟡 Minor — `website/src/components/__tests__/resolveLink.test.ts` — Minor coverage gaps in test file
>
> - `http://` prefix not tested (only `https://`)
> - Empty string `""` in `HOME_PATHS` not exercised
> - `.txt` extension in the fallback regex not covered
>
> **Recommendation:** Add one test case for each to complete coverage of the branching logic.

---

### 🟢 Suggestion

> **TD3** 🟢 Suggestion — `website/src/css/custom.css` — Navbar uses hardcoded color instead of variable
>
> `.navbar { background-color: #3a8bff; }` duplicates `--ifm-color-primary`. If brand color changes, two values need updating independently.
>
> **Recommendation:** Use `background-color: var(--ifm-color-primary);`.

---

> **AR2** 🟢 Suggestion — `website/package.json` — `website/` not registered in root workspaces
>
> Root `workspaces` lists `lib` but not `website`. This is intentional (no shared code dependency), but the difference in DX pattern from `lib/` isn't documented.
>
> **Recommendation:** Add a one-liner in `website/README.md` clarifying that `website/` is deliberately excluded from npm workspaces.

---

> **FN3** 🟢 Suggestion — `website/src/pages/index.tsx` — Homepage README import escapes workspace boundary
>
> `import Readme from "@site/../README.md"` creates an implicit build-time dependency. If root README uses syntax Docusaurus can't handle, the website build breaks with no obvious cause.
>
> **Recommendation:** No action needed — the CI path filter correctly accounts for this. Just noting the coupling for awareness.

---

## Pre-existing Issues

No pre-existing issues identified.

---

## Positive Highlights

- **Clean separation of concerns**: Pure `resolveLink` function with no React/framework dependencies, tested independently. SmartLink is a thin 22-line wrapper. Excellent testability architecture.
- **Tests verify behavior, not implementation**: Assertions are on output shape (`{ type, to/href }`) with realistic link patterns from different page contexts.
- **Discriminated union type**: `ResolvedLink` makes exhaustive handling obvious and type-safe.
- **Security-conscious CI**: `step-security/harden-runner`, read-only `contents` permission by default, scoped `pages: write` only on the deploy job.
- **Build-time validation**: `onBrokenLinks: "throw"` catches broken sidebar/navbar references at build time.
- **Idiomatic Docusaurus patterns**: MDXComponents override for global anchor interception, docs-only mode, search-local plugin.
- **Self-contained workspace**: No coupling to extension build, own test framework (vitest), own tsconfig.
- **Good CI path filtering**: Workflow triggers on exactly the files that affect build output (`docs/**`, `website/**`, `README.md`).

---

## Testing Verdict

The `resolveLink` logic has solid unit test coverage. The SmartLink component (React wiring) and the full Docusaurus build integration require manual verification since there are no component-level or E2E tests for the rendered site.

- **Automated coverage sufficient**: Partial — logic is well-tested, integration is not
- **Manual testing required**: Yes — build and click-through verification recommended
- **Non-regression scope**: None (extension code unaffected)
