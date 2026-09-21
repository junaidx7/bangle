import { afterAll, describe, expect, test } from 'vitest';
import { GithubApi } from '../github-api';
import { parseRepoInput } from '../parse-repo-input';

/**
 * Round-trips a real commit against a real repository.
 *
 * Skipped unless both env vars are set, because it needs a credential no test
 * fixture can stand in for and it writes to a real branch. It exists so the
 * one path unit tests cannot cover — that GitHub accepts the exact request
 * shapes this client builds — can be checked on demand:
 *
 *   BANGLE_GITHUB_TEST_REPO=owner/notes \
 *   BANGLE_GITHUB_TEST_TOKEN=github_pat_... \
 *   pnpm vitest run --configLoader runner packages/js-lib/github-api
 *
 * Everything it writes goes under a unique throwaway directory and is deleted
 * again in cleanup.
 */
const repoInput = process.env.BANGLE_GITHUB_TEST_REPO;
const token = process.env.BANGLE_GITHUB_TEST_TOKEN;
const branch = process.env.BANGLE_GITHUB_TEST_BRANCH ?? 'main';

const enabled = Boolean(repoInput && token);

// `describe.skipIf` still evaluates the callback body, so the repo is parsed
// lazily — the suite must import cleanly when the env vars are absent.
function makeApi(): GithubApi {
  const parsed = parseRepoInput(repoInput ?? '');
  if (!parsed.ok) {
    throw new Error(`BANGLE_GITHUB_TEST_REPO is not valid: ${parsed.reason}`);
  }
  return new GithubApi({
    owner: parsed.value.owner,
    repo: parsed.value.repo,
    branch,
    token: token ?? '',
  });
}

describe.skipIf(!enabled)('GithubApi (live)', () => {
  const api = enabled ? makeApi() : (undefined as unknown as GithubApi);

  const dir = `bangle-live-test-${Date.now()}`;
  const filePath = `${dir}/note.md`;
  const body = 'Round-trip check — em dash, 世界, 🎉\n';

  afterAll(async () => {
    if (!enabled) return;
    try {
      const head = await api.getHead();
      const present = (await api.listFiles()).some((e) => e.path === filePath);
      if (present) {
        await api.commitChanges({
          changes: [{ type: 'delete', path: filePath }],
          message: 'bangle: clean up live test',
          expectedHeadSha: head.commitSha,
        });
      }
    } catch {
      // Cleanup is best-effort; a leftover file in a test repo is not worth
      // failing an otherwise passing run over.
    }
  });

  test('verifies access to the repo and branch', async () => {
    const access = await api.verifyAccess();
    expect(access.branchExists).toBe(true);
    expect(access.canPush).toBe(true);
  });

  test('commits a file, reads it back byte-for-byte, then deletes it', async () => {
    const head = await api.getHead();
    const commit = await api.commitChanges({
      changes: [
        {
          type: 'write',
          path: filePath,
          bytes: new TextEncoder().encode(body),
        },
      ],
      message: 'bangle: live test write',
      expectedHeadSha: head.commitSha,
    });

    expect(commit.commitSha).not.toBe(head.commitSha);
    expect(commit.writtenShas[filePath]).toEqual(expect.any(String));

    const entry = (await api.listFiles()).find((e) => e.path === filePath);
    expect(entry).toBeDefined();
    expect(entry?.sha).toBe(commit.writtenShas[filePath]);

    const bytes = await api.readBlob(entry?.sha ?? '');
    expect(new TextDecoder().decode(bytes)).toBe(body);

    const afterWrite = await api.getHead();
    const deleted = await api.commitChanges({
      changes: [{ type: 'delete', path: filePath }],
      message: 'bangle: live test delete',
      expectedHeadSha: afterWrite.commitSha,
    });

    expect(deleted.commitSha).not.toBe(afterWrite.commitSha);
    expect((await api.listFiles()).some((e) => e.path === filePath)).toBe(
      false,
    );
  });

  test('a stale head sha is rejected rather than force-pushed', async () => {
    const head = await api.getHead();
    await expect(
      api.commitChanges({
        changes: [
          {
            type: 'write',
            path: `${dir}/stale.md`,
            bytes: new Uint8Array([1]),
          },
        ],
        message: 'bangle: should not land',
        // A sha that is well-formed but is not the current head.
        expectedHeadSha: '0000000000000000000000000000000000000000',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect((await api.getHead()).commitSha).toBe(head.commitSha);
  });
});
