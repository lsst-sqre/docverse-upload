### Other changes

- The `Release` workflow no longer runs `scriv collect` itself. Collecting the changelog entry into `CHANGELOG.md` is now a documented prerequisite of tagging a release, and the workflow fails if uncollected fragments remain in `changelog.d/` or `CHANGELOG.md` has no non-empty section for the tagged version. The floating `vX` tag is only updated after these checks pass.
