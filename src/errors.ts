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

interface DetailEntry {
  msg?: unknown;
  loc?: unknown;
  type?: unknown;
}

function extractDetail(failure: HttpFailure): string {
  const body = failure.body;
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((entry: DetailEntry) => {
          const loc = Array.isArray(entry.loc) ? entry.loc.join('.') : '';
          const msg = typeof entry.msg === 'string' ? entry.msg : JSON.stringify(entry);
          return loc ? `${loc}: ${msg}` : msg;
        })
        .join('; ');
    }
    return JSON.stringify(detail);
  }
  return failure.rawBody.slice(0, 400) || '<empty body>';
}
