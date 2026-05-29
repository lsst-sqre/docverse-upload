#!/usr/bin/env node
/**
 * Reads the upstream Docverse OpenAPI spec and rewrites every path key by
 * stripping the leading `/docverse/api` prefix. The action consumes the
 * resource-relative form so openapi-fetch correctly concatenates with the
 * `base-url` input (which already includes that prefix).
 *
 * Usage:
 *   node scripts/prep-openapi.mjs [<input>] [<output>]
 *
 * Defaults to reading the input from `docverse-openapi.json` if present,
 * else from `openapi.json` in place, and writes to `openapi.json`.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PREFIX = '/docverse/api';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pickInput(provided) {
  if (provided) return provided;
  if (await exists('docverse-openapi.json')) return 'docverse-openapi.json';
  if (await exists('openapi.json')) return 'openapi.json';
  throw new Error(
    'No input spec found. Pass an explicit path or drop docverse-openapi.json at the repo root.',
  );
}

async function main() {
  const [, , rawInput, rawOutput] = process.argv;
  const inputPath = resolve(await pickInput(rawInput));
  const outputPath = resolve(rawOutput ?? 'openapi.json');

  const raw = await readFile(inputPath, 'utf8');
  const spec = JSON.parse(raw);

  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('Spec is missing a top-level "paths" object.');
  }

  const rewritten = {};
  for (const [key, value] of Object.entries(spec.paths)) {
    let next = key;
    if (next.startsWith(PREFIX)) {
      next = next.slice(PREFIX.length) || '/';
    }
    if (!next.startsWith('/')) {
      next = `/${next}`;
    }
    if (rewritten[next]) {
      throw new Error(`Duplicate path after prefix strip: ${next}`);
    }
    rewritten[next] = value;
  }
  spec.paths = rewritten;

  const json = `${JSON.stringify(spec, null, 2)}\n`;
  await writeFile(outputPath, json, 'utf8');
  console.error(`Wrote ${outputPath} (${Object.keys(rewritten).length} paths).`);
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
