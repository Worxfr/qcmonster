// Genere les icones PNG de la PWA (monstre rond) sans dependance: node web/scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Couleur d'un point (x,y dans [0,1]) pour un icone; scale < 1 pour la zone sure "maskable".
function shade(x, y, scale, rounded) {
  x = (x - 0.5) / scale + 0.5; y = (y - 0.5) / scale + 0.5;
  let c = hex('#6d28d9');
  if (rounded && Math.hypot(Math.max(Math.abs(x - 0.5) - 0.3, 0), Math.max(Math.abs(y - 0.5) - 0.3, 0)) > 0.2) return null;
  const inBody = ((x - 0.5) / 0.34) ** 2 + ((y - 0.56) / 0.34) ** 2 <= 1;
  const horn = (hx) => Math.hypot(x - hx, y - 0.22) < 0.07 && y < 0.3;
  if (inBody || horn(0.34) || horn(0.66)) c = hex('#86efac');
  for (const ex of [0.4, 0.6]) {
    if (Math.hypot(x - ex, y - 0.5) < 0.075) c = hex('#ffffff');
    if (Math.hypot(x - ex - 0.01, y - 0.51) < 0.036) c = hex('#2b2150');
  }
  if (y > 0.62 && y < 0.74 && Math.abs(x - 0.5) < 0.16 && ((x - 0.5) / 0.16) ** 2 + ((y - 0.62) / 0.12) ** 2 <= 1) c = hex('#2b2150');
  return c;
}

function png(size, scale, rounded) {
  const ss = 3; const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
        const c = shade((px + (i + 0.5) / ss) / size, (py + (j + 0.5) / ss) / size, scale, rounded);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4, n = ss * ss;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), png(192, 1, true));
writeFileSync(new URL('icon-512.png', out), png(512, 1, true));
writeFileSync(new URL('icon-512-maskable.png', out), png(512, 0.8, false));
