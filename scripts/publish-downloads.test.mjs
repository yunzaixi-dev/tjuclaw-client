import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  validateSha,
  validateGitHubRepo,
  checkExistingRelease,
  validateReleaseAncestry,
  findSuccessfulWorkflowRuns,
  buildReleaseNotes,
  publishDownloads,
  TARGET_ASSET_NAMES,
  EXPECTED_GITHUB_REPO,
} from './publish-downloads.mjs';

test('validateSha enforces strict 40-character hexadecimal strings', () => {
  const valid = 'f254037f18dbd06f946043fe5a5ecf88da41806e';
  assert.equal(validateSha(valid), valid);
  assert.throws(() => validateSha(''), /Invalid source_sha/);
  assert.throws(() => validateSha('0123456789abcdef'), /Invalid source_sha/);
  assert.throws(() => validateSha(valid.toUpperCase()), /Invalid source_sha/);
  assert.throws(() => validateSha(`${valid}\n`), /Invalid source_sha/);
});

test('validateGitHubRepo strictly allows only yunzaixi-dev/tjuclaw-client', () => {
  assert.equal(validateGitHubRepo(EXPECTED_GITHUB_REPO), EXPECTED_GITHUB_REPO);
  assert.throws(() => validateGitHubRepo('yunzaixi-dev/tjuclaw'), /Invalid GITHUB_REPOSITORY/);
  assert.throws(() => validateGitHubRepo('other/repo'), /Invalid GITHUB_REPOSITORY/);
  assert.throws(() => validateGitHubRepo(''), /Invalid GITHUB_REPOSITORY/);
});

test('checkExistingRelease rejects existing releases or existing tags to refuse overwrite', async () => {
  const repo = EXPECTED_GITHUB_REPO;
  const tag = 'v0.0.25';

  // 1. Release exists (200) -> throws
  const mockFetchReleaseExists = async (url) => {
    if (url.includes(`/releases/tags/${tag}`)) {
      return { status: 200, ok: true };
    }
    return { status: 404, ok: false };
  };

  await assert.rejects(
    () => checkExistingRelease(tag, repo, 'token', mockFetchReleaseExists),
    /Release with tag "v0.0.25" already exists. Refusing to overwrite immutable release./
  );

  // 2. Tag exists (200) -> throws
  const mockFetchTagExists = async (url) => {
    if (url.includes(`/releases/tags/${tag}`)) {
      return { status: 404, ok: false };
    }
    if (url.includes(`/git/ref/tags/${tag}`)) {
      return { status: 200, ok: true };
    }
    return { status: 404, ok: false };
  };

  await assert.rejects(
    () => checkExistingRelease(tag, repo, 'token', mockFetchTagExists),
    /Git tag "v0.0.25" already exists. Refusing to overwrite immutable release./
  );

  // 3. Neither exists (404) -> passes
  const mockFetchNone = async () => ({ status: 404, ok: false });
  await assert.doesNotReject(() => checkExistingRelease('v9.9.9', repo, 'token', mockFetchNone));
});

test('validateReleaseAncestry rejects commits not on release ancestry', async () => {
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const repo = EXPECTED_GITHUB_REPO;

  // Behind -> valid
  const mockBehind = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'behind' }),
  });
  await assert.doesNotReject(() => validateReleaseAncestry(sourceSha, repo, 'token', { fetchFn: mockBehind }));

  // Ahead / diverged -> rejects
  const mockAhead = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'ahead' }),
  });
  await assert.rejects(
    () => validateReleaseAncestry(sourceSha, repo, 'token', { fetchFn: mockAhead }),
    /is not on release branch ancestry/
  );
});

