import type { Detection } from '../types';

const startsWith = (head: Uint8Array, sig: readonly number[], at = 0): boolean =>
  sig.every((v, i) => head[at + i] === v);

/** ftyp 视频品牌白名单（spec §3.2）：未列品牌不命中，保守落探测链 */
const MP4_VIDEO_BRANDS: ReadonlySet<string> = new Set(['isom', 'iso2', 'mp41', 'mp42', 'msnv', 'm4v ']);

/** magic 签名嗅探：ZIP（PK\x03\x04 / PK\x05\x06 / PK\x07\x08）、OLE、PNG、JPEG、GIF、PDF、MPEG-TS；
 * 议题二扩表：mp4/m4a/avif（ftyp 品牌）、webm、webp、wav、ico、gz、7z、rar、flac、ogg、bmp */
export function sniffSignature(head: Uint8Array): Detection['signature'] {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || startsWith(head, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF87a/GIF89a
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  // MPEG-TS：包长 188、同步字节 0x47 固定在包首（0/188/376 三重校验——单字节 0x47='G'
  // 太弱，TypeScript 源码等文本可能撞上；三重对齐后文本命中概率可忽略）。
  // head 不足 377 字节不判定（保守：真实 TS 流远大于此）。
  if (head.length >= 377 && head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47) return 'mpegts';
  // —— 议题二扩表：全部映射到真有渲染器消费的格式（spec §3.2）；mp3 无稳定前缀不收 ——
  // mp4/m4a/avif：ftyp box 在 offset 4，品牌 [8..11] 收窄分派；未列品牌不命中（保守落探测链）
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4) && head.length >= 12) {
    const brand = String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!);
    if (brand === 'M4A ') return 'm4a';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (MP4_VIDEO_BRANDS.has(brand)) return 'mp4';
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46], 0) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46], 0) && startsWith(head, [0x57, 0x41, 0x56, 0x45], 8)) return 'wav';
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  if (startsWith(head, [0x1f, 0x8b, 0x08])) return 'gz'; // 第三字节 0x08=deflate 收窄
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar'; // v4/v5 共前缀
  if (startsWith(head, [0x66, 0x4c, 0x61, 0x43])) return 'flac'; // fLaC
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return 'ogg'; // OggS
  // bmp：'BM' 2 字节弱 → 保留字段 [6..9] 全零强校验为 10 字节有效签名（文本 "BM…" 无 NUL 天然排除）
  if (head[0] === 0x42 && head[1] === 0x4d && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) return 'bmp';
  return null;
}

/**
 * 无扩展名文件的文本性探测（BUG-07 回退链第 ② 步）：
 * 含 NUL 字节或可打印区外控制字符占比超阈值即判二进制；其余视为文本
 * （严格 UTF-8 失败也可能是 gb18030 文本，不据此拒绝）。
 */
export function looksTextual(head: Uint8Array): boolean {
  // 空文件按文本打开（显示空代码视图，优于报错）
  if (head.length === 0) return true;
  let suspicious = 0;
  const sample = head.length > 8192 ? head.subarray(0, 8192) : head;
  for (const b of sample) {
    if (b === 0) return false; // NUL：文本不出现，出现即二进制（git 同口径）
    // 排除常用文本控制符 \t \n \r \f 后，其余 <0x20 与 0x7f 计为可疑
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) suspicious++;
    else if (b === 0x7f) suspicious++;
  }
  return suspicious / sample.length <= 0.05;
}

/**
 * shebang 首行 → 语言（helix 语言键，与 @vviewer/highlight languages.json 同源同形）。
 * 仅无扩展名回退链使用：此窄表为 languages.json shebangs 的高频子集（完整表在
 * highlight 包，core 不依赖上层；新语言先补 languages.json，本表按需同步）。
 */
const SHEBANG_LANGS: Readonly<Record<string, string>> = {
  python: 'python', // SHEBANG_RE 剥版本号后捕获段：python3 → python
  uv: 'python',
  node: 'javascript',
  deno: 'typescript',
  bun: 'typescript',
  sh: 'bash',
  bash: 'bash',
  dash: 'bash',
  zsh: 'bash',
  ruby: 'ruby',
  perl: 'perl',
  lua: 'lua',
  luajit: 'lua',
  php: 'php',
  make: 'make',
  gmake: 'make',
  r: 'r',
  fish: 'fish'
};

/** 与 @vviewer/highlight langdetect.ts 的 SHEBANG_RE 同源：`#!/usr/bin/env python3` → `python` */
const SHEBANG_RE = /^#!\s*(?:\S*[/\\](?:env\s+(?:-\S+\s+)*)?)?([^\s.\d]+)/;

/** 首行 shebang → 语言键；非 shebang 或解释器不在窄表返回 null */
export function shebangLangOf(text: string): string | null {
  if (!text.startsWith('#!')) return null;
  const newline = text.indexOf('\n');
  const firstLine = newline < 0 ? text : text.slice(0, newline);
  const m = SHEBANG_RE.exec(firstLine);
  return m ? SHEBANG_LANGS[m[1]!] ?? null : null;
}
