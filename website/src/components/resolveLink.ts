/**
 * Pure link-resolution logic for the Docusaurus docs site.
 *
 * Given a raw markdown href, the current page pathname, and the site base URL,
 * decides whether the link is an internal docs route, a home-page route, an
 * external GitHub blob URL, or should be left untouched.
 */

const REPO_BLOB_BASE =
  "https://github.com/AmadeusITGroup/ai-primitives-hub/blob/main";

/** Paths that should resolve to the docs home page. */
export const HOME_PATHS = new Set(["README.md", "docs/README.md", ""]);

/** Top-level docs routes that Docusaurus serves at the site root. */
export const DOC_SECTIONS = new Set([
  "user-guide",
  "author-guide",
  "contributor-guide",
  "reference",
  "migration-guide.md",
]);

export type ResolvedLink =
  | { type: "passthrough" }
  | { type: "internal"; to: string }
  | { type: "external"; href: string };

export function stripMarkdownExtension(pathname: string): string {
  return pathname.replace(/\.(md|mdx)$/i, "");
}

export function toRepoUrl(pathname: string): string {
  return `${REPO_BLOB_BASE}/${pathname}`;
}

/**
 * Resolve a markdown link to its appropriate target.
 *
 * @param href        - Raw href from the markdown anchor element.
 * @param currentPath - The current page pathname (e.g. "/prompt-registry/user-guide/getting-started").
 * @param baseUrl     - The site base URL (e.g. "/prompt-registry/").
 */
export function resolveLink(
  href: string | undefined,
  currentPath: string,
  baseUrl: string,
): ResolvedLink {
  if (!href) {
    return { type: "passthrough" };
  }

  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  ) {
    return { type: "passthrough" };
  }

  const resolved = new URL(href, `https://example.test${currentPath}`);
  const relativePath = resolved.pathname.replace(
    new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}?`),
    "",
  );
  const hash = resolved.hash || "";

  if (HOME_PATHS.has(relativePath)) {
    return { type: "internal", to: `${baseUrl}${hash}` };
  }

  if (relativePath.startsWith("docs/")) {
    const docPath = stripMarkdownExtension(relativePath.slice(5));
    return { type: "internal", to: `${baseUrl}${docPath}${hash}` };
  }

  const firstSegment = relativePath.split("/")[0] || "";
  if (DOC_SECTIONS.has(firstSegment)) {
    const docPath = stripMarkdownExtension(relativePath);
    return { type: "internal", to: `${baseUrl}${docPath}${hash}` };
  }

  if (/\.(md|mdx|txt|json|ya?ml)$/i.test(relativePath)) {
    return { type: "external", href: `${toRepoUrl(relativePath)}${hash}` };
  }

  return { type: "passthrough" };
}
