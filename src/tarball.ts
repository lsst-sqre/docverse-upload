import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { EXCLUDED_PATH_NAMES, isExcludedPath } from './excluded-paths.js';

export interface TarballResult {
  path: string;
  sizeBytes: number;
  /**
   * Number of filesystem entries dropped from the tarball because they matched
   * `EXCLUDED_PATH_NAMES`. An excluded directory counts once; its contents are
   * never visited.
   */
  excludedCount: number;
  cleanup: () => Promise<void>;
}

/**
 * Create a gzipped tarball of the contents of `sourceDir`, omitting build
 * caches and VCS metadata (see `EXCLUDED_PATH_NAMES`). Returns the temp path,
 * the tarball size in bytes, the number of excluded entries, and a cleanup
 * function.
 *
 * Throws if nothing but directories would survive the exclusion filter, so an
 * output tree that holds only caches (even nested ones) is never uploaded as
 * an empty skeleton.
 *
 * No client-side digest is computed: Docverse derives the build's content
 * identity server-side from the uploaded files, and the client-supplied
 * `content_hash` is deprecated.
 */
export async function createTarball(sourceDir: string): Promise<TarballResult> {
  const entries = await readdir(sourceDir);
  if (entries.length === 0) {
    throw new Error(
      `Source directory is empty: ${sourceDir}. Refusing to upload an empty tarball.`,
    );
  }
  // Cheap early refusal for the common case (e.g. a stray `.doctrees/` next to
  // nothing), so no tarball is created at all. Nested-only cases are caught
  // after packing, below.
  if (entries.every((entry) => isExcludedPath(entry))) {
    throw onlyExcludedError(sourceDir);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'docverse-upload-'));
  const tarPath = join(tmpDir, 'build.tar.gz');
  const cleanup = () => safeRm(tmpDir);

  let excludedCount = 0;
  let fileCount = 0;
  const tarStream = createTar(
    {
      gzip: true,
      cwd: sourceDir,
      portable: true,
      // tar calls the filter for every top-level entry and, for each admitted
      // directory, for its children — and never descends into a filtered
      // directory. So every ancestor segment of `path` has already been
      // admitted and only the last segment can newly match, which makes a
      // basename check equivalent to `isExcludedPath` here.
      filter: (path, entry) => {
        if (EXCLUDED_PATH_NAMES.has(basename(path))) {
          excludedCount += 1;
          return false;
        }
        if (!('isDirectory' in entry && entry.isDirectory())) {
          fileCount += 1;
        }
        return true;
      },
    },
    entries,
  );

  try {
    await pipeline(tarStream, createWriteStream(tarPath));
    if (fileCount === 0) {
      throw onlyExcludedError(sourceDir);
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  const { size } = await stat(tarPath);
  return { path: tarPath, sizeBytes: size, excludedCount, cleanup };
}

function onlyExcludedError(sourceDir: string): Error {
  return new Error(
    `Source directory contains only excluded build-cache paths: ${sourceDir}. ` +
      'Refusing to upload an empty tarball.',
  );
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
