'use strict';

// Minimal QR decoder used only to verify generated booth codes in tests.
// Reads format info, unmasks, de-interleaves, checks every Reed-Solomon block
// has zero syndromes (i.e. the code is self-consistent), then parses byte mode.

const QRRSBlock = require('../server/vendor/qrcode/QRRSBlock');

// GF(256) with the QR polynomial 0x11d.
const EXP = new Array(512);
const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];
// Format ECL bits → library level constant (L=1, M=0, Q=3, H=2 in both).
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function bchFormat(data) {
  let d = data << 10;
  for (let i = 14; i >= 10; i--) if (d & (1 << i)) d ^= 0x537 << (i - 10);
  return ((data << 10) | d) ^ 0x5412;
}

function decode(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error(`unsupported size ${size}`);

  // Format info (copy 1, around top-left finder).
  // Bit 0 (LSB) at (0,8) … bit 14 (MSB) at (8,0).
  const coords = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  let fmt = 0;
  coords.forEach(([r, c], i) => { if (m[r][c]) fmt |= 1 << i; });
  let data = -1;
  for (let v = 0; v < 32; v++) if (bchFormat(v) === fmt) data = v;
  if (data < 0) throw new Error('bad format info');
  const ecl = data >> 3;
  const mask = MASKS[data & 7];

  // Function pattern map.
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const fill = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true; };
  fill(0, 0, 9, 9); fill(0, size - 8, 9, 8); fill(size - 8, 0, 8, 9);
  fill(6, 0, 1, size); fill(0, 6, size, 1);
  const al = ALIGN[version];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    fill(r - 2, c - 2, 5, 5);
  }
  if (version >= 7) { fill(0, size - 11, 6, 3); fill(size - 11, 0, 3, 6); }

  // Zigzag read.
  const bits = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (fn[r][c]) continue;
        bits.push(m[r][c] !== mask(r, c));
      }
    }
    up = !up;
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | (b ? 1 : 0), 0));

  // De-interleave.
  const blocks = QRRSBlock.getRSBlocks(version, ecl);
  const maxData = Math.max(...blocks.map((b) => b.dataCount));
  const maxTotal = Math.max(...blocks.map((b) => b.totalCount));
  const out = blocks.map(() => []);
  let p = 0;
  for (let i = 0; i < maxData; i++) blocks.forEach((b, k) => { if (i < b.dataCount) out[k].push(bytes[p++]); });
  for (let i = 0; i < maxTotal - Math.min(...blocks.map((b) => b.dataCount)); i++) {
    blocks.forEach((b, k) => { const ec = b.totalCount - b.dataCount; if (i < ec) out[k].push(bytes[p++]); });
  }
  // Reed-Solomon syndromes must all be zero.
  out.forEach((cw, k) => {
    const ec = blocks[k].totalCount - blocks[k].dataCount;
    for (let s = 0; s < ec; s++) {
      let acc = 0;
      for (const c of cw) acc = mul(acc, EXP[s]) ^ c;
      if (acc !== 0) throw new Error(`RS syndrome non-zero in block ${k}`);
    }
  });
  const dataBytes = out.flatMap((cw, k) => cw.slice(0, blocks[k].dataCount));
  const dbits = dataBytes.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits.shift(); return v; };
  if (read(4) !== 4) throw new Error('expected byte mode');
  const len = read(version < 10 ? 8 : 16);
  return Buffer.from(Array.from({ length: len }, () => read(8))).toString('utf8');
}

module.exports = { decode };
