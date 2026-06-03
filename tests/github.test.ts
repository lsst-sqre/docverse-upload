import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type GithubContext,
  type Octokit,
  postOrUpdateComment,
  resolveTargetPrs,
} from '../src/github.js';

// `@actions/core` v3 ships read-only ESM exports, so `vi.spyOn(core, ...)`
// can no longer redefine them. Mock the module instead, preserving the real
// implementations and replacing `warning` with a spy we can assert on.
vi.mock('@actions/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actions/core')>();
  return { ...actual, warning: vi.fn() };
});

const API = 'https://api.github.test';
const MARKER = '<!-- docverse:pr-comment:example.test:rubin/docs -->';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

/**
 * `@actions/github` defaults octokit to a proxy `fetch` from the `undici`
 * package, which MSW (it patches `globalThis.fetch`) does not intercept.
 * Override it with a lazy global-fetch wrapper so requests hit MSW.
 */
const testFetch = ((...args: Parameters<typeof fetch>) =>
  globalThis.fetch(...args)) as typeof fetch;

function octokit(): Octokit {
  return getOctokit('ghs-test', { baseUrl: API, request: { fetch: testFetch } });
}

function makeContext(overrides: Partial<GithubContext> = {}): GithubContext {
  return {
    eventName: 'push',
    ref: 'refs/heads/tickets/DM-1',
    repo: { owner: 'rubin', repo: 'docs-repo' },
    payload: {},
    ...overrides,
  };
}

describe('resolveTargetPrs', () => {
  it('reads the PR number directly on pull_request events', async () => {
    const result = await resolveTargetPrs(
      octokit(),
      makeContext({ eventName: 'pull_request', payload: { pull_request: { number: 5 } } }),
    );
    expect(result).toEqual({ owner: 'rubin', repo: 'docs-repo', prNumbers: [5] });
  });

  it('reads the PR number on pull_request_target events', async () => {
    const result = await resolveTargetPrs(
      octokit(),
      makeContext({ eventName: 'pull_request_target', payload: { pull_request: { number: 9 } } }),
    );
    expect(result.prNumbers).toEqual([9]);
  });

  it('queries open PRs for the pushed branch and comments on every match', async () => {
    let capturedHead: string | null = null;
    let capturedState: string | null = null;
    server.use(
      http.get(`${API}/repos/:owner/:repo/pulls`, ({ request }) => {
        const url = new URL(request.url);
        capturedHead = url.searchParams.get('head');
        capturedState = url.searchParams.get('state');
        return HttpResponse.json([{ number: 7 }, { number: 8 }]);
      }),
    );

    const result = await resolveTargetPrs(octokit(), makeContext());
    expect(result.prNumbers).toEqual([7, 8]);
    expect(capturedHead).toBe('rubin:tickets/DM-1');
    expect(capturedState).toBe('open');
  });

  it('follows pagination when listing open PRs', async () => {
    server.use(
      http.get(`${API}/repos/:owner/:repo/pulls`, ({ request }) => {
        const url = new URL(request.url);
        if (!url.searchParams.has('page')) {
          return HttpResponse.json([{ number: 1 }], {
            headers: { Link: `<${API}/repos/rubin/docs-repo/pulls?page=2>; rel="next"` },
          });
        }
        return HttpResponse.json([{ number: 2 }]);
      }),
    );

    const result = await resolveTargetPrs(octokit(), makeContext());
    expect(result.prNumbers).toEqual([1, 2]);
  });

  it('skips when no open PR matches the pushed branch', async () => {
    server.use(http.get(`${API}/repos/:owner/:repo/pulls`, () => HttpResponse.json([])));
    const result = await resolveTargetPrs(octokit(), makeContext());
    expect(result.prNumbers).toEqual([]);
  });

  it('returns no PRs for non-PR, non-push events', async () => {
    const result = await resolveTargetPrs(
      octokit(),
      makeContext({ eventName: 'workflow_dispatch' }),
    );
    expect(result.prNumbers).toEqual([]);
  });
});

describe('postOrUpdateComment', () => {
  it('creates a comment when none carries the marker', async () => {
    const created: { issue: string | null; body: string | null } = { issue: null, body: null };
    server.use(
      http.get(`${API}/repos/:owner/:repo/issues/:issue_number/comments`, () =>
        HttpResponse.json([{ id: 1, body: 'a chat comment, no marker' }]),
      ),
      http.post(
        `${API}/repos/:owner/:repo/issues/:issue_number/comments`,
        async ({ request, params }) => {
          created.issue = params.issue_number as string;
          created.body = ((await request.json()) as { body: string }).body;
          return HttpResponse.json({ id: 100 }, { status: 201 });
        },
      ),
    );

    await postOrUpdateComment(octokit(), 'rubin', 'docs-repo', 5, MARKER, `${MARKER}\nhello`);
    expect(created.issue).toBe('5');
    expect(created.body).toContain(MARKER);
  });

  it('updates the existing comment that carries the marker', async () => {
    const patched: { id: string | null; body: string | null } = { id: null, body: null };
    server.use(
      http.get(`${API}/repos/:owner/:repo/issues/:issue_number/comments`, () =>
        HttpResponse.json([
          { id: 11, body: 'unrelated comment' },
          { id: 22, body: `stale preview\n${MARKER}` },
        ]),
      ),
      http.patch(
        `${API}/repos/:owner/:repo/issues/comments/:comment_id`,
        async ({ request, params }) => {
          patched.id = params.comment_id as string;
          patched.body = ((await request.json()) as { body: string }).body;
          return HttpResponse.json({ id: Number(params.comment_id) });
        },
      ),
    );

    await postOrUpdateComment(octokit(), 'rubin', 'docs-repo', 5, MARKER, `${MARKER}\nfresh`);
    expect(patched.id).toBe('22');
    expect(patched.body).toContain('fresh');
  });

  it('warns and does not throw on a 403 (missing pull-requests: write)', async () => {
    const warning = vi.mocked(core.warning);
    warning.mockClear();
    server.use(
      http.get(`${API}/repos/:owner/:repo/issues/:issue_number/comments`, () =>
        HttpResponse.json([]),
      ),
      http.post(`${API}/repos/:owner/:repo/issues/:issue_number/comments`, () =>
        HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 }),
      ),
    );

    await expect(
      postOrUpdateComment(octokit(), 'rubin', 'docs-repo', 5, MARKER, 'body'),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toContain('pull-requests: write');
  });

  it('rethrows non-403 errors for the caller to downgrade', async () => {
    server.use(
      http.get(`${API}/repos/:owner/:repo/issues/:issue_number/comments`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    await expect(
      postOrUpdateComment(octokit(), 'rubin', 'docs-repo', 5, MARKER, 'body'),
    ).rejects.toThrow();
  });
});
