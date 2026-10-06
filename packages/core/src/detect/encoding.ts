import type { Encoding } from '../types';

function hasUtf8Bom(b: Uint8Array) { return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; }
function hasUtf16leBom(b: Uint8Array) { return b[0] === 0xff && b[1] === 0xfe; }
function hasUtf16beBom(b: Uint8Array) { return b[0] === 0xfe && b[1] === 0xff; }

/** 严格校验 UTF-8 序列（RFC 3629，含 overlong/代理对拒绝） */
export function isStrictUtf8(b: Uint8Array): boolean {
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    if (c < 0x80) { i += 1; continue; }
    let len: number; let min: number; let cp: number;
    if ((c & 0xe0) === 0xc0) { len = 2; min = 0x80; cp = c & 0x1f; }
    else if ((c & 0xf0) === 0xe0) { len = 3; min = 0x800; cp = c & 0x0f; }
    else if ((c & 0xf8) === 0xf0) { len = 4; min = 0x10000; cp = c & 0x07; }
    else return false;
    if (i + len > b.length) return false;
    for (let k = 1; k < len; k++) {
      const cc = b[i + k]!;
      if ((cc & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += len;
  }
  return true;
}

/** 编码检测：BOM 优先，UTF-8 严格校验失败回退 gb18030 */
export function detectEncoding(bytes: Uint8Array): Encoding {
  if (hasUtf8Bom(bytes)) return 'utf-8';
  if (hasUtf16leBom(bytes)) return 'utf-16le';
  if (hasUtf16beBom(bytes)) return 'utf-16be';
  if (isStrictUtf8(bytes)) return 'utf-8';
  return 'gb18030';
}
