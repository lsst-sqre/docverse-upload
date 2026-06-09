### New features

- Follow the HATEOAS links Docverse embeds in its responses instead of regex-parsing IDs out of them and rebuilding API paths. The action now follows the build's `queue_url`, the progress `queue_job_url` for publish jobs, and the progress `edition_url` for updated editions, falling back to path reconstruction when a link is absent (e.g. against a server that does not embed them). The Gafaelfawr bearer token is attached only to same-origin links so it never leaks to a host the action did not configure.
