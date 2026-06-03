### New features

- Post (and update in place) a comment on the associated pull request linking to the editions a build updated. Enabled by passing a `github-token` input (typically `${{ github.token }}`, needs `pull-requests: write`); disabled by default when omitted.
- Add a `comment-on-pr` input (default `true`) so dev-server workflows can keep uploading while silencing their PR comments.
- Scope the comment's dedup marker by server host (`<!-- docverse:pr-comment:{host}:{org}/{project} -->`) so a repo that builds the same project to both a dev server and the production org gets one comment per deployment instead of clobbering.
- Discover the target PR(s) per SQR-112: the triggering PR on `pull_request`/`pull_request_target` events, and every open PR for the pushed branch on `push` events. Missing PR context, a disabled switch, or a 403 from a token lacking `pull-requests: write` warn rather than failing the step.
