import * as core from '@actions/core';
import type { Build, Edition, QueueJob } from './client.js';

export interface EditionEntry {
  slug: string;
  published_url?: string;
  title?: string;
  [key: string]: unknown;
}

/** A `publish_edition` queue job referenced from a build job's progress. */
export interface PublishJobRef {
  editionSlug: string;
  jobId: string;
  /**
   * Absolute `job_url` HATEOAS link to the publish job, when the server
   * embedded it. Followed in preference to reconstructing
   * `/orgs/{org}/jobs/{job}`.
   */
  jobUrl?: string;
}

/** An edition updated by this build (`progress.editions_updated`). */
export interface UpdatedEditionRef {
  slug: string;
  /**
   * Absolute `edition_url` HATEOAS link to the edition resource, when the
   * server embedded it. Followed in preference to reconstructing the path.
   */
  editionUrl?: string;
}

export type PublishStatus = 'published' | 'failed' | 'timed-out' | 'skipped';

export interface UploadOutcome {
  build: Build;
  job: QueueJob | null;
  /**
   * Editions updated by this build (from `job.progress.editions_updated`),
   * each enriched with `published_url`/`title` fetched from the edition
   * resource. `published_url` does not appear in the queue-job progress; it
   * lives on the edition itself, so it must be resolved separately.
   */
  editions: EditionEntry[];
  /** Outcome of waiting for the `publish_edition` jobs (or `skipped`). */
  publishStatus: PublishStatus;
}

/**
 * Pull the `slug` values out of an array-of-objects entry on the queue job's
 * progress payload (e.g. `progress.editions_updated[].slug`). `progress` is
 * typed `object | null` in OpenAPI, so we normalize defensively.
 */
function extractProgressSlugs(job: QueueJob | null, key: string): string[] {
  if (!job?.progress) return [];
  const progress = job.progress as Record<string, unknown>;
  const raw = progress[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => entry.slug)
    .filter((slug): slug is string => typeof slug === 'string');
}

/** Slugs of editions updated by this build (`progress.editions_updated`). */
export function extractUpdatedSlugs(job: QueueJob | null): string[] {
  return extractProgressSlugs(job, 'editions_updated');
}

/**
 * Editions updated by this build (`progress.editions_updated`), each with its
 * slug and the optional `edition_url` HATEOAS link the server embedded. The
 * link is carried only when it is a string; callers reconstruct the edition
 * path from `org`/`project`/`slug` when it is absent. Reads the typed
 * `EditionUpdateRef` fields but stays defensive: `progress` is `object | null`
 * at runtime and the array may carry malformed entries.
 */
export function extractUpdatedEditions(job: QueueJob | null): UpdatedEditionRef[] {
  if (!job?.progress) return [];
  const progress = job.progress as Record<string, unknown>;
  const raw = progress.editions_updated;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => {
      const ref: { slug: unknown; editionUrl?: string } = { slug: entry.slug };
      if (typeof entry.edition_url === 'string') {
        ref.editionUrl = entry.edition_url;
      }
      return ref;
    })
    .filter((ref): ref is UpdatedEditionRef => typeof ref.slug === 'string');
}

/**
 * Slugs of editions that failed during this build (`progress.editions_failed`).
 * The build-processing job does not always emit this key; the defensive parse
 * returns `[]` when it is absent, so the comment's failure `<details>` block is
 * forward-compatible if the server starts reporting per-edition failures.
 */
export function extractFailedSlugs(job: QueueJob | null): string[] {
  return extractProgressSlugs(job, 'editions_failed');
}

/** Slugs of editions skipped by this build (`progress.editions_skipped`). */
export function extractSkippedSlugs(job: QueueJob | null): string[] {
  return extractProgressSlugs(job, 'editions_skipped');
}

/**
 * Pull the `publish_edition` job references out of the build job's progress
 * payload (`progress.publish_jobs[]`), mapping `edition_slug`→`editionSlug`,
 * `publish_queue_job_public_id`→`jobId`, and (when present as a string) the
 * `job_url`→`jobUrl` HATEOAS link. `progress` is typed
 * `object | null` in OpenAPI, so we normalize defensively (drop entries missing
 * either required string).
 */
export function extractPublishJobs(job: QueueJob | null): PublishJobRef[] {
  if (!job?.progress) return [];
  const progress = job.progress as Record<string, unknown>;
  const raw = progress.publish_jobs;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => {
      const ref: { editionSlug: unknown; jobId: unknown; jobUrl?: string } = {
        editionSlug: entry.edition_slug,
        jobId: entry.publish_queue_job_public_id,
      };
      if (typeof entry.job_url === 'string') {
        ref.jobUrl = entry.job_url;
      }
      return ref;
    })
    .filter(
      (ref): ref is PublishJobRef =>
        typeof ref.editionSlug === 'string' && typeof ref.jobId === 'string',
    );
}

/** Trim an edition resource down to the fields surfaced in the action outputs. */
export function toEditionEntry(edition: Edition): EditionEntry {
  return {
    slug: edition.slug,
    published_url: edition.published_url ?? undefined,
    title: edition.title,
  };
}

/**
 * Sort editions deterministically by slug ASC and return the first
 * `published_url` (or `null` if no edition has one).
 */
export function selectPublishedUrl(editions: EditionEntry[]): string | null {
  const sorted = [...editions].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const entry of sorted) {
    if (typeof entry.published_url === 'string' && entry.published_url.length > 0) {
      return entry.published_url;
    }
  }
  return null;
}

export function emitOutputs(outcome: UploadOutcome): void {
  const { build, job, editions, publishStatus } = outcome;
  const sorted = [...editions].sort((a, b) => a.slug.localeCompare(b.slug));

  core.setOutput('build-id', build.id);
  core.setOutput('build-url', build.self_url);
  core.setOutput('published-url', selectPublishedUrl(sorted) ?? '');
  core.setOutput('job-status', job?.status ?? 'queued');
  core.setOutput('publish-status', publishStatus);
  core.setOutput('editions-json', JSON.stringify(sorted));
}

export async function writeStepSummary(outcome: UploadOutcome): Promise<void> {
  const { build, job, editions, publishStatus } = outcome;
  const summary = core.summary
    .addHeading('Docverse upload', 2)
    .addRaw(`Build \`${build.id}\` — status \`${build.status}\``)
    .addEOL()
    .addRaw(`Build URL: ${build.self_url}`)
    .addEOL();

  if (job) {
    summary.addRaw(`Job \`${job.id}\` — status \`${job.status}\``).addEOL();
    summary.addRaw(`Publishing: \`${publishStatus}\``).addEOL();
    if (job.phase) {
      summary.addRaw(`Last phase: \`${job.phase}\``).addEOL();
    }
  }

  if (editions.length > 0) {
    const rows: string[][] = [['Slug', 'Title', 'Published URL']];
    for (const entry of [...editions].sort((a, b) => a.slug.localeCompare(b.slug))) {
      rows.push([entry.slug, entry.title ?? '', entry.published_url ?? '']);
    }
    summary.addHeading('Editions updated', 3);
    summary.addTable(
      rows.map((row, idx) => row.map((cell) => ({ data: cell, header: idx === 0 }))),
    );
  }

  await summary.write();
}
