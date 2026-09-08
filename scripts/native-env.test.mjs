import assert from 'node:assert/strict';
import test from 'node:test';
import { prependToolPath } from './native-env.mjs';

test('Windows native children retain pnpm and system Path when Cargo is prepended', () => {
  const source = { Path: 'C:\\pnpm;C:\\Windows\\System32', OTHER: 'preserved' };
  const result = prependToolPath(source, 'C:\\cargo\\bin', 'win32');
  assert.equal(result.PATH, 'C:\\cargo\\bin;C:\\pnpm;C:\\Windows\\System32');
  assert.deepEqual(Object.keys(result).filter(key => key.toLowerCase() === 'path'), ['PATH']);
  assert.equal(source.Path, 'C:\\pnpm;C:\\Windows\\System32');
  assert.equal(result.OTHER, source.OTHER);
  assert.equal(prependToolPath({ PATH: '/usr/bin' }, '/cargo/bin', 'linux').PATH, '/cargo/bin:/usr/bin');
});
