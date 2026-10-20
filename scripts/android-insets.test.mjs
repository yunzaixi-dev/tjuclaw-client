import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { generatedMainActivity, prepareAndroidInsets } from './android-insets.mjs';

test('Android owns system and keyboard insets once, leaving the WebView a resized content area', () => {
  const source = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(source, /Type\.ime\(\)/);
  assert.match(source, /maxOf\(safe\.bottom, ime\.bottom\)/);
  assert.match(source, /WindowInsetsCompat\.CONSUMED/);
});

test('Android keeps the designed text size as a minimum without suppressing larger system text', () => {
  const source = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(source, /override fun onWebViewCreate\(webView: WebView\)/);
  assert.match(source, /super\.onWebViewCreate\(webView\)/);
  assert.match(source, /textZoom = maxOf\(100,.*fontScale.*100/);
  assert.match(source, /override fun onConfigurationChanged/);
});

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

test('Android upgrades the tracked keyboard-insets Activity without touching unknown code', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-android-text-'));
  const template = join(root, 'src-tauri/android/MainActivity.kt');
  const generated = join(root, 'src-tauri/gen/android/app/src/main/java/cn/edu/tju/tjuclaw/MainActivity.kt');
  const source = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8');
  const previous = source
    .replace('import android.content.res.Configuration\n', '')
    .replace('import android.webkit.WebView\n', '')
    .replace(/ {2}private var productWebView[\s\S]*?(?= {2}override fun onCreate)/, '');
  try {
    mkdirSync(dirname(template), { recursive: true });
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(template, source);
    writeFileSync(generated, previous);
    assert.equal(prepareAndroidInsets(root), true);
    assert.equal(readFileSync(generated, 'utf8'), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
