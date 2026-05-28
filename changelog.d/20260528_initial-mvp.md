### New features

- Initial MVP of the `lsst-sqre/docverse-upload` GitHub Action.
- Implements the create-build → upload tarball → patch-uploaded → poll-queue-job flow.
- Auto-detects GitHub Actions provenance annotations and sends them with each build.
- Surfaces `build-id`, `build-url`, `published-url`, `job-status`, and `editions-json` outputs.
- Honors a `wait-timeout` input (default 30 minutes) with 1 s → 15 s exponential backoff.
- Treats `completed_with_errors` as success, emitting a warning annotation per failed edition.
