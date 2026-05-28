import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edition, QueueJob } from '../src/client.js';
import { extractUpdatedSlugs, selectPublishedUrl, toEditionEntry } from '../src/outputs.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeJob(progress: unknown): QueueJob {
  return {
    self_url: 'https://example.test/queue/jobs/J',
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

describe('toEditionEntry', () => {
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

  it('keeps slug, title and published_url', () => {
    expect(toEditionEntry(makeEdition())).toEqual({
      slug: 'main',
      title: 'Main',
      published_url: 'https://docs/main/',
    });
  });

  it('drops a null published_url', () => {
    expect(toEditionEntry(makeEdition({ published_url: null })).published_url).toBeUndefined();
  });
});

describe('selectPublishedUrl', () => {
  it('sorts by slug ASC and returns the first published_url', () => {
    const url = selectPublishedUrl([
      { slug: 'v2', published_url: 'https://x/v2/' },
      { slug: 'main', published_url: 'https://x/main/' },
      { slug: 'v1', published_url: 'https://x/v1/' },
    ]);
    expect(url).toBe('https://x/main/');
  });

  it('skips entries without a published_url', () => {
    const url = selectPublishedUrl([{ slug: 'a' }, { slug: 'b', published_url: 'https://x/b/' }]);
    expect(url).toBe('https://x/b/');
  });

  it('returns null when nothing has a URL', () => {
    expect(selectPublishedUrl([{ slug: 'a' }, { slug: 'b' }])).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(selectPublishedUrl([])).toBeNull();
  });
});