test('findSuccessfulWorkflowRuns verifies CI and Windows Installer succeed and all required jobs pass', async () => {
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const repo = EXPECTED_GITHUB_REPO;
  let includeAppleJobs = true;

  const mockFetchSuccess = async (url) => {
    if (url.includes('/actions/runs?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow_runs: [
            {
              id: 100,
              name: 'CI',
              event: 'push',
              head_branch: 'release',
              head_sha: sourceSha,
              head_repository: { full_name: repo },
              status: 'completed',
              conclusion: 'success',
              jobs_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/100/jobs',
              artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/100/artifacts',
            },
            {
              id: 101,
              name: 'Windows Installer',
              event: 'push',
              head_branch: 'release',
              head_sha: sourceSha,
              head_repository: { full_name: repo },
              status: 'completed',
              conclusion: 'success',
              jobs_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/101/jobs',
              artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/101/artifacts',
            },
          ],
        }),
      };
    }
    if (url.includes('/runs/100/jobs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [
            { name: 'Build Linux amd64 Debian package', status: 'completed', conclusion: 'success' },
            { name: 'Build Android debug arm64 APK', status: 'completed', conclusion: 'success' },
            ...(includeAppleJobs ? [
              { name: 'Build unsigned universal macOS app', status: 'completed', conclusion: 'success' },
              { name: 'Compile unsigned iOS device and simulator archives', status: 'completed', conclusion: 'success' },
            ] : []),
            { name: 'Portable checks', status: 'completed', conclusion: 'success' },
            { name: 'Build Web Client', status: 'completed', conclusion: 'success' },
            { name: 'Browser UI and workspace regression', status: 'completed', conclusion: 'success' },
          ],
        }),
      };
    }
    if (url.includes('/runs/101/jobs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [
            { name: 'windows', status: 'completed', conclusion: 'success' },
          ],
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const runs = await findSuccessfulWorkflowRuns(sourceSha, repo, 'token', mockFetchSuccess);
  assert.equal(runs['CI'].id, 100);
  assert.equal(runs['Windows Installer'].id, 101);
  includeAppleJobs = false;
  await assert.rejects(
    () => findSuccessfulWorkflowRuns(sourceSha, repo, 'token', mockFetchSuccess),
    /Required job "Build unsigned universal macOS app".*was not successful/
  );
});

test('buildReleaseNotes generates expected release notes with provenance and disclaimer', () => {
  const body = buildReleaseNotes('0.0.25', 'f254037f18dbd06f946043fe5a5ecf88da41806e', EXPECTED_GITHUB_REPO, 100, 101);
  assert.ok(body.includes('TJUClaw Client v0.0.25'));
  assert.ok(body.includes('未签名安装包'));
  assert.ok(body.includes('debug 签名调试包'));
  assert.ok(body.includes('actions/runs/100'));
  assert.ok(body.includes('actions/runs/101'));
  assert.ok(body.includes('SHA256SUMS'));
  assert.ok(body.includes('manifest.json'));
});

