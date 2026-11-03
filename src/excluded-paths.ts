import { sep as pathSep } from 'node:path';

/**
 * Path names that are never uploaded to Docverse.
 *
 * These are build-cache and VCS artifacts that documentation builders leave
 * next to their HTML output (Sphinx `.doctrees/` pickles and `.buildinfo` in
 * particular). The Docverse server strips the same names on ingest as a
 * backstop, but filtering here keeps the bytes from ever leaving the runner.
 *
 * This list mirrors `docverse.excluded_paths.EXCLUDED_PATH_NAMES` in the
 * Python client and must be kept identical to it.
 */
export const EXCLUDED_PATH_NAMES: ReadonlySet<string> = new Set([
  '.doctrees',
  '.buildinfo',
  '.git',
  '__pycache__',
  '.pytest_cache',
  '.ipynb_checkpoints',
  '.DS_Store',
  'Thumbs.db',
  '.hg',
  '.svn',
]);

/**
 * Whether `relativePath` should be excluded from the upload.
 *
 * True when any path segment is exactly one of `EXCLUDED_PATH_NAMES`, so a
 * nested `sub/.doctrees/x` is excluded along with a top-level `.doctrees`.
 * Comparison is exact (case-sensitive, no globbing). Both `/` and the
 * platform separator are accepted; leading `./` and trailing separators are
 * ignored.
 */
export function isExcludedPath(relativePath: string): boolean {
  const segments = relativePath.split(pathSep === '/' ? '/' : /[\\/]/);
  return segments.some((segment) => EXCLUDED_PATH_NAMES.has(segment));
}
