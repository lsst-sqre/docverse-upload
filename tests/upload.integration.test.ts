import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, DocverseClient, NetworkError, uploadTarball } from '../src/client.js';
import { extractPublishJobs, extractUpdatedEditions } from '../src/outputs.js';
import { pollQueueJob } from '../src/poll.js';

const BASE_URL = 'https://example.test/docverse/api';
const UPLOAD_HOST = 'https://uploads.example.test';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let workDir = '';
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'docverse-int-'));
  await writeFile(join(workDir, 'index.html'), 'hello');
});
afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function buildResource(overrides: Record<string, unknown> = {}) {
  return {
    self_url: `${BASE_URL}/orgs/rubin/projects/docs/builds/B1`,
    project_url: `${BASE_URL}/orgs/rubin/projects/docs`,
    id: 'B1',
    git_ref: 'main',
    alternate_name: null,
    content_hash: 'sha256:0'.padEnd(7 + 64, '0'),
    status: 'pending',
    upload_url: `${UPLOAD_HOST}/upload/B1?signature=abc`,
    job_url: null,
    object_count: null,
    total_size_bytes: null,
    uploader: 'tester',
    annotations: null,
    date_created: '2026-05-28T00:00:00Z',
    date_uploaded: null,
    date_completed: null,
    ...overrides,
  };
}

function queueJob(overrides: Record<string, unknown> = {}) {
  return {
    self_url: `${BASE_URL}/orgs/rubin/jobs/qbk8-g75d-s0h1-97`,
    id: 'qbk8-g75d-s0h1-97',
    kind: 'build_processing',
    status: 'completed',
    phase: 'editions',
    progress: null,
    errors: null,
    date_created: '2026-05-28T00:01:00Z',
    date_started: '2026-05-28T00:01:01Z',
    date_completed: '2026-05-28T00:02:00Z',
    keeper_sync_run_id: null,
    subject_label: null,
    subject_url: null,
    build_url: null,
    edition_url: null,
    ...overrides,
  };
}

function editionResource(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    self_url: `${BASE_URL}/orgs/rubin/projects/docs/editions/${slug}`,
    project_url: `${BASE_URL}/orgs/rubin/projects/docs`,
    build_url: `${BASE_URL}/orgs/rubin/projects/docs/builds/B1`,
    published_url: `https://docs.example/v/${slug}/`,
    history_url: `${BASE_URL}/orgs/rubin/projects/docs/editions/${slug}/history`,
    rollback_url: `${BASE_URL}/orgs/rubin/projects/docs/editions/${slug}/rollback`,
    slug,
    title: slug,
    kind: 'draft',
    tracking_mode: 'git_ref',
    tracking_params: { git_ref: 'main' },
    lifecycle_exempt: false,
    publish_status: null,
    date_created: '2026-05-28T00:00:00Z',
    date_updated: '2026-05-28T00:02:00Z',
    ...overrides,
  };
}

