import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

export const generatedMainActivity = `package cn.edu.tju.tjuclaw

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;

const previousMainActivity = `package cn.edu.tju.tjuclaw

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }
}
`;

export function prepareAndroidInsets(root = defaultRoot) {
  const template = join(root, 'src-tauri/android/MainActivity.kt');
  const generated = join(root, 'src-tauri/gen/android/app/src/main/java/cn/edu/tju/tjuclaw/MainActivity.kt');
  if (!existsSync(generated)) throw new Error('Android project is missing; run tauri android init first');
  const desired = readFileSync(template, 'utf8');
  const current = readFileSync(generated, 'utf8');
  if (current === desired) return false;
  const keyboardMainActivity = previousMainActivity
    .replace('      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)\n      insets',
      '      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())\n'
      + '      view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))\n'
      + '      // The WebView now fits the unobscured content area. Do not apply system\n'
      + '      // safe areas or the IME a second time inside the web page.\n'
      + '      WindowInsetsCompat.CONSUMED');
  if (current !== generatedMainActivity && current !== previousMainActivity && current !== keyboardMainActivity) {
    throw new Error('Generated MainActivity differs from the expected Tauri template; review before replacing it');
  }
  writeFileSync(generated, desired);
  return true;
}
