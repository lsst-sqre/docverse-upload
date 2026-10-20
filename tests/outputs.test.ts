import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Build, Edition, QueueJob } from '../src/client.js';
import {
  extractPublishJobs,
  extractUpdatedEditions,
  extractUpdatedSlugs,
  type ResolvedEdition,
  selectPrimaryEdition,
  toEditionEntry,
} from '../src/outputs.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeJob(progress: unknown): QueueJob {
  return {
    self_url: 'https://example.test/orgs/rubin/jobs/J',
    id: 'J',
    kind: 'build_processing',
    status: 'completed',
    phase: null,
    progress: progress as QueueJob['progress'],
    errors: null,
    date_created: '2026-05-28T00:00:00Z',
    date_started: null,
    date_completed: null,
    keeper_sync_run_id: null,
    subject_label: null,
  };
}

describe('extractUpdatedSlugs', () => {
  it('pulls slugs out of editions_updated', () => {
    const job = makeJob({
      editions_updated: [
        { slug: 'tickets-DM-1', action: 'updated' },
        { slug: 'main', action: 'created' },
      ],
      editions_skipped: [{ slug: 'v1' }],
      publish_jobs: [{ edition_slug: 'tickets-DM-1', publish_queue_job_public_id: 'p1' }],
    });
    expect(extractUpdatedSlugs(job)).toEqual(['tickets-DM-1', 'main']);
  });

  it('ignores entries without a string slug and non-array payloads', () => {
    expect(extractUpdatedSlugs(makeJob({ editions_updated: [{ action: 'updated' }, 42] }))).toEqual(
      [],
    );
    expect(extractUpdatedSlugs(makeJob({ editions_updated: 'nope' }))).toEqual([]);
  });

  it('returns an empty array when progress is missing', () => {
    expect(extractUpdatedSlugs(null)).toEqual([]);
    expect(extractUpdatedSlugs(makeJob(null))).toEqual([]);
    expect(extractUpdatedSlugs(makeJob({}))).toEqual([]);
  });
});

describe('extractUpdatedEditions', () => {
  it('pulls slug and edition_url out of editions_updated', () => {
    const job = makeJob({
      editions_updated: [
        {
          slug: 'main',
          action: 'updated',
          edition_url: 'https://example.test/orgs/o/projects/p/editions/main',
        },
        { slug: 'v1', action: 'created' },
      ],
    });
    expect(extractUpdatedEditions(job)).toEqual([
      { slug: 'main', editionUrl: 'https://example.test/orgs/o/projects/p/editions/main' },
      { slug: 'v1' },
    ]);
  });

  it('omits editionUrl when edition_url is missing or not a string', () => {
    const refs = extractUpdatedEditions(
      makeJob({
        editions_updated: [
          { slug: 'a', edition_url: 42 },
          { slug: 'b', edition_url: null },
          { slug: 'c' },
        ],
      }),
    );
    expect(refs).toEqual([{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }]);
    expect(refs.every((r) => r.editionUrl === undefined)).toBe(true);
  });

  it('ignores entries without a string slug and non-array payloads', () => {
    expect(extractUpdatedEditions(makeJob({ editions_updated: [{ action: 'x' }, 42] }))).toEqual(
      [],
    );
    expect(extractUpdatedEditions(makeJob({ editions_updated: 'nope' }))).toEqual([]);
  });

  it('returns an empty array when progress is missing', () => {
    expect(extractUpdatedEditions(null)).toEqual([]);
    expect(extractUpdatedEditions(makeJob(null))).toEqual([]);
    expect(extractUpdatedEditions(makeJob({}))).toEqual([]);
  });
});

