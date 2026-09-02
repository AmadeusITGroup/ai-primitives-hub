/** Provider-neutral source-scoped HTTP credential port. */
export interface SourceRequestContext {
  sourceId: string;
  trustedOrigin: string;
  trustedPathPrefix: string;
}

export interface HttpCredentialProvider {
  headersFor(url: string, context: SourceRequestContext): Promise<Readonly<Record<string, string>>>;
}
