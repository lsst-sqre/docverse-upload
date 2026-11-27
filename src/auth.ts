import * as core from '@actions/core';

/** Gafaelfawr scope the action requests; Docverse's API requires it. */
export const DOCVERSE_SCOPE = 'exec:docverse';

const TOKEN_EXCHANGE_PATH = '/auth/api/v1/github/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

/** Prefix of Gafaelfawr's `invalid_grant` description when no project matches. */
const NO_PROJECT_PREFIX = 'No enabled GitHub project matches';

type Fetch = typeof globalThis.fetch;

/**
 * Authentication failure with a message written for the workflow author. The
 * message is the whole diagnosis; `handleFailure` reports it verbatim.
 */
export class AuthError extends Error {}

export interface TokenExchangeOptions {
  /** Docverse API base URL; Gafaelfawr is assumed to share its origin. */
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  /** Obtains the GitHub Actions ID token; injectable for tests. */
  getIdToken?: (audience: string) => Promise<string>;
}

/**
 * Base URL of the Phalanx environment hosting Docverse (the origin of
 * `base-url`). Gafaelfawr serves its API there under `/auth`, and by default
 * requires this exact URL as the audience of the GitHub ID token (SQR-120).
 */
export function environmentUrl(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/**
 * Obtain a Gafaelfawr token for the Docverse API by exchanging the job's
 * GitHub Actions OIDC ID token (SQR-120). The returned token is registered as
 * a secret so it is masked in the job log.
 */
export async function exchangeGitHubToken(opts: TokenExchangeOptions): Promise<string> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const getIdToken = opts.getIdToken ?? ((audience: string) => core.getIDToken(audience));

  const audience = environmentUrl(opts.baseUrl);
  const exchangeUrl = `${audience}${TOKEN_EXCHANGE_PATH}`;
  const repository = env.GITHUB_REPOSITORY || 'this repository';

  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new AuthError(
      'GitHub did not make an OIDC ID token available to this job. Add `id-token: write` to the ' +
        "job's `permissions` (alongside `contents: read`). Note that `pull_request` runs from " +
        'forks never receive an ID token, so the upload cannot run for fork pull requests.',
    );
  }

  let idToken: string;
  try {
    idToken = await getIdToken(audience);
  } catch (err) {
    throw new AuthError(
      `Could not get a GitHub OIDC ID token for audience \`${audience}\`: ${messageOf(err)}`,
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(exchangeUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: GRANT_TYPE,
        subject_token: idToken,
        subject_token_type: ID_TOKEN_TYPE,
        scope: DOCVERSE_SCOPE,
      }),
    });
  } catch (err) {
    throw new AuthError(
      `Could not reach Gafaelfawr at \`${exchangeUrl}\`: ${messageOf(err)}. Check the \`base-url\` input and network connectivity.`,
    );
  }

  const rawBody = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw new AuthError(
      formatExchangeError({ status: response.status, body, rawBody, repository, audience }),
    );
  }

  const token = (body as { access_token?: unknown } | undefined)?.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new AuthError(
      `Gafaelfawr at \`${exchangeUrl}\` returned a successful response without an \`access_token\`.`,
    );
  }
  core.setSecret(token);
  return token;
}

interface ExchangeFailure {
  status: number;
  body: unknown;
  rawBody: string;
  repository: string;
  audience: string;
}

/**
 * Turn a failed token exchange into a message that says what to fix. Gafaelfawr
 * replies with an OAuth 2.0 error document (`error`, `error_description`); its
 * description names the failed check and the claims of the caller's own token,
 * so it is always passed through.
 */
export function formatExchangeError(failure: ExchangeFailure): string {
  const { status, repository, audience } = failure;
  const { error, description } = parseOAuthError(failure.body);
  const detail = description ?? (failure.rawBody.slice(0, 400) || '<empty body>');

  if (error === 'invalid_grant' && description?.startsWith(NO_PROJECT_PREFIX)) {
    return (
      `\`${repository}\` is not authorized to get a Docverse token from \`${audience}\`: no ` +
      'enabled GitHub project registered in Gafaelfawr matches this workflow run. Either the ' +
      'repository has not been registered, or the registered project restricts the workflow, ' +
      'ref, or environment to values that this run does not match. Ask the administrators of ' +
      `\`${audience}\` to register a GitHub project for \`${repository}\` with the ` +
      `\`${DOCVERSE_SCOPE}\` scope, or to check its constraints against the values below. ` +
      `Gafaelfawr said: ${detail}`
    );
  }
  if (error === 'invalid_scope') {
    return (
      `The GitHub project registered in Gafaelfawr for \`${repository}\` does not grant the ` +
      `\`${DOCVERSE_SCOPE}\` scope that Docverse uploads require. Ask the administrators of ` +
      `\`${audience}\` to add it to the project. Gafaelfawr said: ${detail}`
    );
  }
  if (error === 'invalid_grant') {
    return (
      `Gafaelfawr at \`${audience}\` rejected this job's GitHub OIDC ID token: ${detail}. The ` +
      `token was requested with audience \`${audience}\`; if this environment is configured ` +
      'with a different audience, the `base-url` input may point at the wrong host.'
    );
  }
  if (status === 404) {
    return (
      `GitHub Actions token exchange is not available at \`${audience}\` (HTTP 404). Check that ` +
      'the `base-url` input points at the right environment and that its Gafaelfawr has the ' +
      'GitHub token exchange enabled.'
    );
  }
  if (status >= 500) {
    return (
      `Gafaelfawr at \`${audience}\` could not complete the token exchange (HTTP ${status}): ` +
      `${detail}. This is usually temporary; re-run the job.`
    );
  }
  return `Gafaelfawr token exchange at \`${audience}\` failed (HTTP ${status}${error ? ` ${error}` : ''}): ${detail}`;
}

function parseOAuthError(body: unknown): { error?: string; description?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const { error, error_description: description } = body as Record<string, unknown>;
  return {
    error: typeof error === 'string' ? error : undefined,
    description: typeof description === 'string' ? description : undefined,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
