#!/usr/bin/env node
'use strict';

// Usage: npm run qr -- https://your-live-app.example.com [output-dir]
// Writes otter-trivia-qr.svg and otter-trivia-qr.png (print quality).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { qrMatrix, qrSvg } = require('../server/qr');

const args = process.argv.slice(2);
const allowLocal = args.includes('--allow-local');
const [rawUrl, outDir = '.'] = args.filter((a) => !a.startsWith('--'));

function fail(msg) {
  console.error(`\n${msg}\n\nUsage: npm run qr -- https://your-live-app.example.com [output-dir]\n`);
  process.exit(1);
}

if (!rawUrl) fail('Please pass the public URL of the deployed app.');
let url;
try {
  url = new URL(rawUrl);
} catch {
  fail(`"${rawUrl}" is not a valid URL.`);
}
const local = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.endsWith('.local');
if (!allowLocal && (url.protocol !== 'https:' || local)) {
  fail(`Refusing to make a booth QR for ${url.href}: phones at the event can't reach local or non-HTTPS addresses.\nDeploy first, then use the live https:// URL (or pass --allow-local for testing).`);
}
const target = url.href;

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function qrPng(text, scale = 24, margin = 4) {
  const m = qrMatrix(text);
  const size = (m.length + margin * 2) * scale;
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    const r = Math.floor(y / scale) - margin;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - margin;
      if (r >= 0 && c >= 0 && r < m.length && c < m.length && m[r][c]) raw[y * (size + 1) + 1 + x] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
const svgPath = path.join(outDir, 'otter-trivia-qr.svg');
const pngPath = path.join(outDir, 'otter-trivia-qr.png');
fs.writeFileSync(svgPath, qrSvg(target));
fs.writeFileSync(pngPath, qrPng(target));

// Preview in the terminal so you can scan-test it right away.
const m = qrMatrix(target);
const pad = 2;
let out = '';
for (let r = -pad; r < m.length + pad; r += 2) {
  for (let c = -pad; c < m.length + pad; c++) {
    const top = m[r]?.[c] === true;
    const bottom = m[r + 1]?.[c] === true;
    out += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
  }
  out += '\n';
}
console.log(out);
console.log(`QR code for ${target}`);
console.log(`  ${svgPath}`);
console.log(`  ${pngPath}`);
console.log('Scan it with a phone before printing to confirm it opens the live game.');
