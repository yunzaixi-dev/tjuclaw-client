import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  validateSha,
  validateSha256,
  validateGitLabUrl,
  validateProjectId,
  validateGitHubRepo,
  sanitizeErrorMessage,
  isAllowedDownloadHost,
  extractTargetFileFromZip,
  findSuccessfulWorkflowRuns,
  resolveArtifactsForSha,
  downloadArtifactZip,
  checkExistingGitLabFile,
  uploadToGitLabGenericRegistry,
  stageGitLabPackages,
  EXPECTED_GITHUB_REPO,
} from './stage-gitlab-packages.mjs';

function computeHex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('validateSha enforces strict 40-character hexadecimal strings', () => {
  const valid = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(validateSha(valid), valid);
  assert.throws(() => validateSha(''), /Invalid source_sha/);
  assert.throws(() => validateSha('0123456789abcdef'), /Invalid source_sha/);
  assert.throws(() => validateSha(valid.toUpperCase()), /Invalid source_sha/);
  assert.throws(() => validateSha(`${valid}\n`), /Invalid source_sha/);
});

test('validateSha256 enforces strict 64-character hexadecimal strings', () => {
  const valid = 'a'.repeat(64);
  assert.equal(validateSha256(valid), valid);
  assert.throws(() => validateSha256(''), /Invalid sha256/);
  assert.throws(() => validateSha256('a'.repeat(63)), /Invalid sha256/);
  assert.throws(() => validateSha256('A'.repeat(64)), /Invalid sha256/);
});

test('validateGitLabUrl strictly allows only https://gitlab.tju.edu.cn', () => {
  assert.equal(validateGitLabUrl('https://gitlab.tju.edu.cn'), 'https://gitlab.tju.edu.cn');
  assert.equal(validateGitLabUrl('https://gitlab.tju.edu.cn/'), 'https://gitlab.tju.edu.cn');
  assert.equal(validateGitLabUrl(), 'https://gitlab.tju.edu.cn');

  const invalidUrls = [
    'http://gitlab.tju.edu.cn',
    'https://gitlab.com',
    'https://attacker.org',
    'ftp://gitlab.tju.edu.cn',
  ];
  for (const u of invalidUrls) {
    assert.throws(() => validateGitLabUrl(u), /GitLab host|protocol/);
  }
});

test('validateProjectId strictly allows only project 145', () => {
  assert.equal(validateProjectId('145'), '145');
  assert.equal(validateProjectId(145), '145');
  assert.equal(validateProjectId(), '145');
  assert.throws(() => validateProjectId('146'), /Invalid GITLAB_PROJECT_ID/);
  assert.throws(() => validateProjectId('other'), /Invalid GITLAB_PROJECT_ID/);
});

test('validateGitHubRepo strictly allows only yunzaixi-dev/tjuclaw-client', () => {
  assert.equal(validateGitHubRepo('yunzaixi-dev/tjuclaw-client'), 'yunzaixi-dev/tjuclaw-client');
  assert.throws(() => validateGitHubRepo('yunzaixi-dev/tjuclaw'), /Invalid GITHUB_REPOSITORY/);
  assert.throws(() => validateGitHubRepo('other/repo'), /Invalid GITHUB_REPOSITORY/);
  assert.throws(() => validateGitHubRepo(''), /Invalid GITHUB_REPOSITORY/);
});

test('sanitizeErrorMessage strips tokens and signed URLs from errors', () => {
  const secret1 = 'glpat-SECRET1234567890abcdef';
  const secret2 = 'ghp_MYSECRETGH_TOKEN_HERE_12345';
  const rawErr = new Error(`Auth failed with ${secret1} and gh token ${secret2} at https://blob.core.windows.net/artifact.zip?sig=SUPERSECRET123&sp=r`);
  const sanitized = sanitizeErrorMessage(rawErr, [secret1, secret2]);
  assert.ok(!sanitized.includes('SECRET1234567890abcdef'));
  assert.ok(!sanitized.includes('MYSECRETGH_TOKEN_HERE_12345'));
  assert.ok(!sanitized.includes('SUPERSECRET123'));
  assert.ok(sanitized.includes('[REDACTED]'));
  assert.ok(sanitized.includes('[REDACTED_URL]'));
});

