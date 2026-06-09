---
name: dependabot-merge
description: Process the open Dependabot PRs on lsst-sqre/docverse-upload to get them merged — bring each branch up to date, rebuild the bundled dist/, fix the action code for new dependency versions, and merge when CI is green. Use when asked to merge/clear/process Dependabot PRs, handle dependency-update PRs, or "deal with dependabot" in this repo.
---

# Dependabot merge loop

Drive every open Dependabot PR on `lsst-sqre/docverse-upload` to **merged**.
Auto-merge each PR once CI is green. For a PR whose update would cause
user-facing behavior changes, or that's blocked by a toolchain
incompatibility, leave an explanatory comment and move on. Stop the loop only
when nothing but those genuinely-unmergeable PRs remain.

## What the automation already does

Three Dependabot workflows now handle the routine cases on their own:

- `.github/workflows/dependabot-build.yml` rebuilds and commits `generated/` +
  `dist/` on **every** Dependabot PR (pushed by the org GitHub App so the new
  commit gets a fresh CI run).
- `.github/workflows/dependabot-label.yml` applies a
  `dependencies-{major,minor,patch}` label from `dependabot/fetch-metadata`.
- `.github/workflows/dependabot-auto-merge.yml` enables squash auto-merge once
  CI is green **and** the label is `dependencies-patch`/`dependencies-minor`.

So patch/minor bumps rebuild `dist/`, go green, and merge themselves. **This
skill is for the leftovers:**

- `dependencies-major` PRs — labeled and rebuilt, but the fail-closed allowlist
  blocks their auto-merge by design (manual review).
- PRs where the new dependency version needs **code changes** — CI stays red
  even after the bot's `dist/` rebuild, so auto-merge never fires.

## Repo context you must know

This repo is a GitHub Action bundled with `@vercel/ncc` into `dist/`. CI
(`.github/workflows/ci.yml`) ends with a **"Verify generated/ and dist/ are up
to date"** step (`git diff --exit-code generated/ dist/`).

Any bump to a *runtime* dependency (anything in `package.json` `dependencies`,
e.g. `@actions/core`, `openapi-fetch`, `tar`) needs a rebuilt `dist/` or it
fails that step. The `dependabot-build` workflow normally does this rebuild
automatically — **the bot may have already pushed a `dist/` rebuild commit to
the branch.** So `git pull` (or fetch + reset) before working, and don't
blindly re-rebuild: if `dist/` is already in sync, CI is red for some *other*
reason (a code change the new version needs). Dev-only bumps usually don't
touch `dist/` at all.

## Per-PR workflow

1. List blocked work — open Dependabot PRs that did **not** auto-merge, with
   their semver label:
   `gh pr list --repo lsst-sqre/docverse-upload --author "app/dependabot" --state open --json number,title,labels,mergeable,mergeStateStatus`.
   Expect mostly `dependencies-major` PRs and PRs whose CI is red after the
   bot's rebuild; patch/minor PRs with green CI are already auto-merging.
2. Read the failure: `gh pr checks <n>`, then `gh run view --log-failed <runId>`.
3. `git fetch origin && git checkout <branch> && git pull` (pick up any `dist/`
   commit the bot already pushed), then `pnpm install --frozen-lockfile`.
4. Run the local CI gate: `bash .claude/skills/dependabot-merge/scripts/ci-local.sh`. It runs the exact CI sequence and stops at the first failing step.
5. Fix the failing step (see **Known fix patterns**). Rebuilding `dist/` is `pnpm generate-types && pnpm build`.
6. Re-run the gate until clean, then `git add -A`, commit, and push to the Dependabot branch (`git push` or `--force-with-lease` after a rebase).
7. Confirm CI: `gh run watch <runId> --exit-status`. When `gh pr view <n>` shows `MERGEABLE`/`CLEAN`, merge: `gh pr merge <n> --merge --delete-branch`.

## Known fix patterns

| Symptom in CI | Cause | Fix |
|---|---|---|
| `generated/ or dist/ is out of sync` | runtime dep bumped, bundle not rebuilt | `pnpm generate-types && pnpm build`, commit `dist/` (+ `generated/` if `openapi.json` changed) |
| Biome: `schema version does not match` / unknown key `ignore`/`organizeImports` | Biome major bump | `pnpm biome migrate --write`, then `pnpm biome check --write .` to apply the new import ordering across src/tests |
| Test: `Cannot redefine property: warning` (`vi.spyOn(core, …)`) | `@actions/core` v3 ships read-only ESM exports | replace the spy with a module mock — see [REFERENCE.md](REFERENCE.md) |
| Test startup: `ERR_PACKAGE_PATH_NOT_EXPORTED: ./module-runner` | Vitest 4 needs Vite ≥6 but pnpm's auto-peer is stuck at Vite 5 | add an explicit `vite` devDependency (`pnpm add -D "vite@^7"`); a `pnpm.overrides` entry alone does **not** force the peer to re-resolve |
| Build: `TS5011 … rootDir must be explicitly set` under TypeScript 6 | **ncc + TS 6 incompatibility** — ncc forces `outDir` and strips `rootDir`; TS 6 makes this fatal. No tsconfig fix works | **Unmergeable.** If it's a grouped PR, revert just the TS bump in `package.json` so the rest lands; comment explaining the hold-back |

## Merge ordering (avoid dist/ conflicts)

Multiple PRs that each rebuild `dist/index.js` will conflict with each other
once one merges. After each merge, bring the next branch up to date:

- Small/clean case: `git rebase origin/main`, resolve `dist/` conflicts by
  **regenerating** (`pnpm install --frozen-lockfile && pnpm generate-types && pnpm build`, `git add`, `git rebase --continue`).
- When grouped/dev-dep changes have accumulated on `main` and the rebase is
  messy: `git reset --hard origin/main`, re-apply only the PR's essential change
  (the dependency bump + any code fix + rebuilt `dist/`), then `--force-with-lease`.

Validate (gate script) and confirm CI green before every merge.

## Details

- Test-mock conversion and full validation command list: [REFERENCE.md](REFERENCE.md)
