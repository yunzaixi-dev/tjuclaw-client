import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPe, verifyNsisPayload, verifyWindowsBundle } from './verify-windows-bundle.mjs';

function pe(machine = 0x8664, format = 0x20b, subsystem = 2) {
  const data = Buffer.alloc(256);
  data.write('MZ');
  data.writeUInt32LE(0x80, 0x3c);
  data.write('PE\0\0', 0x80);
  data.writeUInt16LE(machine, 0x84);
  data.writeUInt16LE(72, 0x94);
  data.writeUInt16LE(format, 0x98);
  data.writeUInt16LE(subsystem, 0x98 + 68);
  return data;
}

function nsisInstaller(machine = 0x14c, format = 0x10b, subsystem = 2) {
  const data = Buffer.alloc(512 + 28 + 256);
  pe(machine, format, subsystem).copy(data);
  data.writeUInt32LE(0xdeadbeef, 512 + 4);
  data.write('NullsoftInst', 512 + 8);
  data.writeUInt32LE(64, 512 + 20);
  data.writeUInt32LE(data.length - 512, 512 + 24);
  return data;
}

test('Windows bundle verifies a GUI x64 app and accepts an x86 NSIS stub', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-windows-'));
  const release = join(root, 'src-tauri', 'target', 'release');
  const nsis = join(release, 'bundle', 'nsis');
  try {
    mkdirSync(nsis, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"version":"0.0.30"}');
    const app = join(release, 'tjuclaw-client.exe');
    const installer = join(nsis, 'TJUClaw_0.0.30_x64-setup.exe');
    writeFileSync(app, pe());
    writeFileSync(installer, nsisInstaller());
    assert.deepEqual(verifyWindowsBundle(root), { app, installer });

    writeFileSync(app, pe(0x14c, 0x10b));
    assert.throws(() => verifyWindowsBundle(root), /x64 GUI/);
    writeFileSync(app, pe(0x8664, 0x20b, 3));
    assert.throws(() => verifyWindowsBundle(root), /x64 GUI/);
    writeFileSync(app, pe());
    writeFileSync(installer, Buffer.from('not an installer'));
    assert.throws(() => verifyWindowsBundle(root), /Invalid Windows executable/);
    writeFileSync(installer, nsisInstaller(0x14c, 0x10b, 3));
    assert.throws(() => verifyWindowsBundle(root), /Windows GUI PE stub/);
    writeFileSync(installer, nsisInstaller(0x8664, 0x20b));
    writeFileSync(join(root, 'package.json'), '{"version":"0.0.31"}');
    assert.throws(() => verifyWindowsBundle(root), /Expected one NSIS installer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NSIS payload rejects a PE-only stub, broken marker, and truncated data', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-nsis-'));
  const installer = join(root, 'setup.exe');
  try {
    writeFileSync(installer, pe(0x14c, 0x10b));
    assert.throws(() => verifyNsisPayload(installer), /no complete NSIS payload/);
    const broken = nsisInstaller();
    broken.writeUInt32LE(0, 512 + 4);
    writeFileSync(installer, broken);
    assert.throws(() => verifyNsisPayload(installer), /no complete NSIS payload/);
    writeFileSync(installer, nsisInstaller().subarray(0, -1));
    assert.throws(() => verifyNsisPayload(installer), /no complete NSIS payload/);
    writeFileSync(installer, nsisInstaller());
    assert.doesNotThrow(() => verifyNsisPayload(installer));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PE inspection rejects truncated headers', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-pe-'));
  const path = join(root, 'truncated.exe');
  try {
    writeFileSync(path, pe().subarray(0, 160));
    assert.throws(() => inspectPe(path), /Invalid PE optional header/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