test('isAllowedDownloadHost allows GitHub and Azure blob domains and rejects others', () => {
  assert.ok(isAllowedDownloadHost('https://api.github.com/repos/foo/bar'));
  assert.ok(isAllowedDownloadHost('https://github.com/foo/bar'));
  assert.ok(isAllowedDownloadHost('https://productionresultssa0.blob.core.windows.net/actions-results/xyz'));
  assert.ok(isAllowedDownloadHost('https://pipelines.actions.githubusercontent.com/foo/bar'));

  assert.ok(!isAllowedDownloadHost('http://api.github.com'));
  assert.ok(!isAllowedDownloadHost('https://evil.com'));
  assert.ok(!isAllowedDownloadHost('https://blob.core.windows.net.evil.com'));
  assert.ok(!isAllowedDownloadHost('not-a-url'));
});

test('extractTargetFileFromZip safely extracts single file and rejects zip-slip and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-extract-'));
  try {
    const outDir = join(dir, 'out');
    await mkdir(outDir);

    // 1. Valid zip with .deb file
    const validZip = join(dir, 'valid.zip');
    const pyCreateZip = `
import zipfile
with zipfile.ZipFile("${validZip}", "w") as zf:
    zf.writestr("tjuclaw-client_0.0.25_amd64.deb", b"DEB_BINARY_CONTENT")
`;
    execFileSync('python3', ['-c', pyCreateZip]);

    const res = extractTargetFileFromZip(validZip, '.deb', outDir);
    assert.equal(res.fileName, 'tjuclaw-client_0.0.25_amd64.deb');

    // 2. Reject path traversal
    const slipZip = join(dir, 'slip.zip');
    const pyCreateSlip = `
import zipfile
with zipfile.ZipFile("${slipZip}", "w") as zf:
    zf.writestr("../evil.deb", b"EVIL")
`;
    execFileSync('python3', ['-c', pyCreateSlip]);
    assert.throws(() => extractTargetFileFromZip(slipZip, '.deb', outDir), /Path traversal detected/);

    // 3. Reject multiple matching files
    const multiZip = join(dir, 'multi.zip');
    const pyCreateMulti = `
import zipfile
with zipfile.ZipFile("${multiZip}", "w") as zf:
    zf.writestr("a.deb", b"A")
    zf.writestr("b.deb", b"B")
`;
    execFileSync('python3', ['-c', pyCreateMulti]);
    assert.throws(() => extractTargetFileFromZip(multiZip, '.deb', outDir), /Expected exactly one \.deb file/);

    // 4. Reject symlink in zip
    const symlinkZip = join(dir, 'symlink.zip');
    const pyCreateSymlink = `
import zipfile
with zipfile.ZipFile("${symlinkZip}", "w") as zf:
    zi = zipfile.ZipInfo("symlink.deb")
    zi.create_system = 3 # Unix
    zi.external_attr = 0o120777 << 16 # Symlink
    zf.writestr(zi, "/etc/passwd")
`;
    execFileSync('python3', ['-c', pyCreateSymlink]);
    assert.throws(() => extractTargetFileFromZip(symlinkZip, '.deb', outDir), /Symlink detected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findSuccessfulWorkflowRuns verifies both CI and Windows Installer succeed and rejects newer failed run', async () => {
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const repo = 'yunzaixi-dev/tjuclaw-client';

  // Scenario 1: Both succeeded
  const mockFetchSuccess = async () => {
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
            artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/101/artifacts',
          },
        ],
      }),
    };
  };

  const runs = await findSuccessfulWorkflowRuns(sourceSha, repo, 'fake-token', mockFetchSuccess);
  assert.equal(runs['CI'].id, 100);
  assert.equal(runs['Windows Installer'].id, 101);

  // Scenario 2: Newer failed run rejects even if older succeeded
  const mockFetchNewerFailed = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        workflow_runs: [
          {
            id: 102, // newer run
            name: 'CI',
            event: 'push',
            head_branch: 'release',
            head_sha: sourceSha,
            head_repository: { full_name: repo },
            status: 'completed',
            conclusion: 'failure',
          },
          {
            id: 100, // older run
            name: 'CI',
            event: 'push',
            head_branch: 'release',
            head_sha: sourceSha,
            head_repository: { full_name: repo },
            status: 'completed',
            conclusion: 'success',
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
          },
        ],
      }),
    };
  };

  await assert.rejects(
    () => findSuccessfulWorkflowRuns(sourceSha, repo, 'fake-token', mockFetchNewerFailed),
    /Latest run #102 for workflow "CI" is not successful/
  );
});

