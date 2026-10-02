import { URL, fileURLToPath } from 'node:url';
import { open, rm, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { publicObjectUrl, r2Copy, r2Exists, r2GetText, r2Put, readR2Config } from './r2.mjs';

export const EXPECTED_GITHUB_REPO = 'yunzaixi-dev/tjuclaw-client';
export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const VALID_SHA_REGEX = /^[0-9a-f]{40}$/;
export const VALID_SHA256_REGEX = /^[0-9a-f]{64}$/;
export const VALID_FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export const EXPECTED_WORKFLOWS = ['CI', 'Windows Installer'];

export const TARGET_ASSET_NAMES = {
  deb: 'TJUClaw-linux-amd64.deb',
  apk: 'TJUClaw-android-arm64-debug.apk',
  apkRelease: 'TJUClaw-android-arm64.apk',
  exe: 'TJUClaw-windows-x64-setup.exe',
};

// Every release APK must be signed by this one key, or Android refuses to install
// an update over an existing copy. Losing the keystore strands installed apps.
export const ANDROID_KEY_ALIAS = 'tjuclaw';
export const ANDROID_CERT_SHA256 = 'e47690cb91be690bdb054d741c1d5da7ce8da58da0f2edf6db082d76519cbdf0';

export const R2_PREFIX = 'client';
export const UPDATER_MANIFEST_KEY = `${R2_PREFIX}/latest.json`;

// Tauri updater looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
// Linux only ships .deb, so it has no bare `linux-x86_64` entry that an AppImage
// install could mistake for its own format.
export const UPDATER_PLATFORMS = {
  'windows-x86_64-nsis': 'exe',
  'windows-x86_64': 'exe',
  'linux-x86_64-deb': 'deb',
};

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_LATEST = 'public, max-age=300';
const CACHE_MANIFEST = 'no-cache';

const CONTENT_TYPES = {
  '.deb': 'application/vnd.debian.binary-package',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.sig': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export function contentTypeFor(name) {
  if (name === 'SHA256SUMS') return 'text/plain; charset=utf-8';
  const ext = name.slice(name.lastIndexOf('.'));
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre] = String(v).split('-', 2);
    return { nums: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0) ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

export function validateSha(sha, fieldName = 'source_sha') {
  if (typeof sha !== 'string' || !VALID_SHA_REGEX.test(sha)) {
    throw new Error(`Invalid ${fieldName}: must be a 40-character hexadecimal string`);
  }
  return sha;
}

export function validateSha256(hash, fieldName = 'sha256') {
  if (typeof hash !== 'string' || !VALID_SHA256_REGEX.test(hash)) {
    throw new Error(`Invalid ${fieldName}: must be a 64-character hexadecimal string`);
  }
  return hash;
}

export function validateGitHubRepo(repo) {
  const normalized = String(repo || '').trim();
  if (normalized !== EXPECTED_GITHUB_REPO) {
    throw new Error(`Invalid GITHUB_REPOSITORY: "${normalized}"; expected "${EXPECTED_GITHUB_REPO}"`);
  }
  return normalized;
}

export function sanitizeErrorMessage(err, secretsToRedact = []) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secretsToRedact) {
    if (secret && typeof secret === 'string' && secret.length > 3) {
      msg = msg.replaceAll(secret, '[REDACTED]');
    }
  }
  msg = msg.replace(/(?:glpat-|ghp_|github_pat_|bearer\s+)[A-Za-z0-9_.-]+/gi, '[REDACTED]');
  msg = msg.replace(/https:\/\/[^\s"'<>]+(?:\?|&)(?:sig|token|se|sp|sv|Signature|Key-Pair-Id)=[^\s"'<>]+/gi, '[REDACTED_URL]');
  return msg;
}

export function isAllowedDownloadHost(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'api.github.com' ||
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host.endsWith('.actions.githubusercontent.com') ||
      host.endsWith('.blob.core.windows.net') ||
      host.endsWith('.pkg-containers.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

export function validatedGitHubApiUrl(raw) {
  const url = new URL(raw);
  if (
    url.origin !== 'https://api.github.com' ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(`/repos/${EXPECTED_GITHUB_REPO}/`)
  ) {
    throw new Error('Unexpected authenticated GitHub API endpoint');
  }
  return url.href;
}

export async function timedFetch(url, options = {}, timeoutMs = 30000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Validates that sourceSha is on release ancestry via git or compare API.
 */
export async function validateReleaseAncestry(sourceSha, githubRepo, ghToken, options = {}) {
  validateSha(sourceSha);
  validateGitHubRepo(githubRepo);

  // 1. If git check is requested or available locally
  if (options.gitDir) {
    try {
      execFileSync('git', ['-C', options.gitDir, 'merge-base', '--is-ancestor', sourceSha, 'release'], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      // Fall through to API check if local git check fails or branch is missing
    }
  }

  // 2. Query GitHub Compare API: release...sourceSha
  const fetchFn = options.fetchFn || timedFetch;
  const compareUrl = `https://api.github.com/repos/${githubRepo}/compare/release...${sourceSha}`;
  const res = await fetchFn(compareUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });

  if (!res.ok) {
    throw new Error(`Failed to check release ancestry on GitHub API (HTTP ${res.status})`);
  }

  const data = await res.json();
  // If sourceSha is an ancestor of release (or identical), status is 'behind' or 'identical'
  if (data.status !== 'identical' && data.status !== 'behind') {
    throw new Error(
      `Commit ${sourceSha} is not on release branch ancestry (compare status: ${data.status})`
    );
  }

  return true;
}

/**
 * Checks whether release or tag already exists. Throws if exists (strictly immutable).
 */
export async function checkExistingRelease(tag, githubRepo, ghToken, fetchFn = timedFetch) {
  const existing = await releaseExists(tag, githubRepo, ghToken, fetchFn);
  if (existing) throw new Error(`${existing}. Refusing to overwrite immutable release.`);
}

/**
 * Returns a description when a GitHub release or tag named `tag` exists, otherwise null.
 */
export async function releaseExists(tag, githubRepo, ghToken, fetchFn = timedFetch) {
  validateGitHubRepo(githubRepo);

  const releaseUrl = `https://api.github.com/repos/${githubRepo}/releases/tags/${tag}`;
  const res = await fetchFn(releaseUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });

  if (res.status === 200) return `Release with tag "${tag}" already exists`;

  if (res.status !== 404) throw new Error(`Release lookup failed (HTTP ${res.status})`);

  const tagRefUrl = `https://api.github.com/repos/${githubRepo}/git/ref/tags/${tag}`;
  const tagRes = await fetchFn(tagRefUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });

  if (tagRes.status === 200) return `Git tag "${tag}" already exists`;
  if (tagRes.status !== 404) throw new Error(`Tag lookup failed (HTTP ${tagRes.status})`);
  return null;
}

export async function fetchPackageVersionFromGitHub(sourceSha, githubRepo, ghToken, fetchFn = timedFetch) {
  const url = `https://api.github.com/repos/${githubRepo}/contents/package.json?ref=${sourceSha}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch package.json at ${sourceSha} from GitHub API (HTTP ${res.status})`);
  }

  const content = await res.text();
  const pkg = JSON.parse(content);
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error('Invalid or missing version in package.json');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error(`Package version "${pkg.version}" does not match semver pattern`);
  }
  return pkg.version;
}

