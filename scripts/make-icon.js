// Generates build/icon.png (256x256): white rounded square + three status bars (orange/red/green)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// 4x supersampling for anti-aliasing
function shade(x, y) {
  const layers = [
    [16, 16, 240, 240, 48, [255, 255, 255]],                      // background
    [56, 62, 72, 98, 8, [240, 160, 32]], [88, 66, 200, 94, 14, [27, 29, 34]],    // row 1: working
    [56, 110, 72, 146, 8, [236, 63, 63]], [88, 114, 176, 142, 14, [27, 29, 34]], // row 2: attention
    [56, 158, 72, 194, 8, [31, 184, 96]], [88, 162, 188, 190, 14, [163, 167, 176]], // row 3: ready
  ];
  let c = null;
  for (const [x0, y0, x1, y1, r, col] of layers) if (inRound(x, y, x0, y0, x1, y1, r)) c = col;
  return c;
}
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const c = shade(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
    if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
  }
  const i = (y * S + x) * 4;
  if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (a / 16) * 255; }
}
// drop shadow-ish border: tint the edge of the background slightly
// PNG encoding
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out);