test('resolveArtifactsForSha finds linux-SHA, android-debug-SHA, windows-unsigned-SHA', async () => {
  const sha = '1111222233334444555566667777888899990000';
  const selectedRuns = {
    'CI': {
      id: 1,
      artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/1/artifacts',
    },
    'Windows Installer': {
      id: 2,
      artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/2/artifacts',
    },
  };

  const mockFetch = async (url) => {
    if (url === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/1/artifacts') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          artifacts: [
            { name: `linux-${sha}`, id: 10, archive_download_url: 'https://api.github.com/art/10' },
            { name: `android-debug-${sha}`, id: 11, archive_download_url: 'https://api.github.com/art/11' },
          ],
        }),
      };
    }
    if (url === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/2/artifacts') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          artifacts: [
            { name: `windows-unsigned-${sha}`, id: 12, archive_download_url: 'https://api.github.com/art/12' },
          ],
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const resolved = await resolveArtifactsForSha(sha, 'yunzaixi-dev/tjuclaw-client', selectedRuns, 'fake-token', mockFetch);
  assert.equal(resolved.deb.name, `linux-${sha}`);
  assert.equal(resolved.apk.name, `android-debug-${sha}`);
  assert.equal(resolved.exe.name, `windows-unsigned-${sha}`);
});

test('checkExistingGitLabFile and uploadToGitLabGenericRegistry skip on match and throw on mismatch', async () => {
  const expectedSha256 = computeHex(Buffer.from('identical-content'));
  const testUrl = 'https://gitlab.tju.edu.cn/api/v4/projects/145/packages/generic/tjuclaw-client/sha/app.deb';

  // 1. Check existing matching via x-checksum-sha256
  const mockFetchMatchHeader = async (url, opts) => {
    assert.equal(opts.headers['DEPLOY-TOKEN'], 'secret-deploy-token');
    if (opts.method === 'HEAD') {
      return {
        status: 200,
        headers: new Headers({ 'x-checksum-sha256': expectedSha256 }),
      };
    }
    throw new Error('Should not call GET when HEAD header matches');
  };

  const matchRes = await checkExistingGitLabFile(testUrl, 'secret-deploy-token', expectedSha256, mockFetchMatchHeader);
  assert.equal(matchRes.exists, true);
  assert.equal(matchRes.match, true);

  // 2. Check existing different via GET
  const mockFetchDiffBody = async (url, opts) => {
    if (opts.method === 'HEAD') {
      return { status: 200, headers: new Headers() };
    }
    if (opts.method === 'GET') {
      return {
        ok: true,
        status: 200,
        body: [Buffer.from('different-content')],
      };
    }
  };

  const diffRes = await checkExistingGitLabFile(testUrl, 'secret-deploy-token', expectedSha256, mockFetchDiffBody);
  assert.equal(diffRes.exists, true);
  assert.equal(diffRes.match, false);

  // 3. Upload rejects overwrite when hash differs
  await assert.rejects(
    () => uploadToGitLabGenericRegistry({
      gitlabUrl: 'https://gitlab.tju.edu.cn',
      projectId: '145',
      versionOrSha: 'some-sha',
      fileName: 'app.deb',
      buffer: Buffer.from('identical-content'),
      expectedSha256,
      deployToken: 'secret-deploy-token',
      fetchFn: mockFetchDiffBody,
    }),
    /already exists .* with differing SHA256.*Refusing to overwrite/
  );

  // 4. Upload skips when hash matches
  const skipRes = await uploadToGitLabGenericRegistry({
    gitlabUrl: 'https://gitlab.tju.edu.cn',
    projectId: '145',
    versionOrSha: 'some-sha',
    fileName: 'app.deb',
    buffer: Buffer.from('identical-content'),
    expectedSha256,
    deployToken: 'secret-deploy-token',
    fetchFn: mockFetchMatchHeader,
  });
  assert.equal(skipRes.skipped, true);

  // 5. Upload succeeds when 404
  let putCalled = false;
  const mockFetch404ThenPut = async (url, opts) => {
    if (opts.method === 'HEAD') {
      return { status: 404, headers: new Headers() };
    }
    if (opts.method === 'PUT') {
      putCalled = true;
      assert.equal(opts.headers['DEPLOY-TOKEN'], 'secret-deploy-token');
      return { status: 201 };
    }
  };

  const uploadSuccessRes = await uploadToGitLabGenericRegistry({
    gitlabUrl: 'https://gitlab.tju.edu.cn',
    projectId: '145',
    versionOrSha: 'some-sha',
    fileName: 'app.deb',
    buffer: Buffer.from('identical-content'),
    expectedSha256,
    deployToken: 'secret-deploy-token',
    fetchFn: mockFetch404ThenPut,
  });
  assert.equal(uploadSuccessRes.uploaded, true);
  assert.ok(putCalled);
});

