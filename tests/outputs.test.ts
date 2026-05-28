import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueJob } from '../src/client.js';
import { extractEditions, selectPublishedUrl } from '../src/outputs.js';

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

describe('extractEditions', () => {
  it('pulls completed and failed lists out of progress', () => {
    const job = makeJob({
      editions_completed: [
        { slug: 'main', published_url: 'https://x/main/' },
        { slug: 'v1', published_url: 'https://x/v1/' },
      ],
      editions_failed: [{ slug: 'broken', error: 'boom' }],
    });
    const { completed, failed } = extractEditions(job);
    expect(completed.map((e) => e.slug)).toEqual(['main', 'v1']);
    expect(failed.map((e) => e.slug)).toEqual(['broken']);
  });

  it('returns empty arrays when progress is null', () => {
    expect(extractEditions(null)).toEqual({ completed: [], failed: [] });
    expect(extractEditions(makeJob(null))).toEqual({ completed: [], failed: [] });
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
