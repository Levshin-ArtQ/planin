#!/usr/bin/env node
// Генератор иконок Planin: один рисунок → SVG и PNG (без зависимостей).
// Лист с тремя строками, нижняя зачёркнута. Фон #f3f0e8 на весь квадрат,
// без своих скруглений и прозрачности: маску накладывает iOS/Android (R-5).
// Запуск: node scripts/icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const COLORS = { bg: "#f3f0e8", sheet: "#fffdf8", ink: "#1c1916", strike: "#8a8276" };
const SHEET_W = 0.6; // ширина листа (с обводкой) от стороны
const SHEET_H = SHEET_W * 134 / 108; // пропорция листа 108×134 при 180 px
const STROKE = 0.045; // обводка от стороны
const MASKABLE_SCALE = 0.82; // рисунок внутри центрального круга 80%

// Геометрия в долях стороны (0..1).
function drawing(scale, colors = COLORS) {
  const w = SHEET_W * scale;
  const h = SHEET_H * scale;
  const sw = STROKE * scale;
  const x0 = (1 - w) / 2;
  const y0 = (1 - h) / 2;
  const line = (fx1, fx2, fy, width, color) => ({ x1: x0 + fx1 * w, x2: x0 + fx2 * w, y: y0 + fy * h, width, color });
  return {
    // прямоугольник листа по центру обводки
    rect: { x: x0 + sw / 2, y: y0 + sw / 2, w: w - sw, h: h - sw, r: 0.05 * scale, sw },
    lines: [
      line(0.22, 0.78, 0.31, sw * 0.9, colors.ink),
      line(0.22, 0.78, 0.49, sw * 0.9, colors.ink),
      line(0.22, 0.58, 0.67, sw * 0.9, colors.ink),
      line(0.17, 0.63, 0.67, sw * 0.7, colors.strike)
    ]
  };
}

function svg(scale) {
  const d = drawing(scale);
  const n = (v) => +(v * 512).toFixed(2);
  const r = d.rect;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
    `  <rect width="512" height="512" fill="${COLORS.bg}"/>`,
    `  <rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" rx="${n(r.r)}" fill="${COLORS.sheet}" stroke="${COLORS.ink}" stroke-width="${n(r.sw)}"/>`,
    ...d.lines.map((l) => `  <path d="M${n(l.x1)} ${n(l.y)}H${n(l.x2)}" stroke="${l.color}" stroke-width="${n(l.width)}" stroke-linecap="round"/>`),
    "</svg>",
    ""
  ].join("\n");
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Растр: для каждой подвыборки — цвет верхнего слоя; 4×4 подвыборки на пиксель.
function raster(size, scale, colors = COLORS) {
  const d = drawing(scale, colors);
  const r = d.rect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const hx = r.w / 2 - r.r;
  const hy = r.h / 2 - r.r;
  const roundRect = (x, y) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r.r;
  };
  const capsule = (l, x, y) => {
    const t = Math.max(l.x1, Math.min(l.x2, x));
    return Math.hypot(x - t, y - l.y) - l.width / 2;
  };
  const C = { bg: rgb(colors.bg), sheet: rgb(colors.sheet), ink: rgb(colors.ink) };
  const lineRgb = d.lines.map((l) => rgb(l.color));
  const SS = 4;
  const out = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let R = 0, G = 0, B = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const dr = roundRect(x, y);
          let c = dr < 0 ? C.sheet : C.bg;
          if (Math.abs(dr) <= r.sw / 2) c = C.ink;
          d.lines.forEach((l, i) => { if (capsule(l, x, y) <= 0) c = lineRgb[i]; });
          R += c[0]; G += c[1]; B += c[2];
        }
      }
      const o = (py * size + px) * 3;
      const k = SS * SS;
      out[o] = Math.round(R / k);
      out[o + 1] = Math.round(G / k);
      out[o + 2] = Math.round(B / k);
    }
  }
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// PNG 8-bit RGB (цветовой тип 2) — без альфа-канала.
function png(size, pixels, height = size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(height * (size * 3 + 1));
  for (let y = 0; y < height; y += 1) pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const OUTPUT = [
  { file: "apple-touch-icon.png", size: 180, scale: 1 },
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, scale: MASKABLE_SCALE },
  { file: "favicon-32.png", size: 32, scale: 1 }
];
const SVGS = [
  { file: "icon-192.svg", scale: 1 },
  { file: "icon-512.svg", scale: 1 },
  { file: "icon-maskable.svg", scale: MASKABLE_SCALE }
];

