import type { components } from '#generated/api-types';

export type BuildAnnotations = components['schemas']['BuildAnnotations'];

/**
 * Detect build provenance from GitHub Actions environment variables. Returns
 * `null` outside of GitHub Actions (`GITHUB_ACTIONS !== "true"`).
 */
export function detectGithubActionsAnnotations(
  env: NodeJS.ProcessEnv = process.env,
): BuildAnnotations | null {
  if (env.GITHUB_ACTIONS !== 'true') {
    return null;
  }

  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const runUrl = repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;

  const annotations: Record<string, string | null | undefined> = {
    commit_sha: env.GITHUB_SHA,
    github_repository: repository,
    github_run_id: runId,
    github_run_url: runUrl,
    github_run_attempt: env.GITHUB_RUN_ATTEMPT,
    github_workflow: env.GITHUB_WORKFLOW,
    github_actor: env.GITHUB_ACTOR,
    github_event_name: env.GITHUB_EVENT_NAME,
    ci_platform: 'github-actions',
  };

  return omitEmpty(annotations);
}

function omitEmpty(values: Record<string, string | null | undefined>): BuildAnnotations {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out as BuildAnnotations;
}
