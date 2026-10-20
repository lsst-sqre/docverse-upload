### Backwards-incompatible changes

- Refresh the vendored Docverse OpenAPI spec and generated types from the deployed server (Docverse 1.0.0b11), adopting the DM-55551 API contract polish: the de-mangled `Edition` schema name, route-named operationIds, and the documented `ErrorModel` error bodies. Requires a Docverse server at 1.0.0b1 or later.
- Stop sending the deprecated `content_hash` field when creating a build. Docverse now computes the build's content identity server-side from the uploaded files, so the action no longer hashes the tarball on the client.

### Other changes

- Type Docverse error bodies (`ErrorModel` for 403/404/409, `HTTPValidationError` for 422) from the generated OpenAPI types when formatting error messages.
