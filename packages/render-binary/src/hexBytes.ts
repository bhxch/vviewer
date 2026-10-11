// hexBytes.ts — hex dump 行格式纯函数（jsdom 单测直测；DOM 渲染见 hex.ts）。
// 经典三列：8 位十六进制偏移 + 16 字节十六进制（空格分隔）+ 竖线包裹的 ASCII 列。
// 三列对齐由行内空格保证（等宽字体渲染），不引入逐单元格 DOM。
// Task 2：renderHexBytes 增可选命中高亮区间——命中行走两档 span 切分（.vv-hex-hit /
// .vv-hex-hit-active），hex 列与 ASCII 列对应字节同档；无区间时输出与原版逐字节一致。
// Task 3：档位扩展 cursor（光标字节）与 flash（跳转衰减）——四个单字节/区间档按
// 字节叠加时高档胜出，cursor 与命中区间同行共存即天然合并（hex.ts 装饰机制复用）。

/** 每行字节数 */
export const HEX_ROW_BYTES = 16;

const HEX_ASCII_LAST = HEX_ROW_BYTES * 3 - 1; // 十六进制列宽（47）
/** 行内布局：偏移列 8 + 2 空格；hex 列 47 + 2 空格 + '|'；ASCII 列自 60 起 */
const HEX_PREFIX_LEN = 10;
const HEX_ASCII_COL = HEX_PREFIX_LEN + HEX_ASCII_LAST + 3; // 60

function toAscii(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
}

/**
 * 高亮区间：相对本次 bytes 参数的 [start, end) 字节区间；active = 当前命中档。
 * Task 3 增 cursor（光标字节）与 flash（跳转衰减）两个档——同一字节被多个区间
 * 覆盖时高档胜出（优先级 cursor > flash > active 命中 > 普通命中），不产生嵌套
 * span（区间合并由 highlightIntervals 的逐字节档位归并完成）。
 */
export interface HexHighlight {
  start: number;
  end: number;
  active: boolean;
  /** 光标字节档（Task 3）：最高优先级（光标是用户显式意图，命中是批量标注） */
  cursor?: boolean;
  /** 跳转衰减档（Task 3 收编 T1 行级 flash）：高于命中两档、低于 cursor */
  flash?: boolean;
}

/** 行内切分段：无档位字段的段是普通文本；cursor/flash/active 三档互斥（高档胜出） */
export interface HexRowSpan {
  text: string;
  active?: boolean;
  cursor?: boolean;
  flash?: boolean;
}

/** 高亮行：text 与无高亮时逐字节一致；spans 顺序拼接还原整行 */
export interface HexRow {
  text: string;
  spans: HexRowSpan[];
}

/**
 * 字节档位：0 无 / 1 普通命中 / 2 当前命中 / 3 跳转衰减 / 4 光标。同一字节多区间
 * 覆盖时高档胜出（取 max）——cursor 与命中区间同字节共存即在此合并，无嵌套 span。
 */
function tierOf(hl: HexHighlight): number {
  return hl.cursor ? 4 : hl.flash ? 3 : hl.active ? 2 : 1;
}

/**
 * 本行高亮字节档位 → 行列区间：hex 段含段内分隔空格（字节 j 的 hex 列自 10+3j 起
 * 两字符），ASCII 列对应字节同档。
 */
function highlightIntervals(
  rowStart: number,
  rowLen: number,
  highlights: HexHighlight[]
): { start: number; end: number; tier: number }[] {
  const tier = new Uint8Array(HEX_ROW_BYTES);
  for (const hl of highlights) {
    const from = Math.max(hl.start, rowStart);
    const to = Math.min(hl.end, rowStart + rowLen); // 跨行命中裁剪到本行
    const t = tierOf(hl);
    for (let b = from; b < to; b++) {
      const j = b - rowStart;
      if (tier[j]! < t) tier[j] = t;
    }
  }
  const intervals: { start: number; end: number; tier: number }[] = [];
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
      tier: t
    });
    intervals.push({
      start: HEX_ASCII_COL + first,
      end: HEX_ASCII_COL + last + 1,
      tier: t
    });
  }
  return intervals.sort((a, b) => a.start - b.start);
}

/** 档位 → 切分段（三档互斥：cursor/flash 布尔字段，命中两档经 active 表达） */
function tierToSpan(text: string, tier: number): HexRowSpan {
  if (tier === 4) return { text, cursor: true };
  if (tier === 3) return { text, flash: true };
  return { text, active: tier === 2 };
}

/** 整行 → 切分段（区间间隙为普通文本，各段拼接无损还原整行） */
function rowSpans(line: string, rowStart: number, rowLen: number, highlights: HexHighlight[]): HexRowSpan[] {
  const spans: HexRowSpan[] = [];
  let cur = 0;
  for (const iv of highlightIntervals(rowStart, rowLen, highlights)) {
    if (iv.start > cur) spans.push({ text: line.slice(cur, iv.start) });
    spans.push(tierToSpan(line.slice(iv.start, iv.end), iv.tier));
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

/**
 * 行内字符列 → 字节序号（Task 3 点击定位的纯换算，jsdom 单测锁定；调用方只需把
 * 点击 x 坐标换算成字符列）。布局同上行构造：偏移列 [0,10) 归首字节（最近字节
 * 语义）；hex 列自 10 起每字节 3 列，字节间分隔空格归左邻字节；hex/ASCII 两列的
 * 间隙 [57,60) 与闭合竖线归末字节；ASCII 列自 60 起逐字节。col 须已 clamp 到行宽
 * 内；rowLen 为本行实际字节数（尾行 <16），越界一律 clamp 到 rowLen-1。
 */
export function byteIndexAtColumn(col: number, rowLen: number): number {
  if (col >= HEX_ASCII_COL) return Math.min(col - HEX_ASCII_COL, rowLen - 1);
  return Math.min(Math.max(Math.floor((col - HEX_PREFIX_LEN) / 3), 0), rowLen - 1);
}
