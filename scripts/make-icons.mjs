// Generates the menu bar "template" icons (black + alpha; macOS tints them).
// Run with: npm run icons
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });

function png(size, alphaAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = raw[o + 1] = raw[o + 2] = 0;
      raw[o + 3] = Math.round(alphaAt(x, y) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Distance from point to segment
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Shape in a 16x16 coordinate space; returns 1 if inked
function clock(filled) {
  const c = 8, r = 6.6, stroke = 1.4, hand = 1.4;
  return (x, y) => {
    const d = Math.hypot(x - c, y - c);
    const onHands =
      segDist(x, y, c, c, c, c - 4.2) < hand / 2 || segDist(x, y, c, c, c + 3, c + 1.2) < hand / 2;
    if (filled) return d <= r && !onHands ? 1 : 0;
    const onRing = Math.abs(d - (r - stroke / 2)) <= stroke / 2;
    return onRing || onHands ? 1 : 0;
  };
}

function render(size, shape) {
  const ss = 4; // supersampling for anti-aliasing
  const scale = 16 / size;
  return png(size, (x, y) => {
    let hits = 0;
    for (let i = 0; i < ss; i++)
      for (let j = 0; j < ss; j++)
        hits += shape((x + (i + 0.5) / ss) * scale, (y + (j + 0.5) / ss) * scale);
    return hits / (ss * ss);
  });
}

for (const [name, filled] of [['trayTemplate', false], ['trayRunningTemplate', true]]) {
  writeFileSync(path.join(outDir, `${name}.png`), render(16, clock(filled)));
  writeFileSync(path.join(outDir, `${name}@2x.png`), render(32, clock(filled)));
}
console.log('Icons written to', outDir);

// ---------- App icon (Finder / Launchpad): 1024px rounded square ----------
function appIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const ss = 3;
  const u = (v) => v / size; // normalize
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let a = 0, rr = 0, gg = 0, bb = 0;
      for (let i = 0; i < ss; i++)
        for (let j = 0; j < ss; j++) {
          const px = u(x + (i + 0.5) / ss), py = u(y + (j + 0.5) / ss);
          // macOS icon grid: 824/1024 body, ~185 corner radius
          const m = 100 / 1024, r = 185 / 1024;
          const qx = Math.max(m + r - px, 0, px - (1 - m - r)), qy = Math.max(m + r - py, 0, py - (1 - m - r));
          if (Math.hypot(qx, qy) > r) continue;
          // blue gradient background
          const t = (px + py) / 2;
          let R = 12 + (40 - 12) * t, G = 102 + (60 - 102) * t, B = 228 + (170 - 228) * t;
          // white clock
          const d = Math.hypot(px - 0.5, py - 0.5);
          const ring = Math.abs(d - 0.255) < 0.03;
          const h1 = segDist(px, py, 0.5, 0.5, 0.5, 0.33) < 0.026;
          const h2 = segDist(px, py, 0.5, 0.5, 0.62, 0.56) < 0.026;
          const hub = d < 0.035;
          if (ring || h1 || h2 || hub) R = G = B = 255;
          a++; rr += R; gg += G; bb += B;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a) { raw[o] = rr / a; raw[o + 1] = gg / a; raw[o + 2] = bb / a; }
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return raw;
}
{
  const size = 1024;
  const raw = appIcon(size);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const buildDir = path.join(outDir, '..', 'build');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, 'icon.png'), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log('App icon written to', buildDir);
}
