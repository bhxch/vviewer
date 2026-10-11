// hexBytes.ts — hex dump 行格式纯函数（jsdom 单测直测；DOM 渲染见 hex.ts）。
// 经典三列：8 位十六进制偏移 + 16 字节十六进制（空格分隔）+ 竖线包裹的 ASCII 列。
// 三列对齐由行内空格保证（等宽字体渲染），不引入逐单元格 DOM。
// Task 2：renderHexBytes 增可选命中高亮区间——命中行走两档 span 切分（.vv-hex-hit /
// .vv-hex-hit-active），hex 列与 ASCII 列对应字节同档；无区间时输出与原版逐字节一致。

/** 每行字节数 */
export const HEX_ROW_BYTES = 16;

const HEX_ASCII_LAST = HEX_ROW_BYTES * 3 - 1; // 十六进制列宽（47）
/** 行内布局：偏移列 8 + 2 空格；hex 列 47 + 2 空格 + '|'；ASCII 列自 60 起 */
const HEX_PREFIX_LEN = 10;
const HEX_ASCII_COL = HEX_PREFIX_LEN + HEX_ASCII_LAST + 3; // 60

function toAscii(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
}

/** 命中高亮区间：相对本次 bytes 参数的 [start, end) 字节区间；active = 当前命中档 */
export interface HexHighlight {
  start: number;
  end: number;
  active: boolean;
}

/** 行内切分段：active 为 undefined 的段是普通文本，true/false 对应两档命中类 */
export interface HexRowSpan {
  text: string;
  active?: boolean;
}

/** 高亮行：text 与无高亮时逐字节一致；spans 顺序拼接还原整行 */
export interface HexRow {
  text: string;
  spans: HexRowSpan[];
}

/**
 * 本行命中字节档位（0 无 / 1 普通 / 2 当前，重叠时当前档优先）→ 行列区间：
 * hex 段含段内分隔空格（字节 j 的 hex 列自 10+3j 起两字符），ASCII 列对应字节同档。
 */
function highlightIntervals(
  rowStart: number,
  rowLen: number,
  highlights: HexHighlight[]
): { start: number; end: number; active: boolean }[] {
  const tier = new Uint8Array(HEX_ROW_BYTES);
  for (const hl of highlights) {
    const from = Math.max(hl.start, rowStart);
    const to = Math.min(hl.end, rowStart + rowLen); // 跨行命中裁剪到本行
    const t = hl.active ? 2 : 1;
    for (let b = from; b < to; b++) {
      const j = b - rowStart;
      if (tier[j]! < t) tier[j] = t;
    }
  }
  const intervals: { start: number; end: number; active: boolean }[] = [];
  let j = 0;
  while (j < rowLen) {
    const t = tier[j]!;
    if (t === 0) {
      j++;
      continue;
    }
    const first = j;
    while (j < rowLen && tier[j] === t) j++;
    const last = j - 1;
    intervals.push({
      start: HEX_PREFIX_LEN + 3 * first,
      end: HEX_PREFIX_LEN + 3 * last + 2,
      active: t === 2
    });
    intervals.push({
      start: HEX_ASCII_COL + first,
      end: HEX_ASCII_COL + last + 1,
      active: t === 2
    });
  }
  return intervals.sort((a, b) => a.start - b.start);
}

/** 整行 → 切分段（区间间隙为普通文本，各段拼接无损还原整行） */
function rowSpans(line: string, rowStart: number, rowLen: number, highlights: HexHighlight[]): HexRowSpan[] {
  const spans: HexRowSpan[] = [];
  let cur = 0;
  for (const iv of highlightIntervals(rowStart, rowLen, highlights)) {
    if (iv.start > cur) spans.push({ text: line.slice(cur, iv.start) });
    spans.push({ text: line.slice(iv.start, iv.end), active: iv.active });
    cur = Math.max(cur, iv.end);
  }
  if (cur < line.length) spans.push({ text: line.slice(cur) });
  return spans;
}

/**
 * bytes 自 offset 起的 hex dump 行数组（偏移列以 offset 为首行值，每行步进 16）。
 * 尾行不足 16 字节时十六进制列以空格补齐、ASCII 列以空格补位，总宽与完整行一致。
 * 传 highlights（非空）时返回 HexRow[]：命中行按两档 span 切分，其余行单段整串；
 * 不传（或空数组）时返回 string[]，与无高亮版逐字节一致。
 */
export function renderHexBytes(bytes: Uint8Array, offset: number): string[];
export function renderHexBytes(
  bytes: Uint8Array,
  offset: number,
  highlights?: HexHighlight[]
): string[] | HexRow[];
export function renderHexBytes(
  bytes: Uint8Array,
  offset: number,
  highlights?: HexHighlight[]
): string[] | HexRow[] {
  const highlight = highlights !== undefined && highlights.length > 0;
  const rows: (string | HexRow)[] = [];
  let hexBuf = '';
  let asciiBuf = '';
  let rowStart = 0;
  const flush = (): void => {
    if (asciiBuf === '') return;
    const line = `${(offset + rowStart).toString(16).padStart(8, '0')}  ${hexBuf.padEnd(HEX_ASCII_LAST)}  |${asciiBuf.padEnd(HEX_ROW_BYTES)}|`;
    rows.push(
      highlight
        ? { text: line, spans: rowSpans(line, rowStart, asciiBuf.length, highlights!) }
        : line
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
  return rows as string[] | HexRow[];
}
