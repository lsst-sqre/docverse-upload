import { type Hash, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';

export interface TarballResult {
  path: string;
  contentHash: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a gzipped tarball of the contents of `sourceDir`, computing a
 * streaming SHA-256 over the gzip output. Returns the temp path, the
 * `sha256:<hex>` content hash, and a cleanup function.
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

  const hasher = createHash('sha256');
  const fileStream = createWriteStream(tarPath);
  const hashingStream = new HashingPassthrough(hasher);

  const tarStream = createTar(
    {
      gzip: true,
      cwd: sourceDir,
      portable: true,
    },
    entries,
  );

  try {
    await pipeline(tarStream, hashingStream, fileStream);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return {
    path: tarPath,
    contentHash: `sha256:${hasher.digest('hex')}`,
    cleanup,
  };
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

class HashingPassthrough extends Transform {
  constructor(private readonly hasher: Hash) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hasher.update(chunk);
    cb(null, chunk);
  }
}
