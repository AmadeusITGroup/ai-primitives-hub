export class GitHubClientError extends Error {
  public readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'GitHubClientError';
    this.statusCode = statusCode;
  }
}

export class GitHubAuthError extends GitHubClientError {
  constructor(message: string, statusCode: 401 | 403 = 401) {
    super(message, statusCode);
    this.name = 'GitHubAuthError';
  }
}

export class GitHubNotFoundError extends GitHubClientError {
  constructor(owner: string, repo: string, path?: string) {
    const target = path ? `${owner}/${repo}/${path}` : `${owner}/${repo}`;
    super(`Not found: ${target}`, 404);
    this.name = 'GitHubNotFoundError';
  }
}

export class GitHubRateLimitError extends GitHubClientError {
  public readonly resetAt: Date;

  constructor(resetAt: Date) {
    super(`GitHub API rate limit exceeded. Resets at ${resetAt.toISOString()}`, 403);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}
