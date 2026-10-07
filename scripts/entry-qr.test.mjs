import assert from 'node:assert/strict';
import test from 'node:test';
import jsQR from 'jsqr';
import { entryQr } from '../src/lib/entry-qr.ts';

function decode(matrix) {
  const scale = 6;
  const side = matrix.size * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [, x, y] of matrix.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    for (let row = Number(y) * scale; row < (Number(y) + 1) * scale; row++) {
      for (let col = Number(x) * scale; col < (Number(x) + 1) * scale; col++) {
        const offset = (row * side + col) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
  }
  return jsQR(pixels, side, side)?.data;
}

test('entry QR retains UTF-8, whitespace, URL-shaped payloads and special characters exactly', () => {
  for (const payload of ['  synthetic +/%&=\n', '合成二维码：天大🔑', 'https://campus.invalid/entry?synthetic=1', 'data:image/png;base64,SYNTHETIC', '<script>synthetic</script>', 'x'.repeat(2300)]) {
    const matrix = entryQr(payload);
    assert.equal(decode(matrix), payload);
    assert.ok(matrix.size <= 185);
    for (const [, x, y] of matrix.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
      assert.ok(Number(x) >= 4 && Number(x) < matrix.size - 4);
      assert.ok(Number(y) >= 4 && Number(y) < matrix.size - 4);
    }
    assert.match(matrix.path, /^(?:M\d+,\d+h1v1h-1z)+$/);
  }
});

test('entry QR rejects empty, malformed and oversized payloads without including them in errors', () => {
  for (const payload of ['', '  ', null, undefined, {}, 'x'.repeat(2301), '中'.repeat(800)]) {
    assert.throws(() => entryQr(payload), { message: 'invalid entry QR payload' });
  }
});
