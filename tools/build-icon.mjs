/** Draw build/icon.png, the app icon. 256x256, which is the size electron-builder
 * needs to derive a Windows .ico from it.
 *
 *     npm run icon
 *
 * Hand-rolled rather than a dependency: a PNG is a zlib stream in four chunks,
 * and node has zlib. A bell, because that is what the app is.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const N = 256;
const SS = 3;                        // supersampling per axis, for smooth edges
const BG = [0x1c, 0x1f, 0x26];
const RING = [0x2b, 0x30, 0x39];
const BELL = [0xf2, 0x72, 0x4f];
const GLOW = [0xff, 0xa8, 0x82];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Rounded-square mask, in 0..1, for the plate the bell sits on. */
function plate(x, y) {
  const r = 52, pad = 8, lo = pad + r, hi = N - pad - r;
  const dx = Math.max(0, Math.abs(x - N / 2) - (hi - lo) / 2);
  const dy = Math.max(0, Math.abs(y - N / 2) - (hi - lo) / 2);
  return Math.hypot(dx, dy) - r;     // signed distance, <0 inside
}

/** The bell: a dome, a flared body, a rounded rim and a clapper. */
function bell(x, y) {
  const cx = N / 2;
  const inside = (d) => d;           // readability only
  const dome = Math.hypot(x - cx, y - 118) - 58;
  // Body flares as it descends; expressed as a distance to the flare edge.
  const half = 58 + (y - 118) * 0.52;
  const body = y >= 118 && y <= 178 ? Math.abs(x - cx) - half : 1e3;
  const rim = Math.max(Math.abs(y - 187) - 9, Math.abs(x - cx) - 78);
  const rimRound = rim - 7;
  const knob = Math.hypot(x - cx, y - 50) - 13;
  const clapper = Math.hypot(x - cx, y - 211) - 16;
  return Math.min(inside(dome), body, rimRound, knob, clapper);
}

const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        const dp = plate(px, py);
        if (dp > 0.5) continue;                       // outside the plate
        // plate colour, with a lighter ring just inside the edge
        let col = dp > -3 ? RING : BG;
        const db = bell(px, py);
        if (db < 0) {
          // vertical gradient so it does not look flat
          col = mix(GLOW, BELL, clamp((py - 40) / 180, 0, 1));
        }
        const cov = clamp(0.5 - dp, 0, 1);            // antialias the plate edge
        r += col[0] * cov; g += col[1] * cov; b += col[2] * cov; a += 255 * cov;
      }
    }
    const n = SS * SS, i = (y * N + x) * 4;
    rgba[i] = Math.round(r / n); rgba[i + 1] = Math.round(g / n);
    rgba[i + 2] = Math.round(b / n); rgba[i + 3] = Math.round(a / n);
  }
}

// ---- PNG container -------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // truecolour with alpha
// Each scanline is prefixed with its filter type; 0 = none.
const raw = Buffer.alloc(N * (1 + N * 4));
for (let y = 0; y < N; y++) {
  raw[y * (1 + N * 4)] = 0;
  rgba.copy(raw, y * (1 + N * 4) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(new URL("../build/", import.meta.url), { recursive: true });
writeFileSync(new URL("../build/icon.png", import.meta.url), png);
console.log(`build/icon.png  ${N}x${N}  ${(png.length / 1024).toFixed(1)} KB`);
