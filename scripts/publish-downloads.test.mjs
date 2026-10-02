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
  compareVersions,
  buildUpdaterManifest,
  waitForWindowsRun,
  findCurrentCiRun,
  signAndroidApk,
  ANDROID_CERT_SHA256,
} from './publish-downloads.mjs';
import { signR2Request, publicObjectUrl, validateObjectKey } from './r2.mjs';

const R2 = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'tjuclaw-release',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'r2-secret-example',
  publicUrl: 'https://dl.example.com',
};

// Records R2 calls and serves HEAD/GET from an in-memory bucket.
function fakeR2(objects = new Map()) {
  const calls = [];
  const handle = async (url, options = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(`/${R2.bucket}/`, ''));
    assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    const method = options.method;
    if (method === 'HEAD') return new Response(null, { status: objects.has(key) ? 200 : 404 });
    if (method === 'GET') return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
    const source = options.headers['x-amz-copy-source'];
    if (source) {
      const from = decodeURIComponent(source.replace(`/${R2.bucket}/`, ''));
      calls.push(['COPY', from, key]);
      objects.set(key, objects.get(from));
    } else {
      calls.push(['PUT', key, options.headers['cache-control']]);
      objects.set(key, Buffer.from(options.body).toString());
    }
    return new Response(null, { status: 200 });
  };
  return { calls, objects, handle };
}

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
  const { appendFile } = await import('node:fs/promises');
  const signApkFn = file => appendFile(file, '+SIGNED');
  try {
    const sourceSha = 'f254037f18dbd06f946043fe5a5ecf88da41806e';
    const outDir = join(dir, 'out');


    // Create fake zip files
    const zipDeb = join(dir, 'linux.zip');
    const zipApk = join(dir, 'android.zip');
    const zipExe = join(dir, 'windows.zip');
    const zipRelease = join(dir, 'android-release.zip');

    const py = `
import zipfile
with zipfile.ZipFile("${zipDeb}", "w") as z:
    z.writestr("test.deb", b"DEB_CONTENT")
with zipfile.ZipFile("${zipApk}", "w") as z:
    z.writestr("test.apk", b"APK_CONTENT")
with zipfile.ZipFile("${zipExe}", "w") as z:
    z.writestr("test.exe", b"EXE_CONTENT")
with zipfile.ZipFile("${zipRelease}", "w") as z:
    z.writestr("app-universal-release-unsigned.apk", b"RELEASE_APK")
`;
    execFileSync('python3', ['-c', py]);

    const zipData = await Promise.all([zipDeb, zipApk, zipExe, zipRelease].map(p => readFile(p)));
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
              {
                id: 4,
                name: `android-release-unsigned-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/4/zip',
                digest: digests[3],
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
      if (url.includes('/artifacts/4/zip')) {
        return new Response(zipData[3]);
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
      { fetchFn: mockFetch, signApkFn }
    );

    assert.equal(res.success, true);
    assert.equal(res.preparedOnly, true);
    assert.equal(res.version, '0.0.25');
    assert.equal(res.assets.length, 4);
    assert.deepEqual(res.assets.map(a => a.name), [TARGET_ASSET_NAMES.deb, TARGET_ASSET_NAMES.apk,
      TARGET_ASSET_NAMES.apkRelease, TARGET_ASSET_NAMES.exe]);
    assert.equal(await readFile(join(outDir, TARGET_ASSET_NAMES.apkRelease), 'utf8'), 'RELEASE_APK+SIGNED');
    assert.equal(res.assets[2].sha256, createHash('sha256').update('RELEASE_APK+SIGNED').digest('hex'),
      'checksums describe the signed APK');

    const writes = [];
    const bucket = fakeR2();
    const publishFetch = async (url, options = {}) => {
      if (url.startsWith(R2.endpoint)) return bucket.handle(url, options);
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
        assert.equal(writes.length, 7, 'publish only after all six uploads');
        writes.push('published');
        return Response.json({ html_url: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/tag/v0.0.25' });
      }
      return mockFetch(url);
    };
    const signFn = file => `SIG-${file.split('.').pop()}`;
    const published = await publishDownloads({ sourceSha, githubRepo: EXPECTED_GITHUB_REPO,
      ghToken: 'ghp_fake_token', outDir, r2: R2 }, { fetchFn: publishFetch, signFn, signApkFn });
    assert.equal(published.success, true);
    assert.equal(published.r2.uploaded, true);
    assert.equal(published.r2.promoted, true);

    const versioned = bucket.calls.filter(c => c[0] === 'PUT' && c[1].startsWith('client/v0.0.25/')).map(c => c[1].split('/').pop());
    assert.deepEqual(versioned, [TARGET_ASSET_NAMES.deb, TARGET_ASSET_NAMES.apk, TARGET_ASSET_NAMES.apkRelease, TARGET_ASSET_NAMES.exe,
      `${TARGET_ASSET_NAMES.exe}.sig`, `${TARGET_ASSET_NAMES.deb}.sig`, 'SHA256SUMS', 'manifest.json']);
    assert.ok(bucket.calls.filter(c => c[0] === 'PUT' && c[1].startsWith('client/v0.0.25/')).every(c => c[2].includes('immutable')));
    assert.equal(bucket.calls.filter(c => c[0] === 'COPY').length, 8);
    assert.deepEqual(bucket.calls.at(-1), ['PUT', 'client/latest.json', 'no-cache'], 'latest.json flips last');
    const latest = JSON.parse(bucket.objects.get('client/latest.json'));
    assert.equal(latest.version, '0.0.25');
    assert.deepEqual(latest.platforms['windows-x86_64-nsis'], {
      signature: 'SIG-exe', url: `https://dl.example.com/client/v0.0.25/${TARGET_ASSET_NAMES.exe}` });
    assert.deepEqual(latest.platforms['linux-x86_64-deb'], {
      signature: 'SIG-deb', url: `https://dl.example.com/client/v0.0.25/${TARGET_ASSET_NAMES.deb}` });
    assert.equal(latest.platforms['linux-x86_64'], undefined);
    assert.equal(await readFile(join(outDir, `${TARGET_ASSET_NAMES.exe}.sig`), 'utf8'), 'SIG-exe\n');

    // A second push without a version bump publishes nothing.
    const again = await publishDownloads({ sourceSha, githubRepo: EXPECTED_GITHUB_REPO,
      ghToken: 'ghp_fake_token', outDir, r2: R2 }, {
      signFn,
      signApkFn,
      fetchFn: async (url, options = {}) => {
        if (url.startsWith(R2.endpoint)) return bucket.handle(url, options);
        if (url.includes('/releases/tags/')) return new Response('{}', { status: 200 });
        return publishFetch(url, options);
      },
    });
    assert.equal(again.skipped, true);
    assert.deepEqual(writes, ['draft', TARGET_ASSET_NAMES.deb, TARGET_ASSET_NAMES.apk, TARGET_ASSET_NAMES.apkRelease,
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

test('compareVersions orders releases before their prereleases', () => {
  assert.equal(compareVersions('0.0.31', '0.0.30'), 1);
  assert.equal(compareVersions('0.1.0', '0.0.99'), 1);
  assert.equal(compareVersions('0.0.30', '0.0.30'), 0);
  assert.equal(compareVersions('0.0.30-rc.1', '0.0.30'), -1);
  assert.equal(compareVersions('0.0.9', '0.0.10'), -1);
});

test('buildUpdaterManifest maps NSIS and deb installers to Tauri updater targets', () => {
  const manifest = buildUpdaterManifest('1.2.3', 'a'.repeat(40), '2026-09-28T00:00:00.000Z',
    { exe: 'https://dl/x.exe', deb: 'https://dl/x.deb' }, { exe: 'S1', deb: 'S2' });
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['linux-x86_64-deb', 'windows-x86_64', 'windows-x86_64-nsis']);
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'S1');
  assert.equal(manifest.platforms['linux-x86_64-deb'].url, 'https://dl/x.deb');
  // Without a summary the notes only name the version; with one they are its lines.
  assert.match(manifest.notes, /^TJUClaw Client v1\.2\.3/);
  const summarized = buildUpdaterManifest('1.2.3', 'a'.repeat(40), '2026-09-28T00:00:00.000Z',
    { exe: 'https://dl/x.exe', deb: 'https://dl/x.deb' }, { exe: 'S1', deb: 'S2' }, ['会话可以重命名', '界面更流畅']);
  assert.equal(summarized.notes, '会话可以重命名\n界面更流畅');
});

test('the release summary shipped with the build is short and usable', async () => {
  const { readReleaseSummary } = await import('./publish-downloads.mjs');
  const summary = readReleaseSummary();
  assert.ok(summary.length >= 1 && summary.length <= 4);
  for (const line of summary) assert.ok(line.length > 0 && line.length <= 80 && !line.includes('\n'), line);
  assert.deepEqual(readReleaseSummary(new URL('./no-such-file.json', import.meta.url)), []);
});

test('publish does not move latest backwards when an older version is published later', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-r2-'));
  try {
    const { publishToR2 } = await import('./publish-downloads.mjs');
    const file = join(dir, 'a.exe');
    await (await import('node:fs/promises')).writeFile(file, 'x');
    const bucket = fakeR2(new Map([['client/latest.json', JSON.stringify({ version: '0.0.40' })]]));
    const res = await publishToR2(R2, { version: '0.0.39', updaterManifest: { version: '0.0.39' },
      assets: [{ name: 'a.exe', filePath: file, download: true }] }, bucket.handle);
    assert.equal(res.uploaded, true);
    assert.equal(res.promoted, false);
    assert.equal(bucket.calls.filter(c => c[0] === 'COPY').length, 0);
    assert.equal(JSON.parse(bucket.objects.get('client/latest.json')).version, '0.0.40');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('signR2Request matches an independently computed SigV4 signature', () => {
  const now = new Date('2026-09-28T01:02:03.000Z');
  const req = signR2Request(R2, { method: 'PUT', key: 'client/v1/a_b.txt', payloadHash: 'abc', now,
    headers: { 'content-type': 'text/plain' } });
  assert.equal(req.url, 'https://account.r2.cloudflarestorage.com/tjuclaw-release/client/v1/a_b.txt');
  assert.equal(req.headers['x-amz-date'], '20260928T010203Z');
  assert.match(req.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260928\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  const py = `
import hashlib, hmac
k=lambda key,msg: hmac.new(key, msg.encode(), hashlib.sha256).digest()
canon="PUT\\n/tjuclaw-release/client/v1/a_b.txt\\n\\ncontent-type:text/plain\\nhost:account.r2.cloudflarestorage.com\\nx-amz-content-sha256:abc\\nx-amz-date:20260928T010203Z\\n\\ncontent-type;host;x-amz-content-sha256;x-amz-date\\nabc"
sts="AWS4-HMAC-SHA256\\n20260928T010203Z\\n20260928/auto/s3/aws4_request\\n"+hashlib.sha256(canon.encode()).hexdigest()
key=k(k(k(k(("AWS4r2-secret-example").encode(),"20260928"),"auto"),"s3"),"aws4_request")
print(hmac.new(key, sts.encode(), hashlib.sha256).hexdigest())`;
  const expected = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim();
  assert.ok(req.headers.authorization.endsWith(`Signature=${expected}`));
});

test('R2 object keys reject traversal and public URLs encode segments', () => {
  assert.throws(() => validateObjectKey('client/../x'), /Invalid R2 object key/);
  assert.throws(() => validateObjectKey('/client/x'), /Invalid R2 object key/);
  assert.equal(publicObjectUrl(R2, 'client/latest/TJUClaw-linux-amd64.deb'),
    'https://dl.example.com/client/latest/TJUClaw-linux-amd64.deb');
});

test('CI mode checks its own run and waits for the Windows Installer of the same push', async () => {
  const sha = 'b'.repeat(40);
  const base = { event: 'push', head_branch: 'release', head_sha: sha, head_repository: { full_name: EXPECTED_GITHUB_REPO } };
  const okJobs = names => Response.json({ jobs: names.map(name => ({ name, status: 'completed', conclusion: 'success' })) });
  let polls = 0;
  const fetchFn = async url => {
    if (url.endsWith('/actions/runs/7')) {
      return Response.json({ ...base, id: 7, name: 'CI',
        jobs_url: `https://api.github.com/repos/${EXPECTED_GITHUB_REPO}/actions/runs/7/jobs` });
    }
    if (url.includes('/runs/7/jobs')) {
      return okJobs(['Build Linux amd64 Debian package', 'Build Android debug arm64 APK', 'Build unsigned universal macOS app',
        'Compile unsigned iOS device and simulator archives', 'Portable checks', 'Build Web Client', 'Browser UI and workspace regression']);
    }
    if (url.includes('/actions/runs?head_sha=')) {
      polls++;
      const status = polls < 3 ? 'in_progress' : 'completed';
      return Response.json({ workflow_runs: [{ ...base, id: 8, name: 'Windows Installer', status, conclusion: status === 'completed' ? 'success' : null,
        jobs_url: `https://api.github.com/repos/${EXPECTED_GITHUB_REPO}/actions/runs/8/jobs` }] });
    }
    if (url.includes('/runs/8/jobs')) return okJobs(['windows']);
    throw new Error(`unexpected ${url}`);
  };
  assert.equal((await findCurrentCiRun(7, sha, EXPECTED_GITHUB_REPO, 't', fetchFn)).id, 7);
  await assert.rejects(() => findCurrentCiRun(7, 'c'.repeat(40), EXPECTED_GITHUB_REPO, 't', fetchFn), /not the release push CI run/);
  const run = await waitForWindowsRun(sha, EXPECTED_GITHUB_REPO, 't', { fetchFn, sleep: async () => {}, intervalMs: 0 });
  assert.equal(run.id, 8);
  assert.equal(polls, 3);
});

test('signAndroidApk aligns, signs and pins the release certificate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-apk-'));
  const { writeFile, copyFile } = await import('node:fs/promises');
  try {
    const apk = join(dir, 'app.apk');
    await writeFile(apk, 'UNSIGNED');
    const seen = [];
    const fakeExec = cert => (tool, args, opts) => {
      seen.push([tool.split('/').pop(), args[0], opts?.env?.TJUCLAW_KS_PASS]);
      if (tool.endsWith('zipalign')) return execFileSync('cp', [args.at(-2), args.at(-1)]);
      if (args[0] === 'sign') {
        assert.ok(!args.includes('pw'), 'password never appears on the command line');
        return execFileSync('sh', ['-c', `cat "$0" > "$1" && printf +SIGNED >> "$1"`, args.at(-1), args[args.indexOf('--out') + 1]]);
      }
      return `Signer #1 certificate SHA-256 digest: ${cert}\n`;
    };
    const signing = { keystoreBase64: Buffer.from('keystore').toString('base64'), password: 'pw' };
    assert.equal(await signAndroidApk(apk, signing, fakeExec(ANDROID_CERT_SHA256)), ANDROID_CERT_SHA256);
    assert.equal(await readFile(apk, 'utf8'), 'UNSIGNED+SIGNED');
    assert.deepEqual(seen.map(s => s[0]), ['zipalign', 'apksigner', 'apksigner']);
    assert.equal(seen[1][2], 'pw');

    await copyFile(apk, join(dir, 'before.apk'));
    await assert.rejects(() => signAndroidApk(apk, signing, fakeExec('0'.repeat(64))), /does not match the pinned/);
    assert.equal(await readFile(apk, 'utf8'), 'UNSIGNED+SIGNED', 'a wrong key never replaces the APK');
    await assert.rejects(() => signAndroidApk(apk, {}, fakeExec(ANDROID_CERT_SHA256)), /Missing ANDROID_KEYSTORE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
