/**
 * code/chunks.ts — lazy chunk 常量与行索引构建（FE-2 自 code.ts 分块迁出，函数体
 * 逐字搬移）。本块为子模块 DAG 底层（纯函数零依赖）：chunk 常量/chunkRangeFor/
 * evict 族（chunk 逐出与覆盖率加界）/buildLineIndex/Offsets 族（行索引）。
 */

/** lazy chunk 缓存总行数上限（chunk 粒度逐出，原 hljs-block blockCache 的 5000 行等价）：
 * 超出按插入序整 chunk 淘汰，被逐出的行滚动回来时按需重算 */
export const CHUNK_CACHE_MAX_LINES = 5000;
/** lazy chunk 行粒度：chunk 边界按 200 行对齐，减少窗口移动的重复解析（spec §5.2） */
export const CHUNK_LINES = 200;
/** chunk 请求的额外裕量：virtualScroller 的 overscan(10) + 重叠 2 行——滚动连发时
 * 「请求发出→chunk 完成」间隙内越过的边界行仍落在已请求/已缓存区间 */
export const CHUNK_OVERSCAN_LINES = 10;
export const CHUNK_OVERLAP_LINES = 2;

/**
 * 可视区 [first,last] → 200 行对齐的 chunk 区间（纯函数）：先外扩 overscan+2 行裕量
 * 并夹到文件边界，再按 CHUNK_LINES 对齐（下界向下取整、上界向上取整），chunkKey=startLine。
 * 空文件（虚拟滚动对 0 行传 -1,-1）返回 lineCount 0。
 */
export function chunkRangeFor(
  first: number,
  last: number,
  totalLines: number
): { startLine: number; lineCount: number } {
  if (totalLines <= 0) return { startLine: 0, lineCount: 0 };
  const lo = Math.max(0, Math.min(first, last) - CHUNK_OVERSCAN_LINES - CHUNK_OVERLAP_LINES);
  const hi = Math.min(totalLines - 1, Math.max(first, last) + CHUNK_OVERSCAN_LINES + CHUNK_OVERLAP_LINES);
  if (hi < lo) return { startLine: 0, lineCount: 0 };
  const startLine = Math.floor(lo / CHUNK_LINES) * CHUNK_LINES;
  const endLine = Math.min(totalLines - 1, (Math.floor(hi / CHUNK_LINES) + 1) * CHUNK_LINES - 1);
  return { startLine, lineCount: endLine - startLine + 1 };
}

/** Map 插入序淘汰：把 m 裁到 ≤max 条（最早写入的先删） */
export function evictOldestEntries<K, V>(m: Map<K, V>, max: number): void {
  let excess = m.size - max;
  while (excess-- > 0) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    m.delete(oldest.value);
  }
}

/** chunkCoverage 条目上限（R-1 加界）：覆盖率条目与 chunk 缓存同阶只增不减，
 * 512MB 流式上限 × 短行（~16B）理论可达数万条目——与 chunk 缓存逐出联动加界：
 * 超出按插入序清最旧。被清条目的 chunk 若其高亮缓存仍在，hasChunkData 的覆盖率
 * 裁决视为未处理而重发（覆盖式整 chunk 重算、set 回写条目，无正确性影响，代价
 * 仅为极端长文件下最旧 chunk 的一次重高亮）；与「缓存缺席面兜底重发」同语义 */
export const CHUNK_COVERAGE_MAX_ENTRIES = 4096;

/** chunkCoverage 加界（纯函数，导出供单测）：超出上限按插入序清最旧（evictOldestEntries 复用） */
export function capChunkCoverage(coverage: Map<number, number>): void {
  evictOldestEntries(coverage, CHUNK_COVERAGE_MAX_ENTRIES);
}

/**
 * chunk 粒度逐出（纯函数）：把 chunk 缓存（startLine → 行 map）总行数裁到 ≤maxLines，
 * 超出版的最早 chunk 整个删除（行级半删会让 chunkKey 缓存标记失真——hasChunkData 按
 * 键判断「已处理」，整删才能保证被逐出的 chunk 下次完整重算）。
 */
export function evictChunksByLines<V>(m: Map<number, Map<number, V>>, maxLines: number): void {
  let total = 0;
  for (const chunk of m.values()) total += chunk.size;
  while (total > maxLines) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    total -= m.get(oldest.value)?.size ?? 0;
    m.delete(oldest.value);
  }
}

/**
 * 行表构建（BUG-38 尾 \n 归一）：以 \n 结尾的文本不再产出末尾虚行——'a\nb\n' →
 * ['a','b']（wc -l 口径 2 行），与 getMeta/状态栏/服务端行域（StartBeyondEof 校验）
 * 同一口径；中间空行保留（'a\n\n' → ['a','']）；空文件 '' → []（0 行）。缺陷态
 * split('\n') 的尾空串元素曾让虚拟滚动多渲染一条不存在的空行（gutter N+1 与状态栏
 * 「行: N」矛盾），服务端档滚到底还会以虚行行号发出 {startLine:N, lineCount:1} 的
 * highlight chunk 被 StartBeyondEof 判 400。
 */
export function buildLineIndex(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

/** 行起始偏移（UTF-16，含前序换行符）：'ab\ncd' → [0, 3] */
export function buildLineOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = offset;
    offset += lines[i]!.length + 1; // +1 换行符
  }
  return offsets;
}

/**
 * 字节域行起始偏移（spec 2026-10-16 错误身份与字节映射 §4.5）：在原始 buffer 上扫
 * 终结符记行起始——\r\n 单终结符记 2 字节、\n 记 1、lone \r 亦终结记 1（与字符域
 * 归一语义的行号一致）；BOM 从偏移剔除（post-BOM 逻辑域，与 jsonl 索引 offsets
 * 同基）。BUG-38 尾 \n 归一：末尾终结符不再产出伪起始条目（与 buildLineIndex 的
 * 尾 \n 归一对齐，两域行号逐行一致）；空文件/BOM-only 返回 []（lineOf 二分在空表
 * 上恒钳 0，lineAtByteOffset 越界钳末行语义不受影响）。lone \r 文件两域不可同时
 * 逐字节对齐（jsonl 记账不终结），属已知边界（jsonl 内容按定义不含裸 \r 行尾）。
 * 非 UTF-8 多字节编码（GBK/Shift_JIS 等）的尾字节均不含 0x0D/0x0A，终结符扫描
 * 不受干扰；口径按原始字节定义（spec §4.5）。
 */
export function buildByteLineOffsets(buffer: Uint8Array): number[] {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const starts: number[] = buffer.length > bom ? [0] : [];
  let i = bom;
  while (i < buffer.length) {
    const b = buffer[i]!;
    if (b === 0x0d) {
      i += buffer[i + 1] === 0x0a ? 2 : 1;
    } else if (b === 0x0a) {
      i += 1;
    } else {
      i += 1;
      continue;
    }
    if (i < buffer.length) starts.push(i - bom); // 文件尾终结符后的空段非真实行，不产伪起始
  }
  return starts;
}
