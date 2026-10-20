### Backwards-incompatible changes

- Refresh the vendored Docverse OpenAPI spec and generated types from the deployed server (Docverse 1.0.0b11), adopting the DM-55551 API contract polish: the de-mangled `Edition` schema name, route-named operationIds, and the documented `ErrorModel` error bodies. Requires a Docverse server at 1.0.0b1 or later.
- Stop sending the deprecated `content_hash` field when creating a build. Docverse now computes the build's content identity server-side from the uploaded files, so the action no longer hashes the tarball on the client.
- The `wait-timeout` input is now in seconds (default `1800`) instead of minutes, matching the units used by other GitHub Actions. A workflow that set `wait-timeout: 30` previously waited 30 minutes and now waits 30 seconds; multiply existing values by 60.
- The `published-url` output now points at the primary updated edition rather than the first `published_url` by slug: the edition tracking the build's `git_ref` (and `alternate_name`) wins, then the `main` edition, then the first by slug ASC. For single-edition builds the value is unchanged; for a release tag on a semver project it now names the tag's edition rather than the lowest-sorting aggregate.

### Other changes

- `editions-json` entries now carry the server's `kind` and `publish_status` alongside `slug`, `title`, and `published_url`, and the step summary marks the primary edition.
- Type Docverse error bodies (`ErrorModel` for 403/404/409, `HTTPValidationError` for 422) from the generated OpenAPI types when formatting error messages.
- Add an end-to-end smoke test to CI that runs the action against the roundtable-dev Docverse server and verifies the published site.
