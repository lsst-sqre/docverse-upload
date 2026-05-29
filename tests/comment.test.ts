import { describe, expect, it } from 'vitest';
import type { Build, QueueJob } from '../src/client.js';
import { commentMarker, renderCommentBody } from '../src/comment.js';
import type { ActionInputs } from '../src/inputs.js';
import type { EditionEntry, PublishStatus, UploadOutcome } from '../src/outputs.js';

const MARKER = '<!-- docverse:pr-comment:example.test:rubin/docs -->';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    org: 'rubin',
    project: 'docs',
    dir: '/tmp/docs',
    token: 'gt-test',
    baseUrl: 'https://example.test/docverse/api',
    gitRef: 'tickets/DM-1',
    alternateName: null,
    wait: true,
    waitForPublish: true,
    waitTimeoutMs: 30 * 60_000,
    githubToken: 'ghs-test',
    commentOnPr: true,
    ...overrides,
  };
}

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    self_url: 'https://example.test/docverse/api/orgs/rubin/projects/docs/builds/01HQ-3KBR-T5GN-8W',
    project_url: 'https://example.test/docverse/api/orgs/rubin/projects/docs',
    id: '01HQ-3KBR-T5GN-8W',
    git_ref: 'tickets/DM-1',
    alternate_name: null,
    content_hash: `sha256:${'0'.repeat(64)}`,
    status: 'completed',
    upload_url: null,
    queue_url: null,
    object_count: 3,
    total_size_bytes: 1024,
    uploader: 'tester',
    annotations: null,
    date_created: '2026-05-28T00:00:00Z',
    date_uploaded: '2026-05-28T00:01:00Z',
    date_completed: '2026-05-28T00:02:00Z',
    ...overrides,
  } as Build;
}

function makeJob(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    self_url: 'https://example.test/docverse/api/queue/jobs/J',
    id: 'J',
    kind: 'build_processing',
    status: 'completed',
    phase: 'complete',
    progress: null,
    errors: null,
    date_created: '2026-05-28T00:01:00Z',
    date_started: '2026-05-28T00:01:01Z',
    date_completed: '2026-05-28T00:02:00Z',
    keeper_sync_run_id: null,
    subject_label: null,
    ...overrides,
  } as QueueJob;
}

function makeOutcome(parts: {
  job?: QueueJob | null;
  editions?: EditionEntry[];
  publishStatus?: PublishStatus;
  build?: Build;
}): UploadOutcome {
  return {
    build: parts.build ?? makeBuild(),
    job: parts.job ?? makeJob(),
    editions: parts.editions ?? [],
    publishStatus: parts.publishStatus ?? 'published',
  };
}

describe('commentMarker', () => {
  it('scopes the marker by server host, org, and project', () => {
    expect(commentMarker('https://example.test/docverse/api', 'rubin', 'docs')).toBe(
      '<!-- docverse:pr-comment:example.test:rubin/docs -->',
    );
  });

  it('includes the port in the host so dev servers do not collide', () => {
    expect(commentMarker('http://localhost:8080/docverse/api', 'rubin', 'docs')).toBe(
      '<!-- docverse:pr-comment:localhost:8080:rubin/docs -->',
    );
  });

  it('distinguishes two deployments of the same org/project', () => {
    const dev = commentMarker('https://dev.example.test/docverse/api', 'rubin', 'docs');
    const prod = commentMarker('https://roundtable.lsst.cloud/docverse/api', 'rubin', 'docs');
    expect(dev).not.toBe(prod);
  });
});

