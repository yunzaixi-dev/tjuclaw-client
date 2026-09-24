import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { generatedMainActivity, prepareAndroidInsets } from './android-insets.mjs';

test('Android initialization applies native safe areas and repeated builds preserve them', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-android-insets-'));
  const template = join(root, 'src-tauri/android/MainActivity.kt');
  const generated = join(root, 'src-tauri/gen/android/app/src/main/java/cn/edu/tju/tjuclaw/MainActivity.kt');
  try {
    mkdirSync(dirname(template), { recursive: true });
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(template, 'native-insets');
    writeFileSync(generated, generatedMainActivity);
    assert.equal(prepareAndroidInsets(root), true);
    assert.equal(readFileSync(generated, 'utf8'), 'native-insets');
    assert.equal(prepareAndroidInsets(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android preparation refuses unknown native changes instead of overwriting them', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-android-insets-'));
  const template = join(root, 'src-tauri/android/MainActivity.kt');
  const generated = join(root, 'src-tauri/gen/android/app/src/main/java/cn/edu/tju/tjuclaw/MainActivity.kt');
  try {
    mkdirSync(dirname(template), { recursive: true });
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(template, 'native-insets');
    writeFileSync(generated, 'custom activity');
    assert.throws(() => prepareAndroidInsets(root), /review before replacing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
