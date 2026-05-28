import { describe, expect, it, vi } from 'vitest';
import type { DocverseClient, QueueJob } from '../src/client.js';
import { PollTimeoutError, pollQueueJob } from '../src/poll.js';

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
