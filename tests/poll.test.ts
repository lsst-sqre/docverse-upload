import { describe, expect, it, vi } from 'vitest';
import type { DocverseClient, QueueJob } from '../src/client.js';
import { PollTimeoutError, pollPublishJobs, pollQueueJob } from '../src/poll.js';

function makeJob(status: QueueJob['status'], phase: string | null = null): QueueJob {
  return {
    self_url: 'https://example.test/queue/jobs/JOB1',
    id: 'JOB1',
    kind: 'build_processing',
    status,
    phase,
    progress: null,
    errors: null,
    date_created: '2026-05-28T00:00:00Z',
    date_started: null,
    date_completed: null,
    keeper_sync_run_id: null,
    subject_label: null,
  };
}

function fakeClient(jobs: QueueJob[]): { client: DocverseClient; calls: number } {
  let calls = 0;
  const client = {
    getQueueJob: vi.fn(async () => {
      const job = jobs[Math.min(calls, jobs.length - 1)]!;
      calls += 1;
      return job;
    }),
  } as unknown as DocverseClient;
  return {
    client,
    get calls() {
      return calls;
    },
  } as { client: DocverseClient; calls: number };
}

/**
 * Fake client exposing `getQueueJobById` (per-id sequence), `getQueueJobByUrl`
 * (per-url sequence), and an `isSameOrigin` that treats `https://example.test`
 * as the configured origin.
 */
function fakePublishClient(
  jobsById: Record<string, QueueJob[]>,
  jobsByUrl: Record<string, QueueJob[]> = {},
): DocverseClient {
  const calls: Record<string, number> = {};
  const next = (seq: QueueJob[], key: string): QueueJob => {
    const idx = Math.min(calls[key] ?? 0, seq.length - 1);
    calls[key] = (calls[key] ?? 0) + 1;
    return seq[idx]!;
  };
  return {
    getQueueJobById: vi.fn(async (jobId: string) => next(jobsById[jobId]!, `id:${jobId}`)),
    getQueueJobByUrl: vi.fn(async (url: string) => next(jobsByUrl[url]!, `url:${url}`)),
    isSameOrigin: vi.fn((url: string) => {
      try {
        return new URL(url).origin === 'https://example.test';
      } catch {
        return false;
      }
    }),
  } as unknown as DocverseClient;
}

describe('pollQueueJob', () => {
  it('returns immediately when first poll is terminal', async () => {
    const { client } = fakeClient([makeJob('completed')]);
    const job = await pollQueueJob(client, 'https://example.test/queue/jobs/JOB1', {
      timeoutMs: 60_000,
      sleep: vi.fn(),
      random: () => 0,
      now: () => 0,
    });
    expect(job.status).toBe('completed');
  });

  it('uses exponential backoff (1s → 15s)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const sequence = [
      makeJob('in_progress'),
      makeJob('in_progress'),
      makeJob('in_progress'),
      makeJob('in_progress'),
      makeJob('in_progress'),
      makeJob('in_progress'),
      makeJob('completed'),
    ];
    const { client } = fakeClient(sequence);
    const t = 0;
    await pollQueueJob(client, 'https://example.test/queue/jobs/JOB1', {
      timeoutMs: 10 * 60_000,
      sleep,
      random: () => 0,
      now: () => t,
    });
    expect(sleep).toHaveBeenCalledTimes(6);
    const delays = sleep.mock.calls.map((c) => c[0]);
    expect(delays[0]).toBe(1_000);
    expect(delays[1]).toBe(2_000);
    expect(delays[2]).toBe(4_000);
    expect(delays[3]).toBe(8_000);
    expect(delays[4]).toBe(15_000);
    expect(delays[5]).toBe(15_000);
  });

  it('adds jitter scaled to current delay', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { client } = fakeClient([makeJob('in_progress'), makeJob('completed')]);
    await pollQueueJob(client, 'https://example.test/queue/jobs/JOB1', {
      timeoutMs: 60_000,
      sleep,
      random: () => 0.5,
      now: () => 0,
    });
    // 1000ms base + 0.5 * 1000 * 0.5 = 1250
    expect(sleep.mock.calls[0]?.[0]).toBe(1_250);
  });

  it('throws PollTimeoutError when deadline expires', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { client } = fakeClient([
      makeJob('in_progress', 'inventory'),
      makeJob('in_progress', 'inventory'),
    ]);
    let now = 0;
    await expect(
      pollQueueJob(client, 'https://example.test/queue/jobs/JOB1', {
        timeoutMs: 500,
        sleep,
        random: () => 0,
        now: () => {
          const value = now;
          now += 1_000;
          return value;
        },
      }),
    ).rejects.toBeInstanceOf(PollTimeoutError);
  });
});

