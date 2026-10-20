/** Delivery only: policies, verdicts, scores and Markdown stay in shared packages. */
import fs from 'node:fs';
import path from 'node:path';
import { renderGovernanceMarkdown, validateCollectionGovernance } from '@ai-primitives-hub/app/governance';
import { NodeFileSystem } from '@ai-primitives-hub/infra/fs';
import { GitHubReleaseLookup } from '@ai-primitives-hub/infra/governance';
import { GitHubApiClient, NodeHttpClient, parseGitHubRepositoryTarget } from '@ai-primitives-hub/infra/http';

export async function runCollectionGovernance(repoRoot) {
    const policy = process.env['INPUT_POLICY-PATH'] || undefined;
    const minimum = process.env['INPUT_MIN-SCORE'];
    const selectedFile = process.env['INPUT_COLLECTION-FILE'];
    const reportPath = process.env['INPUT_REPORT-PATH'];
    const checkReleases = process.env['INPUT_CHECK-RELEASES'] === 'true';
    const repository = process.env.INPUT_REPOSITORY || undefined;
    // Do not use ambient GITHUB_TOKEN/GH_TOKEN or a host CLI credential store.
    const releaseLookup = checkReleases && repository ? new GitHubReleaseLookup((url) => new GitHubApiClient(new NodeHttpClient(), {
        repositoryTarget: parseGitHubRepositoryTarget(url),
        tokenProvider: { getToken: async () => process.env['INPUT_SOURCE-TOKEN'] || undefined }
    })) : undefined;
    const report = await validateCollectionGovernance(new NodeFileSystem(), {
        repoRoot,
        policy,
        checkReleases,
        repository,
        releaseLookup,
        minScore: minimum ? (minimum.trim() === '' ? Number.NaN : Number(minimum)) : undefined,
        collectionFiles: selectedFile ? [selectedFile] : undefined
    });
    const markdown = renderGovernanceMarkdown(report);
    let writeFailed = false;
    if (reportPath) {
        try {
            fs.writeFileSync(path.resolve(repoRoot, reportPath), markdown);
        } catch (error) {
            process.stderr.write(`Unable to write governance report: ${error.message}\n`);
            writeFailed = true;
        }
    }
    process.stdout.write(markdown);
    const exitCode = report.verdict === 'pass' && !writeFailed ? 0 : 1;
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    }
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${exitCode === 0 ? 'pass' : 'fail'}\nscore=${report.score}\nexit-code=${exitCode}\n`);
    }
    return exitCode;
}