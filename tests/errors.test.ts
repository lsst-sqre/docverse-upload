import { describe, expect, it } from 'vitest';
import { formatApiError, formatNetworkError, formatUploadError } from '../src/errors.js';

const ctx = { org: 'rubin', project: 'docs', baseUrl: 'https://example.test' };

describe('formatApiError', () => {
  it('maps 401 to a token-focused message', () => {
    expect(
      formatApiError({ status: 401, statusText: 'Unauthorized', body: null, rawBody: '' }, ctx),
    ).toMatch(/Authentication failed/);
  });

  it('maps 403 to a role-focused message that includes the org', () => {
    expect(
      formatApiError({ status: 403, statusText: 'Forbidden', body: null, rawBody: '' }, ctx),
    ).toMatch(/lacks `uploader` role for org `rubin`/);
  });

  it('maps 404 to an org/project message that includes the base URL', () => {
    const msg = formatApiError(
      { status: 404, statusText: 'Not Found', body: null, rawBody: '' },
      ctx,
    );
    expect(msg).toContain('`rubin`');
    expect(msg).toContain('`docs`');
    expect(msg).toContain('`https://example.test`');
  });

  it('includes validation details for 422', () => {
    const msg = formatApiError(
      {
        status: 422,
        statusText: 'Unprocessable',
        body: {
          detail: [{ loc: ['body', 'git_ref'], msg: 'field required', type: 'missing' }],
        },
        rawBody: '',
      },
      ctx,
    );
    expect(msg).toContain('body.git_ref: field required');
  });
});

describe('formatNetworkError', () => {
  it('embeds the base URL and underlying message', () => {
    const msg = formatNetworkError(new Error('ENOTFOUND'), 'https://example.test');
    expect(msg).toContain('`https://example.test`');
    expect(msg).toContain('ENOTFOUND');
  });
});

describe('formatUploadError', () => {
  it('includes status and a body excerpt', () => {
    const msg = formatUploadError({
      status: 403,
      statusText: 'Forbidden',
      body: null,
      rawBody: '<Error>SignatureDoesNotMatch</Error>',
    });
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('SignatureDoesNotMatch');
  });
});
