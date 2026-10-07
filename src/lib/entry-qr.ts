import qrcode from 'qrcode-generator';

// Match the official client's QRCode(value: qrContent): encode the payload,
// even when it looks like a URL, rather than fetching it as an image.
qrcode.stringToBytes = value => Array.from(new TextEncoder().encode(value));

export function entryQr(content: string) {
  if (typeof content !== 'string' || !content.trim() || new TextEncoder().encode(content).length > 2300) {
    throw new Error('invalid entry QR payload');
  }
  const qr = qrcode(0, 'M');
  qr.addData(content, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const paths: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) paths.push(`M${col + quiet},${row + quiet}h1v1h-1z`);
    }
  }
  return { size: count + quiet * 2, path: paths.join('') };
}
