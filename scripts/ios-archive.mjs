import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function preserveIosArchive(buildDir, destination, target) {
  if (!['device', 'simulator'].includes(target)) throw new Error(`Unknown iOS target: ${target}`);
  const archives = readdirSync(buildDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.xcarchive'));
  if (archives.length !== 1) throw new Error(`Expected one fresh iOS archive in ${buildDir}, found ${archives.length}`);

  const archive = join(buildDir, archives[0].name);
  const applications = join(archive, 'Products', 'Applications');
  const apps = readdirSync(applications, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  if (apps.length !== 1 || !existsSync(join(applications, apps[0].name, 'Info.plist'))) {
    throw new Error(`iOS archive ${archive} does not contain one valid app`);
  }

  mkdirSync(destination, { recursive: true });
  const preserved = join(destination, target, archives[0].name);
  if (existsSync(preserved)) throw new Error(`Refusing to overwrite existing iOS archive: ${preserved}`);
  mkdirSync(join(destination, target), { recursive: true });
  renameSync(archive, preserved);
  return preserved;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const target = process.argv[2];
  const appleDir = fileURLToPath(new URL('../src-tauri/gen/apple/', import.meta.url));
  console.log(`Preserved ${target} iOS archive at ${preserveIosArchive(join(appleDir, 'build'), join(appleDir, 'archives'), target)}`);
}