describe('extractPublishJobs', () => {
  it('pulls edition/job refs out of publish_jobs', () => {
    const job = makeJob({
      editions_updated: [{ slug: 'main', action: 'updated' }],
      publish_jobs: [
        { edition_slug: 'main', publish_queue_job_public_id: 'whgn-wnz2-tvyx-05' },
        { edition_slug: 'tickets-DM-1', publish_queue_job_public_id: 'abcd-efgh-ijkl-01' },
      ],
    });
    expect(extractPublishJobs(job)).toEqual([
      { editionSlug: 'main', jobId: 'whgn-wnz2-tvyx-05' },
      { editionSlug: 'tickets-DM-1', jobId: 'abcd-efgh-ijkl-01' },
    ]);
  });

  it('drops malformed entries (missing either string)', () => {
    const job = makeJob({
      publish_jobs: [
        { edition_slug: 'main', publish_queue_job_public_id: 'p1' },
        { edition_slug: 'no-job' },
        { publish_queue_job_public_id: 'no-slug' },
        { edition_slug: 42, publish_queue_job_public_id: 'p2' },
        'nope',
      ],
    });
    expect(extractPublishJobs(job)).toEqual([{ editionSlug: 'main', jobId: 'p1' }]);
  });

  it('maps job_url to jobUrl when present and omits it otherwise', () => {
    const job = makeJob({
      publish_jobs: [
        {
          edition_slug: 'main',
          publish_queue_job_public_id: 'p1',
          job_url: 'https://example.test/orgs/rubin/jobs/p1',
        },
        { edition_slug: 'v1', publish_queue_job_public_id: 'p2' },
        { edition_slug: 'v2', publish_queue_job_public_id: 'p3', job_url: 42 },
      ],
    });
    const refs = extractPublishJobs(job);
    expect(refs).toEqual([
      { editionSlug: 'main', jobId: 'p1', jobUrl: 'https://example.test/orgs/rubin/jobs/p1' },
      { editionSlug: 'v1', jobId: 'p2' },
      { editionSlug: 'v2', jobId: 'p3' },
    ]);
    expect(refs[1]?.jobUrl).toBeUndefined();
    expect(refs[2]?.jobUrl).toBeUndefined();
  });

  it('returns an empty array when publish_jobs is missing or non-array', () => {
    expect(extractPublishJobs(null)).toEqual([]);
    expect(extractPublishJobs(makeJob(null))).toEqual([]);
    expect(extractPublishJobs(makeJob({}))).toEqual([]);
    expect(extractPublishJobs(makeJob({ publish_jobs: 'nope' }))).toEqual([]);
  });
});

function makeEdition(overrides: Partial<Edition> = {}): Edition {
  return {
    self_url: 'https://example.test/orgs/o/projects/p/editions/main',
    project_url: 'https://example.test/orgs/o/projects/p',
    build_url: null,
    published_url: 'https://docs/main/',
    history_url: 'https://example.test/orgs/o/projects/p/editions/main/history',
    rollback_url: 'https://example.test/orgs/o/projects/p/editions/main/rollback',
    slug: 'main',
    title: 'Main',
    kind: 'main',
    tracking_mode: 'git_ref',
    tracking_params: null,
    lifecycle_exempt: true,
    publish_status: null,
    date_created: '2026-05-28T00:00:00Z',
    date_updated: '2026-05-28T00:00:00Z',
    ...overrides,
  } as Edition;
}

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    self_url: 'https://example.test/orgs/o/projects/p/builds/B',
    project_url: 'https://example.test/orgs/o/projects/p',
    id: 'B',
    git_ref: 'main',
    alternate_name: null,
    status: 'completed',
    ...overrides,
  } as Build;
}

describe('toEditionEntry', () => {
  it('keeps slug, title, published_url, kind and publish_status', () => {
    expect(toEditionEntry(makeEdition({ publish_status: 'published' }))).toEqual({
      slug: 'main',
      title: 'Main',
      published_url: 'https://docs/main/',
      kind: 'main',
      publish_status: 'published',
    });
  });

  it('drops a null published_url', () => {
    expect(toEditionEntry(makeEdition({ published_url: null })).published_url).toBeUndefined();
  });

  it('keeps a null publish_status (never published)', () => {
    const entry = toEditionEntry(makeEdition({ publish_status: null }));
    expect(entry.publish_status).toBeNull();
    expect('publish_status' in entry).toBe(true);
  });

  it('normalizes a missing publish_status to null', () => {
    const edition = makeEdition();
    delete (edition as { publish_status?: unknown }).publish_status;
    expect(toEditionEntry(edition).publish_status).toBeNull();
  });
});

/** Build a resolved edition from a partial `Edition`, deriving the entry. */
function resolved(overrides: Partial<Edition>): ResolvedEdition {
  const edition = makeEdition({
    published_url: `https://docs/${overrides.slug ?? 'main'}/`,
    ...overrides,
  });
  return { entry: toEditionEntry(edition), edition };
}

