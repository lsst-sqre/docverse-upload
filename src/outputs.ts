import * as core from '@actions/core';
import type { Build, QueueJob } from './client.js';

export interface EditionEntry {
  slug: string;
  published_url?: string;
  title?: string;
  [key: string]: unknown;
}

export interface UploadOutcome {
  build: Build;
  job: QueueJob | null;
  /** Editions extracted from `job.progress.editions_completed`. */
  editionsCompleted: EditionEntry[];
  /** Editions extracted from `job.progress.editions_failed`. */
  editionsFailed: EditionEntry[];
}

/**
 * Pull `editions_completed` / `editions_failed` arrays out of a job's
 * progress payload. Both fields are typed `object | null` in OpenAPI, so we
 * defensively normalize.
 */
export function extractEditions(job: QueueJob | null): {
  completed: EditionEntry[];
  failed: EditionEntry[];
} {
  if (!job?.progress) return { completed: [], failed: [] };
  const progress = job.progress as Record<string, unknown>;
  return {
    completed: asEditionList(progress.editions_completed),
    failed: asEditionList(progress.editions_failed),
  };
}

function asEditionList(raw: unknown): EditionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => entry as EditionEntry)
    .filter((entry) => typeof entry.slug === 'string');
}

/**
 * Sort completed editions deterministically by slug ASC and return the first
 * `published_url` (or `null` if no edition has one).
 */
export function selectPublishedUrl(completed: EditionEntry[]): string | null {
  const sorted = [...completed].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const entry of sorted) {
    if (typeof entry.published_url === 'string' && entry.published_url.length > 0) {
      return entry.published_url;
    }
  }
  return null;
}

export function emitOutputs(outcome: UploadOutcome): void {
  const { build, job, editionsCompleted } = outcome;
  const sorted = [...editionsCompleted].sort((a, b) => a.slug.localeCompare(b.slug));

  core.setOutput('build-id', build.id);
  core.setOutput('build-url', build.self_url);
  core.setOutput('published-url', selectPublishedUrl(sorted) ?? '');
  core.setOutput('job-status', job?.status ?? 'queued');
  core.setOutput('editions-json', JSON.stringify(sorted));
}

export async function writeStepSummary(outcome: UploadOutcome): Promise<void> {
  const { build, job, editionsCompleted, editionsFailed } = outcome;
  const summary = core.summary
    .addHeading('Docverse upload', 2)
    .addRaw(`Build \`${build.id}\` — status \`${build.status}\``)
    .addEOL()
    .addRaw(`Build URL: ${build.self_url}`)
    .addEOL();

  if (job) {
    summary.addRaw(`Job \`${job.id}\` — status \`${job.status}\``).addEOL();
    if (job.phase) {
      summary.addRaw(`Last phase: \`${job.phase}\``).addEOL();
    }
  }

  if (editionsCompleted.length > 0) {
    const rows: string[][] = [['Slug', 'Title', 'Published URL']];
    for (const entry of [...editionsCompleted].sort((a, b) => a.slug.localeCompare(b.slug))) {
      rows.push([entry.slug, entry.title ?? '', entry.published_url ?? '']);
    }
    summary.addHeading('Editions completed', 3);
    summary.addTable(
      rows.map((row, idx) => row.map((cell) => ({ data: cell, header: idx === 0 }))),
    );
  }

  if (editionsFailed.length > 0) {
    summary.addHeading('Editions failed', 3);
    summary.addList(editionsFailed.map((entry) => entry.slug));
  }

  await summary.write();
}
