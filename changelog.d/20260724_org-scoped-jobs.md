### Backwards-incompatible changes

- Adopt the org-scoped Docverse jobs API (DM-55550). The globally-addressable `GET /queue/jobs/{job}` endpoint is gone; the action now polls jobs at `GET /orgs/{org}/jobs/{job}` when it has to reconstruct a path, and follows the renamed HATEOAS links otherwise: the build's `queue_url` is now `job_url`, and the progress `publish_jobs[].queue_job_url` is now `job_url`. The vendored OpenAPI spec and generated types were regenerated from the updated server. Requires a Docverse server that serves the org-scoped jobs API (lsst-sqre/docverse#465).
