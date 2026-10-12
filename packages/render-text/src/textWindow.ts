/**
 * textWindow.ts — 公共文本窗口（io-streaming 计划 3 Task 2）：块解码缓存 LRU +
 * 前缀解码游标 + 跨块字节域拼装。从 jsonl/index.ts 原样抽取（P2-T3 钩子面标准：
 * 分歧段逐字保留、既有 jsonl 用例零变更、双模式等价性钉住），jsonl 窗口模式改用、
 * code 流式渲染（计划 3 Task 4）复用。
 *
 * 三路职责（对应 jsonl 模块头「窗口模式行文本三路」）：
 * - 块解码缓存：Map<blockIndex, BlockTextEntry> LRU（命中触新，超限逐出最旧），
 *   块文本 = 整块字节单次 decode（非 stream 模式，模块级 decoder 单例）；
 * - 前缀解码游标：块内字节偏移 → 块文本字符下标。行首/行尾恒为字符边界（行终
 *   结符是单字节 ASCII），自游标起的字节前缀独立 decode 的长度即字符增量；降序/
 *   冷查询回退整前缀。块 0 前缀 decode 与整块解码同口径剥 BOM；
 * - 跨块字节域拼装：块切口可能切开多字节字符，逐块解码再拼会产出重复 U+FFFD，
 *   拼装必须在字节域进行（gather 按块号分段写入新数组后单次解码）。
 *
 * 块字节取数经注入的 blockAt 闭包（jsonl 注入 bs.block，code 同型）——块未驻留
 * 时由取数方抛错/重拉，本模块不管驻留性（BlockStream has/ensureBlock 把关面）。
 */

/** 块解码缓存条目：块文本 + 前缀解码游标（walkByte 恒为字符边界——只落行首/行尾） */
export interface BlockTextEntry {
  text: string;
  /** 游标已覆盖的字节偏移（块内） */
  walkByte: number;
  /** walkByte 对应的块文本字符下标 */
  walkChar: number;
}

export interface TextWindowOptions {
  /** 块大小（字节）：块号/块内偏移换算与 gather 分段的单位 */
  blockSize: number;
  /** 缓存条目上限（LRU，超限逐出最旧） */
  maxBlocks: number;
  /** 块字节取数闭包（返回块 i 的实际字节——末块可短；未驻留块由取数方抛错） */
  blockAt: (blockIndex: number) => Uint8Array<ArrayBuffer>;
}

export interface TextWindow {
  readonly blockSize: number;
  /** 缓存条目表（Map 插入序即 LRU 新近序）。观测口：单测断言上限与逐出，生产不读 */
  readonly entries: Map<number, BlockTextEntry>;
  /** 块文本条目（LRU 触新；未命中经 blockAt 取字节解码建条目） */
  entryOf(blockIndex: number): BlockTextEntry;
  /** 块内字节偏移 → 块文本字符下标（前缀解码游标推进，条目游标随查询更新） */
  charOffsetOf(entry: BlockTextEntry, blockIndex: number, byteOffset: number): number;
  /** 文件字节域 [startFile, endFile) 跨块拼装（末块短读按实际块长） */
  gather(startFile: number, endFile: number): Uint8Array<ArrayBuffer>;
  /** 原始字节解码（与条目解码同一 decoder 单例——BOM 剥离/替换符口径一致） */
  decode(bytes: Uint8Array<ArrayBuffer>): string;
}

/** 窗口行文本解码器（模块级单例：decode 非 stream 模式调用间无状态） */
const LINE_DECODER = new TextDecoder('utf-8', { fatal: false });

export function createTextWindow(opts: TextWindowOptions): TextWindow {
  const { blockSize, maxBlocks, blockAt } = opts;
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`textWindow：blockSize 须为正整数，收到 ${blockSize}`);
  }
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1) {
    throw new Error(`textWindow：maxBlocks 须为正整数，收到 ${maxBlocks}`);
  }

  // 块解码缓存：blockIndex → 块文本 + 前缀解码游标，LRU 上限 maxBlocks（jsonl
  // 缺省 8 块 ≈ 2MB，spec §4.2）。Map 插入序即 LRU 新近序（hexSource 同款）。
  const entries = new Map<number, BlockTextEntry>();

  /**
   * 块文本条目（LRU：触碰即重插，超限按 Map 插入序逐出最旧）。仅对已驻留的块
   * 调用（调用面以「可见行 ⊆ 驻留块」把关——jsonl 侧 lineAvailable/BlockStream
   * has，缺块走占位 + ensureBlock 重拉，不到这里）。
   */
  function entryOf(b: number): BlockTextEntry {
    const hit = entries.get(b);
    if (hit !== undefined) {
      entries.delete(b);
      entries.set(b, hit);
      return hit;
    }
    const entry: BlockTextEntry = { text: LINE_DECODER.decode(blockAt(b)), walkByte: 0, walkChar: 0 };
    entries.set(b, entry);
    if (entries.size > maxBlocks) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return entry;
  }

  /**
   * 块内字节偏移 → 块文本字符下标。行首/行尾恒为字符边界（行终结符是单字节
   * ASCII），故自游标起的字节前缀独立 decode 的长度即字符增量；降序/冷查询回退
   * 整前缀（块 0 前缀 decode 同样剥 BOM，与整块解码口径一致）。
   */
  function charOffsetOf(e: BlockTextEntry, b: number, byteOff: number): number {
    const bytes = blockAt(b);
    const ch = byteOff >= e.walkByte
      ? e.walkChar + LINE_DECODER.decode(bytes.subarray(e.walkByte, byteOff)).length
      : LINE_DECODER.decode(bytes.subarray(0, byteOff)).length;
    e.walkByte = byteOff;
    e.walkChar = ch;
    return ch;
  }

  /** 行原始字节跨块拼装（[startFile, endFile) 文件字节空间；末块短读按实际块长） */
  function gather(startFile: number, endFile: number): Uint8Array<ArrayBuffer> {
    const b0 = Math.floor(startFile / blockSize);
    const b1 = Math.floor((endFile - 1) / blockSize);
    const first = blockAt(b0);
    if (b0 === b1) {
      return first.subarray(startFile - b0 * blockSize, endFile - b0 * blockSize);
    }
    const out = new Uint8Array(endFile - startFile);
    let pos = 0;
    for (let b = b0; b <= b1; b++) {
      const base = b * blockSize;
      const from = Math.max(0, startFile - base);
      const to = Math.min(blockAt(b).length, endFile - base);
      out.set(blockAt(b).subarray(from, to), pos);
      pos += to - from;
    }
    return out;
  }

  return {
    blockSize,
    entries,
    entryOf,
    charOffsetOf,
    gather,
    decode: (bytes) => LINE_DECODER.decode(bytes)
  };
}
