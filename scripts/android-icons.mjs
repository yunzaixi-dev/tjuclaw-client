import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

// android init creates template icons; committed icons must win on clean CI builds too.
export function prepareAndroidIcons(root = defaultRoot) {
  const source = join(root, 'src-tauri/icons/android');
  const target = join(root, 'src-tauri/gen/android/app/src/main/res');
  if (!existsSync(target)) throw new Error('Android project is missing; run tauri android init first');
  cpSync(source, target, { recursive: true });
}
