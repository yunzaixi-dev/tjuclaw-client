import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEdgeoneConfig } from './edgeone-config.mjs';

const generator = fileURLToPath(new URL('./edgeone-config.mjs', import.meta.url));

test('EdgeOne SPA fallback and sandbox connect-src use exact origins', () => {
  const config = createEdgeoneConfig('https://sandbox.example.invalid');
  assert.deepEqual(config.rewrites, [{ source: '/*', destination: '/index.html' }]);
  assert.equal(config.outputDirectory, 'assets');
  assert.equal(config.headers[0].source, '/*');
  const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.match(headers['Content-Security-Policy'], /connect-src 'self' https:\/\/sandbox\.example\.invalid;/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /connect-src[^;]*(?:\*|'unsafe-inline'|https:;)/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /worker-src 'self'/);
  assert.deepEqual(config.headers[1], { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] });
  assert.match(createEdgeoneConfig().headers[0].headers[0].value, /connect-src 'self';/);
  for (const invalid of [
    'http://sandbox.example.invalid', 'https://sandbox.example.invalid/',
    'https://sandbox.example.invalid/path', 'https://sandbox.example.invalid?x=1',
    'https://user@sandbox.example.invalid', 'https://sandbox.example.invalid#fragment',
    "https://sandbox.example.invalid' *", 'https://sandbox.example.invalid:bad',
  ]) {
    assert.throws(() => createEdgeoneConfig(invalid), /exact HTTPS origin/);
  }
});

test('production CSP permits local image previews without granting executable blob URLs', () => {
  const csp = createEdgeoneConfig().headers[0].headers[0].value;
  const directives = new Map(csp.split(';').map(value => {
    const [name, ...sources] = value.trim().split(/\s+/);
    return [name, sources];
  }));
  assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'blob:', 'https:']);
  assert.deepEqual(directives.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
});

test('deployment generator writes the tested configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tjuclaw-edgeone-'));
  try {
    const target = join(dir, 'edgeone.json');
    const direct = join(dir, 'direct-upload.json');
    execFileSync(process.execPath, [generator, target], {
      env: { ...process.env, EDGEONE_SANDBOX_ORIGIN: 'https://sandbox.example.invalid' },
    });
    execFileSync(process.execPath, [generator, direct, '--direct-upload'], {
      env: { ...process.env, EDGEONE_SANDBOX_ORIGIN: 'https://sandbox.example.invalid' },
    });
    const config = createEdgeoneConfig('https://sandbox.example.invalid');
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), config);
    const { outputDirectory, ...upload } = config;
    assert.equal(outputDirectory, 'assets');
    assert.deepEqual(JSON.parse(await readFile(direct, 'utf8')), upload);
    assert.throws(() => execFileSync(process.execPath, [generator, target], { stdio: 'ignore' }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
