import { URL, fileURLToPath } from 'node:url';
import { open, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const ALLOWED_GITLAB_HOSTS = new Set(['gitlab.tju.edu.cn']);
export const ALLOWED_PROJECT_ID = '145';
export const EXPECTED_GITHUB_REPO = 'yunzaixi-dev/tjuclaw-client';
export const PACKAGE_NAME = 'tjuclaw-client';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const VALID_SHA_REGEX = /^[0-9a-f]{40}$/;
export const VALID_SHA256_REGEX = /^[0-9a-f]{64}$/;
export const VALID_FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export const EXPECTED_WORKFLOWS = ['CI', 'Windows Installer'];

/**
 * Validates a 40-character hexadecimal SHA.
 */
export function validateSha(sha, fieldName = 'source_sha') {
  if (typeof sha !== 'string' || !VALID_SHA_REGEX.test(sha)) {
    throw new Error(`Invalid ${fieldName}: must be a 40-character hexadecimal string`);
  }
  return sha;
}

/**
 * Validates a 64-character hexadecimal SHA256 string.
 */
export function validateSha256(hash, fieldName = 'sha256') {
  if (typeof hash !== 'string' || !VALID_SHA256_REGEX.test(hash)) {
    throw new Error(`Invalid ${fieldName}: must be a 64-character hexadecimal string`);
  }
  return hash;
}

/**
 * Validates and normalizes GitLab URL. Strictly https://gitlab.tju.edu.cn.
 */
export function validateGitLabUrl(rawUrl) {
  const parsed = new URL(rawUrl || 'https://gitlab.tju.edu.cn');
  if (parsed.protocol !== 'https:') {
    throw new Error(`GitLab URL protocol must be https: got ${parsed.protocol}`);
  }
  if (!ALLOWED_GITLAB_HOSTS.has(parsed.host)) {
    throw new Error(`GitLab host ${parsed.host} is not allowed; must be one of: ${[...ALLOWED_GITLAB_HOSTS].join(', ')}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('GitLab URL must contain only the allowed HTTPS origin');
  }
  return parsed.origin;
}

function validatedGitHubApiUrl(raw) {
  const url = new URL(raw);
  if (url.origin !== 'https://api.github.com' || url.username || url.password
    || !url.pathname.startsWith(`/repos/${EXPECTED_GITHUB_REPO}/actions/`)) {
    throw new Error('Unexpected authenticated GitHub API endpoint');
  }
  return url.href;
}

/**
 * Validates GitLab project ID. Strictly '145'.
 */
export function validateProjectId(id) {
  const normalized = String(id ?? ALLOWED_PROJECT_ID);
  if (normalized !== ALLOWED_PROJECT_ID) {
    throw new Error(`Invalid GITLAB_PROJECT_ID: ${normalized}; expected ${ALLOWED_PROJECT_ID}`);
  }
  return normalized;
}

/**
 * Validates GitHub repository name.
 */
export function validateGitHubRepo(repo) {
  const normalized = String(repo || '').trim();
  if (normalized !== EXPECTED_GITHUB_REPO) {
    throw new Error(`Invalid GITHUB_REPOSITORY: "${normalized}"; expected "${EXPECTED_GITHUB_REPO}"`);
  }
  return normalized;
}

/**
 * Sanitizes errors so that secrets, tokens, or signed URLs are not leaked in log messages.
 */
export function sanitizeErrorMessage(err, secretsToRedact = []) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secretsToRedact) {
    if (secret && typeof secret === 'string' && secret.length > 3) {
      msg = msg.replaceAll(secret, '[REDACTED]');
    }
  }
  // Redact token patterns
  msg = msg.replace(/(?:glpat-|ghp_|github_pat_|bearer\s+)[A-Za-z0-9_.-]+/gi, '[REDACTED]');
  // Redact URLs containing signatures / SAS tokens / sensitive query strings
  msg = msg.replace(/https:\/\/[^\s"'<>]+(?:\?|&)(?:sig|token|se|sp|sv|Signature|Key-Pair-Id)=[^\s"'<>]+/gi, '[REDACTED_URL]');
  return msg;
}

/**
 * Validates whether download URL host is an allowed GitHub / Azure artifact domain.
 */
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

/**
 * Timed fetch wrapper with strict timeout.
 */
export async function timedFetch(url, options = {}, timeoutMs = 30000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Stream sha256 calculation up to maxBytes.
 */
export async function streamSha256(stream, maxBytes = MAX_FILE_SIZE_BYTES) {
  const hasher = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of stream) {
    bytesRead += chunk.length;
    if (bytesRead > maxBytes) {
      throw new Error(`Stream size exceeded maximum allowed limit of ${maxBytes} bytes`);
    }
    hasher.update(chunk);
  }
  return hasher.digest('hex');
}

/**
 * Finds matching workflow runs for the given source SHA, push event, and main branch.
 * Rejects if the newest run for a required workflow failed.
 */
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
    // Filter runs matching workflow name, push event, head_sha, branch main, and head repo
    const matchingRuns = runs.filter(r =>
      r.name === wfName &&
      r.event === 'push' &&
      r.head_branch === 'release' &&
      r.head_sha === sourceSha &&
      r.head_repository?.full_name === githubRepo
    );

    if (matchingRuns.length === 0) {
      throw new Error(`No workflow run found for workflow "${wfName}" at commit ${sourceSha}`);
    }

    // Sort descending by run attempt or run ID (or created_at)
    matchingRuns.sort((a, b) => b.id - a.id);
    const newestRun = matchingRuns[0];

    if (newestRun.status !== 'completed' || newestRun.conclusion !== 'success') {
      throw new Error(
        `Latest run #${newestRun.id} for workflow "${wfName}" is not successful (status: ${newestRun.status}, conclusion: ${newestRun.conclusion})`
      );
    }

    selectedRuns[wfName] = newestRun;
  }

  return selectedRuns;
}

