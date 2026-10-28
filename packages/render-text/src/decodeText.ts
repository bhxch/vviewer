// decodeText.ts — 文本解码单源（议题三 §4.2）：UTF-32 走自带定长解码器（WHATWG
// TextDecoder 不支持），其余透传 TextDecoder（fatal:false，坏字节替换符）。全部
// 文本渲染器的解码点只准经本函数（Task 7 替换 4 处直构点）。
import type { Encoding } from '@vviewer/core';
import { DECODERS } from './code/strategy';

export function decodeText(bytes: Uint8Array, encoding: Encoding | undefined): string {
  if (encoding === 'utf-32le') return decodeUtf32(bytes, true);
  if (encoding === 'utf-32be') return decodeUtf32(bytes, false);
  return new TextDecoder(DECODERS[encoding ?? 'utf-8'], { fatal: false }).decode(bytes);
}

/** UTF-32 定长解码：BOM 剥离（TextDecoder 对 utf-8/16 同样自动剥，语义对齐）；
 * 非法码点/代理区 → U+FFFD。合法/替换码点统一收集进数组，末尾 String.fromCodePoint
 * 分块批量成型（终审 M-3：替换逐字符 out += 拼接的 O(n²) 字符串重建；分块 4096 防
 * 大文件展开参数超引擎调用栈上限，仍是线性一次性成型）。 */
function decodeUtf32(b: Uint8Array, le: boolean): string {
  const hasBom = le
    ? b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0
    : b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff;
  const start = hasBom ? 4 : 0;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const codes: number[] = [];
  for (let i = start; i + 4 <= b.length; i += 4) {
    const cp = view.getUint32(i, le);
    codes.push(cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? cp : 0xfffd);
  }
  let out = '';
  for (let i = 0; i < codes.length; i += 4096) {
    out += String.fromCodePoint(...codes.slice(i, i + 4096));
  }
  return out;
}
