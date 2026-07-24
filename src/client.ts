import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import createOpenapiFetch from 'openapi-fetch';
import type { components, paths } from '#generated/api-types';
import type { BuildAnnotations } from './annotations.js';
import type { ApiErrorContext, HttpFailure } from './errors.js';
import { formatApiError, formatNetworkError, formatUploadError } from './errors.js';

export type Build = components['schemas']['Build'];
export type QueueJob = components['schemas']['QueueJob'];
export type Edition = components['schemas']['docverse__handlers__orgs__models__Edition'];

type Fetch = typeof globalThis.fetch;
type OpenapiFetchClient = ReturnType<typeof createOpenapiFetch<paths>>;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly failure: HttpFailure,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {}

export interface CreateBuildOptions {
  org: string;
  project: string;
  gitRef: string;
  contentHash: string;
  alternateName: string | null;
  annotations: BuildAnnotations | null;
}

export class DocverseClient {
  private readonly client: OpenapiFetchClient;
  private readonly errorContext: ApiErrorContext;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly org: string,
    private readonly project: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.client = createOpenapiFetch<paths>({
      baseUrl,
      headers: { Authorization: `Bearer ${token}` },
      fetch: fetchImpl,
    });
    this.errorContext = { org, project, baseUrl };
  }

  async createBuild(opts: CreateBuildOptions): Promise<Build> {
    const body: components['schemas']['BuildCreate'] = {
      git_ref: opts.gitRef,
      content_hash: opts.contentHash,
    };
    if (opts.alternateName !== null) {
      body.alternate_name = opts.alternateName;
    }
    if (opts.annotations !== null) {
      body.annotations = opts.annotations;
    }

    const result = await this.callApi(() =>
      this.client.POST('/orgs/{org}/projects/{project}/builds', {
        params: { path: { org: opts.org, project: opts.project } },
        body,
      }),
    );
    return result as Build;
  }

  async completeUpload(buildId: string): Promise<Build> {
    const result = await this.callApi(() =>
      this.client.PATCH('/orgs/{org}/projects/{project}/builds/{build}', {
        params: { path: { org: this.org, project: this.project, build: buildId } },
        body: { status: 'uploaded' },
      }),
    );
    return result as Build;
  }

  /**
   * Fetch the build-processing queue job by following the build's `job_url`
   * HATEOAS link. `job_url` is minted server-side (via `request.url_for`) on
   * the same host the action just PATCHed, so it is always same-origin and the
   * Gafaelfawr bearer is attached. There is no reconstruction fallback here: a
   * cross-origin or otherwise anomalous `job_url` simply surfaces as a normal
   * `ApiError` (cross-origin links are followed without the token, so the
   * server's auth check fails as expected).
   */
  async getQueueJob(jobUrl: string): Promise<QueueJob> {
    return this.followLink<QueueJob>(jobUrl);
  }

  /** Follow an absolute queue-job URL (e.g. a `job_url` progress link). */
  async getQueueJobByUrl(url: string): Promise<QueueJob> {
    return this.followLink<QueueJob>(url);
  }

  async getQueueJobById(jobId: string): Promise<QueueJob> {
    const result = await this.callApi(() =>
      this.client.GET('/orgs/{org}/jobs/{job}', {
        params: { path: { org: this.org, job: jobId } },
      }),
    );
    return result as QueueJob;
  }

  async getEdition(org: string, project: string, slug: string): Promise<Edition> {
    const result = await this.callApi(() =>
      this.client.GET('/orgs/{org}/projects/{project}/editions/{edition}', {
        params: { path: { org, project, edition: slug } },
      }),
    );
    return result as Edition;
  }

  /** Follow an absolute edition URL (e.g. a progress `edition_url` link). */
  async getEditionByUrl(url: string): Promise<Edition> {
    return this.followLink<Edition>(url);
  }

  /**
   * Whether `url` shares the configured `base-url` origin. Callers use this to
   * decide whether a server-provided HATEOAS link is safe to follow (the
   * bearer token is only ever attached to same-origin requests) before falling
   * back to path reconstruction.
   */
  isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  /**
   * Follow an absolute API URL with a bare `fetch`, reusing {@link callApi} for
   * error/network handling. The Gafaelfawr bearer is attached only when the URL
   * is same-origin with `base-url`, so the token never leaks to a host the
   * action did not configure. On a non-OK response the body is left unread so
   * {@link buildFailure} can consume it for the error message.
   */
  private async followLink<T>(url: string): Promise<T> {
    const sameOrigin = this.isSameOrigin(url);
    return this.callApi<T>(async () => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (sameOrigin) {
        headers.Authorization = `Bearer ${this.token}`;
      }
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        return { response };
      }
      return { data: (await response.json()) as T, response };
    });
  }

  private async callApi<T>(
    call: () => Promise<{
      data?: T;
      error?: unknown;
      response: Response;
    }>,
  ): Promise<T> {
    let result: Awaited<ReturnType<typeof call>>;
    try {
      result = await call();
    } catch (err) {
      throw new NetworkError(formatNetworkError(err, this.baseUrl));
    }

    if (result.data !== undefined) {
      return result.data;
    }

    const failure = await buildFailure(result.response, result.error);
    throw new ApiError(formatApiError(failure, this.errorContext), failure);
  }
}

/**
 * Upload a tarball file to a presigned URL. Uses a bare fetch — no
 * Authorization header — so the Gafaelfawr token never reaches cloud storage.
 */
export async function uploadTarball(
  uploadUrl: string,
  filePath: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<void> {
  const { size } = await stat(filePath);
  const nodeStream = createReadStream(filePath);
  const body = Readable.toWeb(nodeStream) as unknown as BodyInit;

  let response: Response;
  try {
    response = await fetchImpl(uploadUrl, {
      method: 'PUT',
      body,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(size),
      },
      // node fetch needs duplex when streaming a body
      // @ts-expect-error: duplex is a Node-specific option
      duplex: 'half',
    });
  } catch (err) {
    throw new NetworkError(
      `Tarball upload to presigned URL failed (network error): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const failure = await buildFailure(response, undefined);
    throw new ApiError(formatUploadError(failure), failure);
  }
}

async function buildFailure(response: Response, parsedError: unknown): Promise<HttpFailure> {
  let rawBody = '';
  let body: unknown = parsedError;
  try {
    rawBody = await response.clone().text();
  } catch {
    // ignore
  }
  if (body === undefined && rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    body,
    rawBody,
  };
}
