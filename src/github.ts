import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';

/** Hydrated octokit instance, as returned by `@actions/github`'s `getOctokit`. */
export type Octokit = ReturnType<typeof getOctokit>;

/**
 * Minimal structural view of `@actions/github`'s `context` — only the fields
 * PR discovery needs. Declaring it this way lets tests pass a plain object and
 * lets production pass the real `context` (which is a structural superset).
 */
export interface GithubContext {
  eventName: string;
  ref: string;
  repo: { owner: string; repo: string };
  payload: {
    pull_request?: { number: number } | undefined;
  };
}

/** Repository coordinates plus the PR numbers this run should comment on. */
export interface TargetPrs {
  owner: string;
  repo: string;
  prNumbers: number[];
}

/**
 * Determine which pull request(s) to comment on, following the SQR-112
 * discovery rules:
 *
 * - `pull_request` / `pull_request_target`: the triggering PR.
 * - `push`: every open PR whose head is the pushed branch (a branch can back
 *   more than one PR); none ⇒ skip.
 * - any other event (`workflow_dispatch`, `schedule`, …): skip.
 */
export async function resolveTargetPrs(
  octokit: Octokit,
  context: GithubContext,
): Promise<TargetPrs> {
  const { owner, repo } = context.repo;

  if (context.eventName === 'pull_request' || context.eventName === 'pull_request_target') {
    const number = context.payload.pull_request?.number;
    return { owner, repo, prNumbers: typeof number === 'number' ? [number] : [] };
  }

  if (context.eventName === 'push') {
    const branch = context.ref.replace(/^refs\/heads\//, '');
    const pulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: 'open',
    });
    return { owner, repo, prNumbers: pulls.map((pull) => pull.number) };
  }

  return { owner, repo, prNumbers: [] };
}

/**
 * Post the rendered comment on a PR, or update the action's existing comment in
 * place. The comment is identified by the hidden `marker` line so repeated runs
 * edit one comment instead of piling new ones up.
 *
 * A 403 (token lacks `pull-requests: write`) is downgraded to a warning and
 * swallowed: the upload already succeeded, so a commenting-permission gap must
 * never fail the step.
 */
export async function postOrUpdateComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
    });
    const existing = comments.find(
      (comment) => typeof comment.body === 'string' && comment.body.includes(marker),
    );

    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      core.info(`Updated Docverse preview comment on PR #${prNumber} (comment ${existing.id}).`);
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
      core.info(`Created Docverse preview comment on PR #${prNumber}.`);
    }
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 403) {
      core.warning(
        `Could not comment on PR #${prNumber}: GitHub returned 403. Grant the \`github-token\` \`pull-requests: write\` permission to enable PR comments.`,
      );
      return;
    }
    throw err;
  }
}
