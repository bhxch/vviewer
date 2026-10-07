// gen-icons.mjs —— PWA 图标生成（Task 1，M7）：192/512 两个尺寸，纯色底 + 简单 "V" 形。
// 不依赖 canvas（避免原生二进制依赖）：直接构造 RGBA 像素缓冲，经 zlib 压缩后手写
// PNG chunk（IHDR/IDAT/IEND，CRC32 自实现）。产物写入 apps/web/static/icons/（不入库，
// .gitignore 排除；apps/web build 脚本在 vite build 前调用本脚本）。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../apps/web/static/icons', import.meta.url));
const SIZES = [192, 512];
// 配色与 app.css 的暗色 UI 一致：底 #0d1117、前景 #e6edf3（"V" = viewer）
const BG = [0x0d, 0x11, 0x17, 0xff];
const FG = [0xe6, 0xed, 0xf3, 0xff];

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素缓冲 → 最小合法 PNG（8bit RGBA、无滤波、单 IDAT）。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 原始数据：每行前置 filter byte 0（None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 绘制：纯色底 + "V" 形（两条粗线段，逐像素点到线段距离 + 简单抗锯齿） ----------

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size * 0.05; // 线宽（半径）
  const apexX = 0.5 * size;
  const apexY = 0.72 * size;
  const strokes = [
    [0.26 * size, 0.28 * size, apexX, apexY],
    [0.74 * size, 0.28 * size, apexX, apexY]
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(...strokes.map(([x1, y1, x2, y2]) => distToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2)));
      // 1px 过渡带做抗锯齿
      const cov = Math.max(0, Math.min(1, half + 0.5 - d));
      const i = (y * size + x) * 4;
      for (let k = 0; k < 4; k++) {
        rgba[i + k] = Math.round(BG[k] + (FG[k] - BG[k]) * cov);
      }
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `pwa-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`[gen-icons] ${file}（${size}x${size}）`);
}
