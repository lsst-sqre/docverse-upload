import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InputError, parseInputs, resolveGitRef } from '../src/inputs.js';

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'docverse-upload-test-'));
  await writeFile(join(workDir, 'index.html'), '<p>hi</p>');
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function setBaseInputs(extra: Record<string, string> = {}) {
  process.env.INPUT_ORG = 'rubin';
  process.env.INPUT_PROJECT = 'docs';
  process.env.INPUT_DIR = workDir;
  process.env.INPUT_TOKEN = 'gt-abc';
  for (const [k, v] of Object.entries(extra)) {
    process.env[`INPUT_${k.toUpperCase()}`] = v;
  }
}

describe('resolveGitRef', () => {
  it('prefers GITHUB_HEAD_REF (PR events)', () => {
    expect(resolveGitRef({ GITHUB_HEAD_REF: 'feature/x', GITHUB_REF_NAME: 'main' })).toBe(
      'feature/x',
    );
  });

  it('falls back to GITHUB_REF_NAME', () => {
    expect(resolveGitRef({ GITHUB_REF_NAME: 'v1.2.3' })).toBe('v1.2.3');
  });

  it('returns empty string when nothing is set', () => {
    expect(resolveGitRef({})).toBe('');
  });

  it('ignores whitespace-only HEAD ref', () => {
    expect(resolveGitRef({ GITHUB_HEAD_REF: '   ', GITHUB_REF_NAME: 'main' })).toBe('main');
  });
});

describe('parseInputs', () => {
  it('parses the happy path with environment-derived git-ref', () => {
    setBaseInputs();
    process.env.GITHUB_REF_NAME = 'main';
    const inputs = parseInputs();
    expect(inputs.org).toBe('rubin');
    expect(inputs.project).toBe('docs');
    expect(inputs.gitRef).toBe('main');
    expect(inputs.baseUrl).toBe('https://roundtable.lsst.cloud/docverse/api');
    expect(inputs.wait).toBe(true);
    expect(inputs.waitForPublish).toBe(true);
    expect(inputs.waitTimeoutMs).toBe(30 * 60_000);
    expect(inputs.alternateName).toBeNull();
  });

  it('honors an explicit git-ref input', () => {
    setBaseInputs({ 'git-ref': 'release/2026.01' });
    expect(parseInputs().gitRef).toBe('release/2026.01');
  });

  it('honors GITHUB_HEAD_REF on pull requests', () => {
    setBaseInputs();
    process.env.GITHUB_HEAD_REF = 'feature/x';
    process.env.GITHUB_REF_NAME = 'main';
    expect(parseInputs().gitRef).toBe('feature/x');
  });

  it('strips trailing slashes from base-url', () => {
    setBaseInputs({ 'base-url': 'https://example.test/docverse/api/' });
    process.env.GITHUB_REF_NAME = 'main';
    expect(parseInputs().baseUrl).toBe('https://example.test/docverse/api');
  });

  it('rejects a missing dir', () => {
    setBaseInputs({ dir: '/this/path/does/not/exist' });
    process.env.GITHUB_REF_NAME = 'main';
    expect(() => parseInputs()).toThrow(InputError);
  });

  it('parses wait: false', () => {
    setBaseInputs({ wait: 'false' });
    process.env.GITHUB_REF_NAME = 'main';
    expect(parseInputs().wait).toBe(false);
  });

  it('rejects non-boolean wait', () => {
    setBaseInputs({ wait: 'maybe' });
    process.env.GITHUB_REF_NAME = 'main';
    expect(() => parseInputs()).toThrow(InputError);
  });

  it('parses wait-for-publish: false', () => {
    setBaseInputs({ wait: 'true', 'wait-for-publish': 'false' });
    process.env.GITHUB_REF_NAME = 'main';
    expect(parseInputs().waitForPublish).toBe(false);
  });

  it('rejects non-boolean wait-for-publish', () => {
    setBaseInputs({ wait: 'true', 'wait-for-publish': 'maybe' });
    process.env.GITHUB_REF_NAME = 'main';
    expect(() => parseInputs()).toThrow(InputError);
  });

  it('rejects when git ref cannot be determined', () => {
    setBaseInputs();
    expect(() => parseInputs()).toThrow(InputError);
  });
});
