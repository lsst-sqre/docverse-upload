import * as core from '@actions/core';
import type { Build, Edition, QueueJob } from './client.js';

/**
 * One element of the `editions-json` output. `kind` and `publish_status` are
 * omitted (not `null`) only for slug-only fallback entries whose edition
 * resource could not be fetched; `publish_status: null` is meaningful and
 * means the server has never published the edition.
 */
export interface EditionEntry {
  slug: string;
  published_url?: string;
  title?: string;
  kind?: Edition['kind'];
  publish_status?: Edition['publish_status'];
}

/**
 * An updated edition paired with the full edition resource it was derived
 * from. `edition` is `null` for the slug-only fallback produced when the
 * edition lookup failed; those entries never win `published-url` selection.
 */
export interface ResolvedEdition {
  entry: EditionEntry;
  edition: Edition | null;
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

/**
 * Outcome of the action's wait for the `publish_edition` jobs, surfaced as
 * the `publish-status` output. Distinct from the server-side
 * `Edition.publish_status` carried in `editions-json`.
 */
export type PublishWaitStatus = 'published' | 'failed' | 'timed-out' | 'skipped';

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
  /**
   * The edition whose `published_url` becomes the `published-url` output
   * (see `selectPrimaryEdition`), or `null` when no edition has one.
   */
  primaryEdition: EditionEntry | null;
  /** Outcome of waiting for the `publish_edition` jobs (or `skipped`). */
  publishStatus: PublishWaitStatus;
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
    kind: edition.kind,
    publish_status: edition.publish_status ?? null,
  };
}

function hasPublishedUrl(entry: EditionEntry): boolean {
  return typeof entry.published_url === 'string' && entry.published_url.length > 0;
}

/** Read a string-valued key out of the loosely typed `tracking_params`. */
function trackingParam(edition: Edition, key: string): string | null {
  const params = edition.tracking_params;
  if (!params || typeof params !== 'object') return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Whether the edition tracks the build's ref directly, mirroring the server's
 * edition-matching rule: a `git_ref` edition whose `tracking_params.git_ref`
 * equals the build's `git_ref` (only when the build has no alternate name), or
 * an `alternate_git_ref` edition whose `git_ref` and `alternate_name` both
 * match the build's.
 */
function tracksBuildRef(edition: Edition, build: Build): boolean {
  const buildAlternate = build.alternate_name ?? null;
  switch (edition.tracking_mode) {
    case 'git_ref':
      return buildAlternate === null && trackingParam(edition, 'git_ref') === build.git_ref;
    case 'alternate_git_ref':
      return (
        buildAlternate !== null &&
        trackingParam(edition, 'git_ref') === build.git_ref &&
        trackingParam(edition, 'alternate_name') === buildAlternate
      );
    default:
      return false;
  }
}

/**
 * Pick the edition whose `published_url` becomes the `published-url` output.
 * Among the updated editions that have a non-empty `published_url`, in
 * priority order:
 *
 * 1. an edition that tracks the build's ref directly (`git_ref` or
 *    `alternate_git_ref` tracking matching the build's `git_ref` and
 *    `alternate_name`) — e.g. the `tickets-DM-N` edition for a ticket-branch
 *    push, or the `v1.2.0` edition for a semver tag rather than the `1`/`1.2`
 *    aggregates;
 * 2. otherwise the edition with `kind === 'main'` (the project's default
 *    edition);
 * 3. otherwise the first by slug ASC.
 *
 * Slug ASC is the tiebreak at every level, so the result is deterministic.
 * Returns `null` when no edition has a `published_url`.
 */
export function selectPrimaryEdition(
  resolved: ResolvedEdition[],
  build: Build,
): EditionEntry | null {
  const candidates = [...resolved]
    .filter((r) => hasPublishedUrl(r.entry))
    .sort((a, b) => a.entry.slug.localeCompare(b.entry.slug));
  if (candidates.length === 0) return null;

  const tracking = candidates.find((r) => r.edition !== null && tracksBuildRef(r.edition, build));
  if (tracking) return tracking.entry;

  const main = candidates.find((r) => r.edition?.kind === 'main');
  if (main) return main.entry;

  return candidates[0]?.entry ?? null;
}

export function emitOutputs(outcome: UploadOutcome): void {
  const { build, job, editions, primaryEdition, publishStatus } = outcome;
  const sorted = [...editions].sort((a, b) => a.slug.localeCompare(b.slug));

  core.setOutput('build-id', build.id);
  core.setOutput('build-url', build.self_url);
  core.setOutput('published-url', primaryEdition?.published_url ?? '');
  core.setOutput('job-status', job?.status ?? 'queued');
  core.setOutput('publish-status', publishStatus);
  core.setOutput('editions-json', JSON.stringify(sorted));
}

export async function writeStepSummary(outcome: UploadOutcome): Promise<void> {
  const { build, job, editions, primaryEdition, publishStatus } = outcome;
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
    const rows: string[][] = [['Slug', 'Title', 'Kind', 'Published URL']];
    for (const entry of [...editions].sort((a, b) => a.slug.localeCompare(b.slug))) {
      const slug = entry.slug === primaryEdition?.slug ? `${entry.slug} (primary)` : entry.slug;
      rows.push([slug, entry.title ?? '', entry.kind ?? '', entry.published_url ?? '']);
    }
    summary.addHeading('Editions updated', 3);
    summary.addTable(
      rows.map((row, idx) => row.map((cell) => ({ data: cell, header: idx === 0 }))),
    );
  }

  await summary.write();
}