test('stageGitLabPackages complete end-to-end mock test', async () => {
  const sourceSha = '1111222233334444555566667777888899990000';
  const tempDir = await mkdtemp(join(tmpdir(), 'test-stage-e2e-'));

  try {
    // Create mock zips
    const debZip = join(tempDir, `linux-${sourceSha}.zip`);
    const apkZip = join(tempDir, `android-debug-${sourceSha}.zip`);
    const exeZip = join(tempDir, `windows-unsigned-${sourceSha}.zip`);

    const debContent = Buffer.from('deb-binary-payload');
    const apkContent = Buffer.from('apk-binary-payload');
    const exeContent = Buffer.from('exe-binary-payload');

    const pyScript = `
import zipfile
with zipfile.ZipFile("${debZip}", "w") as z:
    z.writestr("tjuclaw-client_0.0.25_amd64.deb", b"${debContent.toString()}")
with zipfile.ZipFile("${apkZip}", "w") as z:
    z.writestr("app-debug.apk", b"${apkContent.toString()}")
with zipfile.ZipFile("${exeZip}", "w") as z:
    z.writestr("tjuclaw-client-0.0.25-setup.exe", b"${exeContent.toString()}")
`;
    execFileSync('python3', ['-c', pyScript]);

    const debZipBuf = await import('node:fs/promises').then(fs => fs.readFile(debZip));
    const apkZipBuf = await import('node:fs/promises').then(fs => fs.readFile(apkZip));
    const exeZipBuf = await import('node:fs/promises').then(fs => fs.readFile(exeZip));

    const uploadedUrls = [];

    const mockFetch = async (url, opts = {}) => {
      const u = String(url);

      // 1. package.json from GitHub API
      if (u.includes('/contents/package.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ name: '@tjuclaw/client', version: '0.0.25' }),
        };
      }

      // 2. GitHub workflow runs query
      if (u.includes('/actions/runs?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            workflow_runs: [
              {
                id: 10,
                name: 'CI',
                event: 'push',
                head_branch: 'release',
                head_sha: sourceSha,
                head_repository: { full_name: EXPECTED_GITHUB_REPO },
                status: 'completed',
                conclusion: 'success',
                artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/10/artifacts',
              },
              {
                id: 11,
                name: 'Windows Installer',
                event: 'push',
                head_branch: 'release',
                head_sha: sourceSha,
                head_repository: { full_name: EXPECTED_GITHUB_REPO },
                status: 'completed',
                conclusion: 'success',
                artifacts_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/11/artifacts',
              },
            ],
          }),
        };
      }

      // 3. Artifacts list
      if (u === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/10/artifacts') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            artifacts: [
              {
                name: `linux-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/deb',
                digest: `sha256:${computeHex(debZipBuf)}`,
              },
              {
                name: `android-debug-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/apk',
                digest: `sha256:${computeHex(apkZipBuf)}`,
              },
            ],
          }),
        };
      }

      if (u === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/runs/11/artifacts') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            artifacts: [
              {
                name: `windows-unsigned-${sourceSha}`,
                archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/exe',
                digest: `sha256:${computeHex(exeZipBuf)}`,
              },
            ],
          }),
        };
      }

      // 4. Artifact download (with 302 signed redirect)
      if (u === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/deb') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://pipelines.actions.githubusercontent.com/signed/deb.zip?token=signedtoken',
          }),
        };
      }
      if (u === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/apk') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://pipelines.actions.githubusercontent.com/signed/apk.zip?token=signedtoken',
          }),
        };
      }
      if (u === 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/exe') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://pipelines.actions.githubusercontent.com/signed/exe.zip?token=signedtoken',
          }),
        };
      }

      // 5. Signed download locations
      if (u.includes('/signed/deb.zip')) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (sent) return { done: true };
                  sent = true;
                  return { done: false, value: debZipBuf };
                },
              };
            },
          },
        };
      }
      if (u.includes('/signed/apk.zip')) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (sent) return { done: true };
                  sent = true;
                  return { done: false, value: apkZipBuf };
                },
              };
            },
          },
        };
      }
      if (u.includes('/signed/exe.zip')) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (sent) return { done: true };
                  sent = true;
                  return { done: false, value: exeZipBuf };
                },
              };
            },
          },
        };
      }

      // 6. GitLab Generic package registry
      if (u.includes('gitlab.tju.edu.cn/api/v4/projects/145/packages/generic/tjuclaw-client/')) {
        if (opts.method === 'HEAD') {
          return { status: 404, headers: new Headers() };
        }
        if (opts.method === 'PUT') {
          assert.equal(opts.headers['DEPLOY-TOKEN'], 'valid-deploy-token');
          uploadedUrls.push(u);
          return { status: 201 };
        }
      }

      throw new Error(`Unexpected request in test: ${opts.method || 'GET'} ${u}`);
    };

    const workDir = join(tempDir, 'work');
    await mkdir(workDir);

    const result = await stageGitLabPackages({
      sourceSha,
      gitlabUrl: 'https://gitlab.tju.edu.cn',
      projectId: '145',
      githubRepo: EXPECTED_GITHUB_REPO,
      ghToken: 'valid-gh-token',
      gitlabPackageToken: 'valid-deploy-token',
      tempDir: workDir,
    }, { fetchFn: mockFetch });

    assert.equal(result.success, true);
    assert.equal(result.version, '0.0.25');
    assert.equal(result.files.length, 3);
    assert.equal(result.manifest.files.length, 3);

    // Verify 3 files + 1 manifest uploaded to GitLab generic registry in order
    assert.equal(uploadedUrls.length, 4);
    assert.ok(uploadedUrls.some(u => u.includes(encodeURIComponent('app-debug.apk'))));
    assert.ok(uploadedUrls.some(u => u.includes(encodeURIComponent('tjuclaw-client-0.0.25-setup.exe'))));
    assert.ok(uploadedUrls.some(u => u.includes(encodeURIComponent('tjuclaw-client_0.0.25_amd64.deb'))));
    assert.ok(uploadedUrls[3].endsWith('/manifest.json')); // manifest uploaded LAST
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('artifact download requires provenance and strips credentials on redirect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-digest-'));
  const payload = Buffer.from('verified artifact bytes');
  const artifact = { name: 'linux-test', archive_download_url: 'https://api.github.com/repos/yunzaixi-dev/tjuclaw-client/actions/artifacts/42/zip', digest: `sha256:${computeHex(payload)}` };
  try {
    let calls = 0;
    await assert.rejects(() => downloadArtifactZip({ ...artifact, digest: undefined }, 'secret', dir, () => { calls++; }), /digest/);
    await assert.rejects(() => downloadArtifactZip({ ...artifact, archive_download_url: 'https://evil.test/zip' }, 'secret', dir, () => { calls++; }), /endpoint/);
    assert.equal(calls, 0);
    await downloadArtifactZip(artifact, 'secret', dir, async (_url, options) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://artifacts.blob.core.windows.net/result.zip?sig=fake' } });
      assert.equal(options.headers?.Authorization, undefined);
      assert.equal(options.redirect, 'error');
      return new Response(payload);
    });
    assert.equal(calls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
