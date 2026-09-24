import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runTool(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function executableInApp(app, platform, run) {
  const plist = platform === 'macos' ? join(app, 'Contents', 'Info.plist') : join(app, 'Info.plist');
  if (!existsSync(plist)) throw new Error(`Missing app Info.plist: ${plist}`);
  const name = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid CFBundleExecutable in ${plist}`);
  }
  const binary = platform === 'macos' ? join(app, 'Contents', 'MacOS', name) : join(app, name);
  if (!existsSync(binary)) throw new Error(`Missing app executable: ${binary}`);
  return { binary, plist };
}

export function verifyMacosApp(app, run = runTool) {
  const { binary } = executableInApp(app, 'macos', run);
  run('xcrun', ['lipo', '-verify_arch', 'arm64', 'x86_64', binary]);
  return binary;
}

export function verifyIosArchives(root, run = runTool) {
  const verified = [];
  for (const [target, platform] of [['device', 'iphoneos'], ['simulator', 'iphonesimulator']]) {
    const folder = join(root, target);
    const archives = readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.xcarchive'));
    if (archives.length !== 1) throw new Error(`Expected one ${target} archive, found ${archives.length}`);
    const appsDir = join(folder, archives[0].name, 'Products', 'Applications');
    const apps = readdirSync(appsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`Expected one ${target} app, found ${apps.length}`);
    const { binary, plist } = executableInApp(join(appsDir, apps[0].name), 'ios', run);
    const actualPlatform = run('/usr/libexec/PlistBuddy', ['-c', 'Print :DTPlatformName', plist]);
    if (actualPlatform !== platform) {
      throw new Error(`Expected ${platform} for ${target}, got ${actualPlatform}`);
    }
    run('xcrun', ['lipo', '-verify_arch', 'arm64', binary]);
    verified.push(binary);
  }
  return verified;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const mode = process.argv[2];
  const verified = mode === 'macos'
    ? [verifyMacosApp(join(root, 'src-tauri/target/universal-apple-darwin/release/bundle/macos/TJUClaw.app'))]
    : mode === 'ios'
      ? verifyIosArchives(join(root, 'src-tauri/gen/apple/archives'))
      : null;
  if (!verified) throw new Error('Expected macos or ios');
  console.log(`Verified Apple bundle executable(s): ${verified.join(', ')}`);
}
