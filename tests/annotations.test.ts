import { describe, expect, it } from 'vitest';
import { detectGithubActionsAnnotations } from '../src/annotations.js';

describe('detectGithubActionsAnnotations', () => {
  it('returns null when not running in GitHub Actions', () => {
    expect(detectGithubActionsAnnotations({})).toBeNull();
  });

  it('populates the standard 9 fields from env', () => {
    const annotations = detectGithubActionsAnnotations({
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'deadbeef',
      GITHUB_REPOSITORY: 'lsst-sqre/foo',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW: 'docs',
      GITHUB_ACTOR: 'jonathansick',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SERVER_URL: 'https://github.example',
    });
    expect(annotations).toEqual({
      commit_sha: 'deadbeef',
      github_repository: 'lsst-sqre/foo',
      github_run_id: '42',
      github_run_url: 'https://github.example/lsst-sqre/foo/actions/runs/42',
      github_run_attempt: '1',
      github_workflow: 'docs',
      github_actor: 'jonathansick',
      github_event_name: 'push',
      ci_platform: 'github-actions',
    });
  });

  it('omits empty fields rather than emitting empty strings', () => {
    const annotations = detectGithubActionsAnnotations({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'lsst-sqre/foo',
    });
    expect(annotations).toEqual({
      github_repository: 'lsst-sqre/foo',
      ci_platform: 'github-actions',
    });
  });
});