describe('pollPublishJobs', () => {
  const stable = { timeoutMs: 60_000, sleep: vi.fn(), random: () => 0, now: () => 0 };

  it('resolves when every publish job is completed', async () => {
    const client = fakePublishClient({
      p1: [makeJob('completed')],
      p2: [makeJob('completed')],
    });
    const results = await pollPublishJobs(
      client,
      [
        { editionSlug: 'main', jobId: 'p1' },
        { editionSlug: 'v1', jobId: 'p2' },
      ],
      stable,
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.editionSlug).sort()).toEqual(['main', 'v1']);
    expect(results.every((r) => r.job.status === 'completed')).toBe(true);
  });

  it('returns a failed publish job instead of throwing', async () => {
    const client = fakePublishClient({
      p1: [makeJob('completed')],
      p2: [makeJob('failed')],
    });
    const results = await pollPublishJobs(
      client,
      [
        { editionSlug: 'main', jobId: 'p1' },
        { editionSlug: 'v1', jobId: 'p2' },
      ],
      stable,
    );
    expect(results.find((r) => r.editionSlug === 'v1')?.job.status).toBe('failed');
  });

  it('throws PollTimeoutError when a publish job never finishes', async () => {
    const client = fakePublishClient({ p1: [makeJob('in_progress')] });
    let now = 0;
    await expect(
      pollPublishJobs(client, [{ editionSlug: 'main', jobId: 'p1' }], {
        timeoutMs: 500,
        sleep: vi.fn(),
        random: () => 0,
        now: () => {
          const value = now;
          now += 1_000;
          return value;
        },
      }),
    ).rejects.toBeInstanceOf(PollTimeoutError);
  });

  it('follows queue_job_url when present and same-origin', async () => {
    const url = 'https://example.test/queue/jobs/p1';
    const client = fakePublishClient({}, { [url]: [makeJob('completed')] });
    const results = await pollPublishJobs(
      client,
      [{ editionSlug: 'main', jobId: 'p1', queueJobUrl: url }],
      stable,
    );
    expect(results[0]?.job.status).toBe('completed');
    expect(client.getQueueJobByUrl).toHaveBeenCalledWith(url);
    expect(client.getQueueJobById).not.toHaveBeenCalled();
  });

  it('reconstructs by id when queue_job_url is absent', async () => {
    const client = fakePublishClient({ p1: [makeJob('completed')] });
    const results = await pollPublishJobs(client, [{ editionSlug: 'main', jobId: 'p1' }], stable);
    expect(results[0]?.job.status).toBe('completed');
    expect(client.getQueueJobById).toHaveBeenCalledWith('p1');
    expect(client.getQueueJobByUrl).not.toHaveBeenCalled();
  });

  it('reconstructs by id when queue_job_url is cross-origin', async () => {
    const client = fakePublishClient({ p1: [makeJob('completed')] });
    const results = await pollPublishJobs(
      client,
      [{ editionSlug: 'main', jobId: 'p1', queueJobUrl: 'https://other.test/queue/jobs/p1' }],
      stable,
    );
    expect(results[0]?.job.status).toBe('completed');
    expect(client.getQueueJobById).toHaveBeenCalledWith('p1');
    expect(client.getQueueJobByUrl).not.toHaveBeenCalled();
  });
});
