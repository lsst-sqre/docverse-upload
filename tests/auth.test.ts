import * as core from '@actions/core';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  discoverGafaelfawrApiUrl,
  environmentUrl,
  exchangeGitHubToken,
} from '../src/auth.js';

// `@actions/core` v3 ships read-only ESM exports, so `vi.spyOn(core, ...)`
// throws; mock the module and replace just `setSecret`.
vi.mock('@actions/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actions/core')>();
  return { ...actual, setSecret: vi.fn() };
});

const BASE_URL = 'https://example.test/docverse/api';
const EXCHANGE_URL = 'https://example.test/auth/api/v1/github/token';
const DISCOVERY_URL = 'https://example.test/repertoire/discovery';

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/idtoken?v=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  GITHUB_REPOSITORY: 'lsst-sqre/sqr-062',
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
// By default the environment publishes no discovery document, so the action
// falls back to the conventional Gafaelfawr path that EXCHANGE_URL uses.
beforeEach(() => {
  server.use(http.get(DISCOVERY_URL, () => new HttpResponse(null, { status: 404 })));
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function exchange(overrides: Partial<Parameters<typeof exchangeGitHubToken>[0]> = {}) {
  return exchangeGitHubToken({
    baseUrl: BASE_URL,
    env: ENV,
    getIdToken: async () => 'id-token-jwt',
    ...overrides,
  });
}

function rejectWith(status: number, body: Record<string, string>) {
  server.use(http.post(EXCHANGE_URL, () => HttpResponse.json(body, { status })));
}

describe('environmentUrl', () => {
  it('is the origin of the Docverse base URL', () => {
    expect(environmentUrl('https://roundtable.lsst.cloud/docverse/api')).toBe(
      'https://roundtable.lsst.cloud',
    );
  });
});

describe('discoverGafaelfawrApiUrl', () => {
  const ENVIRONMENT = 'https://example.test';
  const FALLBACK = 'https://example.test/auth/api/v1';

  function discovery(gafaelfawr: unknown) {
    server.use(
      http.get(DISCOVERY_URL, () => HttpResponse.json({ services: { internal: { gafaelfawr } } })),
    );
  }

  it('uses the versioned API URL from service discovery', async () => {
    discovery({
      url: 'https://example.test/auth',
      versions: { v1: { url: 'https://example.test/gafaelfawr/api/v1/' } },
    });
    await expect(discoverGafaelfawrApiUrl(ENVIRONMENT)).resolves.toBe(
      'https://example.test/gafaelfawr/api/v1',
    );
  });

  it('derives the API URL from the service root without a versions entry', async () => {
    discovery({ url: 'https://auth.example.test/' });
    await expect(discoverGafaelfawrApiUrl(ENVIRONMENT)).resolves.toBe(
      'https://auth.example.test/api/v1',
    );
  });

  it.each([
    ['is missing', () => new HttpResponse(null, { status: 404 })],
    ['is unreachable', () => HttpResponse.error()],
    ['is not JSON', () => new HttpResponse('<html>', { status: 200 })],
    ['does not list Gafaelfawr', () => HttpResponse.json({ services: { internal: {} } })],
    [
      'lists a non-HTTP URL',
      () => HttpResponse.json({ services: { internal: { gafaelfawr: { url: 'ftp://x/auth' } } } }),
    ],
  ])('falls back to /auth when discovery %s', async (_case, resolver) => {
    server.use(http.get(DISCOVERY_URL, resolver));
    await expect(discoverGafaelfawrApiUrl(ENVIRONMENT)).resolves.toBe(FALLBACK);
  });
});

describe('exchangeGitHubToken', () => {
  it('posts the exchange to the Gafaelfawr URL from service discovery', async () => {
    server.use(
      http.get(DISCOVERY_URL, () =>
        HttpResponse.json({
          services: {
            internal: {
              gafaelfawr: { versions: { v1: { url: 'https://example.test/moved/api/v1' } } },
            },
          },
        }),
      ),
      http.post('https://example.test/moved/api/v1/github/token', () =>
        HttpResponse.json({ access_token: 'gt-moved' }),
      ),
    );
    const getIdToken = vi.fn(async () => 'id-token-jwt');
    await expect(exchange({ getIdToken })).resolves.toBe('gt-moved');
    // The audience stays the environment's base URL wherever Gafaelfawr lives.
    expect(getIdToken).toHaveBeenCalledWith('https://example.test');
  });

  it('exchanges the ID token for a masked Gafaelfawr token', async () => {
    const getIdToken = vi.fn(async () => 'id-token-jwt');
    let contentType: string | null = null;
    let form = new URLSearchParams();
    server.use(
      http.post(EXCHANGE_URL, async ({ request }) => {
        contentType = request.headers.get('content-type');
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: 'gt-minted',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'exec:docverse',
        });
      }),
    );

    await expect(exchange({ getIdToken })).resolves.toBe('gt-minted');

    expect(getIdToken).toHaveBeenCalledWith('https://example.test');
    expect(contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'id-token-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      scope: 'exec:docverse',
    });
    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith('gt-minted');
  });

  it('explains the missing id-token permission', async () => {
    const getIdToken = vi.fn(async () => 'unused');
    const result = exchange({ env: { GITHUB_REPOSITORY: 'lsst-sqre/sqr-062' }, getIdToken });
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(/`id-token: write`/);
    await expect(result).rejects.toThrow(/forks/);
    expect(getIdToken).not.toHaveBeenCalled();
  });

  it('reports a failure to obtain the ID token', async () => {
    const result = exchange({
      getIdToken: async () => {
        throw new Error('Failed to get ID Token');
      },
    });
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(
      /audience `https:\/\/example.test`: Failed to get ID Token/,
    );
  });

  it('explains that the repository has no matching GitHub project', async () => {
    const description =
      'No enabled GitHub project matches repository lsst-sqre/sqr-062 (ID 1, owner ID 2),' +
      ' workflow lsst-sqre/sqr-062/.github/workflows/ci.yaml@refs/heads/main,' +
      ' ref refs/heads/main, environment (none)';
    rejectWith(400, { error: 'invalid_grant', error_description: description });

    const result = exchange();
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(/`lsst-sqre\/sqr-062` is not authorized/);
    await expect(result).rejects.toThrow(/register a GitHub project for `lsst-sqre\/sqr-062`/);
    await expect(result).rejects.toThrow(/`exec:docverse`/);
    // The server's account of the token's claims is passed through.
    await expect(result).rejects.toThrow(description);
  });

  it('explains a project that does not grant the Docverse scope', async () => {
    rejectWith(400, {
      error: 'invalid_scope',
      error_description: 'Requested scopes not allowed for this workflow: exec:docverse',
    });
    await expect(exchange()).rejects.toThrow(/does not grant the `exec:docverse` scope/);
  });

  it('reports an ID token that fails verification', async () => {
    rejectWith(400, {
      error: 'invalid_grant',
      error_description: 'Token failed verification: Invalid audience',
    });
    const result = exchange();
    await expect(result).rejects.toThrow(/rejected this job's GitHub OIDC ID token/);
    await expect(result).rejects.toThrow(/Invalid audience/);
    await expect(result).rejects.not.toThrow(/not authorized/);
  });

  it('explains an environment without token exchange', async () => {
    server.use(http.post(EXCHANGE_URL, () => new HttpResponse('Not Found', { status: 404 })));
    await expect(exchange()).rejects.toThrow(/token exchange is not available/);
  });

  it('marks server errors as temporary', async () => {
    rejectWith(502, {
      error: 'temporarily_unavailable',
      error_description: 'Cannot retrieve GitHub signing keys',
    });
    const result = exchange();
    await expect(result).rejects.toThrow(/HTTP 502/);
    await expect(result).rejects.toThrow(/re-run the job/);
  });

  it('reports other errors with the server description', async () => {
    rejectWith(400, { error: 'invalid_request', error_description: 'Missing subject_token' });
    await expect(exchange()).rejects.toThrow(/HTTP 400 invalid_request\): Missing subject_token/);
  });

  it('reports network failures', async () => {
    server.use(http.post(EXCHANGE_URL, () => HttpResponse.error()));
    const result = exchange();
    await expect(result).rejects.toBeInstanceOf(AuthError);
    await expect(result).rejects.toThrow(/Could not reach Gafaelfawr/);
  });

  it('rejects a success response without a token', async () => {
    server.use(http.post(EXCHANGE_URL, () => HttpResponse.json({ token_type: 'Bearer' })));
    await expect(exchange()).rejects.toThrow(/without an `access_token`/);
  });
});
