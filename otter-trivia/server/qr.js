'use strict';

// Renders QR codes as SVG using the vendored Kazuhiko Arase encoder (MIT).
const QRCode = require('./vendor/qrcode');
const QRErrorCorrectLevel = require('./vendor/qrcode/QRErrorCorrectLevel');

function qrMatrix(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

function qrSvg(text, { margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const size = m.length + margin * 2;
  let d = '';
  m.forEach((row, r) => {
    row.forEach((on, c) => {
      if (on) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    });
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`
  );
}

module.exports = { qrMatrix, qrSvg };
