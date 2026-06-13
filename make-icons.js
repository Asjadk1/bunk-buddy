/* One-off generator for Bunk Buddy PWA icons.
   Pure Node (zlib only). Renders a graduation-cap glyph on a gradient,
   supersampled 3× then box-downscaled for clean anti-aliased edges. */
const fs = require('fs');
const zlib = require('zlib');

// ---- tiny PNG (RGBA) encoder ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- vector raster (hard fill at supersample, then downscale = AA) ----
function makeIcon(S, { contentScale, rounded }) {
  const SS = 3, W = S * SS;                 // supersample buffer
  const buf = new Float32Array(W * W * 4);  // premultiplied-ish straight rgba 0..255
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const ia = a / 255, na = 1 - ia;
    buf[i] = buf[i] * na + r * ia;
    buf[i + 1] = buf[i + 1] * na + g * ia;
    buf[i + 2] = buf[i + 2] * na + b * ia;
    buf[i + 3] = Math.max(buf[i + 3], a);
  };
  // gradient bg + radial glow
  const c0 = [108, 140, 255], c1 = [157, 108, 255];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const t = (x + y) / (2 * W);
    let r = c0[0] + (c1[0] - c0[0]) * t;
    let g = c0[1] + (c1[1] - c0[1]) * t;
    let b = c0[2] + (c1[2] - c0[2]) * t;
    const dx = x - W * 0.3, dy = y - W * 0.18;
    const gl = Math.max(0, 1 - Math.hypot(dx, dy) / (W * 0.8)) * 0.22;
    r += (255 - r) * gl; g += (255 - g) * gl; b += (255 - b) * gl;
    const i = (y * W + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
  // polygon fill (even-odd scanline)
  const fillPoly = (pts, col) => {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k < xs.length - 1; k += 2)
        for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) set(x, y, col[0], col[1], col[2], 255);
    }
  };
  const fillCircle = (cx, cy, rad, col) => {
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++)
        if (Math.hypot(x - cx, y - cy) <= rad) set(x, y, col[0], col[1], col[2], 255);
  };
  const thickLine = (x1, y1, x2, y2, lw, col) => {
    const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.ceil(len);
    for (let s = 0; s <= steps; s++) fillCircle(x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps, lw / 2, col);
  };

  // graduation cap (white), all in supersample px
  const k = contentScale, white = [255, 255, 255];
  const cx = W / 2, cyB = W / 2 - W * 0.06 * k;     // board center y
  const bw = 0.36 * W * k, bh = 0.155 * W * k;
  // cap under board
  fillPoly([
    [cx - 0.17 * W * k, cyB], [cx - 0.15 * W * k, cyB + 0.17 * W * k],
    [cx, cyB + 0.215 * W * k], [cx + 0.15 * W * k, cyB + 0.17 * W * k], [cx + 0.17 * W * k, cyB],
  ], white);
  // mortarboard diamond
  fillPoly([[cx, cyB - bh], [cx + bw, cyB], [cx, cyB + bh], [cx - bw, cyB]], white);
  // tassel
  const tx = cx + bw * 0.62, ty = cyB - bh * 0.18;
  thickLine(cx, cyB, tx, ty, 0.02 * W * k, white);
  thickLine(tx, ty, tx, cyB + 0.2 * W * k, 0.02 * W * k, white);
  fillCircle(tx, cyB + 0.225 * W * k, 0.035 * W * k, white);
  fillCircle(cx, cyB, 0.03 * W * k, white);

  // rounded-corner mask (non-maskable icons)
  if (rounded) {
    const r = W * 0.22;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      let inside = true;
      const corners = [[r, r], [W - r, r], [r, W - r], [W - r, W - r]];
      if (x < r && y < r) inside = Math.hypot(x - r, y - r) <= r;
      else if (x > W - r && y < r) inside = Math.hypot(x - (W - r), y - r) <= r;
      else if (x < r && y > W - r) inside = Math.hypot(x - r, y - (W - r)) <= r;
      else if (x > W - r && y > W - r) inside = Math.hypot(x - (W - r), y - (W - r)) <= r;
      if (!inside) buf[(y * W + x) * 4 + 3] = 0;
    }
  }

  // box-downscale SS×SS → S (anti-aliasing)
  const out = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let yy = 0; yy < SS; yy++) for (let xx = 0; xx < SS; xx++) {
      const i = ((y * SS + yy) * W + (x * SS + xx)) * 4;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
    }
    const n = SS * SS, o = (y * S + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
  }
  return encodePNG(S, S, out);
}

const dir = __dirname;
fs.writeFileSync(dir + '/icon-192.png', makeIcon(192, { contentScale: 1, rounded: true }));
fs.writeFileSync(dir + '/icon-512.png', makeIcon(512, { contentScale: 1, rounded: true }));
fs.writeFileSync(dir + '/icon-maskable-512.png', makeIcon(512, { contentScale: 0.72, rounded: false }));
fs.writeFileSync(dir + '/apple-touch-icon.png', makeIcon(180, { contentScale: 1, rounded: true }));
console.log('icons written');
