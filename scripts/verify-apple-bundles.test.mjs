import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyIosArchives, verifyMacosApp } from './verify-apple-bundles.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-apple-bundles-'));
  const createApp = (path, platform) => {
    const content = platform === 'macos' ? join(path, 'Contents') : path;
    const binary = platform === 'macos' ? join(content, 'MacOS', 'TJUClaw') : join(content, 'TJUClaw');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(join(content, 'Info.plist'), 'fixture');
    writeFileSync(binary, 'fixture');
    return path;
  };
  const run = (command, args) => {
    if (command === '/usr/libexec/PlistBuddy') {
      if (args[0] !== '-c') throw new Error(`Unexpected plist command: ${args.join(' ')}`);
      if (args[1] === 'Print :CFBundleExecutable') return 'TJUClaw';
      if (args[1] === 'Print :DTPlatformName') {
        return args[2].includes('/simulator/') ? 'iphonesimulator' : 'iphoneos';
      }
      throw new Error(`Unexpected plist key: ${args[1]}`);
    }
    if (command !== 'xcrun' || args[0] !== 'lipo' || !args[1].endsWith('/TJUClaw') || args[2] !== '-verify_arch') {
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    }
    return '';
  };
  return { root, createApp, run };
}

test('macOS bundle requires a real universal executable', () => {
  const { root, createApp, run } = fixture();
  try {
    const app = createApp(join(root, 'TJUClaw.app'), 'macos');
    const binary = join(app, 'Contents', 'MacOS', 'TJUClaw');
    const calls = [];
    assert.equal(verifyMacosApp(app, (command, args) => {
      calls.push([command, args]);
      return run(command, args);
    }), binary);
    assert.deepEqual(calls[0], ['/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents', 'Info.plist')]]);
    assert.deepEqual(calls.at(-1), ['xcrun', ['lipo', binary, '-verify_arch', 'arm64', 'x86_64']]);
    rmSync(binary);
    assert.throws(() => verifyMacosApp(app, run), /Missing app executable/);
    writeFileSync(binary, 'fixture');
    rmSync(join(app, 'Contents', 'Info.plist'));
    assert.throws(() => verifyMacosApp(app, run), /Missing app Info.plist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iOS archives verify device and simulator platforms separately', () => {
  const { root, createApp, run } = fixture();
  try {
    const device = createApp(join(root, 'device/TJUClaw.xcarchive/Products/Applications/TJUClaw.app'), 'ios');
    const simulator = createApp(join(root, 'simulator/TJUClaw.xcarchive/Products/Applications/TJUClaw.app'), 'ios');
    assert.deepEqual(verifyIosArchives(root, run), [join(device, 'TJUClaw'), join(simulator, 'TJUClaw')]);
    assert.throws(() => verifyIosArchives(root, (command, args) => {
      if (command === '/usr/libexec/PlistBuddy' && args[1].includes('DTPlatformName')) return 'iphoneos';
      return run(command, args);
    }), /Expected iphonesimulator for simulator/);
    assert.throws(() => verifyIosArchives(root, (command, args) => {
      if (command === 'xcrun' && args[1].includes('/simulator/')) throw new Error('wrong architecture');
      return run(command, args);
    }), /wrong architecture/);
    rmSync(join(simulator, 'TJUClaw'));
    assert.throws(() => verifyIosArchives(root, run), /Missing app executable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
