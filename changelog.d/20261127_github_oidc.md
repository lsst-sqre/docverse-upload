### Backwards-incompatible changes

- The action now authenticates with GitHub Actions OIDC and the `token` input is removed. On each run the action requests an ID token from GitHub and exchanges it with Gafaelfawr for a short-lived token with the `exec:docverse` scope, following [SQR-120](https://sqr-120.lsst.io), so no Gafaelfawr token is stored in repository secrets. To migrate, remove `token` from the step, grant the job `id-token: write`, and make sure the repository has a GitHub project registered in the environment's Gafaelfawr with the `exec:docverse` scope and a bot user that holds the `uploader` role on the Docverse organization. A `token` input that is still set is ignored with a warning.

### New features

- Authentication failures explain what to fix. The step reports a missing `id-token: write` permission, a repository with no matching GitHub project registered in Gafaelfawr (including the repository, workflow, ref, and environment that Gafaelfawr saw in the ID token), a project that does not grant `exec:docverse`, and an environment where the token exchange is not enabled.
