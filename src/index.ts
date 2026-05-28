import * as core from '@actions/core';
import { detectGithubActionsAnnotations } from './annotations.js';
import { ApiError, DocverseClient, NetworkError, uploadTarball } from './client.js';
import type { Build, QueueJob } from './client.js';
import { InputError, parseInputs } from './inputs.js';
import { type EditionEntry, emitOutputs, extractEditions, writeStepSummary } from './outputs.js';
import { PollTimeoutError, pollQueueJob } from './poll.js';
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

    await reportOutcome(patched, finalJob, inputs.wait);
  } catch (err) {
    handleFailure(err);
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}

async function reportOutcome(build: Build, job: QueueJob | null, waited: boolean): Promise<void> {
  const { completed, failed } = extractEditions(job);
  const outcome = {
    build,
    job,
    editionsCompleted: completed,
    editionsFailed: failed,
  };
  emitOutputs(outcome);
  await writeStepSummary(outcome);

  if (!waited || !job) {
    return;
  }

  switch (job.status) {
    case 'completed':
      return;
    case 'completed_with_errors':
      for (const entry of failed) {
        annotateFailedEdition(entry);
      }
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

function annotateFailedEdition(entry: EditionEntry): void {
  const msg = typeof entry.error === 'string' ? entry.error : 'edition failed';
  core.warning(`Edition \`${entry.slug}\`: ${msg}`);
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
