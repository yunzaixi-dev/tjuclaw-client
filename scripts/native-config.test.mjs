import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

test('mobile windows start at the product origin rather than the bundled proxy-less page', () => {
  for (const platform of ['android', 'ios']) {
    const mobileConfig = JSON.parse(readFileSync(new URL(`../src-tauri/tauri.${platform}.conf.json`, import.meta.url), 'utf8'));
    assert.equal(mobileConfig.app.windows[0].url, 'https://app.tjuclaw.cloud/workspace');
    assert.equal(mobileConfig.app.windows[0].label, 'main');
  }
  const mobile = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/mobile-app.json', import.meta.url), 'utf8'));
  assert.deepEqual(mobile.platforms, ['android', 'iOS']);
  assert.deepEqual(mobile.remote.urls, ['https://app.tjuclaw.cloud/*']);
  assert.deepEqual(mobile.permissions, [
    'core:app:allow-version', 'allow-store-get', 'allow-store-set', 'allow-store-delete', 'allow-store-list',
  ]);
});

test('native bundles select host-specific targets rather than restricting macOS to deb and nsis', () => {
  assert.equal(config.bundle.targets, undefined);
  assert.ok(config.bundle.icon.includes('icons/icon.icns'));
  assert.ok(config.bundle.icon.includes('icons/icon.ico'));
});

test('native WebViews permit inline captcha fonts without loosening script or network policy', () => {
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    assert.match(policy, /(?:^|; )font-src 'self' data:;/);
    assert.match(policy, /(?:^|; )script-src 'self' 'wasm-unsafe-eval';/);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  }
});

test('native image previews allow object URLs without granting executable blob URLs', () => {
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    assert.match(policy, /(?:^|; )img-src[^;]*\bblob:/);
    assert.doesNotMatch(policy, /(?:^|; )script-src[^;]*\bblob:/);
    assert.doesNotMatch(policy, /(?:^|; )connect-src[^;]*\bblob:/);
    assert.match(policy, /(?:^|; )object-src 'none';/);
  }
});
