/**
 * codeIndexStream.ts — codeIndex 行索引流式推进器（io-streaming 计划 3 Task 3）。
 * 纯逻辑模块（零 DOM / 零 IO）：在原始 UTF-8 字节流上增量维护「行起始偏移 + 行
 * 字节长」索引，供 code 渲染器流式模式后台构建行索引（首屏只需首块索引即可渲染，
 * 可视行解码经块缓存，同 jsonl 形态）。
 *
 * 语义对齐（等价性硬约束）：对任意文本，「全量 decode→replace(/\r\n?/g,'\n')→
 * buildLineIndex（尾 \n 归一，code.ts）」的行序列与本模块「offsets/lengths 逐行取
 * 字节」在 UTF-8 假设下逐行号严格等价（等价性用例钉住，见 test/code-index-stream.test.ts）：
 * - 行终结符为 \n 或 \r，\r\n 记一个终结符（对齐归一化 replace(/\r\n?/g,'\n')）；
 * - **每一行都产出条目**，含空行与纯空白行（与 jsonlIndex 的关键差异）：code 行号
 *   = 文本行号（buildLineIndex 逐元素对齐），虚拟滚动 itemCount =
 *   lines.length（code.ts 现状），故行 i 的字节段 decode 后必为 lines[i]；
 * - 文本以终结符收尾时**不产出末尾虚行条目**（BUG-38 尾 \n 归一：'a\n' → ['a']
 *   单条目，空文件 '' → 0 条目）——finishCodeIndex 仅在悬挂尾段非空（文件不以
 *   终结符收尾）时提交；finish 幂等（重复调用不追加）。
 * - 巨行阈值：code 无逐行巨行防护概念（code.ts 的超限防线是整 buffer 级
 *   STREAM_MAX_BYTES=512MB，非逐行），故 maxLineBytes 支持 **Infinity 语义**：
 *   永不记 oversized（流式渲染器将以 Infinity 调用）；有限阈值仍按 >= 判定（等号
 *   即超限，与 jsonlIndex 同口径），供调用方自选。
 *
 * 实现独立于 jsonl/indexStream.ts（简报允许二选一）：差异是三点耦合语义（空行
 * 产出 + 末尾空串条目 + Infinity 校验），参数化需给生产稳定基座（jsonl 窗口模式）
 * 加多枚举开关，风险大于约 50 行扫描循环的复用收益；字节扫描机制（prevCr 跨块
 * 状态、终结符单字节 ASCII、loadedBytes 按块推进）与其同型。
 *
 * 跨块设计裁决：调用方必须按序喂块（BlockStream 按 blockSize 切，不保证行对齐）；
 * 本模块内部维护「上一字节是否 \r」的跨块状态，任意切面的块序列均产出同一索引。
 * UTF-8 多字节字符跨块无影响——字节扫描不解码，行边界（终结符）恒为单字节 ASCII。
 */

/** codeIndex 公共索引状态（Produces 契约）：与 JsonlIndexState 同型，offsets/
 * lengths 平行数组按产出序（行号 = 文本行号，含空行条目，无尾终结符虚行） */
export interface CodeIndexState {
  /** 行起始字节偏移（相对文件头；行内容不含终结符） */
  offsets: number[];
  /** 各行字节长（不含终结符；与 offsets 平行） */
  lengths: number[];
  /** 已消费的字节游标（块边界或行终结符后） */
  loadedBytes: number;
  /** 已扫描到文件末尾 */
  atEnd: boolean;
  /** 行字节长 >= maxLineBytes 的行号集合（等号即超限）；maxLineBytes 为 Infinity
   * 时恒空（code 无逐行巨行防护概念） */
  oversized: Set<number>;
}

/** 模块内私有扫描状态：经 WeakMap 附着于公共 CodeIndexState（Produces 接口
 * 字段集固定，实现细节不进公共契约）。段起始偏移不单独维护——提交时按
 * 「终结符绝对位置 - 段字节长」推得，天然跨块正确 */
interface CodeScanState {
  /** 待定行段迄今字节长（0 = 空行段/刚提交） */
  lineLen: number;
  /** 上一字节是否 \r（跨块 CRLF 判定：下一字节若为 \n 则吞掉） */
  prevCr: boolean;
  /** 巨行阈值（createCodeIndex 入参，Infinity 合法；一并收进私有状态） */
  maxLineBytes: number;
}

const internals = new WeakMap<CodeIndexState, CodeScanState>();

/** 行终结：条目 = [endPos - lineLen, endPos)，endPos 为终结符（或 EOF）绝对字节
 * 位置。code 语义每行必产出（空行段 lineLen=0 也产出），产出后判巨行 */
function commitLine(state: CodeIndexState, scan: CodeScanState, endPos: number): void {
  const lineNo = state.offsets.length;
  state.offsets.push(endPos - scan.lineLen);
  state.lengths.push(scan.lineLen);
  if (scan.lineLen >= scan.maxLineBytes) state.oversized.add(lineNo);
  scan.lineLen = 0;
}

export function createCodeIndex(maxLineBytes: number): CodeIndexState {
  if (
    maxLineBytes !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0)
  ) {
    throw new Error(`createCodeIndex：maxLineBytes 须为正整数或 Infinity，收到 ${maxLineBytes}`);
  }
  const state: CodeIndexState = {
    offsets: [],
    lengths: [],
    loadedBytes: 0,
    atEnd: false,
    oversized: new Set<number>()
  };
  internals.set(state, { lineLen: 0, prevCr: false, maxLineBytes });
  return state;
}

/**
 * 喂入一块原始 UTF-8 字节（任意切面；调用方必须按序喂块）推进索引。
 * 逐字节扫描：\r 立即终结当前行（旧 Mac 语义）并置 prevCr，随后紧跟的 \n 吞掉
 * （CRLF 一个终结符）；\n 终结当前行；其余字节累计进行。loadedBytes 统一按块长
 * 推进。消费契约（同 jsonlIndex）：finishCodeIndex 之后不得再 advanceCodeIndex。
 */
export function advanceCodeIndex(state: CodeIndexState, chunk: Uint8Array): void {
  const scan = internals.get(state);
  if (scan === undefined) throw new Error('advanceCodeIndex：state 非本模块产物（缺内部扫描状态）');
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i]!;
    if (scan.prevCr) {
      scan.prevCr = false;
      if (b === 0x0a) continue; // \r\n 的尾巴：不终结、不开新行
    }
    if (b === 0x0a) {
      commitLine(state, scan, state.loadedBytes + i);
      continue;
    }
    if (b === 0x0d) {
      commitLine(state, scan, state.loadedBytes + i);
      scan.prevCr = true;
      continue;
    }
    scan.lineLen += 1;
  }
  state.loadedBytes += chunk.length;
}

/**
 * 文件末尾标记：悬挂尾段非空（文件不以终结符收尾）时提交尾行；以终结符收尾的
 * 悬挂空段不再提交（BUG-38 尾 \n 归一——'a\n' 的 split 末尾空串是虚行，条目数
 * = wc -l 口径，与全量 buildLineIndex 的尾 \n 归一语义逐行对齐；'' → 0 条目、
 * 'a' → 1 条目）。置 atEnd；重复调用幂等（atEnd 后不再追加）。
 */
export function finishCodeIndex(state: CodeIndexState): void {
  const scan = internals.get(state);
  if (scan === undefined) throw new Error('finishCodeIndex：state 非本模块产物（缺内部扫描状态）');
  if (state.atEnd) return;
  if (scan.lineLen > 0) commitLine(state, scan, state.loadedBytes);
  state.atEnd = true;
}
