/**
 * PWA icon generator: the sidebar brand chip — a white "W" lettermark on the
 * violet rounded square — rendered to the PNG sizes the manifest references.
 *
 *   node scripts/generate-icons.mjs      (from apps/web; writes public/icons)
 *
 * Zero dependencies on purpose: the mark is four straight bars and a rounded
 * rectangle, so a tiny supersampling rasterizer + node:zlib PNG encoder covers
 * it without pulling a native image library into devDependencies. Output is
 * deterministic — same script, same bytes (modulo zlib version).
 *
 * - icon-{192,512}.png          rounded square (transparent corners), like the chip
 * - icon-maskable-{192,512}.png full-bleed square; the W sits inside the 80%
 *                               safe zone so platform masks never clip it
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// Brand tokens (globals.css: --accent / --on-accent; chip: rounded-md on size-8).
const ACCENT = [0x6d, 0x5c, 0xe6];
const WHITE = [0xff, 0xff, 0xff];
const CHIP_RADIUS_RATIO = 6 / 32; // rounded-md (6px) on the 32px sidebar chip

/**
 * The W, as four bars of constant horizontal thickness in a unit box
 * (x 0..1, y 0..1, y down). Center lines; flat caps land flush on the cap and
 * base lines, which is what makes the joins clean.
 */
const W_BARS = [
  [0.09, 0.0, 0.27, 1.0],
  [0.27, 1.0, 0.5, 0.06],
  [0.5, 0.06, 0.73, 1.0],
  [0.73, 1.0, 0.91, 0.0],
];
const W_THICKNESS = 0.18; // horizontal, in unit-box widths
const W_ASPECT = 1.28; // rendered width : cap height

/** Bars expanded to quads: [x1,y1, x2,y2, x3,y3, x4,y4] in unit-box coords. */
const W_QUADS = W_BARS.map(([xa, ya, xb, yb]) => {
  const h = W_THICKNESS / 2;
  return [xa - h, ya, xa + h, ya, xb + h, yb, xb - h, yb];
});

function pointInQuad(px, py, q) {
  // Ray cast over the 4 edges.
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = q[i * 2];
    const yi = q[i * 2 + 1];
    const xj = q[j * 2];
    const yj = q[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inRoundedSquare(px, py, size, radius) {
  if (px < 0 || py < 0 || px >= size || py >= size) return false;
  const cx = px < radius ? radius : px > size - radius ? size - radius : px;
  const cy = py < radius ? radius : py > size - radius ? size - radius : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Render one icon. `maskable` fills the whole square (platform masks provide
 * the shape) and shrinks the W into the safe zone; otherwise the tile itself
 * is the chip's rounded square with transparent corners.
 */
function renderIcon(size, maskable) {
  const SS = 4; // 4x4 subsamples per pixel
  const capHeight = size * (maskable ? 0.34 : 0.4);
  const wWidth = capHeight * W_ASPECT;
  const wLeft = (size - wWidth) / 2;
  const wTop = (size - capHeight) / 2;
  const radius = maskable ? 0 : size * CHIP_RADIUS_RATIO;

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileHits = 0;
      let markHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const inTile = maskable || inRoundedSquare(px, py, size, radius);
          if (!inTile) continue;
          tileHits++;
          const ux = (px - wLeft) / wWidth;
          const uy = (py - wTop) / capHeight;
          if (ux >= -0.1 && ux <= 1.1 && uy >= 0 && uy <= 1) {
            if (W_QUADS.some((q) => pointInQuad(ux, uy, q))) markHits++;
          }
        }
      }
      const total = SS * SS;
      const tileCov = tileHits / total;
      const markCov = markHits / total;
      // White over accent over transparent, weighted by coverage.
      const bgCov = tileCov - markCov;
      const i = (y * size + x) * 4;
      if (tileCov === 0) continue; // fully transparent, already zeroed
      rgba[i] = Math.round((ACCENT[0] * bgCov + WHITE[0] * markCov) / tileCov);
      rgba[i + 1] = Math.round((ACCENT[1] * bgCov + WHITE[1] * markCov) / tileCov);
      rgba[i + 2] = Math.round((ACCENT[2] * bgCov + WHITE[2] * markCov) / tileCov);
      rgba[i + 3] = Math.round(255 * tileCov);
    }
  }
  return rgba;
}

// ── Minimal PNG encoder (8-bit RGBA, filter 0) ──────────────────────────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Raw scanlines, each prefixed with filter byte 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  for (const maskable of [false, true]) {
    const name = maskable ? `icon-maskable-${size}.png` : `icon-${size}.png`;
    writeFileSync(join(OUT_DIR, name), encodePng(renderIcon(size, maskable), size));
    console.log(`wrote public/icons/${name}`);
  }
}
