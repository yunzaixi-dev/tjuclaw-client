import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectPe(path) {
  const data = readFileSync(path);
  if (data.length < 0x40 || data.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`Invalid Windows executable: ${path}`);
  }
  const header = data.readUInt32LE(0x3c);
  if (header < 0x40 || header + 26 > data.length || data.toString('ascii', header, header + 4) !== 'PE\0\0') {
    throw new Error(`Invalid PE header: ${path}`);
  }
  const machine = data.readUInt16LE(header + 4);
  const optionalSize = data.readUInt16LE(header + 20);
  const optional = header + 24;
  if (optionalSize < 70 || optional + optionalSize > data.length) {
    throw new Error(`Invalid PE optional header: ${path}`);
  }
  return {
    machine,
    format: data.readUInt16LE(optional),
    subsystem: data.readUInt16LE(optional + 68),
  };
}

export function verifyNsisPayload(path) {
  const data = readFileSync(path);
  const marker = Buffer.from('NullsoftInst');
  for (let pos = data.indexOf(marker); pos !== -1; pos = data.indexOf(marker, pos + 1)) {
    const start = pos - 8;
    if (start < 0 || pos + 20 > data.length || data.readUInt32LE(pos - 4) !== 0xdeadbeef) continue;
    const headerLength = data.readUInt32LE(pos + 12);
    const totalLength = data.readUInt32LE(pos + 16);
    if (headerLength > 0 && totalLength >= 28 + headerLength && start + totalLength === data.length) return;
  }
  throw new Error(`Windows installer has no complete NSIS payload: ${path}`);
}

export function verifyWindowsBundle(project) {
  const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
  const app = join(project, 'src-tauri', 'target', 'release', 'tjuclaw-client.exe');
  const executable = inspectPe(app);
  if (executable.machine !== 0x8664 || executable.format !== 0x20b || executable.subsystem !== 2) {
    throw new Error('Windows application must be an x64 GUI PE32+ executable');
  }
  const folder = join(project, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const installers = readdirSync(folder).filter(name => name.endsWith('.exe') && name.includes(version));
  if (installers.length !== 1) throw new Error(`Expected one NSIS installer for ${version}, found ${installers.length}`);
  const installer = join(folder, installers[0]);
  if (statSync(installer).size === 0) throw new Error('NSIS installer is empty');
  const stub = inspectPe(installer);
  if (![0x14c, 0x8664].includes(stub.machine) || ![0x10b, 0x20b].includes(stub.format) || stub.subsystem !== 2) {
    throw new Error('NSIS installer must have a Windows GUI PE stub');
  }
  verifyNsisPayload(installer);
  return { app, installer };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const { app, installer } = verifyWindowsBundle(project);
  console.log(`Verified Windows x64 GUI application ${app} and NSIS installer ${installer}`);
}
