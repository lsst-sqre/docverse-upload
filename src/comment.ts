import type { ActionInputs } from './inputs.js';
import { extractFailedSlugs, extractSkippedSlugs, type UploadOutcome } from './outputs.js';

/**
 * Hidden HTML marker used to find-and-update the action's own comment on a PR.
 *
 * The marker is scoped by **server host** in addition to `{org}/{project}` so a
 * repository that uploads the same project to two Docverse deployments (e.g. a
 * dev server during development and the production org) gets one comment per
 * deployment instead of the two builds clobbering each other's comment.
 */
export function commentMarker(baseUrl: string, org: string, project: string): string {
  const host = new URL(baseUrl).host;
  return `<!-- docverse:pr-comment:${host}:${org}/${project} -->`;
}

const HEADING = '### Documentation preview';
const EM_DASH = '—';

/**
 * Render the Markdown body of the PR comment from the upload outcome. Pure: no
 * I/O, so it is exercised entirely by snapshot tests. The leading `marker`
 * line lets {@link ./github.ts!postOrUpdateComment} recognize and update the
 * comment in place on subsequent runs.
 */
export function renderCommentBody(
  marker: string,
  outcome: UploadOutcome,
  inputs: ActionInputs,
): string {
  const { build, job, editions, publishStatus } = outcome;
  const status = job?.status ?? 'completed';
  const project = `${inputs.org}/${inputs.project}`;
  const lines: string[] = [marker, HEADING, ''];

  if (status === 'failed' || status === 'cancelled') {
    lines.push(`Build \`${build.id}\` for \`${project}\` did not complete — status \`${status}\`.`);
    return lines.join('\n');
  }

  const sorted = [...editions].sort((a, b) => a.slug.localeCompare(b.slug));

  if (sorted.length > 0) {
    lines.push('| Edition | URL |');
    lines.push('| ------- | --- |');
    for (const entry of sorted) {
      lines.push(`| \`${entry.slug}\` | ${entry.published_url ?? EM_DASH} |`);
    }
    lines.push('');
  } else {
    lines.push(`No editions were updated by build \`${build.id}\`.`);
    lines.push('');
  }

  if (status === 'completed_with_errors') {
    appendNotUpdatedDetails(lines, job);
  }

  if (sorted.length > 0 && publishStatus !== 'published') {
    lines.push(
      `> **Note:** publishing status is \`${publishStatus}\`; links may 404 until the editions finish publishing.`,
    );
    lines.push('');
  }

  lines.push(
    status === 'completed_with_errors'
      ? `Build \`${build.id}\` completed with errors.`
      : `Build \`${build.id}\` processed successfully.`,
  );
  return lines.join('\n');
}

/**
 * Append a collapsible `<details>` block listing editions that failed or were
 * skipped during a partial (`completed_with_errors`) build. Emits nothing when
 * neither list has entries.
 */
function appendNotUpdatedDetails(lines: string[], job: UploadOutcome['job']): void {
  const failed = extractFailedSlugs(job);
  const skipped = extractSkippedSlugs(job);
  if (failed.length === 0 && skipped.length === 0) {
    return;
  }

  lines.push('<details>');
  lines.push('<summary>Some editions did not update cleanly</summary>');
  lines.push('');
  if (failed.length > 0) {
    lines.push('**Failed:**');
    lines.push('');
    for (const slug of failed) {
      lines.push(`- \`${slug}\``);
    }
    lines.push('');
  }
  if (skipped.length > 0) {
    lines.push('**Skipped:**');
    lines.push('');
    for (const slug of skipped) {
      lines.push(`- \`${slug}\``);
    }
    lines.push('');
  }
  lines.push('</details>');
  lines.push('');
}
