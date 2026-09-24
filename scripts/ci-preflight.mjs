import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const profile = process.argv[2];
if (!['linux', 'android', 'windows', 'macos', 'ios', 'portable'].includes(profile)) {
  throw new Error('Usage: node scripts/ci-preflight.mjs linux|android|windows|macos|ios|portable');
}
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
let failed = false;
function check(label, ok) {
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
}
function command(name, args, pattern) {
  const result = spawnSync(name, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const ok = !result.error && result.status === 0 && (!pattern || pattern.test(output));
  check(`${name} ${args.join(' ')}`, ok);
  return ok ? output : '';
}
check('Node 24 toolchain', Number(process.versions.node.split('.')[0]) === 24);
check('host platform', process.platform === (profile === 'windows' ? 'win32' : ['macos', 'ios'].includes(profile) ? 'darwin' : 'linux'));
const pnpm = command('pnpm', ['--version']).trim();
check('pnpm matches packageManager', `pnpm@${pnpm}` === pkg.packageManager);
command('task', ['--version'], /\b(?:v)?3\.49\.1\b/);
command('git', ['--version']);
if (profile !== 'portable') {
  command('rustc', ['--version']);
  command('cargo', ['--version']);
  command('rustup', ['--version']);
}
if (profile === 'linux') {
  command('pkg-config', ['--exists', 'webkit2gtk-4.1', 'gtk+-3.0', 'openssl', 'librsvg-2.0', 'ayatana-appindicator3-0.1']);
  command('cc', ['--version']);
  command('patchelf', ['--version']);
}
if (profile === 'android') {
  command('java', ['-version']);
  const sdk = process.env.ANDROID_HOME;
  const ndk = process.env.NDK_HOME;
  check('ANDROID_HOME contains SDK 36 and build-tools 35.0.0/36.0.0', Boolean(sdk &&
    existsSync(join(sdk, 'platforms/android-36/android.jar')) &&
    existsSync(join(sdk, 'build-tools/35.0.0/aapt2')) &&
    existsSync(join(sdk, 'build-tools/36.0.0/aapt2'))));
  check('NDK_HOME contains NDK 27.2.12479018', Boolean(ndk &&
    existsSync(join(ndk, 'source.properties')) &&
    /Pkg\.Revision\s*=\s*27\.2\.12479018\b/.test(readFileSync(join(ndk, 'source.properties'), 'utf8'))));
  command('rustup', ['target', 'list', '--installed'], /^aarch64-linux-android$/m);
}
if (profile === 'windows') {
  command('rustc', ['-vV'], /host: x86_64-pc-windows-msvc/);
}
if (profile === 'macos' || profile === 'ios') {
  command('xcode-select', ['-p']);
  command('xcodebuild', ['-version'], /Xcode \d+/);
  command('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  const targets = command('rustup', ['target', 'list', '--installed']);
  const required = profile === 'macos'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    : ['aarch64-apple-ios', 'aarch64-apple-ios-sim'];
  for (const target of required) check(`${target} Rust target`, targets.split(/\s+/).includes(target));
}
if (profile === 'ios') {
  check('Apple Silicon host for arm64 simulator', process.arch === 'arm64');
  command('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path']);
  command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  command('xcodegen', ['--version']);
  command('pod', ['--version']);
}
process.exitCode = failed ? 1 : 0;
