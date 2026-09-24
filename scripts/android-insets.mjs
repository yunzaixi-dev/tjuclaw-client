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

export function prepareAndroidInsets(root = defaultRoot) {
  const template = join(root, 'src-tauri/android/MainActivity.kt');
  const generated = join(root, 'src-tauri/gen/android/app/src/main/java/cn/edu/tju/tjuclaw/MainActivity.kt');
  if (!existsSync(generated)) throw new Error('Android project is missing; run tauri android init first');
  const desired = readFileSync(template, 'utf8');
  const current = readFileSync(generated, 'utf8');
  if (current === desired) return false;
  if (current !== generatedMainActivity) {
    throw new Error('Generated MainActivity differs from the expected Tauri template; review before replacing it');
  }
  writeFileSync(generated, desired);
  return true;
}
