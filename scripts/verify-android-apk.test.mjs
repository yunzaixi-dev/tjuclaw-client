import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAndroidBadging } from './verify-android-apk.mjs';

const config = {
  identifier: 'cn.edu.tju.tjuclaw',
  productName: 'TJUClaw',
  bundle: { android: { minSdkVersion: 24, debugApplicationIdSuffix: '.debug' } },
};

function badging(variant = 'debug') {
  return [
    `package: name='cn.edu.tju.tjuclaw${variant === 'debug' ? '.debug' : ''}' versionCode='30' versionName='0.0.30'`,
    "sdkVersion:'24'",
    "targetSdkVersion:'36'",
    "launchable-activity: name='cn.edu.tju.tjuclaw.MainActivity'  label='TJUClaw' icon=''",
    "native-code: 'arm64-v8a'",
  ].join('\n');
}

test('both Android variants expose the correct install identity and launch entry', () => {
  for (const variant of ['debug', 'release']) {
    assert.doesNotThrow(() => verifyAndroidBadging(badging(variant), config, '0.0.30', variant));
  }
});

test('Android package validation rejects a wrong identity, version, SDK, or missing launcher', () => {
  const valid = badging();
  for (const broken of [
    valid.replace('.debug', ''),
    valid.replace("versionName='0.0.30'", "versionName='0.0.29'"),
    valid.replace("sdkVersion:'24'", "sdkVersion:'23'"),
    valid.replace("targetSdkVersion:'36'", "targetSdkVersion:'23'"),
    valid.replace("launchable-activity:", "activity:"),
    valid.replace("MainActivity", "OtherActivity"),
    valid.replace("native-code: 'arm64-v8a'", "native-code: 'x86_64'"),
  ]) {
    assert.throws(() => verifyAndroidBadging(broken, config, '0.0.30', 'debug'));
  }
});
