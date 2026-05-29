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
    org: string,
    project: string,
    fetchImpl: Fetch = globalThis.fetch,
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

  async completeUpload(buildSelfUrl: string): Promise<Build> {
    const { org, project, build } = parseBuildSelfUrl(buildSelfUrl, this.baseUrl);
    const result = await this.callApi(() =>
      this.client.PATCH('/orgs/{org}/projects/{project}/builds/{build}', {
        params: { path: { org, project, build } },
        body: { status: 'uploaded' },
      }),
    );
    return result as Build;
  }

  async getQueueJob(queueUrl: string): Promise<QueueJob> {
    return this.getQueueJobById(parseJobId(queueUrl));
  }

  async getQueueJobById(jobId: string): Promise<QueueJob> {
    const result = await this.callApi(() =>
      this.client.GET('/queue/jobs/{job}', { params: { path: { job: jobId } } }),
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

function parseJobId(queueUrl: string): string {
  const match = queueUrl.match(/queue\/jobs\/([A-Za-z0-9-]+)\/?$/);
  if (!match) {
    throw new Error(`Could not parse job ID out of queue URL: ${queueUrl}`);
  }
  return match[1]!;
}

interface BuildPath {
  org: string;
  project: string;
  build: string;
}

function parseBuildSelfUrl(selfUrl: string, baseUrl: string): BuildPath {
  const match = selfUrl.match(/orgs\/([^/]+)\/projects\/([^/]+)\/builds\/([^/?#]+)/);
  if (!match) {
    throw new Error(`Could not parse build self_url: ${selfUrl} (base ${baseUrl})`);
  }
  return { org: match[1]!, project: match[2]!, build: match[3]! };
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
