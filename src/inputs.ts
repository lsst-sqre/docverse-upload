import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as core from '@actions/core';

const DEFAULT_BASE_URL = 'https://roundtable.lsst.cloud/docverse/api';
const DEFAULT_WAIT_TIMEOUT_MINUTES = 30;

export interface ActionInputs {
  org: string;
  project: string;
  dir: string;
  token: string;
  baseUrl: string;
  gitRef: string;
  alternateName: string | null;
  wait: boolean;
  waitForPublish: boolean;
  waitTimeoutMs: number;
  githubToken: string | null;
  commentOnPr: boolean;
}

export class InputError extends Error {}

export function resolveGitRef(env: NodeJS.ProcessEnv = process.env): string {
  const head = env.GITHUB_HEAD_REF?.trim();
  if (head) return head;
  const refName = env.GITHUB_REF_NAME?.trim();
  if (refName) return refName;
  return '';
}

function requiredString(name: string): string {
  const raw = core.getInput(name, { required: true });
  const value = raw.trim();
  if (!value) {
    throw new InputError(`Input \`${name}\` is required.`);
  }
  return value;
}

function optionalString(name: string): string | null {
  const raw = core.getInput(name);
  const value = raw.trim();
  return value === '' ? null : value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const lowered = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
  if (['false', '0', 'no', 'n'].includes(lowered)) return false;
  throw new InputError(`Input \`${name}\` must be a boolean (got "${raw}").`);
}

function parsePositiveNumber(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`Input \`${name}\` must be a positive number (got "${raw}").`);
  }
  return value;
}

export function parseInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const org = requiredString('org');
  const project = requiredString('project');
  const dir = resolve(requiredString('dir'));
  const token = requiredString('token');

  const baseUrlRaw = optionalString('base-url') ?? DEFAULT_BASE_URL;
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');

  let gitRef = optionalString('git-ref') ?? '';
  if (!gitRef) {
    gitRef = resolveGitRef(env);
  }
  if (!gitRef) {
    throw new InputError(
      'Could not determine `git-ref`. Set the `git-ref` input or run inside a GitHub Actions context that provides `GITHUB_HEAD_REF` or `GITHUB_REF_NAME`.',
    );
  }

  const alternateName = optionalString('alternate-name');
  const wait = parseBoolean('wait', true);
  const waitForPublish = parseBoolean('wait-for-publish', true);
  const waitTimeoutMinutes = parsePositiveNumber('wait-timeout', DEFAULT_WAIT_TIMEOUT_MINUTES);
  const waitTimeoutMs = Math.round(waitTimeoutMinutes * 60_000);

  const githubToken = optionalString('github-token');
  const commentOnPr = parseBoolean('comment-on-pr', true);

  validateDir(dir);

  return {
    org,
    project,
    dir,
    token,
    baseUrl,
    gitRef,
    alternateName,
    wait,
    waitForPublish,
    waitTimeoutMs,
    githubToken,
    commentOnPr,
  };
}

function validateDir(dir: string): void {
  if (!existsSync(dir)) {
    throw new InputError(`Input \`dir\` does not exist: ${dir}`);
  }
  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    throw new InputError(`Input \`dir\` is not a directory: ${dir}`);
  }
}
