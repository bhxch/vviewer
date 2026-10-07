// hexBytes.ts — hex dump 行格式纯函数（jsdom 单测直测；DOM 渲染见 hex.ts）。
// 经典三列：8 位十六进制偏移 + 16 字节十六进制（空格分隔）+ 竖线包裹的 ASCII 列。
// 三列对齐由行内空格保证（等宽字体渲染），不引入逐单元格 DOM。

/** 每行字节数 */
export const HEX_ROW_BYTES = 16;

const HEX_ASCII_LAST = HEX_ROW_BYTES * 3 - 1; // 十六进制列宽（47）

function toAscii(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
}

/**
 * bytes 自 offset 起的 hex dump 行数组（偏移列以 offset 为首行值，每行步进 16）。
 * 尾行不足 16 字节时十六进制列以空格补齐、ASCII 列以空格补位，总宽与完整行一致。
 */
export function renderHexBytes(bytes: Uint8Array, offset: number): string[] {
  const rows: string[] = [];
  let hexBuf = '';
  let asciiBuf = '';
  let rowStart = 0;
  const flush = (): void => {
    if (asciiBuf === '') return;
    rows.push(
      `${(offset + rowStart).toString(16).padStart(8, '0')}  ${hexBuf.padEnd(HEX_ASCII_LAST)}  |${asciiBuf.padEnd(HEX_ROW_BYTES)}|`
    );
    hexBuf = '';
    asciiBuf = '';
  };
  for (let i = 0; i < bytes.length; i++) {
    if (hexBuf !== '') hexBuf += ' ';
    const b = bytes[i]!;
    hexBuf += b.toString(16).padStart(2, '0');
    asciiBuf += toAscii(b);
    if (asciiBuf.length === HEX_ROW_BYTES) {
      flush();
      rowStart += HEX_ROW_BYTES;
    }
  }
  flush();
  return rows;
}