describe('upload flow', () => {
  it('runs create → upload → patch → poll happy path, following HATEOAS links', async () => {
    let createdHeader = '';
    let putHeader: string | null = '';
    let patchBody: unknown = null;
    const queueAuth: Record<string, string> = {};
    let editionAuth = '';

    const editionUrl = `${BASE_URL}/orgs/rubin/projects/docs/editions/main`;
    const publishJobUrl = `${BASE_URL}/orgs/rubin/jobs/whgn-wnz2-tvyx-05`;

    server.use(
      http.post(`${BASE_URL}/orgs/:org/projects/:project/builds`, async ({ request }) => {
        createdHeader = request.headers.get('authorization') ?? '';
        return HttpResponse.json(buildResource(), { status: 201 });
      }),
      http.put(`${UPLOAD_HOST}/upload/:id`, ({ request }) => {
        putHeader = request.headers.get('authorization');
        return new HttpResponse(null, { status: 200 });
      }),
      http.patch(`${BASE_URL}/orgs/:org/projects/:project/builds/:build`, async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json(
          buildResource({
            status: 'uploaded',
            job_url: `${BASE_URL}/orgs/rubin/jobs/qbk8-g75d-s0h1-97`,
          }),
        );
      }),
      http.get(`${BASE_URL}/orgs/:org/jobs/:job`, ({ request, params }) => {
        const id = params.job as string;
        queueAuth[id] = request.headers.get('authorization') ?? '';
        return HttpResponse.json(
          queueJob({
            id,
            self_url: `${BASE_URL}/orgs/rubin/jobs/${id}`,
            phase: 'complete',
            progress: {
              message: 'Build processing complete',
              editions_updated: [{ slug: 'main', action: 'updated', edition_url: editionUrl }],
              editions_skipped: [],
              publish_jobs: [
                {
                  edition_slug: 'main',
                  publish_queue_job_public_id: 'whgn-wnz2-tvyx-05',
                  job_url: publishJobUrl,
                },
              ],
            },
          }),
        );
      }),
      http.get(
        `${BASE_URL}/orgs/:org/projects/:project/editions/:edition`,
        ({ request, params }) => {
          editionAuth = request.headers.get('authorization') ?? '';
          return HttpResponse.json(editionResource(params.edition as string));
        },
      ),
    );

    const client = new DocverseClient(BASE_URL, 'gt-test', 'rubin', 'docs');

    const build = await client.createBuild({
      org: 'rubin',
      project: 'docs',
      gitRef: 'main',
      contentHash: 'sha256:0'.padEnd(7 + 64, '0'),
      alternateName: null,
      annotations: null,
    });
    expect(build.upload_url).toContain(UPLOAD_HOST);
    expect(createdHeader).toBe('Bearer gt-test');

    await uploadTarball(build.upload_url!, join(workDir, 'index.html'));
    expect(putHeader).toBeNull();

    const patched = await client.completeUpload(build.id);
    expect(patched.job_url).toContain('/orgs/rubin/jobs/qbk8-g75d-s0h1-97');
    expect(patchBody).toEqual({ status: 'uploaded' });

    const job = await pollQueueJob(client, patched.job_url!, {
      timeoutMs: 60_000,
      sleep: async () => {},
      random: () => 0,
      now: () => 0,
    });
    expect(job.status).toBe('completed');
    // The build's job_url was followed with the bearer token (same-origin).
    expect(queueAuth['qbk8-g75d-s0h1-97']).toBe('Bearer gt-test');

    // Follow the HATEOAS links embedded in the progress payload end-to-end.
    const [editionRef] = extractUpdatedEditions(job);
    const [publishRef] = extractPublishJobs(job);
    expect(editionRef?.editionUrl).toBe(editionUrl);
    expect(publishRef?.jobUrl).toBe(publishJobUrl);

    const edition = await client.getEditionByUrl(editionRef!.editionUrl!);
    expect(edition.slug).toBe('main');
    expect(editionAuth).toBe('Bearer gt-test');

    const publishJob = await client.getQueueJobByUrl(publishRef!.jobUrl!);
    expect(publishJob.id).toBe('whgn-wnz2-tvyx-05');
    expect(queueAuth['whgn-wnz2-tvyx-05']).toBe('Bearer gt-test');
  });

  it('fetches an edition resource to resolve its published_url', async () => {
    server.use(
      http.get(`${BASE_URL}/orgs/:org/projects/:project/editions/:edition`, ({ params }) =>
        HttpResponse.json({
          self_url: `${BASE_URL}/orgs/rubin/projects/docs/editions/${params.edition}`,
          project_url: `${BASE_URL}/orgs/rubin/projects/docs`,
          build_url: `${BASE_URL}/orgs/rubin/projects/docs/builds/B1`,
          published_url: 'https://docs.example/v/tickets-dm-1/',
          history_url: `${BASE_URL}/orgs/rubin/projects/docs/editions/${params.edition}/history`,
          rollback_url: `${BASE_URL}/orgs/rubin/projects/docs/editions/${params.edition}/rollback`,
          slug: params.edition,
          title: 'tickets-DM-1',
          kind: 'draft',
          tracking_mode: 'git_ref',
          tracking_params: { git_ref: 'tickets/DM-1' },
          lifecycle_exempt: false,
          publish_status: null,
          date_created: '2026-05-28T00:00:00Z',
          date_updated: '2026-05-28T00:02:00Z',
        }),
      ),
    );
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    const edition = await client.getEdition('rubin', 'docs', 'tickets-dm-1');
    expect(edition.slug).toBe('tickets-dm-1');
    expect(edition.published_url).toBe('https://docs.example/v/tickets-dm-1/');
  });

  it('fetches a queue job by id (publish_edition jobs)', async () => {
    let requestedOrg = '';
    let requestedJob = '';
    server.use(
      http.get(`${BASE_URL}/orgs/:org/jobs/:job`, ({ params }) => {
        requestedOrg = params.org as string;
        requestedJob = params.job as string;
        return HttpResponse.json(
          queueJob({
            self_url: `${BASE_URL}/orgs/rubin/jobs/whgn-wnz2-tvyx-05`,
            id: 'whgn-wnz2-tvyx-05',
            kind: 'publish_edition',
            status: 'completed',
            phase: 'publish',
          }),
        );
      }),
    );
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    const job = await client.getQueueJobById('whgn-wnz2-tvyx-05');
    expect(requestedOrg).toBe('rubin');
    expect(requestedJob).toBe('whgn-wnz2-tvyx-05');
    expect(job.id).toBe('whgn-wnz2-tvyx-05');
    expect(job.status).toBe('completed');
  });

  it('follows a cross-origin link without attaching the bearer token', async () => {
    const CROSS = 'https://other.example.test';
    let authHeader: string | null = 'unset';
    server.use(
      http.get(`${CROSS}/orgs/:org/jobs/:job`, ({ request, params }) => {
        authHeader = request.headers.get('authorization');
        return HttpResponse.json(
          queueJob({
            id: params.job as string,
            self_url: `${CROSS}/orgs/rubin/jobs/${params.job}`,
          }),
        );
      }),
    );
    const client = new DocverseClient(BASE_URL, 'gt-secret', 'rubin', 'docs');
    const job = await client.getQueueJobByUrl(`${CROSS}/orgs/rubin/jobs/abcd`);
    expect(job.id).toBe('abcd');
    expect(authHeader).toBeNull();
  });

  it('maps a network error on a followed link to NetworkError', async () => {
    server.use(http.get(`${BASE_URL}/orgs/:org/jobs/:job`, () => HttpResponse.error()));
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    await expect(
      client.getQueueJobByUrl(`${BASE_URL}/orgs/rubin/jobs/abcd`),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('reads the error body of a 404 from a followed link (unread-body invariant)', async () => {
    server.use(
      http.get(`${BASE_URL}/orgs/:org/projects/:project/editions/:edition`, () =>
        HttpResponse.json({ detail: 'edition not found' }, { status: 404 }),
      ),
    );
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    const promise = client.getEditionByUrl(`${BASE_URL}/orgs/rubin/projects/docs/editions/missing`);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    // The early `if (!response.ok) return { response }` leaves the body unread so
    // buildFailure can consume it — proven by the parsed `detail` surviving here.
    await expect(promise).rejects.toMatchObject({
      failure: {
        status: 404,
        body: { detail: 'edition not found' },
        rawBody: expect.stringContaining('edition not found'),
      },
    });
  });

  it('maps a 401 from POST builds to an actionable message', async () => {
    server.use(
      http.post(`${BASE_URL}/orgs/:org/projects/:project/builds`, () =>
        HttpResponse.json({ detail: 'invalid token' }, { status: 401 }),
      ),
    );
    const client = new DocverseClient(BASE_URL, 'gt-bad', 'rubin', 'docs');
    await expect(
      client.createBuild({
        org: 'rubin',
        project: 'docs',
        gitRef: 'main',
        contentHash: 'sha256:0'.padEnd(7 + 64, '0'),
        alternateName: null,
        annotations: null,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Authentication failed'),
    });
  });

  it('maps a 403 from POST builds to a role-focused message', async () => {
    server.use(
      http.post(`${BASE_URL}/orgs/:org/projects/:project/builds`, () =>
        HttpResponse.json({ detail: 'forbidden' }, { status: 403 }),
      ),
    );
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    await expect(
      client.createBuild({
        org: 'rubin',
        project: 'docs',
        gitRef: 'main',
        contentHash: 'sha256:0'.padEnd(7 + 64, '0'),
        alternateName: null,
        annotations: null,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('`uploader` role'),
    });
  });

  it('maps a 422 from POST builds with FastAPI-style validation detail', async () => {
    server.use(
      http.post(`${BASE_URL}/orgs/:org/projects/:project/builds`, () =>
        HttpResponse.json(
          {
            detail: [
              {
                loc: ['body', 'content_hash'],
                msg: 'pattern mismatch',
                type: 'string_pattern_mismatch',
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    await expect(
      client.createBuild({
        org: 'rubin',
        project: 'docs',
        gitRef: 'main',
        contentHash: 'sha256:bad',
        alternateName: null,
        annotations: null,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('body.content_hash: pattern mismatch'),
    });
  });

  it('reports an actionable error when the presigned PUT fails', async () => {
    server.use(
      http.put(
        `${UPLOAD_HOST}/upload/:id`,
        () => new HttpResponse('<Error>SignatureDoesNotMatch</Error>', { status: 403 }),
      ),
    );
    await expect(
      uploadTarball(`${UPLOAD_HOST}/upload/abc`, join(workDir, 'index.html')),
    ).rejects.toMatchObject({
      message: expect.stringContaining('SignatureDoesNotMatch'),
    });
    await expect(
      uploadTarball(`${UPLOAD_HOST}/upload/abc`, join(workDir, 'index.html')),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('passes annotations through to the create-build request', async () => {
    type CreateBody = { annotations?: Record<string, string>; alternate_name?: string };
    const received: { body: CreateBody | null } = { body: null };
    server.use(
      http.post(`${BASE_URL}/orgs/:org/projects/:project/builds`, async ({ request }) => {
        received.body = (await request.json()) as CreateBody;
        return HttpResponse.json(buildResource(), { status: 201 });
      }),
    );
    const client = new DocverseClient(BASE_URL, 'gt', 'rubin', 'docs');
    await client.createBuild({
      org: 'rubin',
      project: 'docs',
      gitRef: 'main',
      contentHash: 'sha256:0'.padEnd(7 + 64, '0'),
      alternateName: 'usdf-dev',
      annotations: { commit_sha: 'cafe', ci_platform: 'github-actions' },
    });
    expect(received.body?.annotations).toEqual({
      commit_sha: 'cafe',
      ci_platform: 'github-actions',
    });
    expect(received.body?.alternate_name).toBe('usdf-dev');
  });
});