test('publishDownloads with prepareOnly extracts and produces all 5 assets locally without publishing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-publish-'));
  try {
    const sourceSha = 'f254037f18dbd06f946043fe5a5ecf88da41806e';
    const outDir = join(dir, 'out');


    // Create fake zip files
    const zipDeb = join(dir, 'linux.zip');
    const zipApk = join(dir, 'android.zip');
    const zipExe = join(dir, 'windows.zip');

    const py = `
import zipfile
with zipfile.ZipFile("${zipDeb}", "w") as z:
    z.writestr("test.deb", b"DEB_CONTENT")
with zipfile.ZipFile("${zipApk}", "w") as z:
    z.writestr("test.apk", b"APK_CONTENT")
with zipfile.ZipFile("${zipExe}", "w") as z:
    z.writestr("test.exe", b"EXE_CONTENT")
`;
    execFileSync('python3', ['-c', py]);

    const zipData = await Promise.all([zipDeb, zipApk, zipExe].map(p => readFile(p)));
    const digests = zipData.map(b => 'sha256:' + createHash('sha256').update(b).digest('hex'));
    const mockFetch = async (url) => {
      if (url.includes('/compare/release...')) {
        return { ok: true, status: 200, json: async () => ({ status: 'identical' }) };
      }
      if (url.includes('/contents/package.json?ref=')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ version: '0.0.25' }) };
      }
      if (url.includes('/releases/tags/') || url.includes('/git/ref/tags/')) {
        return { ok: false, status: 404 };
      }
      if (url.includes('/actions/runs?head_sha=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            workflow_runs: [
              {
                id: 100,
                name: 'CI',
                event: 'push',
                head_branch: 'release',
                head_sha: sourceSha,
                head_repository: { full_name: EXPECTED_GITHUB_REPO },
                status: 'completed',
                conclusion: 'success',
                jobs_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/100/jobs',
                artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/100/artifacts',
              },
              {
                id: 101,
                name: 'Windows Installer',
                event: 'push',
                head_branch: 'release',
                head_sha: sourceSha,
                head_repository: { full_name: EXPECTED_GITHUB_REPO },
                status: 'completed',
                conclusion: 'success',
                jobs_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/101/jobs',
                artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/101/artifacts',
              },
            ],
          }),
        };
      }
      if (url.includes('/runs/100/jobs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [
              { name: 'Build Linux amd64 Debian package', status: 'completed', conclusion: 'success' },
              { name: 'Build Android debug arm64 APK', status: 'completed', conclusion: 'success' },
              { name: 'Build unsigned universal macOS app', status: 'completed', conclusion: 'success' },
              { name: 'Compile unsigned iOS device and simulator archives', status: 'completed', conclusion: 'success' },
              { name: 'Portable checks', status: 'completed', conclusion: 'success' },
              { name: 'Build Web Client', status: 'completed', conclusion: 'success' },
              { name: 'Browser UI and workspace regression', status: 'completed', conclusion: 'success' },
            ],
          }),
        };
      }
      if (url.includes('/runs/101/jobs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [{ name: 'windows', status: 'completed', conclusion: 'success' }],
          }),
        };
      }
      if (url.includes('/runs/100/artifacts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            artifacts: [
              {
                id: 1,
                name: `linux-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/1/zip',
                digest: digests[0],
                expired: false,
              },
              {
                id: 2,
                name: `android-debug-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/2/zip',
                digest: digests[1],
                expired: false,
              },
            ],
          }),
        };
      }
      if (url.includes('/runs/101/artifacts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            artifacts: [
              {
                id: 3,
                name: `windows-unsigned-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/3/zip',
                digest: digests[2],
                expired: false,
              },
            ],
          }),
        };
      }
      if (url.includes('/artifacts/1/zip')) {
        return new Response(zipData[0]);
      }
      if (url.includes('/artifacts/2/zip')) {
        return new Response(zipData[1]);
      }
      if (url.includes('/artifacts/3/zip')) {
        return new Response(zipData[2]);
      }
      throw new Error(`Unhandled mock URL: ${url}`);
    };

    const res = await publishDownloads(
      {
        sourceSha,
        githubRepo: EXPECTED_GITHUB_REPO,
        ghToken: 'ghp_fake_token',
        prepareOnly: true,
        outDir,
      },
      { fetchFn: mockFetch }
    );

    assert.equal(res.success, true);
    assert.equal(res.preparedOnly, true);
    assert.equal(res.version, '0.0.25');
    assert.equal(res.assets.length, 3);
    assert.equal(res.assets[0].name, TARGET_ASSET_NAMES.deb);
    assert.equal(res.assets[1].name, TARGET_ASSET_NAMES.apk);
    assert.equal(res.assets[2].name, TARGET_ASSET_NAMES.exe);

    const writes = [];
    const publishFetch = async (url, options = {}) => {
      if (options.method === 'POST' && url.endsWith('/releases')) {
        writes.push('draft');
        assert.equal(JSON.parse(options.body).draft, true);
        return Response.json({ id: 42, upload_url: `https://uploads.github.com/repos/${EXPECTED_GITHUB_REPO}/releases/42/assets{?name,label}` });
      }
      if (url.startsWith('https://uploads.github.com/')) {
        writes.push(new URL(url).searchParams.get('name'));
        return Response.json({ state: 'uploaded' });
      }
      if (options.method === 'PATCH') {
        assert.equal(writes.length, 6, 'publish only after all five uploads');
        writes.push('published');
        return Response.json({ html_url: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/tag/v0.0.25' });
      }
      return mockFetch(url);
    };
    const published = await publishDownloads({ sourceSha, githubRepo: EXPECTED_GITHUB_REPO,
      ghToken: 'ghp_fake_token', outDir }, { fetchFn: publishFetch });
    assert.equal(published.success, true);
    assert.deepEqual(writes, ['draft', TARGET_ASSET_NAMES.deb, TARGET_ASSET_NAMES.apk,
      TARGET_ASSET_NAMES.exe, 'SHA256SUMS', 'manifest.json', 'published']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing release lookup fails closed on API errors', async () => {
  for (const status of [401, 403, 500]) {
    await assert.rejects(() => checkExistingRelease('v0.0.25', EXPECTED_GITHUB_REPO, 'token', async () => ({ status })), /lookup failed/);
  }
});
