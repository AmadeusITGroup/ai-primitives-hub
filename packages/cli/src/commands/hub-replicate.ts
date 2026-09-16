/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line -- thin CLI option wiring */
import {
  replicateHub,
} from '@ai-primitives-hub/app';
import type {
  HttpClient,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  ArtifactoryEnvCredentialProvider,
  ArtifactoryReplicationPublisher,
  defaultTokenProvider,
  FileReplicationCache,
  GitHubApiClient,
  GitHubReleaseSource,
  NodeHttpClient,
} from '@ai-primitives-hub/infra';
import {
  Command,
  Option,
} from 'clipanion';
import {
  formatOutput,
  RegistryError,
  renderError,
} from '../framework';
import type {
  Context,
} from '../framework';

export class HubReplicateCommand extends Command {
  public static readonly paths = [['hub', 'replicate']];
  public static readonly usage = Command.Usage({ description: 'Replicate GitHub release bundles into an Artifactory hub source.', category: 'Hub & Discovery' });
  public commandContext!: { ctx: Context; http?: HttpClient; tokens?: TokenProvider };
  public sourceHub = Option.String('--source-hub', { required: true });
  public sourceRef = Option.String('--source-ref', { required: false });
  public targetRoot = Option.String('--target-root', { required: true });
  public mode = Option.String('--mode', { required: false });
  public publish = Option.Boolean('--publish', false);
  public dryRun = Option.Boolean('--dry-run', false);
  public cacheDir = Option.String('--cache-dir', { required: false });
  public workers = Option.String('--workers', { required: false });
  public requestBudget = Option.String('--request-budget', { required: false });
  public targetCredentialRef = Option.String('--target-credential-ref', { required: false });
  public publisherCredentialRef = Option.String('--publisher-credential-ref', { required: false });
  public targetAuth = Option.String('--target-auth', { required: false });
  public output = Option.String('-o,--output');
  public review = Option.Boolean('--review', false);
  public allowUnverifiedExisting = Option.Boolean('--allow-unverified-existing', false);
  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const mode = (this.mode ?? 'latest') as 'latest' | 'all';
    const sourceRef = this.sourceRef ?? 'main';
    const targetAuth = (this.targetAuth ?? 'bearer') as 'anonymous' | 'bearer';
    const cacheDir = this.cacheDir ?? '.cache/github-artifactory-replication';
    const budget = Number(this.requestBudget ?? '600');
    const workers = Number(this.workers ?? '4');
    const consumerCredentialRef = this.targetCredentialRef ?? 'ARTIFACTORY_READER_TOKEN';
    const publisherCredentialRef = this.publisherCredentialRef ?? 'ARTIFACTORY_PUBLISHER_TOKEN';
    if (!['latest', 'all'].includes(mode) || !this.sourceHub.includes('/') || !['anonymous', 'bearer'].includes(targetAuth) || !Number.isInteger(budget) || budget < 1 || !Number.isInteger(workers) || workers < 1) {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: 'Invalid replication options.' }), ctx); return 1;
    }
    if (this.dryRun && this.publish) {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: '--dry-run and --publish cannot be combined.' }), ctx); return 1;
    }
    if (this.publish && targetAuth === 'anonymous') {
      renderError(new RegistryError({ code: 'USAGE.INVALID_FLAG', message: '--publish requires bearer target authentication.' }), ctx); return 1;
    }
    if (this.publish && !this.review) {
      renderError(new RegistryError({ code: 'USAGE.CONFIRMATION_REQUIRED', message: 'Publication requires explicit --review acknowledgement.' }), ctx); return 1;
    }
    const http = this.commandContext.http ?? new NodeHttpClient();
    const tokens: TokenProvider = this.commandContext.tokens ?? defaultTokenProvider(ctx.env);
    const api = new GitHubApiClient(http, { tokenProvider: tokens });
    const source = new GitHubReleaseSource(api, new FileReplicationCache(cacheDir), budget);
    const target = `${this.targetRoot.replace(/\/$/, '')}/sources/replicated`;
    const publisher = this.publish
      ? new ArtifactoryReplicationPublisher(
        http,
        new ArtifactoryEnvCredentialProvider(ctx.env, publisherCredentialRef, target),
        target,
        this.allowUnverifiedExisting
      )
      : undefined;
    try {
      const result = await replicateHub({
        sourceHub: this.sourceHub,
        sourceRef,
        targetRoot: this.targetRoot,
        mode,
        publish: this.publish,
        workers,
        allowUnverifiedExisting: this.allowUnverifiedExisting,
        targetAuth,
        targetCredentialRef: consumerCredentialRef
      }, source, publisher);
      formatOutput({
        ctx,
        command: 'hub.replicate',
        output: (this.output ?? 'json') as 'json' | 'text' | 'yaml' | 'ndjson',
        status: result.warnings.length > 0 ? 'warning' : 'ok',
        data: { mode, publish: this.publish, selectedBundles: result.selected.length, unresolvedProfiles: result.warnings, index: result.index, targetRoot: target },
        warnings: result.warnings
      });
      return result.warnings.length > 0 ? 2 : 0;
    } catch (error) {
      renderError(new RegistryError({ code: 'REPLICATE.FAILED', message: error instanceof Error ? error.message : 'Replication failed.' }), ctx); return 1;
    }
  }
}
