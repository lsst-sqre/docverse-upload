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
| `wait-timeout`   | no       | `30`                                               | Maximum minutes to wait for the queue job to reach a terminal state. |

## Outputs

| Output          | Description |
| --------------- | ----------- |
| `build-id`      | Crockford Base32 build ID. |
| `build-url`     | HATEOAS `self_url` of the build resource. |
| `published-url` | First `published_url` among the updated editions, sorted by slug ASC. |
| `job-status`    | Terminal queue-job status (`completed`, `completed_with_errors`, `failed`, `cancelled`) — or `queued` when `wait: false`. |
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

> Note: posting a PR comment with the preview URL is **not yet implemented**. Read the output of the action (`published-url`) and post the comment from a downstream step if needed.

## Development

```bash
pnpm install
pnpm generate-types   # rebuild generated/api-types.ts from openapi.json
pnpm test             # vitest
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome ci .
pnpm build            # bundle to dist/index.js via ncc
```

The repository commits both `generated/api-types.ts` and `dist/index.js`. CI rebuilds them and runs `git diff --exit-code` to fail PRs that haven't been updated.

### Updating the OpenAPI spec

1. Drop a fresh upstream spec into the repo root as `docverse-openapi.json` (or any path).
2. Run `pnpm prep-openapi` to rewrite the paths (strip the `/docverse/api` prefix) and write `openapi.json`.
3. Run `pnpm generate-types && pnpm build`.
4. Commit `openapi.json`, `generated/api-types.ts`, and `dist/index.js` together so the diff is reviewable.

### Releasing

1. Add a `changelog.d/<topic>.md` fragment summarizing the change.
2. Merge to `main`.
3. Tag `vX.Y.Z`. The `Release` workflow rebuilds, runs `uvx scriv collect`, updates the floating `vX` tag via `nowactions/update-majorver`, and creates a GitHub Release with the collected notes.
