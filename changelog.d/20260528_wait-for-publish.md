### New features

- Add `wait-for-publish` input (default `true`): after build processing, wait for the
  `publish_edition` jobs so the edition is guaranteed live before the step returns.
- Add `publish-status` output (`published` / `failed` / `timed-out` / `skipped`) for
  downstream gating. Publish failures and timeouts warn rather than failing the step.
