import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

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
