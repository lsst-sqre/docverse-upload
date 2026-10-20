import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list as listTar } from 'tar';
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
  it('produces a gzipped tarball of the directory contents', async () => {
    await mkdir(join(srcDir, 'sub'), { recursive: true });
    await writeFile(join(srcDir, 'index.html'), 'hello\n');
    await writeFile(join(srcDir, 'sub', 'page.html'), 'world\n');

    const result = await createTarball(srcDir);
    try {
      expect(result.sizeBytes).toBeGreaterThan(0);
      const entries: string[] = [];
      await listTar({ file: result.path, onReadEntry: (entry) => entries.push(entry.path) });
      expect(entries.sort()).toEqual(['index.html', 'sub/', 'sub/page.html']);
    } finally {
      await result.cleanup();
    }
  });

  it('refuses an empty directory', async () => {
    await expect(createTarball(srcDir)).rejects.toThrow(/empty/);
  });
});
