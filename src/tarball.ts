import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';

export interface TarballResult {
  path: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}

/**
 * Create a gzipped tarball of the contents of `sourceDir`. Returns the temp
 * path, the tarball size in bytes, and a cleanup function.
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

  const tmpDir = await mkdtemp(join(tmpdir(), 'docverse-upload-'));
  const tarPath = join(tmpDir, 'build.tar.gz');
  const cleanup = () => safeRm(tmpDir);

  const tarStream = createTar(
    {
      gzip: true,
      cwd: sourceDir,
      portable: true,
    },
    entries,
  );

  try {
    await pipeline(tarStream, createWriteStream(tarPath));
  } catch (err) {
    await cleanup();
    throw err;
  }

  const { size } = await stat(tarPath);
  return { path: tarPath, sizeBytes: size, cleanup };
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
