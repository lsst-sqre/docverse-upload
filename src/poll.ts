import type { DocverseClient, QueueJob } from './client.js';

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;
const BACKOFF_FACTOR = 2;

const TERMINAL_STATUSES = new Set<QueueJob['status']>([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

export interface PollOptions {
  timeoutMs: number;
  /** Sleep function (ms). Override in tests with fake timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter generator returning a value in [0, 1). Override for determinism. */
  random?: () => number;
  /** Monotonic clock in ms. Override for determinism. */
  now?: () => number;
}

export class PollTimeoutError extends Error {
  constructor(
    public readonly job: QueueJob,
    public readonly timeoutMs: number,
  ) {
    super(
      `Build processing did not complete within ${Math.round(timeoutMs / 60_000)} minutes. ` +
        `Job \`${job.id}\` is still \`${job.status}\`. Last phase: \`${job.phase ?? 'unknown'}\`.`,
    );
  }
}

/**
 * Poll a queue job until it reaches a terminal state or the timeout expires.
 * Exponential backoff with jitter (1 s → 15 s, jitter up to 50% of the delay).
 */
export async function pollQueueJob(
  client: DocverseClient,
  queueUrl: string,
  opts: PollOptions,
): Promise<QueueJob> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => Date.now());

  const deadline = now() + opts.timeoutMs;
  let delay = INITIAL_DELAY_MS;

  while (true) {
    const job = await client.getQueueJob(queueUrl);
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new PollTimeoutError(job, opts.timeoutMs);
    }
    const jitter = random() * delay * 0.5;
    const wait = Math.min(delay + jitter, remaining);
    await sleep(wait);
    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
