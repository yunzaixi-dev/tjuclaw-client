import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareAndroidIcons } from './android-icons.mjs';

test('Android builds replace generated template launcher resources with tracked brand icons', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-android-icons-'));
  try {
    const source = join(root, 'src-tauri/icons/android/mipmap-mdpi');
    const target = join(root, 'src-tauri/gen/android/app/src/main/res/mipmap-mdpi');
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'ic_launcher.png'), 'brand');
    writeFileSync(join(target, 'ic_launcher.png'), 'default-tauri');
    prepareAndroidIcons(root);
    assert.equal(readFileSync(join(target, 'ic_launcher.png'), 'utf8'), 'brand');
    prepareAndroidIcons(root);
    assert.equal(readFileSync(join(target, 'ic_launcher.png'), 'utf8'), 'brand');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
