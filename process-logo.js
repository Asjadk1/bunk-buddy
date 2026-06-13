/* One-off: take logo-opaque.png (RGB, white bg) → logo.png (RGBA,
   white background knocked out via edge flood-fill so the cat's
   interior light areas + diploma stay opaque). Pure Node + zlib. */
const fs = require('fs');
const zlib = require('zlib');

// ---- decode PNG (8-bit, colorType 2 = RGB, non-interlaced) ----
function decodePNG(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const colorType = buf[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  // gather IDAT
  let p = 8; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.slice(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const x = raw[row + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: v = x;
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  // to RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = out[i * bpp];
    rgba[i * 4 + 1] = out[i * bpp + (channels > 1 ? 1 : 0)];
    rgba[i * 4 + 2] = out[i * bpp + (channels > 2 ? 2 : 0)];
    rgba[i * 4 + 3] = channels === 4 ? out[i * bpp + 3] : 255;
  }
  return { w, h, rgba };
}

// ---- encode RGBA PNG ----
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rowLen = w * 4 + 1;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) { raw[y * rowLen] = 0; rgba.copy(raw, y * rowLen + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- knock out white background by flood fill from borders ----
const { w, h, rgba } = decodePNG(fs.readFileSync(__dirname + '/logo-opaque.png'));
const isWhite = (i) => rgba[i] >= 226 && rgba[i + 1] >= 226 && rgba[i + 2] >= 226;
const seen = new Uint8Array(w * h);
const stack = [];
for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
while (stack.length) {
  const pix = stack.pop();
  if (seen[pix]) continue; seen[pix] = 1;
  const i = pix * 4;
  if (!isWhite(i)) continue;
  rgba[i + 3] = 0;
  const x = pix % w, y = (pix / w) | 0;
  if (x + 1 < w) stack.push(pix + 1);
  if (x - 1 >= 0) stack.push(pix - 1);
  if (y + 1 < h) stack.push(pix + w);
  if (y - 1 >= 0) stack.push(pix - w);
}
fs.writeFileSync(__dirname + '/logo.png', encodePNG(w, h, rgba));
console.log('logo.png written:', w + 'x' + h);
