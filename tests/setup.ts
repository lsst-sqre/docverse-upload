import { afterEach, beforeEach } from 'vitest';

const SNAPSHOT_KEYS = [
  'INPUT_ORG',
  'INPUT_PROJECT',
  'INPUT_DIR',
  'INPUT_TOKEN',
  'INPUT_BASE-URL',
  'INPUT_GIT-REF',
  'INPUT_ALTERNATE-NAME',
  'INPUT_WAIT',
  'INPUT_WAIT-TIMEOUT',
  'GITHUB_ACTIONS',
  'GITHUB_HEAD_REF',
  'GITHUB_REF_NAME',
  'GITHUB_SHA',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_URL',
  'GITHUB_WORKFLOW',
  'GITHUB_ACTOR',
  'GITHUB_EVENT_NAME',
  'GITHUB_SERVER_URL',
  'GITHUB_OUTPUT',
  'GITHUB_STEP_SUMMARY',
];

const snapshot = new Map<string, string | undefined>();

beforeEach(() => {
  snapshot.clear();
  for (const key of SNAPSHOT_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});