export async function findSuccessfulWorkflowRuns(sourceSha, githubRepo, ghToken, fetchFn = timedFetch) {
  validateSha(sourceSha);
  validateGitHubRepo(githubRepo);

  const runsUrl = `https://api.github.com/repos/${githubRepo}/actions/runs?head_sha=${sourceSha}&event=push&branch=release&per_page=100`;
  const res = await fetchFn(runsUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });

  if (!res.ok) {
    throw new Error(`GitHub API error querying workflow runs (HTTP ${res.status})`);
  }

  const data = await res.json();
  const runs = data.workflow_runs || [];

  const selectedRuns = {};

  for (const wfName of EXPECTED_WORKFLOWS) {
    const matchingRuns = runs.filter(
      r =>
        r.name === wfName &&
        r.event === 'push' &&
        r.head_branch === 'release' &&
        r.head_sha === sourceSha &&
        r.head_repository?.full_name === githubRepo
    );

    if (matchingRuns.length === 0) {
      throw new Error(`No workflow run found for workflow "${wfName}" at commit ${sourceSha}`);
    }

    matchingRuns.sort((a, b) => b.id - a.id);
    const newestRun = matchingRuns[0];

    if (newestRun.status !== 'completed' || newestRun.conclusion !== 'success') {
      throw new Error(
        `Latest run #${newestRun.id} for workflow "${wfName}" is not successful (status: ${newestRun.status}, conclusion: ${newestRun.conclusion})`
      );
    }

    await verifyRequiredJobs(newestRun, wfName, ghToken, fetchFn);

    selectedRuns[wfName] = newestRun;
  }

  return selectedRuns;
}

export const REQUIRED_CI_JOBS = [
  'Build Linux amd64 Debian package',
  'Build Android debug arm64 APK',
  'Build unsigned universal macOS app',
  'Compile unsigned iOS device and simulator archives',
  'Portable checks',
  'Build Web Client',
  'Browser UI and workspace regression',
];

