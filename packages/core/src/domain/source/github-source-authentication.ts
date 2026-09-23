/**
 * Source-level authentication outcomes produced by GitHub preflight.
 * @module domain/source/github-source-authentication
 */
export type GitHubSourceAuthCategory =
  | 'public-anonymous'
  | 'public-generic'
  | 'app-authenticated'
  | 'unresolved';