describe('renderCommentBody', () => {
  it('renders a success table for multiple editions', () => {
    const outcome = makeOutcome({
      editions: [
        { slug: 'main', published_url: 'https://docs.example/' },
        { slug: 'tickets-DM-1', published_url: 'https://docs.example/v/tickets-DM-1/' },
      ],
    });
    expect(renderCommentBody(MARKER, outcome, makeInputs())).toMatchInlineSnapshot(`
      "<!-- docverse:pr-comment:example.test:rubin/docs -->
      ### Docverse documentation preview

      | Edition | URL |
      | ------- | --- |
      | \`main\` | https://docs.example/ |
      | \`tickets-DM-1\` | https://docs.example/v/tickets-DM-1/ |

      Build \`01HQ-3KBR-T5GN-8W\` processed successfully."
    `);
  });

  it('sorts editions by slug and renders an em dash for missing URLs', () => {
    const outcome = makeOutcome({
      editions: [
        { slug: 'tickets-DM-1', published_url: 'https://docs.example/v/tickets-DM-1/' },
        { slug: 'main' },
      ],
    });
    expect(renderCommentBody(MARKER, outcome, makeInputs())).toMatchInlineSnapshot(`
      "<!-- docverse:pr-comment:example.test:rubin/docs -->
      ### Docverse documentation preview

      | Edition | URL |
      | ------- | --- |
      | \`main\` | — |
      | \`tickets-DM-1\` | https://docs.example/v/tickets-DM-1/ |

      Build \`01HQ-3KBR-T5GN-8W\` processed successfully."
    `);
  });

  it('notes a non-published publish status', () => {
    const outcome = makeOutcome({
      editions: [{ slug: 'main', published_url: 'https://docs.example/' }],
      publishStatus: 'timed-out',
    });
    expect(renderCommentBody(MARKER, outcome, makeInputs())).toMatchInlineSnapshot(`
      "<!-- docverse:pr-comment:example.test:rubin/docs -->
      ### Docverse documentation preview

      | Edition | URL |
      | ------- | --- |
      | \`main\` | https://docs.example/ |

      > **Note:** publishing status is \`timed-out\`; links may 404 until the editions finish publishing.

      Build \`01HQ-3KBR-T5GN-8W\` processed successfully."
    `);
  });

  it('reports no editions updated', () => {
    const outcome = makeOutcome({ editions: [] });
    expect(renderCommentBody(MARKER, outcome, makeInputs())).toMatchInlineSnapshot(`
      "<!-- docverse:pr-comment:example.test:rubin/docs -->
      ### Docverse documentation preview

      No editions were updated by build \`01HQ-3KBR-T5GN-8W\`.

      Build \`01HQ-3KBR-T5GN-8W\` processed successfully."
    `);
  });

  it('reports a failed job without a table', () => {
    const outcome = makeOutcome({
      build: makeBuild({ status: 'failed' }),
      job: makeJob({ status: 'failed', phase: 'editions' }),
      editions: [],
    });
    expect(renderCommentBody(MARKER, outcome, makeInputs())).toMatchInlineSnapshot(`
      "<!-- docverse:pr-comment:example.test:rubin/docs -->
      ### Docverse documentation preview

      Build \`01HQ-3KBR-T5GN-8W\` for \`rubin/docs\` did not complete — status \`failed\`."
    `);
  });

  it('renders a details block for completed_with_errors', () => {
    const outcome = makeOutcome({
      job: makeJob({
        status: 'completed_with_errors',
        progress: {
          editions_updated: [{ slug: 'main', action: 'updated' }],
          editions_failed: [{ slug: 'tickets-DM-9' }],
          editions_skipped: [{ slug: 'v1' }],
        },
      }),
      editions: [{ slug: 'main', published_url: 'https://docs.example/' }],
    });
    expect(renderCommentBody(MARKER, outcome, makeInputs())).toMatchInlineSnapshot(`
      "<!-- docverse:pr-comment:example.test:rubin/docs -->
      ### Docverse documentation preview

      | Edition | URL |
      | ------- | --- |
      | \`main\` | https://docs.example/ |

      <details>
      <summary>Some editions did not update cleanly</summary>

      **Failed:**

      - \`tickets-DM-9\`

      **Skipped:**

      - \`v1\`

      </details>

      Build \`01HQ-3KBR-T5GN-8W\` completed with errors."
    `);
  });
});