async function verifyRequiredJobs(run, wfName, ghToken, fetchFn) {
  const jobsUrl = validatedGitHubApiUrl(`${run.jobs_url}?per_page=100`);
  const jobsRes = await fetchFn(jobsUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });

  if (!jobsRes.ok) {
    throw new Error(`GitHub API error querying jobs for run #${run.id} (HTTP ${jobsRes.status})`);
  }

  const jobsData = await jobsRes.json();
  const jobs = jobsData.jobs || [];

  if (wfName === 'CI') {
    for (const req of REQUIRED_CI_JOBS) {
      const found = jobs.find(j => j.name === req);
      if (!found || found.status !== 'completed' || found.conclusion !== 'success') {
        throw new Error(`Required job "${req}" in CI run #${run.id} was not successful`);
      }
    }
  } else if (wfName === 'Windows Installer') {
    const found = jobs.find(j => j.name === 'windows');
    if (!found || found.status !== 'completed' || found.conclusion !== 'success') {
      throw new Error(`Required job "windows" in Windows Installer run #${run.id} was not successful`);
    }
  }
}

function ghHeaders(ghToken) {
  return {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function isOwnReleasePush(run, sourceSha, githubRepo) {
  return run.event === 'push' && run.head_branch === 'release' && run.head_sha === sourceSha &&
    run.head_repository?.full_name === githubRepo;
}

/**
 * CI mode: the publish job runs inside the CI run itself, so that run is still in
 * progress. Its required build jobs must already have succeeded (they are `needs`).
 */
export async function findCurrentCiRun(runId, sourceSha, githubRepo, ghToken, fetchFn = timedFetch) {
  if (!/^[0-9]+$/.test(String(runId))) throw new Error('Invalid CI run id');
  const res = await fetchFn(`https://api.github.com/repos/${githubRepo}/actions/runs/${runId}`, {
    headers: ghHeaders(ghToken),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`GitHub API error querying CI run #${runId} (HTTP ${res.status})`);
  const run = await res.json();
  if (run.name !== 'CI' || !isOwnReleasePush(run, sourceSha, githubRepo)) {
    throw new Error(`Run #${runId} is not the release push CI run for ${sourceSha}`);
  }
  await verifyRequiredJobs(run, 'CI', ghToken, fetchFn);
  return run;
}

/**
 * CI mode: waits for the separate Windows Installer workflow of the same push.
 */
export async function waitForWindowsRun(sourceSha, githubRepo, ghToken, options = {}) {
  const fetchFn = options.fetchFn || timedFetch;
  const wait = options.sleep || sleep;
  const intervalMs = options.intervalMs ?? 30000;
  const deadline = Date.now() + (options.timeoutMs ?? 55 * 60 * 1000);
  const runsUrl = `https://api.github.com/repos/${githubRepo}/actions/runs?head_sha=${sourceSha}&event=push&branch=release&per_page=100`;

  while (true) {
    const res = await fetchFn(runsUrl, { headers: ghHeaders(ghToken), redirect: 'error' });
    if (!res.ok) throw new Error(`GitHub API error querying workflow runs (HTTP ${res.status})`);
    const runs = ((await res.json()).workflow_runs || [])
      .filter(r => r.name === 'Windows Installer' && isOwnReleasePush(r, sourceSha, githubRepo))
      .sort((a, b) => b.id - a.id);
    const newest = runs[0];
    if (newest?.status === 'completed') {
      if (newest.conclusion !== 'success') {
        throw new Error(`Windows Installer run #${newest.id} finished with conclusion ${newest.conclusion}`);
      }
      await verifyRequiredJobs(newest, 'Windows Installer', ghToken, fetchFn);
      return newest;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the Windows Installer run');
    await wait(intervalMs);
  }
}

/**
 * Signs a file for the Tauri updater with the pinned Tauri CLI and returns the
 * signature text. The private key only reaches the signer process environment.
 */
export function signUpdaterAsset(filePath, signing, exec = execFileSync) {
  if (!signing?.privateKey || !signing?.password) {
    throw new Error('Missing TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(signing.cliVersion || '')) throw new Error('Tauri CLI version must be pinned');
  exec('npx', ['--yes', `@tauri-apps/cli@${signing.cliVersion}`, 'signer', 'sign', filePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 300000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: 'true',
      TAURI_SIGNING_PRIVATE_KEY: signing.privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signing.password,
    },
  });
  const signature = readFileSync(`${filePath}.sig`, 'utf8').trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error(`Invalid updater signature for ${filePath}`);
  return signature;
}

function androidBuildTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) return name;
  const dir = resolve(sdk, 'build-tools');
  const versions = existsSync(dir)
    ? readdirSync(dir).filter(v => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)).sort((a, b) => compareVersions(b, a))
    : [];
  // zipalign has no --version flag, so probe by file presence, newest build-tools first.
  const found = versions.map(v => resolve(dir, v, name)).find(tool => existsSync(tool));
  return found || name;
}

/**
 * Aligns and signs an unsigned release APK in place with the permanent release key,
 * then refuses the result unless its signer certificate is the pinned one.
 */
export async function signAndroidApk(apkPath, signing, exec = execFileSync) {
  if (!signing?.keystoreBase64 || !signing?.password) {
    throw new Error('Missing ANDROID_KEYSTORE_BASE64 or ANDROID_KEYSTORE_PASSWORD');
  }
  const dir = await mkdtemp(resolve(tmpdir(), 'tjuclaw-apk-'));
  try {
    const keystore = resolve(dir, 'release.p12');
    await writeFile(keystore, Buffer.from(signing.keystoreBase64, 'base64'), { mode: 0o600 });
    const zipalign = androidBuildTool('zipalign');
    const apksigner = androidBuildTool('apksigner');
    const aligned = resolve(dir, 'aligned.apk');
    const signed = resolve(dir, 'signed.apk');
    // 16 KB page alignment for uncompressed native libraries (Android 15+ devices).
    exec(zipalign, ['-f', '-P', '16', '4', apkPath, aligned], { stdio: 'ignore', timeout: 120000 });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TJUCLAW_KS_PASS: signing.password };
    exec(apksigner, ['sign', '--ks', keystore, '--ks-type', 'PKCS12', '--ks-key-alias', ANDROID_KEY_ALIAS,
      '--ks-pass', 'env:TJUCLAW_KS_PASS', '--key-pass', 'env:TJUCLAW_KS_PASS', '--out', signed, aligned],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000, env });
    const report = String(exec(apksigner, ['verify', '--print-certs', signed], { encoding: 'utf8', timeout: 120000 }));
    const certs = [...report.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map(m => m[1]);
    if (certs.length !== 1 || certs[0] !== ANDROID_CERT_SHA256) {
      throw new Error('Signed APK certificate does not match the pinned TJUClaw release certificate');
    }
    await writeFile(apkPath, await readFile(signed), { mode: 0o644 });
    return certs[0];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The short lines that say what this version changes, from
 * public/release-notes.json. The update notice shows them; without the file
 * or with nothing usable in it there is no summary.
 */
export function readReleaseSummary(file = new URL('../public/release-notes.json', import.meta.url)) {
  try {
    const items = JSON.parse(readFileSync(file, 'utf8')).items;
    return (Array.isArray(items) ? items : []).filter(item => typeof item === 'string')
      .map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

export function buildUpdaterManifest(version, sourceSha, pubDate, urls, signatures, summary = []) {
  const platforms = {};
  for (const [platform, kind] of Object.entries(UPDATER_PLATFORMS)) {
    platforms[platform] = { signature: signatures[kind], url: urls[kind] };
  }
  return {
    version,
    // The updater hands these notes to the app, which lists them one per line.
    notes: summary.length ? summary.join('\n') : `TJUClaw Client v${version}（源码提交 ${sourceSha.slice(0, 12)}）`,
    pub_date: pubDate,
    platforms,
  };
}

/**
 * Uploads a version under client/v<version>/ (immutable, skipped when its manifest
 * already exists), then moves client/latest/ and client/latest.json forward only
 * when this version is newer than the one currently published.
 */
export async function publishToR2(r2, { version, assets, updaterManifest }, fetchFn = timedFetch) {
  const versionPrefix = `${R2_PREFIX}/v${version}`;
  const manifestKey = `${versionPrefix}/manifest.json`;
  const uploaded = !(await r2Exists(r2, manifestKey, fetchFn));

  if (uploaded) {
    // manifest.json goes last: its presence marks a complete version directory.
    for (const asset of assets) {
      await r2Put(r2, `${versionPrefix}/${asset.name}`, await readFile(asset.filePath), {
        contentType: contentTypeFor(asset.name),
        cacheControl: CACHE_IMMUTABLE,
        contentDisposition: asset.download ? `attachment; filename="${asset.name}"` : undefined,
      }, fetchFn);
    }
  }

  const currentText = await r2GetText(r2, UPDATER_MANIFEST_KEY, fetchFn);
  const current = currentText ? JSON.parse(currentText).version : null;
  const promoted = !current || compareVersions(version, current) > 0;
  if (promoted) {
    for (const asset of assets) {
      await r2Copy(r2, `${versionPrefix}/${asset.name}`, `${R2_PREFIX}/latest/${asset.name}`, {
        contentType: contentTypeFor(asset.name),
        cacheControl: CACHE_LATEST,
        contentDisposition: asset.download ? `attachment; filename="${asset.name}"` : undefined,
      }, fetchFn);
    }
    await r2Put(r2, UPDATER_MANIFEST_KEY, Buffer.from(JSON.stringify(updaterManifest, null, 2) + '\n'), {
      contentType: 'application/json',
      cacheControl: CACHE_MANIFEST,
    }, fetchFn);
  }

  return { uploaded, promoted, previous: current, url: publicObjectUrl(r2, manifestKey) };
}

export async function resolveArtifactsForSha(sourceSha, githubRepo, selectedRuns, ghToken, fetchFn = timedFetch) {
  const expectedArtifactNames = {
    deb: `linux-${sourceSha}`,
    apk: `android-debug-${sourceSha}`,
    apkRelease: `android-release-unsigned-${sourceSha}`,
    exe: `windows-unsigned-${sourceSha}`,
  };

  const artifactsFound = {};

  for (const run of Object.values(selectedRuns)) {
    const artifactsUrl = validatedGitHubApiUrl(run.artifacts_url);
    const res = await fetchFn(artifactsUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    });

    if (!res.ok) {
      throw new Error(`GitHub API error querying artifacts for run #${run.id} (HTTP ${res.status})`);
    }

    const data = await res.json();
    const artifacts = data.artifacts || [];

    for (const [type, expectedName] of Object.entries(expectedArtifactNames)) {
      const match = artifacts.find(a => a.name === expectedName);
      if (match) {
        if (artifactsFound[type]) {
          throw new Error(`Duplicate artifact found for ${type}: "${expectedName}" in multiple runs`);
        }
        artifactsFound[type] = match;
      }
    }
  }

  for (const [type, expectedName] of Object.entries(expectedArtifactNames)) {
    if (!artifactsFound[type]) {
      throw new Error(`Required artifact "${expectedName}" (${type}) was not found in workflow runs`);
    }
  }

  return artifactsFound;
}

export async function downloadArtifactZip(artifact, ghToken, tempDir, fetchFn = timedFetch) {
  const zipPath = resolve(tempDir, `${artifact.name}.zip`);
  const initialUrl = validatedGitHubApiUrl(artifact.archive_download_url);
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || artifact.expired) {
    throw new Error('Artifact must have a valid GitHub SHA-256 digest and remain available');
  }

  const res = await fetchFn(initialUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
  });

  let downloadRes = res;
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location');
    if (!isAllowedDownloadHost(location)) throw new Error('Artifact download redirect destination host is not allowed');
    downloadRes = await fetchFn(location, { redirect: 'error' }, 120000);
  }

  if (!downloadRes.ok) {
    throw new Error(`Failed to download artifact payload for "${artifact.name}" (HTTP ${downloadRes.status})`);
  }

  const handle = await open(zipPath, 'w', 0o600);
  const hasher = createHash('sha256');
  let bytesDownloaded = 0;

  try {
    const reader = downloadRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesDownloaded += value.length;
      if (bytesDownloaded > MAX_FILE_SIZE_BYTES) {
        throw new Error(`Artifact zip "${artifact.name}" exceeds maximum allowed size of 1 GiB`);
      }
      hasher.update(value);
      await handle.writeFile(value);
    }
  } finally {
    await handle.close();
  }

  const computedDigest = hasher.digest('hex');

  if (artifact.digest) {
    let expectedHex = artifact.digest;
    if (expectedHex.startsWith('sha256:')) {
      expectedHex = expectedHex.slice('sha256:'.length);
    }
    if (expectedHex.toLowerCase() !== computedDigest) {
      throw new Error(`Artifact "${artifact.name}" digest mismatch: expected ${expectedHex}, got ${computedDigest}`);
    }
  }

  return {
    zipPath,
    size: bytesDownloaded,
    sha256: computedDigest,
  };
}

