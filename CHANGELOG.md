# Change log

<!-- scriv-insert-here -->

<a id='changelog-1.0.0'></a>
## 1.0.0 (2026-10-20)

### New features

- Initial release of `lsst-sqre/docverse-upload`, a native JavaScript (Node 24) GitHub Action that uploads a built documentation directory to [Docverse](https://github.com/lsst-sqre/docverse). The action tars the directory, creates a build, uploads the tarball to the presigned URL, marks the build as uploaded, and then polls the build-processing job and each `publish_edition` job until the editions are live. Built against the Docverse 1.0.0b11 API; requires a Docverse server at 1.0.0b1 or later.
- Builds are annotated with GitHub Actions provenance automatically. The build's `git_ref` defaults to `$GITHUB_HEAD_REF` on `pull_request` events and `$GITHUB_REF_NAME` otherwise, which is what Docverse uses to scope PR-preview editions.
- Optionally posts (and updates in place) a pull request comment linking to the updated editions when a `github-token` with `pull-requests: write` is provided. On `push` events the comment goes to every open PR for the branch.
- `completed_with_errors` is treated as success with a warning annotation per failed edition; publish failures and timeouts also warn rather than failing the step. Gate downstream steps on `job-status` and `publish-status` for strict behavior.
- Inputs: `org`, `project`, `dir`, and `token` (required); `base-url` (default `https://roundtable.lsst.cloud/docverse/api`), `git-ref`, `alternate-name`, `wait` (default `true`), `wait-for-publish` (default `true`), `wait-timeout` (seconds, default `1800`), `github-token`, and `comment-on-pr` (default `true`).
- Outputs: `build-id`, `build-url`, `published-url` (the primary updated edition: the one tracking the build's `git_ref`, else `main`, else first by slug), `job-status`, `publish-status` (`published`, `failed`, `timed-out`, or `skipped`), and `editions-json` (array of `slug`, `title`, `kind`, `published_url`, `publish_status`).