describe('selectPrimaryEdition', () => {
  const ticketEdition = resolved({
    slug: 'tickets-DM-1',
    kind: 'draft',
    tracking_mode: 'git_ref',
    tracking_params: { git_ref: 'tickets/DM-1' },
  });
  const mainEdition = resolved({
    slug: '__main',
    kind: 'main',
    tracking_mode: 'git_ref',
    tracking_params: { git_ref: 'main' },
  });

  it('prefers the edition tracking the build git_ref over the main edition', () => {
    const build = makeBuild({ git_ref: 'tickets/DM-1' });
    expect(selectPrimaryEdition([mainEdition, ticketEdition], build)?.slug).toBe('tickets-DM-1');
  });

  it('prefers a semver tag edition over the aggregate editions and main', () => {
    const build = makeBuild({ git_ref: 'v1.2.0' });
    const tag = resolved({
      slug: 'v1.2.0',
      kind: 'release',
      tracking_mode: 'git_ref',
      tracking_params: { git_ref: 'v1.2.0' },
    });
    const major = resolved({ slug: '1', kind: 'major', tracking_mode: 'semver_major' });
    const minor = resolved({ slug: '1.2', kind: 'minor', tracking_mode: 'semver_minor' });
    expect(selectPrimaryEdition([major, minor, mainEdition, tag], build)?.slug).toBe('v1.2.0');
  });

  it('falls back to the main edition when nothing tracks the build ref', () => {
    const build = makeBuild({ git_ref: 'v1.2.0' });
    const major = resolved({ slug: '1', kind: 'major', tracking_mode: 'semver_major' });
    const lsstDoc = resolved({ slug: '__main', kind: 'main', tracking_mode: 'lsst_doc' });
    expect(selectPrimaryEdition([major, lsstDoc], build)?.slug).toBe('__main');
  });

  it('falls back to slug ASC when neither rule matches', () => {
    const build = makeBuild({ git_ref: 'other' });
    const b = resolved({ slug: 'b', kind: 'draft', tracking_params: { git_ref: 'x' } });
    const a = resolved({ slug: 'a', kind: 'draft', tracking_params: { git_ref: 'y' } });
    expect(selectPrimaryEdition([b, a], build)?.slug).toBe('a');
  });

  it('breaks ties by slug ASC within the top priority', () => {
    const build = makeBuild({ git_ref: 'main' });
    const dup = resolved({
      slug: 'zz-main-mirror',
      kind: 'draft',
      tracking_mode: 'git_ref',
      tracking_params: { git_ref: 'main' },
    });
    expect(selectPrimaryEdition([dup, mainEdition], build)?.slug).toBe('__main');
  });

  it('matches alternate_git_ref editions only when the build has the same alternate name', () => {
    const alt = resolved({
      slug: 'alt-main',
      kind: 'alternate',
      tracking_mode: 'alternate_git_ref',
      tracking_params: { git_ref: 'main', alternate_name: 'staging' },
    });
    const withAlternate = makeBuild({ git_ref: 'main', alternate_name: 'staging' });
    expect(selectPrimaryEdition([mainEdition, alt], withAlternate)?.slug).toBe('alt-main');

    const otherAlternate = makeBuild({ git_ref: 'main', alternate_name: 'prod' });
    expect(selectPrimaryEdition([alt, mainEdition], otherAlternate)?.slug).toBe('__main');
  });

  it('does not match a plain git_ref edition when the build has an alternate name', () => {
    const build = makeBuild({ git_ref: 'tickets/DM-1', alternate_name: 'staging' });
    expect(selectPrimaryEdition([ticketEdition, mainEdition], build)?.slug).toBe('__main');
  });

  it('skips a tracking edition without a published_url', () => {
    const build = makeBuild({ git_ref: 'tickets/DM-1' });
    const unpublished = resolved({
      slug: 'tickets-DM-1',
      kind: 'draft',
      tracking_params: { git_ref: 'tickets/DM-1' },
      published_url: null,
    });
    expect(selectPrimaryEdition([unpublished, mainEdition], build)?.slug).toBe('__main');
  });

  it('never selects a slug-only fallback entry', () => {
    const build = makeBuild({ git_ref: 'main' });
    const fallback: ResolvedEdition = { entry: { slug: 'a' }, edition: null };
    expect(selectPrimaryEdition([fallback, mainEdition], build)?.slug).toBe('__main');
  });

  it('returns the published_url the output will carry', () => {
    const build = makeBuild({ git_ref: 'tickets/DM-1' });
    expect(selectPrimaryEdition([ticketEdition], build)?.published_url).toBe(
      'https://docs/tickets-DM-1/',
    );
  });

  it('returns null when nothing has a URL or the list is empty', () => {
    const build = makeBuild();
    const a = resolved({ slug: 'a', published_url: null });
    expect(selectPrimaryEdition([a, { entry: { slug: 'b' }, edition: null }], build)).toBeNull();
    expect(selectPrimaryEdition([], build)).toBeNull();
  });
});
