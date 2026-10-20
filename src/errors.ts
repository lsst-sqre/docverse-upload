import type { components } from '#generated/api-types';

/**
 * Error body shapes documented in the Docverse OpenAPI spec: safir's
 * `ErrorModel` for 403/404/409 and FastAPI's `HTTPValidationError` for 422.
 * Both carry a `detail` array; FastAPI may also emit a plain-string `detail`
 * (e.g. from `HTTPException`), which the spec does not document but the
 * server can still produce.
 */
export type ApiErrorBody =
  | components['schemas']['ErrorModel']
  | components['schemas']['HTTPValidationError'];

type ErrorDetailEntry =
  | components['schemas']['ErrorDetail']
  | components['schemas']['ValidationError'];

export interface ApiErrorContext {
  org: string;
  project: string;
  baseUrl: string;
}

export interface HttpFailure {
  status: number;
  statusText: string;
  body: unknown;
  rawBody: string;
}

/**
 * Convert an HTTP failure from the Docverse API into a user-actionable
 * message. Status codes the action exposes specifically:
 * 401 (token), 403 (role), 404 (org/project), 422 (validation).
 */
export function formatApiError(failure: HttpFailure, ctx: ApiErrorContext): string {
  const { status, statusText } = failure;
  const detail = extractDetail(failure);

  if (status === 401) {
    return 'Authentication failed (HTTP 401). Check that `token` is set to a valid Gafaelfawr token (typically `${{ secrets.DOCVERSE_TOKEN }}`).';
  }
  if (status === 403) {
    return `Token is authenticated but lacks \`uploader\` role for org \`${ctx.org}\` (HTTP 403). Contact the org admin to grant access.`;
  }
  if (status === 404) {
    return `Org \`${ctx.org}\` or project \`${ctx.project}\` does not exist on \`${ctx.baseUrl}\` (HTTP 404).`;
  }
  if (status === 422) {
    return `Server rejected the request (HTTP 422 validation error): ${detail}`;
  }
  if (status >= 500) {
    return `Docverse server error (HTTP ${status} ${statusText}): ${detail}`;
  }
  return `Docverse API error (HTTP ${status} ${statusText}): ${detail}`;
}

/**
 * Network-level failures (DNS, connection refused, TLS, etc.).
 */
export function formatNetworkError(err: unknown, baseUrl: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Could not reach Docverse at \`${baseUrl}\`: ${message}. Check the \`base-url\` input and network connectivity.`;
}

/**
 * Failure from a presigned PUT to cloud storage.
 */
export function formatUploadError(failure: HttpFailure): string {
  const excerpt = failure.rawBody.slice(0, 400);
  return `Tarball upload to presigned URL failed (HTTP ${failure.status} ${failure.statusText}): ${excerpt}`;
}

/**
 * Whether an HTTP failure body has the documented `{ detail: [...] }` shape.
 * Structural only: the entries themselves are still read defensively because
 * the body came off the wire.
 */
export function isApiErrorBody(body: unknown): body is { detail: ErrorDetailEntry[] } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'detail' in body &&
    Array.isArray((body as { detail: unknown }).detail)
  );
}

function formatDetailEntry(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) {
    return JSON.stringify(entry);
  }
  const { loc, msg } = entry as Partial<ErrorDetailEntry>;
  const location = Array.isArray(loc) ? loc.join('.') : '';
  const message = typeof msg === 'string' ? msg : JSON.stringify(entry);
  return location ? `${location}: ${message}` : message;
}

function extractDetail(failure: HttpFailure): string {
  const body = failure.body;
  if (isApiErrorBody(body)) {
    return body.detail.map(formatDetailEntry).join('; ');
  }
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    return JSON.stringify(detail);
  }
  return failure.rawBody.slice(0, 400) || '<empty body>';
}
