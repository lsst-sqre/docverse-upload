import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { isExcludedPath } from './excluded-paths.js';

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
  const topLevel = entries.filter((entry) => !isExcludedPath(entry));
  if (topLevel.length === 0) {
    throw new Error(
      `Source directory contains only excluded build-cache paths: ${sourceDir}. ` +
        'Refusing to upload an empty tarball.',
    );
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'docverse-upload-'));
  const tarPath = join(tmpDir, 'build.tar.gz');
  const cleanup = () => safeRm(tmpDir);

  // Top-level exclusions are already dropped from the entry list; the filter
  // catches nested ones (e.g. `sub/.doctrees`). tar does not descend into a
  // filtered directory, so each excluded directory counts once.
  let excludedCount = entries.length - topLevel.length;
  const tarStream = createTar(
    {
      gzip: true,
      cwd: sourceDir,
      portable: true,
      filter: (path) => {
        if (isExcludedPath(path)) {
          excludedCount += 1;
          return false;
        }
        return true;
      },
    },
    topLevel,
  );

  try {
    await pipeline(tarStream, createWriteStream(tarPath));
  } catch (err) {
    await cleanup();
    throw err;
  }

  const { size } = await stat(tarPath);
  return { path: tarPath, sizeBytes: size, excludedCount, cleanup };
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
