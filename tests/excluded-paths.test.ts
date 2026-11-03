import { describe, expect, it } from 'vitest';
import { EXCLUDED_PATH_NAMES, isExcludedPath } from '../src/excluded-paths.js';

describe('EXCLUDED_PATH_NAMES', () => {
  it('holds exactly the names shared with the Docverse Python client', () => {
    // Mirrors `docverse.excluded_paths.EXCLUDED_PATH_NAMES`. Any change here
    // must be made in lockstep with the Python list (lsst-sqre/docverse#853).
    expect([...EXCLUDED_PATH_NAMES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});

describe('isExcludedPath', () => {
  it('matches a top-level excluded name', () => {
    expect(isExcludedPath('.doctrees')).toBe(true);
    expect(isExcludedPath('.buildinfo')).toBe(true);
  });

  it('matches an excluded name in any nested segment', () => {
    expect(isExcludedPath('sub/.doctrees')).toBe(true);
    expect(isExcludedPath('sub/.doctrees/environment.pickle')).toBe(true);
    expect(isExcludedPath('a/b/__pycache__/mod.cpython-313.pyc')).toBe(true);
  });

  it('ignores leading ./ and trailing separators', () => {
    expect(isExcludedPath('./.git')).toBe(true);
    expect(isExcludedPath('.doctrees/')).toBe(true);
    expect(isExcludedPath('./sub/page.html')).toBe(false);
  });

  it('compares segments exactly, without globbing or substring matching', () => {
    expect(isExcludedPath('index.html')).toBe(false);
    expect(isExcludedPath('sub/page.html')).toBe(false);
    expect(isExcludedPath('.doctrees.html')).toBe(false);
    expect(isExcludedPath('my.git')).toBe(false);
    expect(isExcludedPath('gitignore')).toBe(false);
    expect(isExcludedPath('.DS_STORE')).toBe(false);
    expect(isExcludedPath('_static/.buildinfo.txt')).toBe(false);
  });
});
