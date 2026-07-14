# docverse-upload

GitHub Action that uploads a built documentation directory to [Docverse](https://github.com/lsst-sqre/docverse) — the in-development successor to LSST the Docs.

The action is a **native JavaScript GitHub Action**: it runs directly on the runner's Node 24 without paying the `actions/setup-python` cost on every job.

## Quick start

```yaml
- uses: actions/checkout@v4

- name: Build documentation
  run: |
    pip install -r docs/requirements.txt
    sphinx-build -b html docs/ docs/_build/html

- uses: lsst-sqre/docverse-upload@v1
  with:
    org: rubin
    project: my-docs
    dir: docs/_build/html
    token: ${{ secrets.DOCVERSE_TOKEN }}
```

The action performs the full upload workflow:

1. Tars the directory and streams it through SHA-256.
2. `POST /orgs/{org}/projects/{project}/builds` to create a build resource.
3. `PUT` the tarball to the presigned URL returned by the server.
4. `PATCH` the build with `status: uploaded` to start processing.
5. Polls the queue job until it reaches a terminal state.
6. Polls each `publish_edition` job until the edition is live (unless `wait-for-publish: false`).

## Inputs

| Input            | Required | Default                                            | Description |
| ---------------- | -------- | -------------------------------------------------- | ----------- |
| `org`            | yes      | —                                                  | Docverse organization slug. |
| `project`        | yes      | —                                                  | Docverse project slug. |
| `dir`            | yes      | —                                                  | Path to the built documentation directory. |
| `token`          | yes      | —                                                  | Gafaelfawr bearer token, typically `${{ secrets.DOCVERSE_TOKEN }}`. |
| `base-url`       | no       | `https://roundtable.lsst.cloud/docverse/api`       | Docverse API base URL. |
| `git-ref`        | no       | `$GITHUB_HEAD_REF || $GITHUB_REF_NAME`             | Short branch/tag name sent as the build's `git_ref`. Correctly handles `pull_request` events. |
| `alternate-name` | no       | —                                                  | Alternate deployment name for scoped editions. |
| `wait`           | no       | `true`                                             | Wait for processing to complete. When `false`, the action returns right after PATCH. |
| `wait-for-publish` | no     | `true`                                             | After build processing, wait for the `publish_edition` jobs so the edition is live. Only effective when `wait: true`. Failures/timeouts warn rather than failing the step. |
| `wait-timeout`   | no       | `30`                                               | Maximum minutes to wait for the queue job to reach a terminal state. |
| `github-token`   | no       | —                                                  | GitHub token used to post (and update in place) a PR comment linking to the updated editions, typically `${{ github.token }}`. Requires `pull-requests: write`. Omitted ⇒ commenting disabled. |
| `comment-on-pr`  | no       | `true`                                             | Post the PR comment (`true`/`false`). When `false`, commenting is disabled even if `github-token` is set — for dev-server workflows that should keep uploading but stay silent on PRs. |

## Outputs

| Output          | Description |
| --------------- | ----------- |
| `build-id`      | Crockford Base32 build ID. |
| `build-url`     | HATEOAS `self_url` of the build resource. |
| `published-url` | First `published_url` among the updated editions, sorted by slug ASC. |
| `job-status`    | Terminal queue-job status (`completed`, `completed_with_errors`, `failed`, `cancelled`) — or `queued` when `wait: false`. |
| `publish-status`| Publish outcome: `published` (all editions live), `failed` (a publish job ended non-`completed`), `timed-out`, or `skipped` (`wait` off, `wait-for-publish` off, or no publish jobs). |
| `editions-json` | JSON array of the updated editions (`slug`, `title`, `published_url`), sorted by slug. |

The build-processing queue job reports the slugs it updated (`progress.editions_updated`) but not their public URLs — `published_url` lives on the edition resource. The action therefore fetches each updated edition to resolve `published-url` and `editions-json`.

`completed_with_errors` is treated as **success** for the step result; the action emits a `core.warning()` annotation summarizing the job errors. Workflows that need strict behavior should gate downstream steps on `job-status == 'completed'`.

## Authentication

The action authenticates to Docverse with a [Gafaelfawr](https://gafaelfawr.lsst.io) bearer token. The token must hold the `uploader` role on the target organization. Store it in a repo or org secret and pass it as the `token` input — typically `${{ secrets.DOCVERSE_TOKEN }}`.

The token is sent only to Docverse. The presigned-URL PUT to cloud storage runs without an Authorization header so the token never reaches the cloud provider.

## Common patterns

### Docs CI on push

```yaml
on: { push: { branches: [main] } }
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make html
      - uses: lsst-sqre/docverse-upload@v1
        with:
          org: rubin
          project: my-docs
          dir: build/html
          token: ${{ secrets.DOCVERSE_TOKEN }}
```

### PR docs preview

```yaml
on: { pull_request: {} }
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make html
      - uses: lsst-sqre/docverse-upload@v1
        with:
          org: rubin
          project: my-docs
          dir: build/html
          token: ${{ secrets.DOCVERSE_TOKEN }}
```

The action sends `$GITHUB_HEAD_REF` as the build's `git_ref` on `pull_request` events, which is what Docverse uses to scope PR-preview editions.

## Pull request comments

When `github-token` is set (and `comment-on-pr` is left at its `true` default), the action posts a comment on the associated pull request linking to every edition this build updated, and **updates that same comment in place** on each subsequent run instead of piling new comments up.

```yaml
on: { pull_request: {} }
permissions:
  contents: read
  pull-requests: write   # required for the github-token to comment
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make html
      - uses: lsst-sqre/docverse-upload@v1
        with:
          org: rubin
          project: my-docs
          dir: build/html
          token: ${{ secrets.DOCVERSE_TOKEN }}
          github-token: ${{ github.token }}
```

The comment renders a Markdown table of the updated editions and their published URLs. A failed/cancelled build reports the failure and build ID instead of a table; a partial build (`completed_with_errors`) lists failed and skipped editions in a collapsible block below the successful ones. When `publish-status` is not `published`, the comment notes that links may 404 until the editions finish publishing.

**PR discovery** mirrors the build's `git_ref` handling: on `pull_request`/`pull_request_target` events the triggering PR is used; on `push` events the action looks up every open PR whose head is the pushed branch (commenting on each); other events are skipped silently. A missing PR context, a `false` `comment-on-pr`, or a `github-token` that lacks `pull-requests: write` (the API returns 403) all degrade to a log line or warning — never a failed step, since the upload already succeeded.

**Update-in-place dedup.** The action finds its own comment via a hidden HTML marker at the top of the body:

```
<!-- docverse:pr-comment:{host}:{org}/{project} -->
```

The marker is scoped by **server host** as well as `{org}/{project}`. This is deliberate: during development the same repo/PR often uploads to both a dev Docverse *server* and the production *org* under the same `{org}/{project}` slug. Scoping by host (`new URL(base-url).host`, including any port) keeps the dev and prod comments as two separate, independently-updated comments instead of clobbering each other. Repositories that publish to multiple Docverse projects likewise get one comment per project.

Set `comment-on-pr: false` to keep uploading (e.g. from a dev-server workflow gathering data) while silencing the PR comments.

## Development

```bash
pnpm install
pnpm generate-types   # rebuild generated/api-types.ts from openapi.json
pnpm test             # vitest
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome ci .
pnpm build            # bundle to dist/ via esbuild (scripts/build.mjs)
```

The repository commits both `generated/api-types.ts` and the bundled `dist/`. CI rebuilds them and runs `git diff --exit-code` to fail PRs that haven't been updated.

### Updating the OpenAPI spec

1. Drop a fresh upstream spec into the repo root as `docverse-openapi.json` (or any path).
2. Run `pnpm prep-openapi` to rewrite the paths (strip the `/docverse/api` prefix) and write `openapi.json`.
3. Run `pnpm generate-types && pnpm build`.
4. Commit `openapi.json`, `generated/api-types.ts`, and the rebuilt `dist/` together so the diff is reviewable.

### Releasing

1. Add a `changelog.d/<topic>.md` fragment summarizing the change.
2. Merge to `main`.
3. Tag `vX.Y.Z`. The `Release` workflow rebuilds, runs `uvx scriv collect`, updates the floating `vX` tag via `nowactions/update-majorver`, and creates a GitHub Release with the collected notes.

### CI GitHub App (Rubin Squarebot)

The Dependabot automation workflows authenticate as the [**Rubin Squarebot** GitHub App](https://github.com/apps/rubin-squarebot) rather than the default `GITHUB_TOKEN`. Two workflows mint a short-lived App token via [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token):

- **`dependabot-build.yml`** rebuilds `generated/` + `dist/` on a Dependabot PR and pushes the result back to the PR branch. The push is made with the App token (not `GITHUB_TOKEN`) so it **re-triggers CI** — a `GITHUB_TOKEN` push would not, leaving CI's `git diff --exit-code` bundle gate stuck.
- **`dependabot-auto-merge.yml`** enables squash auto-merge for patch/minor Dependabot PRs once CI is green.

**Required configuration.** The App is identified by a non-sensitive client id and authenticated with a private key:

| Name | Kind | Used by |
| ---- | ---- | ------- |
| `CI_GH_APP_CLIENT_ID` | Actions **variable** (`vars`) | both workflows (available in every context) |
| `CI_GH_APP_PRIVATE_KEY` | **Dependabot** secret | `dependabot-build.yml` (Dependabot `pull_request` context) |
| `CI_GH_APP_PRIVATE_KEY` | **Actions** secret | `dependabot-auto-merge.yml` (`workflow_run` context, which cannot read Dependabot secrets) |

The private key must be stored in **both** secret stores under the same name: a `workflow_run`-triggered workflow reads the Actions secret store, while a Dependabot-triggered workflow reads the Dependabot secret store.
