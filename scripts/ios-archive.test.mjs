import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preserveIosArchive } from './ios-archive.mjs';

test('iOS device and simulator archives remain distinct after sequential builds', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-ios-'));
  const build = join(root, 'build');
  const kept = join(root, 'archives');
  const archive = join(build, 'TJUClaw.xcarchive', 'Products', 'Applications', 'TJUClaw.app');
  try {
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'Info.plist'), 'device');
    const device = preserveIosArchive(build, kept, 'device');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'Info.plist'), 'simulator');
    const simulator = preserveIosArchive(build, kept, 'simulator');
    assert.notEqual(device, simulator);
    assert.deepEqual(readdirSync(kept).sort(), ['device', 'simulator']);
    assert.deepEqual(readdirSync(build).filter(name => name.endsWith('.xcarchive')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iOS archive preservation rejects missing apps and stale destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-ios-'));
  const build = join(root, 'build');
  const kept = join(root, 'archives');
  try {
    mkdirSync(join(build, 'TJUClaw.xcarchive'), { recursive: true });
    assert.throws(() => preserveIosArchive(build, kept, 'device'));
    const app = join(build, 'TJUClaw.xcarchive', 'Products', 'Applications', 'TJUClaw.app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'Info.plist'), 'device');
    preserveIosArchive(build, kept, 'device');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'Info.plist'), 'stale');
    assert.throws(() => preserveIosArchive(build, kept, 'device'), /Refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
