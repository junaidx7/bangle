import type { GithubRepoConfig } from './github-api';

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

export type ParseRepoResult =
  | { ok: true; value: Omit<GithubRepoConfig, 'branch'> }
  | { ok: false; reason: string };

/**
 * Accepts what someone actually has on hand — a browser URL, a clone URL, or
 * plain `owner/repo` — rather than demanding one canonical form.
 */
export function parseRepoInput(raw: string): ParseRepoResult {
  const input = raw.trim();
  if (!input) {
    return { ok: false, reason: 'Enter a repository' };
  }

  let candidate = input;

  if (candidate.startsWith('git@github.com:')) {
    candidate = candidate.slice('git@github.com:'.length);
  } else if (/^https?:\/\//.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return { ok: false, reason: 'Not a valid URL' };
    }
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return {
        ok: false,
        reason: 'Only github.com repositories are supported',
      };
    }
    // Keep just the first two segments so a deep link such as
    // /owner/repo/tree/main/notes still resolves to the repo.
    candidate = url.pathname
      .replace(/^\//, '')
      .split('/')
      .slice(0, 2)
      .join('/');
  }

  candidate = candidate.replace(/\.git$/, '').replace(/\/$/, '');

  if (!OWNER_REPO.test(candidate)) {
    return { ok: false, reason: 'Use the format owner/repository' };
  }

  const [owner, repo] = candidate.split('/');
  if (!owner || !repo) {
    return { ok: false, reason: 'Use the format owner/repository' };
  }

  return { ok: true, value: { owner, repo } };
}
