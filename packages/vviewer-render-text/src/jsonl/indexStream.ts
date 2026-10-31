/**
 * indexStream.ts — jsonlIndex 行索引流式推进器（io-streaming 计划 2 Task 2）。
 * 纯逻辑模块（零 DOM / 零 IO）：在原始 UTF-8 字节流上增量维护「行起始偏移 + 行
 * 字节长」索引，供行级懒加载渲染（先见行骨架、卡片进入窗口再取块解码）。
 *
 * 语义对齐（等价性硬约束）：对任意文本，「全量 decode→replace(/\r\n?/g,'\n')→
 * splitJsonlLines」的行序列与本模块「offsets/lengths 逐行取字节」在 UTF-8 假设下
 * 等价（专用等价性用例钉住，见 test/jsonl-index-stream.test.ts）：
 * - 行终结符为 \n 或 \r，\r\n 记一个终结符（对齐归一化 replace(/\r\n?/g,'\n')）；
 * - 空行与纯 ASCII 空白行（空格/\t/\v/\f 构成的行）不产出条目（对齐 splitJsonlLines
 *   丢弃 trim()==='' 的行）；含多字节 Unicode 空白（U+00A0/U+3000 等）的行在字节层
 *   无法廉价判定为空白，按内容行产出——与 trim() 的差异仅限此病态输入，下游
 *   parseJsonlLine 会将其正常解析为 failed 行（不崩溃、有展示），见任务报告说明；
 * - 巨行阈值与 parse.ts 的 JSONL_OVERSIZE_LINE_BYTES 同源（>maxLineBytes 语义为
 *   「行字节长 >= maxLineBytes 记 oversized」，等号即超限——对齐 parseJsonlLine 的
 *   >= 判定与其「1MB 整为超限」测试锚定；简报注释的「>」以 parse.ts 实测为准）。
 *
 * 跨块设计裁决：调用方必须按序喂块（BlockStream 按 blockSize 切，不保证行对齐）；
 * 本模块内部维护「上一字节是否 \r」的跨块状态，任意切面的块序列均产出同一索引。
 * UTF-8 多字节字符跨块无影响——字节扫描不解码，行边界（终结符）恒为单字节 ASCII。
 */

/** jsonlIndex 公共索引状态（Produces 契约）：offsets/lengths 平行数组按产出序 */
export interface JsonlIndexState {
  /** 行起始字节偏移（相对文件头；行内容不含终结符） */
  offsets: number[];
  /** 各行字节长（不含终结符；与 offsets 平行） */
  lengths: number[];
  /** 已消费的字节游标（块边界或行终结符后） */
  loadedBytes: number;
  /** 已扫描到文件末尾 */
  atEnd: boolean;
  /** 超长行（行字节长 >= maxLineBytes，等号即超限——对齐 parseJsonlLine 的 >=
   * 判定与「1MB 整为超限」测试锚定）行号集合——不解析、预览截断（parse.ts 既有
   * 语义）；行号为产出条目下标（空行/空白行已剔除后的 0 基序号） */
  oversized: Set<number>;
}

/** 模块内私有扫描状态：经 WeakMap 附着于公共 JsonlIndexState（Produces 接口
 * 字段集固定，实现细节不进公共契约） */
interface IndexScanState {
  /** 待定行起始字节偏移（行首内容字节出现时置位） */
  lineStart: number;
  /** 待定行迄今字节长（0 = 行未开始/刚提交） */
  lineLen: number;
  /** 待定行迄今是否全为 ASCII 空白（提交时据此丢弃纯空白行） */
  lineBlank: boolean;
  /** 上一字节是否 \r（跨块 CRLF 判定：下一字节若为 \n 则吞掉） */
  prevCr: boolean;
  /** 巨行阈值（createJsonlIndex 入参，一并收进私有状态） */
  maxLineBytes: number;
}

const internals = new WeakMap<JsonlIndexState, IndexScanState>();

/** ASCII 空白字节（JS trim() 可移除的 ASCII 子集；\n/\r 属终结符不在此列） */
function isAsciiWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0b || b === 0x0c;
}

/** 行终结：按 splitJsonlLines 语义决定产出（空行/纯空白行丢弃），产出才判巨行 */
function commitLine(state: JsonlIndexState, scan: IndexScanState): void {
  if (scan.lineLen > 0 && !scan.lineBlank) {
    const lineNo = state.offsets.length;
    state.offsets.push(scan.lineStart);
    state.lengths.push(scan.lineLen);
    if (scan.lineLen >= scan.maxLineBytes) state.oversized.add(lineNo);
  }
  scan.lineLen = 0;
  scan.lineBlank = true;
}

export function createJsonlIndex(maxLineBytes: number): JsonlIndexState {
  if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new Error(`createJsonlIndex：maxLineBytes 须为正整数，收到 ${maxLineBytes}`);
  }
  const state: JsonlIndexState = {
    offsets: [],
    lengths: [],
    loadedBytes: 0,
    atEnd: false,
    oversized: new Set<number>()
  };
  internals.set(state, { lineStart: 0, lineLen: 0, lineBlank: true, prevCr: false, maxLineBytes });
  return state;
}

/**
 * 喂入一块原始 UTF-8 字节（任意切面；调用方必须按序喂块）推进索引。
 * 逐字节扫描：\r 立即终结当前行（旧 Mac 语义）并置 prevCr，随后紧跟的 \n 吞掉
 * （CRLF 一个终结符）；\n 终结当前行；其余字节累计进行（首字节记行起点，同时
 * 维护「全空白行」判定）。loadedBytes 统一按块长推进。
 */
export function advanceJsonlIndex(state: JsonlIndexState, chunk: Uint8Array): void {
  const scan = internals.get(state);
  if (scan === undefined) throw new Error('advanceJsonlIndex：state 非本模块产物（缺内部扫描状态）');
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i]!;
    if (scan.prevCr) {
      scan.prevCr = false;
      if (b === 0x0a) continue; // \r\n 的尾巴：不终结、不开新行
    }
    if (b === 0x0a) {
      commitLine(state, scan);
      continue;
    }
    if (b === 0x0d) {
      commitLine(state, scan);
      scan.prevCr = true;
      continue;
    }
    if (scan.lineLen === 0) scan.lineStart = state.loadedBytes + i;
    scan.lineLen += 1;
    if (!isAsciiWs(b)) scan.lineBlank = false;
  }
  state.loadedBytes += chunk.length;
}

/**
 * 文件末尾标记：提交悬挂的无终结符尾行（'a\nb' 的 'b'）并置 atEnd。
 * Produces 接口未给出 EOF 触发方式，补此显式导出（避免用空 chunk 之类隐式信号）。
 */
export function finishJsonlIndex(state: JsonlIndexState): void {
  const scan = internals.get(state);
  if (scan === undefined) throw new Error('finishJsonlIndex：state 非本模块产物（缺内部扫描状态）');
  commitLine(state, scan);
  state.atEnd = true;
}