export function extractTargetFileFromZip(zipPath, expectedExt, outDir) {
  if (!['.deb', '.apk', '.exe'].includes(expectedExt)) {
    throw new Error(`Invalid expected extension "${expectedExt}"`);
  }

  const pythonScript = `
import sys, os, zipfile

zip_path = sys.argv[1]
expected_ext = sys.argv[2]
out_dir = sys.argv[3]

with zipfile.ZipFile(zip_path, 'r') as zf:
    candidates = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        if '..' in name or name.startswith('/') or name.startswith('\\\\'):
            sys.stderr.write(f"Path traversal detected: {name}\\n")
            sys.exit(2)
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            sys.stderr.write(f"Symlink detected in zip: {name}\\n")
            sys.exit(3)
        if name.lower().endswith(expected_ext.lower()):
            candidates.append(info)

    if len(candidates) != 1:
        sys.stderr.write(f"Expected exactly one {expected_ext} file, found {len(candidates)}\\n")
        sys.exit(4)

    target_info = candidates[0]
    target_basename = os.path.basename(target_info.filename)
    if not target_basename or target_basename in ('.', '..'):
        sys.stderr.write(f"Invalid basename: {target_basename}\\n")
        sys.exit(5)

    dest_path = os.path.join(out_dir, target_basename)
    total_unpacked = 0
    with zf.open(target_info, 'r') as src, open(dest_path, 'wb') as dst:
        while True:
            chunk = src.read(65536)
            if not chunk:
                break
            total_unpacked += len(chunk)
            if total_unpacked > 1024 * 1024 * 1024:
                sys.stderr.write("Unpacked file exceeds 1 GiB limit\\n")
                sys.exit(6)
            dst.write(chunk)

    print(target_basename)
`;

  try {
    const stdout = execFileSync('python3', ['-c', pythonScript, zipPath, expectedExt, outDir], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    const extractedFileName = stdout.trim();
    if (!VALID_FILENAME_REGEX.test(extractedFileName)) {
      throw new Error(`Extracted filename contains invalid characters: "${extractedFileName}"`);
    }
    const extractedFilePath = resolve(outDir, extractedFileName);
    return {
      fileName: extractedFileName,
      filePath: extractedFilePath,
    };
  } catch (err) {
    throw new Error(`Failed to extract ${expectedExt} from zip: ${err.stderr || err.message}`);
  }
}

export function buildReleaseNotes(version, sourceSha, githubRepo, ciRunId, windowsRunId) {
  return `TJUClaw Client v${version}

下载 Windows x64 安装包、Linux amd64 Debian 包和 Android arm64 APK。

Windows 为未签名安装包。Android 请安装 \`TJUClaw-android-arm64.apk\`：由固定的 TJUClaw 发布密钥签名，后续版本可直接覆盖升级并保留数据（证书 SHA-256 \`e47690cb…9cbdf0\`）；\`-debug.apk\` 为 debug 签名调试包，每次构建密钥不同，无法覆盖升级。

全部文件来自同一源码提交 \`${sourceSha}\` 的成功构建。便携检查、浏览器回归、Linux/Android 构建：[CI](https://github.com/${githubRepo}/actions/runs/${ciRunId})；[Windows 构建](https://github.com/${githubRepo}/actions/runs/${windowsRunId})。使用 SHA256SUMS 校验文件，manifest.json 记录来源。`;
}

export async function publishDownloads(options, injected = {}) {
  const fetchFn = injected.fetchFn || timedFetch;
  const secrets = [];

  const sourceSha = validateSha(options.sourceSha, 'SOURCE_SHA');
  const githubRepo = validateGitHubRepo(options.githubRepo);
  const ghToken = options.ghToken;
  if (!ghToken) {
    throw new Error('Missing GITHUB_TOKEN (or GH_TOKEN)');
  }
  secrets.push(ghToken, options.signing?.privateKey, options.signing?.password,
    options.androidSigning?.keystoreBase64, options.androidSigning?.password);

  const prepareOnly = Boolean(options.prepareOnly);
  const targetDir = options.outDir ? resolve(options.outDir) : await mkdtemp(resolve(tmpdir(), 'tjuclaw-release-'));
  const cleanupTemp = !options.outDir && !prepareOnly;

  try {
    // 1. Ancestry validation
    await validateReleaseAncestry(sourceSha, githubRepo, ghToken, {
      fetchFn,
      gitDir: options.gitDir,
    });

    // 2. Fetch package version from source SHA
    const version = await fetchPackageVersionFromGitHub(sourceSha, githubRepo, ghToken, fetchFn);
    const tagName = `v${version}`;

    // 3. Published versions are immutable: each target that already has this
    // version is skipped, never overwritten. A version is published on R2 once its
    // manifest exists and latest.json has reached it (or a newer version).
    const githubExisting = await releaseExists(tagName, githubRepo, ghToken, fetchFn);
    const r2 = prepareOnly ? null : (options.r2 || readR2Config());
    if (r2) secrets.push(r2.secretAccessKey);
    if (r2 && githubExisting && await r2Exists(r2, `${R2_PREFIX}/v${version}/manifest.json`, fetchFn)) {
      const latestText = await r2GetText(r2, UPDATER_MANIFEST_KEY, fetchFn);
      const latest = latestText ? JSON.parse(latestText).version : null;
      if (latest && compareVersions(latest, version) >= 0) {
        return { success: true, skipped: true, tagName, reason: `${tagName} is already published to GitHub and R2` };
      }
    }

    // 4. Verify workflow runs. In CI mode the publish job runs inside the CI run
    // and waits for the separate Windows Installer workflow of the same push.
    const runs = options.ciRunId
      ? {
          CI: await findCurrentCiRun(options.ciRunId, sourceSha, githubRepo, ghToken, fetchFn),
          'Windows Installer': await waitForWindowsRun(sourceSha, githubRepo, ghToken, { fetchFn, sleep: injected.sleep }),
        }
      : await findSuccessfulWorkflowRuns(sourceSha, githubRepo, ghToken, fetchFn);
    const ciRun = runs['CI'];
    const windowsRun = runs['Windows Installer'];

    // 5. Resolve artifacts
    const artifacts = await resolveArtifactsForSha(sourceSha, githubRepo, runs, ghToken, fetchFn);

    await mkdir(targetDir, { recursive: true });
    // 6. Download and extract each artifact, rename to canonical names
    const types = [
      { key: 'deb', ext: '.deb', targetName: TARGET_ASSET_NAMES.deb },
      { key: 'apk', ext: '.apk', targetName: TARGET_ASSET_NAMES.apk },
      { key: 'apkRelease', ext: '.apk', targetName: TARGET_ASSET_NAMES.apkRelease },
      { key: 'exe', ext: '.exe', targetName: TARGET_ASSET_NAMES.exe },
    ];
    const signApk = injected.signApkFn || (file => signAndroidApk(file, options.androidSigning));

    const preparedAssets = [];

    for (const { key, ext, targetName } of types) {
      const art = artifacts[key];
      const downloaded = await downloadArtifactZip(art, ghToken, targetDir, fetchFn);
      const extracted = extractTargetFileFromZip(downloaded.zipPath, ext, targetDir);

      const targetPath = resolve(targetDir, targetName);
      // If extracted name differs from targetName, rename
      if (extracted.filePath !== targetPath) {
        const content = await readFile(extracted.filePath);
        await writeFile(targetPath, content, { mode: 0o644 });
        await rm(extracted.filePath).catch(() => {});
      }
      if (key === 'apkRelease') await signApk(targetPath);

      // Compute sha256 and size
      const fHandle = await open(targetPath, 'r');
      const hasher = createHash('sha256');
      let bytes = 0;
      try {
        const stream = fHandle.createReadStream();
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > MAX_FILE_SIZE_BYTES) {
            throw new Error(`File ${targetName} exceeds 1 GiB limit`);
          }
          hasher.update(chunk);
        }
      } finally {
        await fHandle.close();
      }

      const sha256 = hasher.digest('hex');
      preparedAssets.push({
        name: targetName,
        bytes,
        sha256,
        filePath: targetPath,
      });
    }

    // 7. Generate SHA256SUMS
    // Order: deb, apk, exe
    preparedAssets.sort((a, b) => {
      const order = [TARGET_ASSET_NAMES.deb, TARGET_ASSET_NAMES.apk, TARGET_ASSET_NAMES.apkRelease, TARGET_ASSET_NAMES.exe];
      return order.indexOf(a.name) - order.indexOf(b.name);
    });

    const sha256SumsContent = preparedAssets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n';
    const sha256SumsPath = resolve(targetDir, 'SHA256SUMS');
    await writeFile(sha256SumsPath, sha256SumsContent, 'utf8');

    // 8. Generate manifest.json
    const manifestData = {
      version,
      source_sha: sourceSha,
      ci_run: ciRun.id,
      windows_run: windowsRun.id,
      assets: preparedAssets.map(a => ({
        name: a.name,
        bytes: a.bytes,
        sha256: a.sha256,
      })),
    };
    const manifestContent = JSON.stringify(manifestData, null, 2) + '\n';
    const manifestPath = resolve(targetDir, 'manifest.json');
    await writeFile(manifestPath, manifestContent, 'utf8');

    const releaseBody = buildReleaseNotes(version, sourceSha, githubRepo, ciRun.id, windowsRun.id);

    if (prepareOnly) {
      return {
        success: true,
        preparedOnly: true,
        sourceSha,
        version,
        tagName,
        assets: preparedAssets,
        manifest: manifestData,
        outDir: targetDir,
      };
    }

    // 9. Sign the desktop installers for the Tauri updater and publish to R2.
    const signFn = injected.signFn || (file => signUpdaterAsset(file, options.signing));
    const byName = Object.fromEntries(preparedAssets.map(a => [a.name, a]));
    const signatures = {};
    const signatureAssets = [];
    for (const [kind, name] of [['exe', TARGET_ASSET_NAMES.exe], ['deb', TARGET_ASSET_NAMES.deb]]) {
      const signature = signFn(byName[name].filePath);
      const sigPath = `${byName[name].filePath}.sig`;
      await writeFile(sigPath, signature + '\n', { mode: 0o644 });
      signatures[kind] = signature;
      signatureAssets.push({ name: `${name}.sig`, filePath: sigPath });
    }
    const versionUrl = name => publicObjectUrl(r2, `${R2_PREFIX}/v${version}/${name}`);
    const updaterManifest = buildUpdaterManifest(version, sourceSha, new Date().toISOString(),
      { exe: versionUrl(TARGET_ASSET_NAMES.exe), deb: versionUrl(TARGET_ASSET_NAMES.deb) }, signatures, readReleaseSummary());
    const r2Result = await publishToR2(r2, {
      version,
      updaterManifest,
      assets: [
        ...preparedAssets.map(a => ({ name: a.name, filePath: a.filePath, download: true })),
        ...signatureAssets,
        { name: 'SHA256SUMS', filePath: sha256SumsPath },
        { name: 'manifest.json', filePath: manifestPath },
      ],
    }, fetchFn);

    if (githubExisting) {
      return { success: true, tagName, r2: r2Result, github: { skipped: true, reason: githubExisting } };
    }

    // 10. Create draft release
    const createReleaseUrl = `https://api.github.com/repos/${githubRepo}/releases`;
    const createRes = await fetchFn(createReleaseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        tag_name: tagName,
        target_commitish: sourceSha,
        name: `TJUClaw Client ${tagName}`,
        body: releaseBody,
        draft: true,
        prerelease: false,
      }),
      redirect: 'error',
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create draft release on GitHub (HTTP ${createRes.status})`);
    }

    const releaseInfo = await createRes.json();
    const releaseId = releaseInfo.id;
    const uploadUrlRaw = releaseInfo.upload_url.replace(/\{.*?\}$/, '');
    if (uploadUrlRaw !== `https://uploads.github.com/repos/${githubRepo}/releases/${releaseId}/assets`) {
      throw new Error('Unexpected release upload endpoint');
    }

    // 11. Upload assets
    const filesToUpload = [
      ...preparedAssets.map(a => ({ name: a.name, path: a.filePath, contentType: 'application/octet-stream' })),
      { name: 'SHA256SUMS', path: sha256SumsPath, contentType: 'text/plain' },
      { name: 'manifest.json', path: manifestPath, contentType: 'application/json' },
    ];

    for (const f of filesToUpload) {
      const uploadUrl = `${uploadUrlRaw}?name=${encodeURIComponent(f.name)}`;
      const fileData = await readFile(f.path);
      const upRes = await fetchFn(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': f.contentType,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: fileData,
        redirect: 'error',
      }, 120000);

      if (!upRes.ok) {
        throw new Error(`Failed to upload asset "${f.name}" to draft release (HTTP ${upRes.status})`);
      }
    }

    // 12. Publish draft release as latest
    const publishUrl = `https://api.github.com/repos/${githubRepo}/releases/${releaseId}`;
    const pubRes = await fetchFn(publishUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        draft: false,
        make_latest: 'true',
      }),
      redirect: 'error',
    });

    if (!pubRes.ok) {
      throw new Error(`Failed to publish GitHub release #${releaseId} (HTTP ${pubRes.status})`);
    }

    const published = await pubRes.json();

    return {
      success: true,
      releaseId,
      tagName,
      url: published.html_url,
      manifest: manifestData,
      r2: r2Result,
    };
  } catch (err) {
    const clean = sanitizeErrorMessage(err, secrets);
    throw new Error(clean);
  } finally {
    if (cleanupTemp) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let cliSourceSha = process.env.SOURCE_SHA;
  let cliOutDir = process.env.OUT_DIR;
  let cliPrepareOnly = process.env.PREPARE_ONLY === 'true';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source-sha' && args[i + 1]) {
      cliSourceSha = args[++i];
    } else if (args[i] === '--out-dir' && args[i + 1]) {
      cliOutDir = args[++i];
    } else if (args[i] === '--prepare-only') {
      cliPrepareOnly = true;
    }
  }

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const options = {
    sourceSha: cliSourceSha,
    githubRepo: process.env.GITHUB_REPOSITORY || EXPECTED_GITHUB_REPO,
    ghToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    prepareOnly: cliPrepareOnly,
    outDir: cliOutDir,
    ciRunId: process.env.CI_RUN_ID || undefined,
    androidSigning: {
      keystoreBase64: process.env.ANDROID_KEYSTORE_BASE64,
      password: process.env.ANDROID_KEYSTORE_PASSWORD,
    },
    signing: {
      privateKey: process.env.TAURI_SIGNING_PRIVATE_KEY,
      password: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
      cliVersion: pkg.devDependencies?.['@tauri-apps/cli'],
    },
  };

  publishDownloads(options)
    .then(res => {
      if (res.preparedOnly) {
        console.log(`Successfully prepared downloads for commit ${res.sourceSha} (v${res.version}) at ${res.outDir}`);
      } else if (res.skipped) {
        console.log(`Nothing to publish: ${res.reason}. Bump package.json to release a new version.`);
      } else {
        const r2 = res.r2;
        console.log(`R2 ${res.tagName}: ${r2.uploaded ? 'uploaded' : 'already present'}; latest ${r2.promoted ? `moved from ${r2.previous ?? 'none'}` : `kept at ${r2.previous}`}.`);
        console.log(res.github?.skipped ? `GitHub release: ${res.github.reason}` : `GitHub release published: ${res.url}`);
      }
    })
    .catch(err => {
      console.error(`Error publishing downloads: ${err.message}`);
      process.exit(1);
    });
}
