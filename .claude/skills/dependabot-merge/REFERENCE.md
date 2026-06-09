# dependabot-merge reference

## The CI sequence (what `ci.yml` runs, in order)

```sh
pnpm install --frozen-lockfile
pnpm biome ci .          # lint — exits 0 on warnings, non-zero only on errors
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest run
pnpm generate-types      # openapi-typescript openapi.json -> generated/api-types.ts
pnpm build               # node scripts/build.mjs (esbuild bundle -> dist/)
git diff --exit-code generated/ dist/   # must be empty
```

`scripts/ci-local.sh` runs exactly this and stops at the first failure.

Notes:
- Local Node may warn `Unsupported engine: wanted node >=24` — harmless; CI uses Node 24.
- `pnpm biome ci .` passing with "Found N warnings" is **green** (exit 0). Don't
  chase warnings introduced by a Biome major bump unless they're errors.
- `generated/api-types.ts` only changes when `openapi.json` changes — a runtime
  dep bump typically leaves it untouched and only changes `dist/`.

## `@actions/core` v3 — read-only ESM exports

v3 is `"type": "module"` with non-configurable exports, so
`vi.spyOn(core, 'warning')` throws `Cannot redefine property: warning`. Replace
the spy with a module mock that preserves the real implementations:

```ts
// top of the test file, after imports
vi.mock('@actions/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actions/core')>();
  return { ...actual, warning: vi.fn() };
});
```

Then in the test that asserted on the spy:

```ts
const warning = vi.mocked(core.warning);
warning.mockClear();
// … exercise code …
expect(warning).toHaveBeenCalledOnce();
```

Spreading `...actual` keeps `core.info`, `core.getInput`, etc. working for the
source under test; only `warning` becomes an assertable spy. The mock is scoped
to that one test file, so other tests using `core` are unaffected. Rebuild
`dist/` afterward (`@actions/core` is bundled).

## TypeScript 6 — no longer blocked

The build used to run `@vercel/ncc`, which drove the TypeScript compiler and
forced `outDir` without a `rootDir`; TypeScript 6 promotes that to a fatal
`TS5011`, so `pnpm build` failed and `typescript` was pinned to `^5.x`. The
bundler is now **esbuild** (`scripts/build.mjs`), which transpiles with its own
Go compiler and never invokes `tsc`, so it no longer gates TypeScript upgrades.
A `typescript` major bump now just needs `pnpm typecheck` (`tsc --noEmit`) to
pass; rebuild `dist/` (`pnpm build`) and merge it like any other dep bump.

## Vite peer for Vitest 4

Vitest 4 requires `vite@^6 || ^7 || ^8`. `vite` is only an auto-installed peer
here (not imported directly), and pnpm reuses the old Vite 5 resolution even
after a fresh `--force` install or a `pnpm.overrides` entry. The reliable fix is
to declare it explicitly:

```sh
pnpm add -D "vite@^7"
```

This is non-user-facing (Vite/Vitest are test-only; the shipped action is the
esbuild bundle, which doesn't use Vite).

## Useful gh commands

```sh
gh pr list --repo lsst-sqre/docverse-upload --author "app/dependabot" --state open \
  --json number,title,mergeable,mergeStateStatus
gh pr checks <n> --repo lsst-sqre/docverse-upload
gh run view --log-failed <runId> --repo lsst-sqre/docverse-upload
gh run list --repo lsst-sqre/docverse-upload --branch <branch> --limit 3 \
  --json status,conclusion,headSha,databaseId
gh run watch <runId> --repo lsst-sqre/docverse-upload --interval 15 --exit-status
gh pr view <n> --repo lsst-sqre/docverse-upload --json mergeable,mergeStateStatus
gh pr merge <n> --repo lsst-sqre/docverse-upload --merge --delete-branch
gh pr comment <n> --repo lsst-sqre/docverse-upload --body "…"
```

Pushing manual commits to a Dependabot branch stops Dependabot from managing it
(so `@dependabot merge`/`rebase` comments no longer apply) — merge it yourself
with `gh pr merge`.