// Заставки iOS (R-24): фон темы и маленький лист 64 pt цветом --faint по центру,
// без текста. Экраны в CSS px и DPR (портрет); сверено с линейкой до iPhone 17 / Air.
const SPLASH_SCREENS = [
  [375, 667, 2], [375, 812, 3], [414, 896, 2], [414, 896, 3], [390, 844, 3], [428, 926, 3],
  [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3], [420, 912, 3]
];
const SPLASH_THEMES = {
  light: { bg: "#f3f0e8", sheet: "#f3f0e8", ink: "#857d71", strike: "#857d71" },
  dark: { bg: "#141311", sheet: "#141311", ink: "#8a8378", strike: "#8a8378" }
};
const SPLASH_ICON_PT = 64;
const splashFile = (w, h, dpr, theme) => `splash/${w * dpr}x${h * dpr}-${theme}.png`;
function splash(w, h, dpr, theme) {
  const W = w * dpr, H = h * dpr, S = SPLASH_ICON_PT * dpr;
  const colors = SPLASH_THEMES[theme];
  const bg = rgb(colors.bg);
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) { out[i * 3] = bg[0]; out[i * 3 + 1] = bg[1]; out[i * 3 + 2] = bg[2]; }
  const icon = raster(S, 1, colors);
  const ox = Math.round((W - S) / 2), oy = Math.round((H - S) / 2);
  for (let y = 0; y < S; y += 1) icon.copy(out, ((oy + y) * W + ox) * 3, y * S * 3, (y + 1) * S * 3);
  return png(W, out, H);
}
// <link> для index.html: одна строка на экран и тему.
function splashLinks() {
  return SPLASH_SCREENS.flatMap(([w, h, dpr]) => ["light", "dark"].map((t) =>
    `<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) and (prefers-color-scheme: ${t})" href="${splashFile(w, h, dpr, t)}" />`));
}

module.exports = { drawing, svg, raster, png, OUTPUT, SVGS, COLORS, MASKABLE_SCALE, SPLASH_SCREENS, SPLASH_THEMES, splash, splashFile, splashLinks };

if (require.main === module) {
  const dir = path.join(__dirname, "..", "icons");
  SVGS.forEach(({ file, scale }) => fs.writeFileSync(path.join(dir, file), svg(scale)));
  OUTPUT.forEach(({ file, size, scale }) => {
    fs.writeFileSync(path.join(dir, file), png(size, raster(size, scale)));
    console.log(`icons/${file} ${size}×${size}`);
  });
  fs.mkdirSync(path.join(__dirname, "..", "splash"), { recursive: true });
  SPLASH_SCREENS.forEach(([w, h, dpr]) => ["light", "dark"].forEach((t) => {
    const file = splashFile(w, h, dpr, t);
    fs.writeFileSync(path.join(__dirname, "..", file), splash(w, h, dpr, t));
    console.log(file);
  }));
  // Ссылки в index.html — между маркерами.
  const index = path.join(__dirname, "..", "index.html");
  const html = fs.readFileSync(index, "utf8");
  const block = splashLinks().map((l) => "    " + l).join("\n");
  fs.writeFileSync(index, html.replace(/(    <!-- splash:start[^\n]*-->\n)[\s\S]*?(    <!-- splash:end -->)/, (_, a, b) => a + block + "\n" + b));
}
