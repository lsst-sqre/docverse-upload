import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

async function listEntries(tarPath: string): Promise<string[]> {
  const entries: string[] = [];
  await listTar({ file: tarPath, onReadEntry: (entry) => entries.push(entry.path) });
  return entries.sort();
}

describe('createTarball', () => {
  it('produces a gzipped tarball of the directory contents', async () => {
    await mkdir(join(srcDir, 'sub'), { recursive: true });
    await writeFile(join(srcDir, 'index.html'), 'hello\n');
    await writeFile(join(srcDir, 'sub', 'page.html'), 'world\n');

    const result = await createTarball(srcDir);
    try {
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.excludedCount).toBe(0);
      expect(await listEntries(result.path)).toEqual(['index.html', 'sub/', 'sub/page.html']);
    } finally {
      await result.cleanup();
    }
  });

  it('drops excluded build-cache paths at any depth and reports the count', async () => {
    await mkdir(join(srcDir, '.doctrees'), { recursive: true });
    await mkdir(join(srcDir, 'sub', '.doctrees'), { recursive: true });
    await writeFile(join(srcDir, 'index.html'), 'hello\n');
    await writeFile(join(srcDir, '.buildinfo'), 'config: abc\n');
    await writeFile(join(srcDir, '.doctrees', 'environment.pickle'), 'pickle\n');
    await writeFile(join(srcDir, 'sub', '.doctrees', 'x'), 'x\n');

    const result = await createTarball(srcDir);
    try {
      expect(await listEntries(result.path)).toEqual(['index.html', 'sub/']);
      // .buildinfo, .doctrees/ and sub/.doctrees/ — excluded directories are
      // counted once and never descended into.
      expect(result.excludedCount).toBe(3);
    } finally {
      await result.cleanup();
    }
  });

  it('refuses an empty directory', async () => {
    await expect(createTarball(srcDir)).rejects.toThrow(/empty/);
  });

  it('refuses a directory containing only excluded paths and creates no tarball', async () => {
    await mkdir(join(srcDir, '.doctrees'), { recursive: true });
    await writeFile(join(srcDir, '.doctrees', 'environment.pickle'), 'pickle\n');
    await writeFile(join(srcDir, '.buildinfo'), 'config: abc\n');

    const before = await listTmpDirs();
    await expect(createTarball(srcDir)).rejects.toThrow(/empty/);
    expect(await listTmpDirs()).toEqual(before);
  });

  it('refuses a directory whose only files are nested under excluded paths', async () => {
    await mkdir(join(srcDir, 'sub', '.doctrees'), { recursive: true });
    await writeFile(join(srcDir, 'sub', '.doctrees', 'environment.pickle'), 'pickle\n');
    await writeFile(join(srcDir, 'sub', '.buildinfo'), 'config: abc\n');

    const before = await listTmpDirs();
    await expect(createTarball(srcDir)).rejects.toThrow(/empty/);
    expect(await listTmpDirs()).toEqual(before);
  });
});

// Temp dirs created by createTarball: the `docverse-upload-` prefix followed by
// mkdtemp's six random characters. The pattern is exact so that other test
// files' temp dirs (e.g. `docverse-upload-test-XXXXXX` from inputs.test.ts,
// running in a parallel worker) cannot make this list flap.
async function listTmpDirs(): Promise<string[]> {
  const names = await readdir(tmpdir());
  return names.filter((name) => /^docverse-upload-[A-Za-z0-9]{6}$/.test(name)).sort();
}
