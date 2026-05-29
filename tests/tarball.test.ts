import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTarball } from '../src/tarball.js';

let srcDir = '';

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), 'docverse-tar-src-'));
});

afterEach(async () => {
  if (srcDir) await rm(srcDir, { recursive: true, force: true });
});

describe('createTarball', () => {
  it('produces a tar.gz whose SHA-256 matches an independent hash', async () => {
    await mkdir(join(srcDir, 'sub'), { recursive: true });
    await writeFile(join(srcDir, 'index.html'), 'hello\n');
    await writeFile(join(srcDir, 'sub', 'page.html'), 'world\n');

    const result = await createTarball(srcDir);
    try {
      const file = await readFile(result.path);
      const independent = `sha256:${createHash('sha256').update(file).digest('hex')}`;
      expect(result.contentHash).toBe(independent);
      expect(result.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await result.cleanup();
    }
  });

  it('refuses an empty directory', async () => {
    await expect(createTarball(srcDir)).rejects.toThrow(/empty/);
  });
});
