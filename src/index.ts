import * as core from '@actions/core';
import { detectGithubActionsAnnotations } from './annotations.js';
import { ApiError, DocverseClient, NetworkError, uploadTarball } from './client.js';
import type { Build, QueueJob } from './client.js';
import { type ActionInputs, InputError, parseInputs } from './inputs.js';
import {
  type EditionEntry,
  type PublishStatus,
  emitOutputs,
  extractPublishJobs,
  extractUpdatedSlugs,
  toEditionEntry,
  writeStepSummary,
} from './outputs.js';
import { PollTimeoutError, pollPublishJobs, pollQueueJob } from './poll.js';
import { createTarball } from './tarball.js';

export async function run(): Promise<void> {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const inputs = parseInputs();
    core.info(`Uploading docs for ${inputs.org}/${inputs.project} on ref ${inputs.gitRef}`);

    const tarball = await createTarball(inputs.dir);
    cleanup = tarball.cleanup;
    core.info(`Built tarball at ${tarball.path} (${tarball.contentHash})`);

    const annotations = detectGithubActionsAnnotations();
    const client = new DocverseClient(inputs.baseUrl, inputs.token, inputs.org, inputs.project);

    const build = await client.createBuild({
      org: inputs.org,
      project: inputs.project,
      gitRef: inputs.gitRef,
      contentHash: tarball.contentHash,
      alternateName: inputs.alternateName,
      annotations,
    });
    core.info(`Created build ${build.id}`);

    if (!build.upload_url) {
      throw new Error(`Server did not return an upload_url for build ${build.id}; cannot proceed.`);
    }
    await uploadTarball(build.upload_url, tarball.path);
    core.info('Tarball upload complete.');

    const patched = await client.completeUpload(build.self_url);
    core.info(`Build ${patched.id} marked uploaded; queue url=${patched.queue_url ?? '<none>'}`);

    // Shared budget for build polling and the subsequent publish wait.
    const deadline = Date.now() + inputs.waitTimeoutMs;

    let finalJob: QueueJob | null = null;
    if (inputs.wait) {
      if (!patched.queue_url) {
        throw new Error(`Server did not return a queue_url for build ${patched.id}; cannot wait.`);
      }
      finalJob = await pollQueueJob(client, patched.queue_url, {
        timeoutMs: inputs.waitTimeoutMs,
      });
      core.info(`Queue job ${finalJob.id} reached terminal status ${finalJob.status}`);
    }

    let publishStatus: PublishStatus = 'skipped';
    if (inputs.wait && inputs.waitForPublish && finalJob) {
      publishStatus = await waitForPublish(client, finalJob, Math.max(deadline - Date.now(), 0));
    } else if (!inputs.wait && inputs.waitForPublish) {
      core.info('Skipping wait-for-publish because `wait` is off.');
    }

    await reportOutcome(client, inputs, patched, finalJob, publishStatus);
  } catch (err) {
    handleFailure(err);
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}

async function reportOutcome(
  client: DocverseClient,
  inputs: ActionInputs,
  build: Build,
  job: QueueJob | null,
  publishStatus: PublishStatus,
): Promise<void> {
  const editions = await resolveEditions(
    client,
    inputs.org,
    inputs.project,
    extractUpdatedSlugs(job),
  );
  const outcome = { build, job, editions, publishStatus };
  emitOutputs(outcome);
  await writeStepSummary(outcome);

  if (!inputs.wait || !job) {
    return;
  }

  switch (job.status) {
    case 'completed':
      return;
    case 'completed_with_errors':
      core.warning(
        `Build processing completed with errors (phase=${job.phase ?? 'unknown'}): ${formatJobError(job)}`,
      );
      return;
    case 'failed':
      core.setFailed(
        `Build processing failed (phase=${job.phase ?? 'unknown'}): ${formatJobError(job)}`,
      );
      return;
    case 'cancelled':
      core.setFailed('Build processing was cancelled.');
      return;
    default:
      core.setFailed(`Unexpected terminal job status: ${job.status}`);
  }
}

/**
 * Wait for the `publish_edition` jobs referenced by the completed build job so
 * the edition is guaranteed live. Publish failures and timeouts are downgraded
 * to warnings (reflected in the returned status) rather than failing the step;
 * downstream workflows gate on the `publish-status` output.
 */
async function waitForPublish(
  client: DocverseClient,
  job: QueueJob,
  timeoutMs: number,
): Promise<PublishStatus> {
  const refs = extractPublishJobs(job);
  if (refs.length === 0) {
    return 'skipped';
  }
  core.info(`Waiting for ${refs.length} publish job(s) to finish…`);

  let results: Awaited<ReturnType<typeof pollPublishJobs>>;
  try {
    results = await pollPublishJobs(client, refs, { timeoutMs });
  } catch (err) {
    if (err instanceof PollTimeoutError) {
      core.warning(`Timed out waiting for editions to publish: ${err.message}`);
      return 'timed-out';
    }
    throw err;
  }

  const failed = results.filter((r) => r.job.status !== 'completed');
  for (const { editionSlug, job: publishJob } of failed) {
    core.warning(
      `Edition \`${editionSlug}\` did not publish cleanly (status \`${publishJob.status}\`).`,
    );
  }
  return failed.length ? 'failed' : 'published';
}

/**
 * Resolve `published_url`/`title` for each updated edition. The queue-job
 * progress only names the updated slugs; the published URL lives on the
 * edition resource, so we fetch each one. A failed lookup degrades to a
 * slug-only entry rather than failing the whole action.
 */
async function resolveEditions(
  client: DocverseClient,
  org: string,
  project: string,
  slugs: string[],
): Promise<EditionEntry[]> {
  const editions: EditionEntry[] = [];
  for (const slug of slugs) {
    try {
      editions.push(toEditionEntry(await client.getEdition(org, project, slug)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(`Could not resolve published URL for edition \`${slug}\`: ${message}`);
      editions.push({ slug });
    }
  }
  return editions;
}

function formatJobError(job: QueueJob): string {
  if (job.errors && typeof job.errors === 'object') {
    try {
      return JSON.stringify(job.errors);
    } catch {
      return '<unserializable errors>';
    }
  }
  return '<no error details>';
}

function handleFailure(err: unknown): void {
  if (err instanceof InputError) {
    core.setFailed(err.message);
    return;
  }
  if (err instanceof PollTimeoutError) {
    core.setFailed(err.message);
    return;
  }
  if (err instanceof ApiError || err instanceof NetworkError) {
    core.setFailed(err.message);
    return;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  core.setFailed(message);
}

run();