/**
 * Queries and verifies artifacts for the selected workflow runs.
 * Matches linux-SHA, android-debug-SHA, windows-unsigned-SHA.
 */
export async function resolveArtifactsForSha(sourceSha, githubRepo, selectedRuns, ghToken, fetchFn = timedFetch) {
  const expectedArtifactNames = {
    deb: `linux-${sourceSha}`,
    apk: `android-debug-${sourceSha}`,
    exe: `windows-unsigned-${sourceSha}`,
  };

  const artifactsFound = {};

  for (const [, run] of Object.entries(selectedRuns)) {
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

/**
 * Downloads artifact ZIP from GitHub Actions API.
 * Handles manual redirect, strips auth token for cross-host location, validates domain and size limit.
 */
export async function downloadArtifactZip(artifact, ghToken, tempDir, fetchFn = timedFetch) {
  const zipPath = resolve(tempDir, `${artifact.name}.zip`);
  const initialUrl = validatedGitHubApiUrl(artifact.archive_download_url);
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || artifact.expired) {
    throw new Error('Artifact must have a valid GitHub SHA-256 digest and remain available');
  }

  // GitHub returns 302 redirect with Location
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

  // Verify digest if provided in artifact metadata (digest format e.g. "sha256:hex")
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

/**
 * Extracts a single expected file extension (.deb, .apk, or .exe) from artifact ZIP using Python's zipfile.
 * Rejects path traversal, symlinks, directory entries, multiple candidate files.
 * Extracts using explicit basename into outDir.
 */
export function extractTargetFileFromZip(zipPath, expectedExt, outDir) {
  if (!['.deb', '.apk', '.exe'].includes(expectedExt)) {
    throw new Error(`Invalid expected extension "${expectedExt}"`);
  }

  // Python script to safely inspect and extract exactly one file matching expectedExt
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
        # Check for path traversal or malicious characters
        name = info.filename
        if '..' in name or name.startswith('/') or name.startswith('\\\\'):
            sys.stderr.write(f"Path traversal detected: {name}\\n")
            sys.exit(2)
        # Check file attributes for symlinks (Unix mode upper 4 bits == 0o12)
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
    # Extract only to out_dir using basename only
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

/**
 * Retrieves client package.json version via GitHub API for given ref SHA.
 */
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

/**
 * Checks existing package file in GitLab Generic Package Registry.
 * Uses DEPLOY-TOKEN header.
 */
export async function checkExistingGitLabFile(fileUrl, deployToken, expectedSha256, fetchFn = timedFetch) {
  const headRes = await fetchFn(fileUrl, {
    method: 'HEAD',
    headers: { 'DEPLOY-TOKEN': deployToken },
    redirect: 'error',
  });

  if (headRes.status === 404) {
    return { exists: false };
  }

  if (headRes.status === 200) {
    const headerSha = headRes.headers?.get?.('x-checksum-sha256');
    if (headerSha && headerSha === expectedSha256) {
      return { exists: true, sha256: headerSha, match: true };
    }

    const getRes = await fetchFn(fileUrl, {
      method: 'GET',
      headers: { 'DEPLOY-TOKEN': deployToken },
      redirect: 'error',
    });

    if (!getRes.ok) {
      throw new Error(`Failed to retrieve existing package file for checksum comparison (HTTP ${getRes.status})`);
    }

    const remoteHash = await streamSha256(getRes.body);
    const match = remoteHash === expectedSha256;
    return { exists: true, sha256: remoteHash, match };
  }

  if (headRes.status === 401 || headRes.status === 403) {
    throw new Error(`GitLab deploy token authentication failed checking file (HTTP ${headRes.status})`);
  }

  throw new Error(`Unexpected HTTP status checking existing file in GitLab: ${headRes.status}`);
}

/**
 * Uploads a local file or buffer to GitLab Generic Package Registry.
 * Checks for existing file, skips on match, rejects on mismatch.
 */
export async function uploadToGitLabGenericRegistry({
  gitlabUrl,
  projectId,
  packageName = PACKAGE_NAME,
  versionOrSha,
  fileName,
  filePath = null,
  buffer = null,
  expectedSha256,
  deployToken,
  fetchFn = timedFetch,
}) {
  if (!VALID_FILENAME_REGEX.test(fileName) || fileName !== basename(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`Invalid filename for upload: "${fileName}"`);
  }

  validateSha256(expectedSha256);
  const targetUrl = `${gitlabUrl}/api/v4/projects/${projectId}/packages/generic/${packageName}/${versionOrSha}/${encodeURIComponent(fileName)}`;

  // 1. Check existing
  const existing = await checkExistingGitLabFile(targetUrl, deployToken, expectedSha256, fetchFn);
  if (existing.exists) {
    if (existing.match) {
      return { skipped: true, fileName, url: targetUrl, sha256: expectedSha256 };
    }
    throw new Error(
      `File "${fileName}" already exists at version/sha "${versionOrSha}" with differing SHA256 (${existing.sha256} vs expected ${expectedSha256}). Refusing to overwrite.`
    );
  }

  // 2. Perform upload
  let bodyStream;
  let fileHandle = null;

  try {
    if (filePath) {
      fileHandle = await open(filePath, 'r');
      bodyStream = fileHandle.createReadStream();
    } else if (buffer) {
      bodyStream = buffer;
    } else {
      throw new Error('Either filePath or buffer must be provided for upload');
    }

    const putRes = await fetchFn(targetUrl, {
      method: 'PUT',
      headers: {
        'DEPLOY-TOKEN': deployToken,
        'Content-Type': 'application/octet-stream',
      },
      body: bodyStream,
      duplex: 'half',
      redirect: 'error',
    }, 120000); // 120s timeout for file upload

    if (putRes.status === 201 || putRes.status === 200) {
      return { uploaded: true, fileName, url: targetUrl, sha256: expectedSha256 };
    }

    if (putRes.status === 409) {
      // Possible concurrent upload; re-verify checksum
      const recheck = await checkExistingGitLabFile(targetUrl, deployToken, expectedSha256, fetchFn);
      if (recheck.exists && recheck.match) {
        return { skipped: true, fileName, url: targetUrl, sha256: expectedSha256 };
      }
      throw new Error(`Upload conflict (HTTP 409) for "${fileName}" and remote checksum does not match`);
    }

    throw new Error(`GitLab upload failed for "${fileName}" (HTTP ${putRes.status})`);
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

/**
 * Main staging orchestrator.
 */
export async function stageGitLabPackages(options, injected = {}) {
  const fetchFn = injected.fetchFn || timedFetch;
  const secrets = [];

  const sourceSha = validateSha(options.sourceSha, 'SOURCE_SHA');
  const gitlabUrl = validateGitLabUrl(options.gitlabUrl);
  const projectId = validateProjectId(options.projectId);
  const githubRepo = validateGitHubRepo(options.githubRepo);

  const ghToken = options.ghToken;
  if (!ghToken) {
    throw new Error('Missing GH_TOKEN (or GITHUB_TOKEN)');
  }
  secrets.push(ghToken);

  const gitlabPackageToken = options.gitlabPackageToken;
  if (!gitlabPackageToken) {
    throw new Error('Missing GITLAB_PACKAGE_TOKEN');
  }
  secrets.push(gitlabPackageToken);

  const tempDir = options.tempDir || await mkdtemp(resolve(tmpdir(), 'tjuclaw-stage-'));
  const cleanupTemp = !options.tempDir;

  try {
    // 1. Fetch package version from GitHub
    const version = await fetchPackageVersionFromGitHub(sourceSha, githubRepo, ghToken, fetchFn);

    // 2. Find successful workflow runs
    const runs = await findSuccessfulWorkflowRuns(sourceSha, githubRepo, ghToken, fetchFn);

    // 3. Resolve artifacts (deb, apk, exe)
    const artifacts = await resolveArtifactsForSha(sourceSha, githubRepo, runs, ghToken, fetchFn);

    // 4. Download and extract each artifact
    const types = [
      { key: 'deb', ext: '.deb' },
      { key: 'apk', ext: '.apk' },
      { key: 'exe', ext: '.exe' },
    ];

    const stagedFiles = [];

    for (const { key, ext } of types) {
      const art = artifacts[key];
      const downloaded = await downloadArtifactZip(art, ghToken, tempDir, fetchFn);
      const extracted = extractTargetFileFromZip(downloaded.zipPath, ext, tempDir);

      // Verify extracted file and compute sha256
      const fHandle = await open(extracted.filePath, 'r');
      const hasher = createHash('sha256');
      let size = 0;
      try {
        const stream = fHandle.createReadStream();
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_FILE_SIZE_BYTES) {
            throw new Error(`Extracted file ${extracted.fileName} exceeds 1 GiB limit`);
          }
          hasher.update(chunk);
        }
      } finally {
        await fHandle.close();
      }

      const fileSha256 = hasher.digest('hex');
      stagedFiles.push({
        type: key,
        name: extracted.fileName,
        path: extracted.filePath,
        size,
        sha256: fileSha256,
      });
    }

    // Sort files deterministically by name
    stagedFiles.sort((a, b) => a.name.localeCompare(b.name));

    // 5. Upload files to GitLab Generic Package Registry under tjuclaw-client/<source_sha>/
    const uploadResults = [];
    for (const fileItem of stagedFiles) {
      const res = await uploadToGitLabGenericRegistry({
        gitlabUrl,
        projectId,
        packageName: PACKAGE_NAME,
        versionOrSha: sourceSha,
        fileName: fileItem.name,
        filePath: fileItem.path,
        expectedSha256: fileItem.sha256,
        deployToken: gitlabPackageToken,
        fetchFn,
      });
      uploadResults.push(res);
    }

    // 6. Upload manifest.json LAST as completion marker
    const manifestData = {
      source_sha: sourceSha,
      version,
      files: stagedFiles.map(f => ({
        name: f.name,
        sha256: f.sha256,
        size: f.size,
      })),
    };

    const manifestBuffer = Buffer.from(JSON.stringify(manifestData, null, 2), 'utf8');
    const manifestSha256 = createHash('sha256').update(manifestBuffer).digest('hex');

    const manifestRes = await uploadToGitLabGenericRegistry({
      gitlabUrl,
      projectId,
      packageName: PACKAGE_NAME,
      versionOrSha: sourceSha,
      fileName: 'manifest.json',
      buffer: manifestBuffer,
      expectedSha256: manifestSha256,
      deployToken: gitlabPackageToken,
      fetchFn,
    });
    uploadResults.push(manifestRes);

    return {
      success: true,
      sourceSha,
      version,
      files: stagedFiles,
      manifest: manifestData,
      uploadResults,
    };
  } catch (err) {
    const cleanMsg = sanitizeErrorMessage(err, secrets);
    throw new Error(cleanMsg);
  } finally {
    if (cleanupTemp) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = {
    sourceSha: process.env.SOURCE_SHA,
    gitlabUrl: process.env.GITLAB_URL,
    projectId: process.env.GITLAB_PROJECT_ID,
    githubRepo: process.env.GITHUB_REPOSITORY,
    ghToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    gitlabPackageToken: process.env.GITLAB_PACKAGE_TOKEN,
  };

  stageGitLabPackages(options)
    .then((res) => {
      console.log(`Successfully staged ${res.files.length} packages and manifest.json for ${res.sourceSha} (v${res.version})`);
      for (const f of res.files) {
        console.log(`- ${f.name} (${f.size} bytes, sha256: ${f.sha256})`);
      }
    })
    .catch((err) => {
      console.error(`Error staging packages: ${err.message}`);
      process.exit(1);
    });
}
