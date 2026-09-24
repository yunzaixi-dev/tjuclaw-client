import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));

export function verifyAndroidBadging(badging, config, version, variant) {
  assert.ok(variant === 'debug' || variant === 'release', 'Expected an Android debug or release APK');
  const identity = `${config.identifier}${variant === 'debug' ? config.bundle.android.debugApplicationIdSuffix : ''}`;
  const packageLine = badging.match(/^package: ([^\n]+)$/m)?.[1] ?? '';
  assert.match(packageLine, new RegExp(`(?:^| )name='${identity.replaceAll('.', '\\.')}'(?: |$)`), 'Unexpected Android application ID');
  assert.ok(packageLine.includes(`versionName='${version}'`), 'Unexpected Android version');
  const minSdk = Number(badging.match(/^sdkVersion:'(\d+)'$/m)?.[1]);
  const targetSdk = Number(badging.match(/^targetSdkVersion:'(\d+)'$/m)?.[1]);
  assert.equal(minSdk, config.bundle.android.minSdkVersion, 'Unexpected minimum Android SDK');
  assert.ok(targetSdk >= minSdk, 'Android target SDK must not precede the minimum SDK');
  assert.match(badging, new RegExp(`^launchable-activity: name='${config.identifier.replaceAll('.', '\\.')}\\.MainActivity' `, 'm'),
    'Missing Tauri Android launcher activity');
  assert.match(badging, /^native-code: 'arm64-v8a'$/m, 'Unexpected Android native architecture');
}

function verifyApk(variant) {
  assert.ok(variant === 'debug' || variant === 'release', 'Expected an Android debug or release APK');
  const apk = join(project, `src-tauri/gen/android/app/build/outputs/apk/universal/${variant}`,
    variant === 'debug' ? 'app-universal-debug.apk' : 'app-universal-release-unsigned.apk');
  assert.ok(statSync(apk).size > 0, `Android ${variant} APK is empty`);

  const files = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8' }).trim().split('\n');
  const libraries = files.filter(file => file.startsWith('lib/') && file.endsWith('.so'));
  assert.deepEqual(libraries, ['lib/arm64-v8a/libtjuclaw_client_lib.so'], `${variant} APK must contain only the arm64 native library`);

  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  assert.ok(sdk, 'ANDROID_HOME or ANDROID_SDK_ROOT is required to verify APK signatures and manifest');
  const buildTools = join(sdk, 'build-tools/36.0.0');
  const aapt = join(buildTools, 'aapt');
  const apksigner = join(buildTools, 'apksigner');
  assert.ok(existsSync(aapt), `Missing aapt: ${aapt}`);
  assert.ok(existsSync(apksigner), `Missing apksigner: ${apksigner}`);
  const config = JSON.parse(readFileSync(join(project, 'src-tauri/tauri.conf.json'), 'utf8'));
  const { version } = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  verifyAndroidBadging(execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' }), config, version, variant);
  const signature = spawnSync(apksigner, ['verify', apk], { encoding: 'utf8' });
  assert.ifError(signature.error);
  assert.equal(signature.status === 0, variant === 'debug',
    `Android ${variant} APK ${variant === 'debug' ? 'must have a valid debug signature' : 'must remain unsigned'}: ${signature.stderr}`);
  console.log(`Verified arm64 ${variant} APK identity, launcher, SDK and signature: ${apk}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) verifyApk(process.argv[2]);
