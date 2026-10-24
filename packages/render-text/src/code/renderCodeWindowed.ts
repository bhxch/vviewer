/**
 * code/renderCodeWindowed.ts — 窗口流式渲染路径（FE-2 自 code.ts 分块迁出，函数体
 * 逐字搬移；含 pump 常量与 codeWindowedPumpControls WeakMap）。renderCodeWindowed
 * 原为 code.ts 模块内私有函数，跨块消费（renderCode 的 ctx 分派）升 internal 导出。
 * attachedClient/attachedRouter 的读取经 client.getHighlightClient/getHighlightRouter
 * （行为等价的读取面，拆分前为同模块直读）。
 */
import { isAbortError, showErrorCard, type ComputeWhere, type SearchMatch, type StreamCtx } from '@vviewer/core';
import { detectLanguage, HighlightCanceledError } from '@vviewer/highlight';
import { STREAM_MAX_BYTES, createBlockStream, isSuspiciousUtf8Block } from '../blockStream';
import { createTextWindow } from '../textWindow';
import { advanceCodeIndex, createCodeIndex, finishCodeIndex } from '../codeIndexStream';
import { virtualScroller, type VirtualScrollerHandle } from '../virtualScroller';
import { searchCode, type SearchMatchWithPreview } from '../search';
import {
  LINE_HEIGHT,
  HLJS_MAX_BYTES,
  resolveHljsLang,
  highlightAutoDetect,
  type HighlightStrategy,
  type HLJS
} from './strategy';
import {
  CHUNK_LINES,
  CHUNK_CACHE_MAX_LINES,
  chunkRangeFor,
  evictChunksByLines,
  capChunkCoverage,
  buildLineOffsets
} from './chunks';
import {
  type LineSeg,
  renderLineHtml,
  overlaySearchHits,
  escapeHtml,
  splitHighlightedLines,
  mergeChunkLines
} from './lines';
import {
  type CodeEngine,
  type CodeRenderOptions,
  type LargeFileHighlightChunk,
  type RenderCodeHandle,
  getHighlightClient,
  getHighlightRouter,
  waitForAttachedClient
} from './client';

// ---------- 窗口流式模式（io-streaming 计划 3 Task 4，spec §4.3） ----------
//
// 前置条件（codeRenderer.render 守卫）：ctx 存在且编码为 UTF-8（Encoding 联合类型
// 无 ascii——ASCII 为 UTF-8 子集，探测即 utf-8）。窗口模式仅 UTF-8/ASCII：行终结符
// 字节扫描与块解码均依赖 UTF-8 假设；非 UTF-8 回退全量路径后 dispatcher 终审 F2 以
// 全量重算 detect 编码精判——detect 的 O(n) 全量扫描只发生在全量路径（设计内解决
// detect 收口遗留）。
//
// 形态同 jsonl 窗口模式（spec §4.2/§4.3）：BlockStream 256KB 逐块喂 codeIndex 后台
// 推进行索引（首屏首块即可渲染）；行文本经 textWindow 块解码缓存切片/跨块字节域拼
// 装；滚动接近已加载尾部续读；行所需块被块表 LRU 逐出走「占位 + ensure + 重拉」
// （hex 同语义）；高亮沿用 lazy chunk 机制（chunkKey=startLine），仅行文本来源换
// textWindow。size 未知同样流式（BlockStream 短读探测 atEnd）；!rangeCapable 的全量
// 视图（ctx.head=全量+同步切片 read）属退化形态，BlockStream head 预置全部块后零 IO
// 排空；200-回退切全量底座同构（二次路径自查：degraded 后排空即全量等价，无需重选路）。
//
// 防线换代（spec §4.3）：窗口模式不再有全量解码失控前提——上限裁决换 STREAM_MAX_BYTES
// （512MB，索引/块表常驻内存口径）：size 已知构造即知（零读停机 + 提示条建议 hex），
// size 未知随续读逐块裁决（confirmedBytes 判定，动态插条）。PLAIN_MAX_BYTES 仅约束
// 非 streaming 的全量调用面（jsonl 委托/降级卡等），本模式不触及。
//
// 首拉失败面：start() 的首块拉取/本地化排空失败经 whenReady 上抛（codeRenderer.render
// await 后销毁半装配实例再 rethrow——dispatcher 已把 ctx.read 失败标为 DispatchReadError，
// 走调用方读取失败面，同 jsonl 渲染期首拉口径）；滚动期续读/回看重拉失败自兜底
// （continueFailed/reloadFailed 停机闩 + 用户滚动动作解除，「下次用户动作才重试」，
// hex/jsonl 三处纪律同款）。

/** 窗口模式块大小：256KB（jsonl 窗口同款，spec §4.2 口径：首屏首块即可渲染） */
const CODE_WINDOW_BLOCK_BYTES = 256 * 1024;
/** 块解码缓存 LRU 上限（块数）：8 块 ≈ 2MB 解码文本（spec 验收「jsonl/code 文本缓存 ≤8 块」） */
const CODE_TEXT_CACHE_MAX_BLOCKS = 8;
/** BlockStream 块表驻留上界（块数）：16×256KB = 4MB 原始字节（jsonl 同款；逐出块经
 * 行渲染占位 + ensureBlock 重拉补齐，坐标与字节不变） */
const CODE_STREAM_MAX_BLOCKS = 16;
/** 续读余量（行）：可视末行距已加载尾部 ≤ 此值即续读下一块（scroller overscan 10 的 2 倍，
 * 覆盖滚动连发时「请求发出→块完成」间隙的越界窗口） */
const WINDOW_CONTINUE_MARGIN_LINES = 20;
/** 后台索引泵（BUG-201）：拉块间隙节拍（毫秒）——逐块让出主线程 */
const CODE_PUMP_TICK_MS = 0;
/** 后台索引泵：单飞闸被占（滚动续读/回看重拉/搜索扫描在飞）时的重评间隔（毫秒）
 * ——不取 0，防慢网 stall 期间 0ms 定时器空转刷频（fa41d40 进度自旋同病理） */
const CODE_PUMP_WAIT_MS = 50;
/** 流式上限提示条（spec §4.3 防线换代：非失败态，不复用错误卡片；建议 hex 与 jsonl
 * STREAM_LIMIT_NOTICE 同口径） */
const CODE_STREAM_LIMIT_NOTICE =
  '文件超过 512MB，已达流式渲染上限（索引停止推进），建议以 hex 打开';

/** internal：renderCode 的 ctx 分派入口（拆分前为 code.ts 模块内私有函数） */
export function renderCodeWindowed(
  ctx: StreamCtx,
  buffer: Uint8Array,
  target: HTMLElement,
  opts: CodeRenderOptions
): RenderCodeHandle {
  // 行尺度（字体系统 Task 2）：局部 lineHeight 单源供全部消费点（fillRows/mount/
  // jumpToLine 闭包捕获），缺省回落 LINE_HEIGHT（全量路径同款）
  const lineHeight = opts.lineMetrics?.lineHeight ?? LINE_HEIGHT;
  // 高亮分界（spec §4.3）：窗口模式按定义 >2MB（或 size 未知）→ lazy；highlight:false
  // 仍纯文本（renderDegradedCode/委托形态不传 ctx，此组合仅直接调用可达）
  const strategy: HighlightStrategy = opts.highlight === false ? 'plain' : 'lazy';
  // 语言：与全量模式同一表达式形态，但文本探测仅用头部 8KB——shebang 恒在首行，
  // ext 命中 languages.json 时文本不参与。窗口模式不持全量解码文本（spec 验收内存
  // 有界断言：唯一的全量解码面是行级窗口切片）
  const headText = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, 8192));
  const lang = opts.lang ?? (opts.ext ? detectLanguage(opts.ext, headText) : null);

  target.classList.add('vv-code');
  const pre = document.createElement('div');
  pre.className = 'vv-code-pre'; // virtualScroller 的滚动容器

  // 提示条（BUG-20 同构）：pre 的兄弟节点而非子节点——virtualScroller 会
  // replaceChildren 滚动容器，提示条放里面会被清掉且 spacer 定位被顶偏。
  // 流式上限提示不受 noticeEnabled 门控（它是停机解释而非高亮提示；highlight:false
  // 的窗口调用超限同样必须解释「为何不再推进」）
  let limitReached = ctx.size !== null && ctx.size > STREAM_MAX_BYTES;
  const noticeEnabled = opts.oversizeNotice ?? opts.highlight !== false;
  let noticeBar: HTMLElement | null = null;
  function buildNotice(text: string): void {
    if (noticeBar !== null) return;
    noticeBar = document.createElement('div');
    noticeBar.className = 'vv-error-card vv-oversize-card vv-code-oversize-card';
    const title = document.createElement('div');
    title.className = 'vv-error-title';
    title.textContent = text;
    noticeBar.append(title);
  }
  function mountNotice(): void {
    if (noticeBar === null || noticeBar.isConnected) return;
    target.classList.add('vv-code-oversize');
    target.insertBefore(noticeBar, pre);
  }
  if (limitReached) {
    buildNotice(CODE_STREAM_LIMIT_NOTICE);
  } else if (
    noticeEnabled && strategy === 'lazy' && ctx.size !== null && ctx.size > HLJS_MAX_BYTES
  ) {
    buildNotice(
      `文件超过 ${HLJS_MAX_BYTES / 1024 / 1024}MB，已按可视区懒高亮显示（滚动到即增量解析，稍候即着色）`
    );
  }
  if (noticeBar !== null) target.replaceChildren(noticeBar, pre);
  else target.replaceChildren(pre);

  // 块流 + 行索引 + 文本窗口（Task 1/2/3 公共基座）：索引在原始 UTF-8 字节上增量
  // 推进（不解码）；行文本经块解码缓存切片/跨块字节域拼装。maxLineBytes=Infinity：
  // code 无逐行巨行防护概念（超限防线是整流级 STREAM_MAX_BYTES，非逐行）
  const readAbort = new AbortController(); // 实例级：destroy 时取消全部在飞块读
  const bs = createBlockStream(ctx, CODE_WINDOW_BLOCK_BYTES, {
    maxBlocks: CODE_STREAM_MAX_BLOCKS,
    signal: readAbort.signal
  });
  const index = createCodeIndex(Number.POSITIVE_INFINITY);
  const win = createTextWindow({
    blockSize: CODE_WINDOW_BLOCK_BYTES,
    maxBlocks: CODE_TEXT_CACHE_MAX_BLOCKS,
    blockAt: (b) => bs.block(b)
  });
  // BOM 剥离（jsonl 窗口同裁决）：恒在文件头=块 0 首，无跨块问题；剥离后索引偏移为
  // 逻辑字节空间（文件字节 = 逻辑偏移 + bomLen），首行解码与全量 TextDecoder 剥 BOM
  // 口径一致——不剥则首行长度含 BOM，getMeta 展示层口径漂移
  let bomLen = 0;
  let nextFeed = 0; // 下一个待喂索引的块号
  // 消费契约（codeIndexStream）：finishCodeIndex 之后不得再 advanceCodeIndex——
  // 此标志后续读全部停机，EOF 确认后滚动零 IO
  let indexFinished = false;
  // 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8（head 误判 utf-8 形态）——置位后停喂
  //（防 U+FFFD 扩散），降级经注入出口异步进行。已喂的干净前缀在降级完成前保持可读。
  // 无降级通道（onEncodingBroken 缺省）不嗅探：行为与现状一致
  let encodingBroken = false;
  let downgradePromise: Promise<void> | null = null;
  // 降级产物（全量重渲实例）：窗口 handle 的方法面转投它（ViewerPane 只持窗口
  // handle——render 已先于滚动期降级返回），销毁复合收口
  let fullInst: RenderCodeHandle | null = null;
  // 行数 = 索引条目数：codeIndexStream 已对尾终结符归一（BUG-38，'a\n' → 1 条目），
  // rows() 即 wc -l 口径（EOF 后与全量 buildLineIndex lines.length 同值），虚拟滚动
  // itemCount/chunkRangeFor 的 totalLines 同口径，不再有「末尾空串条目」虚行
  const rows = (): number => index.offsets.length;

  // lazy 路径双缓存（chunkKey=startLine → 行 map）：与全量模式同构，仅行文本来源换
  // textWindow（highlightChunk 内 subLines 构建）
  const chunkCache = new Map<number, Map<number, LineSeg[]>>();
  const hljsChunkCache = new Map<number, Map<number, string>>();
  let hljs: HLJS | null = null;
  let hljsLang: string | null = null;
  let scroller: VirtualScrollerHandle | null = null;
  let mountedRows = -1; // 当前 scroller 的行数（窗口模式行数动态：增长即重建）
  // 当前可视行范围（onRange 更新，SUSP-02：runScan 喂块落地后的视口块触新消费）。
  // 初始 visLast = -1：首帧 onRange 前触新循环天然空转
  let visFirst = 0;
  let visLast = -1;
  let destroyed = false;
  // 引擎实时值：lazy 主路径在首个 chunk 产出到达前为 pending；plain 策略即终值。
  // 构造期已判超限（size 已知 >STREAM_MAX_BYTES，零读停机）同样即终值 plain——
  // 不留「解析中」。chunk 全走行级 hljs 兜底时置 'hljs'（首个 tree-sitter chunk
  // 产出后保持主导引擎）
  let engine: CodeEngine = strategy === 'plain' || limitReached ? 'plain' : 'pending';
  let computeWhere: ComputeWhere | null = null;
  // 文件内搜索状态（BUG-18/23 同构）。窗口模式 = 后台全文扫描（Task 5，见下方
  // 扫描段注释）——SearchPanel 挂载/消费面零变更
  let lastQuery: string | null = null;
  let lastCaseSensitive = false;
  let lastMatches: SearchMatch[] = [];
  let searchHitsByLine = new Map<number, Array<{ start: number; end: number }>>();
  let hitLine = -1;
  let hitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 把 hitLine 的行级类同步到已渲染行 DOM（全量路径同款，见其注释）
   */
  function applyHitClass(): void {
    for (const el of pre.querySelectorAll('.vv-code-line.vv-search-hit-line-active')) {
      el.classList.remove('vv-search-hit-line-active');
    }
    if (hitLine >= 0) {
      const el = pre.querySelector(`[data-line="${hitLine}"]`);
      if (el) el.classList.add('vv-search-hit-line', 'vv-search-hit-line-active');
    }
  }

  function clearHit(): void {
    if (hitTimer !== null) {
      clearTimeout(hitTimer);
      hitTimer = null;
    }
    const prev = hitLine;
    hitLine = -1;
    applyHitClass();
    if (prev >= 0 && !searchHitsByLine.has(prev)) scroller?.refresh(true);
  }

  /**
   * 行原始文本（窗口三路，jsonl rawLine 同构）：单块行=块解码缓存切片（前缀解码游
   * 标换算字符下标）；跨块行=按索引 lengths 拼原始字节后单次解码（块切口不打碎跨
   * 块多字节字符）。len=0 的空行直返空串——行首恰在块边界时避免对未驻留块的无效
   * 取数。调用面前置：行所需块驻留（fillRows 的 lineAvailable / pump 的
   * chunkBlocksReady 把关；块 0 部分预置天然免疫——索引有行 ⇒ 块 0 已整块替换）
   */
  function lineText(i: number): string {
    const len = index.lengths[i] ?? 0;
    if (len === 0) return '';
    const startFile = (index.offsets[i] ?? 0) + bomLen;
    const endFile = startFile + len;
    const b0 = Math.floor(startFile / win.blockSize);
    const b1 = Math.floor((endFile - 1) / win.blockSize);
    if (b0 !== b1) return win.decode(win.gather(startFile, endFile));
    const entry = win.entryOf(b0);
    const off = startFile - b0 * win.blockSize;
    const cs = win.charOffsetOf(entry, b0, off);
    const ce = win.charOffsetOf(entry, b0, off + len);
    return entry.text.slice(cs, ce);
  }

  /** 行 i 所需块号区间 [b0, b1]（驻留性把关面） */
  function lineBlockSpan(i: number): [number, number] {
    const startFile = (index.offsets[i] ?? 0) + bomLen;
    const endFile = startFile + (index.lengths[i] ?? 0);
    const b0 = Math.floor(startFile / bs.blockSize);
    return [b0, Math.floor(Math.max(startFile, endFile - 1) / bs.blockSize)];
  }

  // 回看重拉待办（块表 LRU 配套）：lineAvailable 探测到缺块时登记（Set 去重），
  // maybeContinue 统一 ensureBlock 后 refresh 重渲（同步渲染路径不能 await）
  const pendingReload = new Set<number>();

  /** 行 i 所需块全部驻留才可渲染；缺块登记待办并渲染占位行（hex「占位+ensure+重拉」） */
  function lineAvailable(i: number): boolean {
    if ((index.lengths[i] ?? 0) === 0) return true; // 空行无字节需求
    const [b0, b1] = lineBlockSpan(i);
    let ok = true;
    for (let b = b0; b <= b1; b++) {
      if (!bs.has(b)) {
        ok = false;
        pendingReload.add(b);
      }
    }
    return ok;
  }

  /**
   * 行 HTML 文本段统一入口（全量路径同构去 lineSegs/hlLines 整文件两路——窗口模式
   * 恒 lazy/plain，无整文件高亮产出）：tree-sitter chunk 段落 → 行级 hljs chunk →
   * null（无高亮产出，调用方回落纯文本转义）
   */
  function lineHtml(i: number): string | null {
    const chunkKey = Math.floor(i / CHUNK_LINES) * CHUNK_LINES;
    const chunkSegs = chunkCache.get(chunkKey)?.get(i);
    if (chunkSegs) return renderLineHtml(lineText(i), chunkSegs);
    const cached = hljsChunkCache.get(chunkKey)?.get(i);
    return cached !== undefined ? cached : null;
  }

  function fillRows(first: number, last: number, viewport: HTMLElement): void {
    const frag = document.createDocumentFragment();
    for (let i = Math.max(0, first); i <= last; i++) {
      const row = document.createElement('div');
      row.className = 'vv-code-line';
      row.style.height = `${lineHeight}px`; // 占位行同款保行高
      row.dataset.line = String(i);
      const gutter = document.createElement('span');
      gutter.className = 'vv-code-gutter';
      gutter.textContent = String(i + 1);
      // 行所需块被块表 LRU 逐出（或越界防御）：占位行——pendingReload 已由
      // lineAvailable 登记，maybeContinue 统一重拉后 refresh 填充（hex 同语义）
      if (i >= rows() || !lineAvailable(i)) {
        row.append(gutter);
        frag.append(row);
        continue;
      }
      const hits = searchHitsByLine.get(i);
      if (hits !== undefined || i === hitLine) row.classList.add('vv-search-hit-line');
      if (i === hitLine) row.classList.add('vv-search-hit-line-active');
      const body = document.createElement('span');
      body.className = 'vv-code-body';
      const html = lineHtml(i);
      if (hits !== undefined) {
        body.innerHTML = overlaySearchHits(html ?? escapeHtml(lineText(i)), hits);
      } else if (html !== null) body.innerHTML = html;
      else body.textContent = lineText(i);
      row.append(gutter, body);
      frag.append(row);
    }
    viewport.replaceChildren(frag);
  }

  // ---------- lazy 路径：可视区 chunk 懒高亮（与全量路径同构，行文本来源换窗口） ----------
  /** 待请求 chunk 键队列/串行化泵/取消与停机语义：全量路径同款（见其注释——
   * 串行化裁决勿改并发） */
  let wantedChunks: number[] = [];
  let chunkBusy = false;
  let chunkCanceled = false;
  let chunkPipelineStopped = false;

  function hasChunkData(startLine: number): boolean {
    if (!chunkCache.has(startLine) && !hljsChunkCache.has(startLine)) return false;
    // 覆盖率裁决（窗口模式新增面；全量路径行数静态无此问题）：chunk 可能在更少
    // 已加载行数时被处理（渐进索引），行数增长后其缓存不覆盖增长后的行段——不视为
    // 已处理，须重发（覆盖式整 chunk 重算，renderLineHtml 段落照常夹紧）
    const need = Math.min(CHUNK_LINES, rows() - startLine);
    return (chunkCoverage.get(startLine) ?? 0) >= need;
  }

  /** chunkKey → 处理时已覆盖的行数（hasChunkData 覆盖率裁决的依据）：条目数与
   * chunk 缓存同阶只增不减——R-1 加界（capChunkCoverage，写入点同步裁剪），缓存被
   * LRU 逐出/条目被清最旧后由 hasChunkData 的未处理面兜底重发 */
  const chunkCoverage = new Map<number, number>();

  /** chunk 文本所需块是否驻留（pump 取数面前置）：未驻留 chunk 留队不处理，块经
   * 续读/回看重拉补齐后由下次 onRange 重发——杜绝 lineText 在 pump 内对未驻留块
   * 抛错（全量路径行数组恒可用，此把关为窗口模式新增面） */
  function chunkBlocksReady(startLine: number): boolean {
    const last = startLine + Math.min(CHUNK_LINES, rows() - startLine) - 1;
    if (last < startLine) return false;
    const startFile = (index.offsets[startLine] ?? 0) + bomLen;
    const endFile = (index.offsets[last] ?? 0) + bomLen + (index.lengths[last] ?? 0);
    if (endFile <= startFile) return true; // 单空行 chunk：无字节需求
    const b0 = Math.floor(startFile / bs.blockSize);
    const b1 = Math.floor((endFile - 1) / bs.blockSize);
    for (let b = b0; b <= b1; b++) {
      if (!bs.has(b)) return false;
    }
    return true;
  }

  /** 可视区 → 未缓存的 chunk 键（对齐、去重），近视口中心者优先（全量路径同款） */
  function wantedChunkKeys(first: number, last: number): number[] {
    const { startLine, lineCount } = chunkRangeFor(first, last, rows());
    const keys: number[] = [];
    for (let s = startLine; s < startLine + lineCount; s += CHUNK_LINES) {
      if (!hasChunkData(s)) keys.push(s);
    }
    const mid = (first + last) / 2;
    return keys.sort(
      (a, b) => Math.abs(a + CHUNK_LINES / 2 - mid) - Math.abs(b + CHUNK_LINES / 2 - mid)
    );
  }

  function scheduleChunks(first: number, last: number): void {
    if (chunkPipelineStopped) return;
    wantedChunks = wantedChunkKeys(first, last);
    void pumpChunk();
  }

  /** 队列泵：单在-flight，逐个消化最新窗口的 chunk（串行化裁决同全量路径） */
  async function pumpChunk(): Promise<void> {
    if (chunkBusy || destroyed || chunkPipelineStopped) return;
    const startLine = wantedChunks.find((s) => !hasChunkData(s) && chunkBlocksReady(s));
    if (startLine === undefined) return;
    chunkBusy = true;
    chunkCanceled = false;
    try {
      await highlightChunk(startLine);
    } catch (err) {
      // 高亮失败兜底（ledger H9，low）：unhandled rejection 噪音消除，该块停留
      // plain（与 hljs 缺席同形态）；不续泵——失败块留在 wantedChunks，下次滚动
      // scheduleChunks 自然重试（避免恒失败源的当前轮紧循环）；取消同此静默
      console.debug('[code] pumpChunk 高亮失败（该块停留 plain）', err);
      return;
    } finally {
      chunkBusy = false;
    }
    if (destroyed || chunkCanceled) return;
    scroller?.refresh(true); // 新 chunk 到达：重绘可视行（fillRows 经 lineHtml 读到）
    void pumpChunk(); // 下一个（队列已被本次 refresh 的 onRange 重算裁剪过）
  }

  /** 单 chunk 高亮：来源选择——服务端 range 路由 → 本地 worker chunk → 行级 hljs 兜底。
   * 与全量路径唯一的差异是 subLines 来源（lineText 窗口解码 vs lines 数组切片） */
  async function highlightChunk(startLine: number): Promise<void> {
    const lineCount = Math.min(CHUNK_LINES, rows() - startLine);
    if (lineCount <= 0) return;
    // chunk 行文本窗口解码（同步、无 await——chunkBlocksReady 已把关驻留性，
    // 到首个 await 之间块不会被动）
    const subLines: string[] = new Array(lineCount);
    for (let k = 0; k < lineCount; k++) subLines[k] = lineText(startLine + k);
    const chunkText = subLines.join('\n');
    const chunkOffsets = buildLineOffsets(subLines);
    const router = getHighlightRouter();
    if (router && lang !== null && opts.computeSrc?.path) {
      let res: LargeFileHighlightChunk | null;
      try {
        res = await router(opts.computeSrc, lang, { startLine, lineCount });
      } catch (err) {
        if (destroyed || err instanceof HighlightCanceledError) {
          chunkCanceled = true; // 取消≠失败：仅逐出在-flight
          return;
        }
        // 显式 remote 失败：如实错误卡片，不静默降级；管线停机闩落下（全量路径同款）
        chunkPipelineStopped = true;
        wantedChunks = [];
        engine = 'plain';
        computeWhere = null;
        showErrorCard(target, err instanceof Error ? err.message : String(err), {
          name: opts.ext ? `.${opts.ext}` : '代码'
        });
        return;
      }
      if (destroyed) return;
      if (res !== null) {
        // 区间相对 chunk 首行（baseLine 平移到绝对行）。旧服务端 wholeFile 应答
        //（baseLine=0 与请求 startLine 不符，或区间越出 chunk 长度）在窗口模式下
        // 无法忠实解释——全量路径按整文件字符偏移表解释，而窗口模式设计上不持
        // 全量解码文本/字符偏移（内存有界验收），硬解释会把整文件偏移错切到 chunk
        // 窗口（渲染错位高亮）。按 chunk 失败同面走行级 hljs 兜底（质量降级、
        // 位置永远正确），debug 留痕便于服务端升级排查。
        const maxEnd = res.intervals.reduce((m, iv) => Math.max(m, iv.end), 0);
        if (res.baseLine !== startLine || maxEnd > chunkText.length) {
          console.debug('[code] 窗口模式收到 wholeFile 高亮应答（旧服务端），本 chunk 落行级 hljs 兜底', startLine);
          await hljsChunk(startLine, lineCount, subLines);
          return;
        }
        const merged = mergeChunkLines(res.intervals, chunkOffsets, res.baseLine);
        chunkCache.set(startLine, merged);
        chunkCoverage.set(startLine, lineCount);
        capChunkCoverage(chunkCoverage); // R-1 加界：与 chunk 缓存逐出联动（见常量注）
        evictChunksByLines(chunkCache, CHUNK_CACHE_MAX_LINES);
        engine = 'tree-sitter';
        computeWhere = 'remote';
        return;
      }
      // router null（auto 门/失败回退）：该 chunk 行级 hljs——不回落本地 wasm
      //（server-served 大文件连发本地 chunk 会持续占用 worker，全量路径同裁决）
      await hljsChunk(startLine, lineCount, subLines);
      return;
    }
    // client 未就绪先等待注入（attach 竞态口径同全量路径——懒 chunk 若直落 hljsChunk
    // 会双锁：hljsChunkCache 永不重发 tree-sitter 且 engine 错锁 'hljs'）
    let client = getHighlightClient();
    if (client === null && lang !== null) {
      client = await waitForAttachedClient();
      if (destroyed) return;
    }
    if (client && lang !== null) {
      try {
        const intervals = await client.highlight(chunkText, lang, {
          chunk: { startLine, lineCount }
        });
        if (destroyed) return;
        chunkCache.set(startLine, mergeChunkLines(intervals, chunkOffsets, startLine));
        chunkCoverage.set(startLine, lineCount);
        capChunkCoverage(chunkCoverage); // R-1 加界：与 chunk 缓存逐出联动（见常量注）
        evictChunksByLines(chunkCache, CHUNK_CACHE_MAX_LINES);
        engine = 'tree-sitter';
        computeWhere = 'local';
        return;
      } catch (err) {
        if (destroyed || err instanceof HighlightCanceledError) {
          chunkCanceled = true; // 取消≠失败：仅逐出在-flight，不落 hljs 兜底
          return;
        }
        await hljsChunk(startLine, lineCount, subLines); // chunk 失败 → 行级 hljs 兜底
        return;
      }
    }
    await hljsChunk(startLine, lineCount, subLines); // 无 client/lang：hljs highlightAuto chunk
  }

  /** 行级 hljs 兜底：单 chunk 主线程高亮（200 行）写 hljsChunkCache（全量路径同款，
   * auto 检测同走采样防线——chunk 级病态输入同样冻结主线程） */
  async function hljsChunk(startLine: number, lineCount: number, subLines: string[]): Promise<void> {
    hljs ??= (await import('highlight.js')).default;
    if (destroyed) return;
    hljsLang = hljsLang ?? resolveHljsLang(hljs, lang) ?? highlightAutoDetect(hljs, subLines.join('\n'));
    const chunkText = subLines.join('\n');
    let value: string | null = null;
    if (hljsLang !== null) {
      try {
        value = hljs.highlight(chunkText, { language: hljsLang, ignoreIllegals: true }).value;
      } catch {
        value = null; // 指定语言高亮异常（罕见）：该块保持纯文本，不再叠加 auto 重探
      }
    }
    if (destroyed) return;
    if (value !== null) {
      const parts = splitHighlightedLines(value, lineCount);
      const byLine = new Map<number, string>();
      for (let k = 0; k < parts.length; k++) byLine.set(startLine + k, parts[k] ?? '');
      hljsChunkCache.set(startLine, byLine);
      chunkCoverage.set(startLine, lineCount);
      capChunkCoverage(chunkCoverage); // R-1 加界：与 chunk 缓存逐出联动（见常量注）
      evictChunksByLines(hljsChunkCache, CHUNK_CACHE_MAX_LINES);
    }
    if (engine !== 'tree-sitter') {
      engine = value !== null ? 'hljs' : 'plain';
      computeWhere = value !== null ? 'local' : computeWhere;
    }
  }

  function onRange(first: number, last: number, viewport: HTMLElement): void {
    visFirst = first;
    visLast = last; // SUSP-02：可视行范围存闭包（扫描喂块落地的触新消费，见 runScan）
    if (strategy === 'lazy') scheduleChunks(first, last); // 可视区驱动 chunk 请求
    fillRows(first, last, viewport);
    maybeContinue(last); // 接近已加载尾部续读 / 缺块回看重拉
  }

  /** 行数动态的 scroller 装配：virtualScroller rowCount 为构造期快照——行数增长即
   * 重建（scrollTop 在容器上不丢，构造即按当前 scrollTop 重渲；RO 重挂开销可忽略） */
  function mount(): void {
    if (destroyed) return;
    const n = rows();
    if (scroller !== null && mountedRows === n) return;
    scroller?.destroy();
    mountedRows = n;
    scroller = virtualScroller(pre, n, lineHeight, onRange);
  }

  /** 续读/重拉完成后的重渲：行数增长 → 重建 scroller（spacer/总数更新，构造即重渲）；
   * 未增长（巨行块无新行提交等）→ 强制重绘重评（仍近尾部则续读下一块） */
  function remountOrRefresh(): void {
    const prev = mountedRows;
    mount();
    if (mountedRows === prev) scroller?.refresh(true);
  }

  const startsWithBom = (b: Uint8Array<ArrayBuffer>): boolean =>
    b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

  /** EOF 收口：atEnd 且已确认字节全部喂完（200-回退全量底座/全量视图需喂到文件尾） */
  function maybeFinish(): void {
    if (indexFinished) return;
    if (bs.atEnd() && nextFeed * bs.blockSize >= bs.confirmedBytes) {
      finishCodeIndex(index); // 提交悬挂尾段；此后不再 advance（消费契约）
      indexFinished = true;
    }
  }

  /**
   * 拉取下一块（至多一个新块）并喂入索引。块喂入前必经 ensureBlock——head 预置的
   * 部分块（探测头 8KB < 256KB 块）未经整块替换不得进索引/解码。原子性（jsonl 同款）：
   * ensureBlock 失败上抛时 nextFeed 不推进，重试拉同一块，块序列不错位。
   */
  const pullBlock = async (): Promise<void> => {
    if (indexFinished || limitReached || encodingBroken) return;
    // 尺寸防线（STREAM_MAX_BYTES）：size 已知构造即知（零读停机），此处 > 分支只
    // 防御 200-回退 degraded 等构造后确认字节越限的形态；size 未知随续读逐块裁决
    // ——达限即停（项 5 恰界收紧：旧判定 > 允许越限一块 ≤256KB 才停），不发起会
    // 越限的块读。恰等于上限的 size 已知文件不受影响（构造期 > 判定放行、
    // confirmedBytes=size 不触发达限分支），可完整流式至 EOF
    if (
      bs.confirmedBytes > STREAM_MAX_BYTES ||
      (ctx.size === null && bs.confirmedBytes >= STREAM_MAX_BYTES)
    ) {
      limitReached = true; // loadedBytes 不再增长（续读面与 maybeContinue 同步封闭）
      if (engine === 'pending') engine = 'plain'; // 非 pending 终值（不留「解析中」）
      buildNotice(CODE_STREAM_LIMIT_NOTICE);
      mountNotice();
      return;
    }
    maybeFinish(); // size 已知空文件：0 块即 EOF，无需任何拉取
    if (indexFinished) return;
    const i = nextFeed;
    const raw = await bs.ensureBlock(i);
    let chunk = raw;
    if (i === 0 && startsWithBom(raw)) {
      bomLen = 3; // 索引/解码前剥离（见上裁决）
      chunk = raw.subarray(3);
    }
    // 项 1：喂块面流内嗅探（每块一次性判定，零非法块不重复嗅探；判定面共享于
    // blockStream.isSuspiciousUtf8Block，jsonl 同款）——单块非法序列超阈判非 UTF-8：
    // 停喂（本块不入索引，干净前缀不受影响），降级经注入出口异步进行（与「判出的
    // 非 UTF-8」入口回退同路径，见 CodeRenderOptions.onEncodingBroken 注）
    if (opts.onEncodingBroken !== undefined && isSuspiciousUtf8Block(chunk)) {
      encodingBroken = true;
      const p = (async () => {
        fullInst = await opts.onEncodingBroken!();
      })();
      downgradePromise = p;
      // 滚动期降级无等待面：catch 留痕防 unhandled rejection（项 C，W3-1——此前纯
      // 静默，「已停在前缀」未落地日志；首拉期降级经 start 的 await 原始 promise，
      // 拒绝照常上抛走 whenReady 渲染期读失败面，不经此处）
      p.catch((err: unknown) => {
        console.debug('[vviewer] 窗口降级读取失败，已停在前缀', err);
      });
      return;
    }
    advanceCodeIndex(index, chunk);
    nextFeed = i + 1; // 喂入成功才推进
    maybeFinish();
  };

  let pulling = false;
  // 续读失败停机（jsonl 同款）：失败后 refresh 重评仍近尾部会无限重试（活锁），置位
  // 后停止自动续读；用户滚动动作（onUserScroll）解除，重评时单次重试
  let continueFailed = false;
  // 回看重拉失败停机（占位卡维持，滚动后重试）
  let reloadFailed = false;

  function maybeContinue(lastVisible: number): void {
    // 回看重拉优先于续读：缺块占位行等待补块（与 EOF/尾部距离无关——回看发生在已
    // 加载坐标区，逐块 ensure 后一次 refresh 填充全部占位行）。reloadFailed 停机闩
    // 与 continueFailed 同款：失败后任何自动 onRange/refresh 不得重试重拉（防活锁），
    // 用户滚动动作（onUserScroll）解除后单次重试
    if (pendingReload.size > 0 && !pulling && !reloadFailed && !encodingBroken && !destroyed) {
      const targets = [...pendingReload];
      pendingReload.clear();
      pulling = true;
      void (async () => {
        try {
          for (const b of targets) await bs.ensureBlock(b);
        } catch (err) {
          if (isAbortError(err)) { pulling = false; return; } // 取消（AbortError 身份）：静默，闩不动、不回填待办；pulling 复位（spec §3.4）
          for (const b of targets) pendingReload.add(b); // 未完成块回待办（占位行维持）
          reloadFailed = true;
          console.debug('[code] 回看重拉失败，已停机（滚动后重试）', err);
          pulling = false;
          return; // 失败停机不 refresh（下次用户动作再试，续读失败同口径——防活锁）
        }
        pulling = false;
        if (destroyed) return;
        remountOrRefresh(); // 重渲：占位行换实行
      })();
      return;
    }
    if (indexFinished || limitReached || encodingBroken || pulling || continueFailed || destroyed) return;
    if (lastVisible < rows() - WINDOW_CONTINUE_MARGIN_LINES) return; // 距尾部余量充足
    pulling = true;
    void (async () => {
      try {
        await pullBlock();
      } catch (err) {
        if (isAbortError(err)) { pulling = false; return; } // 取消（AbortError 身份）：静默，闩不动；pulling 复位（catch 后的复位语句位不经此路径，spec §3.4）
        continueFailed = true; // 停机：杜绝「失败→refresh 重评→仍近尾部→再失败」活锁
        console.debug('[code] 流式续读失败，已停机（滚动后重试）', err);
      }
      pulling = false;
      if (destroyed) return;
      if (encodingBroken) return; // 项 1：判非 UTF-8——降级重渲进行中/已完成，窗口面停评
      remountOrRefresh(); // 重渲 + 再评估（停机时 maybeContinue 直返；未停机仍近尾部则续读下一块）
    })();
  }

  // 用户动作入口（滚动/视口 resize）：解除续读/回看停机闩（「下次用户动作才重试」，
  // hex/jsonl 同口径）。jsonl 的 ResizeObserver→notifyUserAction 双入口同构：视口
  // 尺寸变化同为用户可感知动作（侧栏折叠/窗口调整等），停机后 resize 即单次重评
  const onUserScroll = (): void => {
    continueFailed = false;
    reloadFailed = false;
    scheduleIndexPump(); // 停机闩解除后重启后台泵（用户动作单次重试口径的延续）
  };
  pre.addEventListener('scroll', onUserScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    onUserScroll(); // 与 scroll 同一解锁入口：清续读/回看双闩
    scroller?.refresh(true); // 单次重评：重绘可视行并重估续读/回看（maybeContinue）
  });
  ro.observe(pre);

  // ---------- 后台索引泵（BUG-201，io spec §4.3「后台逐块推进、可取消」） ----------
  //
  // 缺陷：窗口流式下行索引原仅靠滚动续读推进（maybeContinue 距尾 WINDOW_CONTINUE_
  // MARGIN_LINES 闸），start() 排空仅在 bs.atEnd() 形态可达——size 已知 range 流式
  // 打开大文件后不滚动则行数永久冻结在首块部分值（BUG-20 契约锚受 io plan「既有
  // 断言零变更」保护而确定性双红）。泵在空闲节拍下逐块 pullBlock 推进至 EOF/防线：
  // - 单飞闸复用 pulling（与滚动续读/回看重拉/搜索扫描互斥，pullBlock 重入会双喂
  //   错位——扫描注释同款约束）；闸被占时间隔重评（CODE_PUMP_WAIT_MS，慢网 stall
  //   不刷频）；
  // - 停机条件与 maybeContinue 完全同款：indexFinished/limitReached/encodingBroken/
  //   destroyed 永久停；continueFailed 读失败闩防活锁，用户滚动动作（onUserScroll）
  //   解除后重启泵；
  // - 可取消：destroy 清定时器（在飞 pullBlock 落地后各项检查点拦截）。
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  let pumpPaused = false;
  function scheduleIndexPump(delayMs: number = CODE_PUMP_TICK_MS): void {
    if (pumpTimer !== null || destroyed || pumpPaused) return;
    if (indexFinished || limitReached || encodingBroken || continueFailed) return;
    pumpTimer = setTimeout(pumpTick, delayMs);
  }
  function pumpTick(): void {
    pumpTimer = null;
    if (destroyed || pumpPaused || indexFinished || limitReached || encodingBroken || continueFailed) return;
    if (scan !== null) {
      // 扫描在飞：泵让位（扫描自身逐块喂向 EOF，索引照常推进；扫描进度游标/进度条
      // 以「已扫描字节」计——泵抢喂只会推高行数而扫描游标不动，0% 假死）。慢机实证：
      // setTimeout(0) 泵与 50ms 轮询的扫描争用单飞闸，扫描全程饿死在 0%
      scheduleIndexPump(CODE_PUMP_WAIT_MS);
      return;
    }
    if (pulling) {
      scheduleIndexPump(CODE_PUMP_WAIT_MS); // 单飞闸在飞：间隔重评，不双喂
      return;
    }
    pulling = true;
    void (async () => {
      try {
        await pullBlock();
      } catch (err) {
        if (isAbortError(err)) { pulling = false; return; } // 取消（AbortError 身份）：静默，闩不动；pulling 复位（catch 后的复位语句位不经此路径，spec §3.4）
        continueFailed = true; // 与滚动续读同口径：停机闩防活锁，用户滚动动作解除
        console.debug('[code] 后台索引泵拉块失败，已停机（滚动后重试）', err);
      }
      pulling = false;
      if (destroyed) return;
      if (encodingBroken) return; // 项 1：判非 UTF-8——降级重渲进行中/已完成，窗口面停评
      remountOrRefresh(); // 行数增长上屏（spacer/总数随索引更新，滚动续读同款）——
      // 缺此步则 scroller 行数停在最后一次滚动续读的 mount 值，滚到底够不着真实末行
      scheduleIndexPump(); // 未停机则续拍至 EOF/防线；已停机则空转直返
    })();
  }
  function setPumpPaused(paused: boolean): void {
    pumpPaused = paused;
    if (paused) {
      if (pumpTimer !== null) clearTimeout(pumpTimer);
      pumpTimer = null;
    } else {
      scheduleIndexPump();
    }
  }

  /**
   * 启动：首块拉取（失败上抛——经 whenReady 到 codeRenderer.render 的渲染期读失败
   * 面）；已本地化（!rangeCapable 全量视图 head 预置全部块 / 200-回退切全量底座 /
   * 短读已确认 EOF）时排空剩余已确认块——零 IO，仅把索引喂到文件尾。首块在手即
   * mount（首屏首块即可渲染），其余交滚动续读。
   */
  async function start(): Promise<void> {
    // 首拉/排空全程持单飞闸：本函数的 pullBlock 循环是唯一不经 pulling 直呼的驱动
    // 面，真实 fetch 的宏任务级 RTT 窗口内，用户动作（ResizeObserver 初次回调/scroll
    // → onUserScroll → scheduleIndexPump(0)）启动的泵 tick 会经 blockStream inflight
    // 表去重 await 同一块 promise——落地后双方各自 advanceCodeIndex 一次 = 同块双喂，
    // 行数恰多一整块且内容重复已扫块（CI 幻影行三观测：DEG-03 +4096 / BUG-20 阶段4
    // +3640 / SCAN-10 mobile +4096；单测 read 直返微任务即落、无重叠窗口故不复现）。
    // 持闸后泵/滚动续读在飞等待（WAIT 重评），start 收闸后接管，语义不变。
    pulling = true;
    try {
      await pullBlock();
      while (!destroyed && !indexFinished && !limitReached && !encodingBroken && bs.atEnd()) await pullBlock();
    } finally {
      pulling = false;
    }
    if (destroyed) return;
    // 项 1：首拉即判非 UTF-8（脏块落在已排空区间）——降级在此收口：补拉失败经
    // await 原样上抛（whenReady → codeRenderer.render 的渲染期读失败面）；成功时
    // 全量实例已重渲上屏，不 mount 窗口面（方法面经 fullInst 转投）
    if (encodingBroken && downgradePromise !== null) {
      await downgradePromise;
      return;
    }
    // 空流/超限停机：不留「解析中」终态
    if (rows() === 0 && engine === 'pending' && (indexFinished || limitReached)) {
      engine = 'plain';
    }
    mount();
    scheduleIndexPump(); // 首屏在手，余下交后台泵推进（不滚动也至 EOF——BUG-201）
  }

  function jumpToLine(line: number): void {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitLine = line;
    const center = line * lineHeight - pre.clientHeight / 2 + lineHeight / 2;
    if (scroller) scroller.scrollTo(Math.max(0, center)); // 虚拟坐标定位（BUG-55，同全量引擎）
    else pre.scrollTop = Math.max(0, center);
    scroller?.refresh();
    applyHitClass();
    hitTimer = setTimeout(() => {
      hitTimer = null;
      clearHit();
    }, 1500);
  }

  /** 已加载行的跳转共用体（gotoMatch/revealLine 共用）：目标行所在块可能已被块表
   * LRU 逐出（全文扫描后早期块普遍不在驻）——占位行不承载命中高亮，先跳后补会闪
   * 失。跳转异步化（接口签名 void 不变）：补齐（或补块失败占位兜底）后再滚动+行级
   * 高亮（spec §4.3 定位）。 */
  function revealLoadedLine(line: number): void {
    const [b0, b1] = lineBlockSpan(line);
    void (async () => {
      try {
        for (let b = b0; b <= b1; b++) {
          if (!bs.has(b)) await bs.ensureBlock(b);
        }
      } catch (err) {
        console.debug('[code] 搜索跳转补块失败（占位行兜底，滚动后重试）', err);
      }
      if (destroyed) return;
      jumpToLine(line);
    })();
  }

  // ---------- 后台全文扫描搜索（Task 5，spec §4.3 搜索） ----------
  //
  // 替换 Task 4 的 snapshotLines「已加载区间快照」过渡实现，同时消除其补块风暴面
  //（先对 [0,nextFeed) 全量并发补块再解码——大文件先验重拉数百块，先回的随即被
  // LRU 逐出，白拉重传）。新语义：
  // - 全文性：search() 从文件头驱动 BlockStream 逐块前向喂索引（pullBlock 与滚动
  //   续读共用单飞闸 pulling——双喂会使索引错位），每块落地后把新提交的行逐行解码
  //   扫描到 EOF；
  // - 渐进可用（先到先出）：命中即时并入命中集并重绘——已扫描区域的行级背景/词级
  //   mark 先于全文完成可见；Promise 仍为完成制（SearchPanel await 后才读计数并
  //   gotoMatch，UI 零变更，面板现状无进度挂点——扫描进度不上 UI，报告已说明）；
  // - 取消 = 令牌失效：新搜索/空查询（退出搜索）/destroy 递增 scanSeq，旧扫描在
  //   下一个检查点退出，以当时已得的部分命中收场，不再触碰共享状态；
  // - 停机口径与滚动续读一致：limitReached（STREAM_MAX_BYTES 防线）与
  //   continueFailed（读失败闩，用户滚动解除）下扫描只覆盖已加载区间即收场；
  // - 补块：块表 LRU 逐出的已确认块按行序懒补（scanLineText 单飞 ensure——行序
  //   推进天然按块序触达，无先验全量补块，风暴面即此消除）。

  /** 扫描等待在飞喂块（续读/回看持有 pulling 时）的轮询间隔（毫秒） */
  const SCAN_POLL_MS = 4;

  /** 扫描令牌：seq 失效制；scan 为在飞句柄（同键重入共享同一 Promise，完成后
   * 置 null 恢复短路缓存语义） */
  let scanSeq = 0;
  let scan: { seq: number; key: string; promise: Promise<SearchMatch[]> } | null = null;
  /** 上次同键扫描的收场形态（缓存键纳入扫描进度，项 2）：true = 全文完成
   * （indexFinished 且扫描至尾）——同 query 重搜可短路零读；false = 停机/取消收场
   * 的部分结果——不得短路，同 query 重搜触发续扫。取消方（换键搜索）自行重置，
   * 被取消扫描不回写（「取消不触碰共享状态」纪律） */
  let lastScanComplete = false;
  /** 上次扫描的进度游标（已扫描行数）：lastScanComplete=false 时同 query 重搜据此
   * 断点续扫（不重复扫已扫行/不重拉已扫块），换键重置为 0 */
  let lastScanCursor = 0;
  /** lastMatches 的具体形态引用（SearchMatchWithPreview[]）：续扫时往同一数组合并
   * 命中（lastMatches 对 SearchPanel 的引用保持稳定） */
  let lastAcc: SearchMatchWithPreview[] = [];

  const delay = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * 行 i 的扫描文本：所需块缺驻留时按行序单飞补拉；补块失败返回 null（该项 F 语义：
   * 该行以缺失参与本次扫描——不可得 ≠ 命中断言——但不计入已扫前缀，收场游标回退，
   * 续扫重访）。failedBlocks 记忆本次扫描内已失败的块号（项 3 突发收敛）：持续失败
   * 时同块只发一次失败请求（失败粒度从「每行」收敛到「每块一次」），记忆命中的行
   * 直接跳过、下一块继续；记忆按次扫描新建（runScan 内），续扫/换键重搜保留单次
   * 重试机会。onBlockFailed 上抛失败块号（runScan 据此算游标回退点，项 F）。
   */
  async function scanLineText(
    i: number,
    failedBlocks: Set<number>,
    onBlockFailed: (b: number) => void
  ): Promise<string | null> {
    const len = index.lengths[i] ?? 0;
    if (len === 0) return '';
    const [b0, b1] = lineBlockSpan(i);
    for (let b = b0; b <= b1; b++) {
      if (bs.has(b)) continue;
      if (failedBlocks.has(b)) return null; // 本扫描内该块已失败：不再逐行重试
      try {
        await bs.ensureBlock(b);
      } catch (err) {
        failedBlocks.add(b);
        onBlockFailed(b);
        console.debug('[code] 搜索扫描补块失败（该块行以空串参与扫描）', err);
        return null;
      }
    }
    return lineText(i);
  }

  /**
   * 块 b 的起始行（项 F 游标回退点）：最大 l 使 offsets[l] ≤ 块起始逻辑字节。该行
   * 可能跨本块与前块切口（行首在前块字节域）——自它起重扫恰好覆盖失败块全部行
   * （失败行之前的同块行可能从未被扫过：跨块失败行先行触达失败块）。b=0 且 BOM
   * 存在时逻辑字节为负，兜底返回行 0。
   */
  function blockStartLine(b: number): number {
    const logical = b * bs.blockSize - bomLen;
    let lo = 0;
    let hi = index.offsets.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((index.offsets[mid] ?? 0) <= logical) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  // ---------- 项 2（遗留清偿波 3）：后台扫描进度条（spec §4.3 承诺兑现） ----------
  //
  // 扫描完成制 Promise + 命中渐进上屏期间进度无处可看（SearchPanel 零变更约束）——
  // 进度承载在渲染器 DOM 层：扫描期间在 target 顶部（oversize 条同位，pre 的兄弟
  // 节点）显示一次性 .vv-code-scan-progress 元素。形态：size 已知「扫描中 N%（已命中
  // M 处）」（N% = 已扫描字节/size，字节游标取索引行偏移）；size 未知「扫描中 · 已
  // 扫描 N KB（已命中 M 处）」。完成/取消（destroy）/失败三态移除（runScan finally
  // 统一收口 + destroy 直调即时收口——在途读闸挂起时 finally 不可达）。更新节流在
  // 扫描主循环外圈（≈每块一次，不逐行写 DOM）。样式内联（hex toolbar 先例，不依赖
  // app.css）；getMeta 零变更。
  let scanBar: HTMLElement | null = null;
  // 项 A（W3-4）：进度条属主扫描序号——扫描在飞换 query 时新扫描接管既有条，
  // 被取消旧扫描的收场清理不得移除新扫描的条（否则新扫描数分钟无进度）：
  // show 记录 ownerSeq、hide 仅属主匹配才移除
  let scanBarOwnerSeq = -1;

  function showScanProgress(ownerSeq: number): void {
    scanBarOwnerSeq = ownerSeq; // 属主切换：条已存在则新扫描复用同一实例
    if (scanBar !== null) return; // 一次性元素：续扫/同键重入复用同一实例
    scanBar = document.createElement('div');
    scanBar.className = 'vv-code-scan-progress';
    scanBar.setAttribute('role', 'status');
    scanBar.style.cssText = [
      'display:flex',
      'align-items:center',
      'padding:2px 10px',
      'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:var(--vv-text-dim, #888)',
      'background:var(--vv-panel, rgba(127,127,127,0.08))',
      'border-bottom:1px solid var(--vv-border, rgba(127,127,127,0.25))'
    ].join(';');
    target.insertBefore(scanBar, pre); // oversize 条同位（pre 的兄弟节点，见 mountNotice 注）
  }

  /** 进度文本更新（扫描主循环外圈调用）：字节游标 = 已扫描行前缀的字节终点
   * （scannedRow==rows() 的拉块间隙取已加载末行行尾，显示值不回退；+BOM 换算文件字节）。
   * 项 B（W3-5）：内部按时间节流——拉块等待期 SCAN_POLL_MS=4ms 自旋每轮调用
   * （≈250Hz），≥100ms 才写 DOM；force=true（属主收场末写）绕过节流强制刷新 */
  const SCAN_PROGRESS_THROTTLE_MS = 100;
  let lastProgressWriteAt = 0;
  let lastProgressHits = -1;
  function updateScanProgress(scannedRow: number, hits: number, force = false): void {
    if (scanBar === null) return;
    const now = Date.now();
    // 命中数变化不受节流：spec §4.3「命中即时并入命中集并重绘」的进度条侧契约——
    // 快扫后挂死（stall 门/慢网）的扫描，字节游标与命中数若同被节流吞掉，进度条
    // 恒停在初始 0%/0 处假死（CI 实证），命中渐进不可观察
    if (!force && hits !== lastProgressHits) {
      lastProgressHits = hits;
      lastProgressWriteAt = now;
    } else if (!force && now - lastProgressWriteAt < SCAN_PROGRESS_THROTTLE_MS) {
      return;
    }
    lastProgressWriteAt = now;
    const at = Math.min(scannedRow, index.offsets.length) - 1;
    const bytes = (at >= 0 ? (index.offsets[at] ?? 0) + (index.lengths[at] ?? 0) : 0) + bomLen;
    const where =
      ctx.size !== null
        ? `扫描中 ${Math.min(100, Math.floor((bytes * 100) / ctx.size))}%`
        : `扫描中 · 已扫描 ${Math.floor(bytes / 1024)} KB`;
    scanBar.textContent = `${where}（已命中 ${hits} 处）`;
  }

  /** 移除进度条（项 A 属主语义）：仅属主扫描才移除——被取消旧扫描的收场清理
   * 不得移除已被新扫描接管的条 */
  function hideScanProgress(ownerSeq: number): void {
    if (scanBar === null || scanBarOwnerSeq !== ownerSeq) return;
    scanBar.remove();
    scanBar = null;
  }

  /** SUSP-01 fix wave：自缓存重建行级命中索引（lastMatches → searchHitsByLine）。
   * 退出搜索清空视觉索引（视觉清理面）而短路缓存保留——同词短路（全量重建）与
   * 断点续扫（补 line < maxLine，与 runScan 截断删 >= startFrom 精确互补）各自经此
   * 恢复 mark/行级背景（fillRows 唯一消费面）。lastMatches 按扫描行序升序；已有
   * 索引（非退出态）或空命中集不动，返回是否有重建（调用方据以 refresh）。 */
  function rebuildSearchHitsFromCache(maxLine = Number.POSITIVE_INFINITY): boolean {
    if (searchHitsByLine.size > 0 || lastMatches.length === 0) return false;
    searchHitsByLine = new Map();
    for (const m of lastMatches) {
      if (m.line >= maxLine) break;
      const arr = searchHitsByLine.get(m.line);
      if (arr) arr.push({ start: m.start, end: m.end });
      else searchHitsByLine.set(m.line, [{ start: m.start, end: m.end }]);
    }
    return true;
  }

  /** 后台全文扫描主循环：返回扫描终止时已得的命中（取消/停机 = 部分结果）。
   * startFrom 为断点续扫起点（项 2：停机收场后同 query 重搜自游标继续）；
   * 收场形态回写 lastScanComplete/lastScanCursor（alive 守卫——取消方已重置，
   * 被取消扫描不得回写） */
  async function runScan(
    acc: SearchMatchWithPreview[],
    query: string,
    caseSensitive: boolean,
    mySeq: number,
    startFrom: number
  ): Promise<SearchMatch[]> {
    const alive = (): boolean => !destroyed && scanSeq === mySeq;
    const failedBlocks = new Set<number>(); // 补拉失败块记忆（本次扫描一份，见 scanLineText）
    // 项 F（W2-2）：失败块游标回退点（块起始行；-1 = 本次扫描无失败）。补块失败的
    // 行不得计入已扫前缀（否则续扫永不回访、命中永久缺失）——收场游标不越过它，
    // 停机解除后的续扫自失败块起重扫（与项 E 配合：重搜触发续扫覆盖失败区间）
    let failedResume = -1;
    const markFailedBlock = (b: number): void => {
      const start = blockStartLine(b);
      if (failedResume < 0 || start < failedResume) failedResume = start;
    };
    // 返修（项 F fix round 2）：断点续扫自 startFrom 起对 [startFrom, EOF) 全区间
    // 重扫——既有命中集中行号 ≥ startFrom 的条目（首扫在失败块之后已成功扫描的行）
    // 须先截断，否则重扫再 push 一次：命中数虚高、gotoMatch 索引错位、行级高亮
    // 区间重复。双截：lastAcc（按扫描行序升序，线性找首个越界条目截尾）+
    // searchHitsByLine（键为行号，删越界键）。截断无条件执行（不按 startFrom > 0
    // 设门）：startFrom=0 的同键续扫（块 0 拉取失败回退/首写点前异常的残留角）
    // 同样可能有已入集命中，重扫自 0 重收——截断即清空，语义仍正确；换键重搜
    // 命中集已重置，截断为空操作。
    {
      let cut = acc.length;
      for (let i = 0; i < acc.length; i++) {
        if (acc[i]!.line >= startFrom) {
          cut = i;
          break;
        }
      }
      acc.length = cut;
      for (const key of [...searchHitsByLine.keys()]) {
        if (key >= startFrom) searchHitsByLine.delete(key);
      }
    }
    let scanned = startFrom; // 已扫描行数（索引已提交行的前缀指针：断点续扫不重复）
    showScanProgress(mySeq); // 项 2：扫描开始即挂进度条（同键续扫/接管复用同一元素，项 A 属主切换）
    try {
      for (;;) {
        if (!alive()) return acc;
        updateScanProgress(scanned, acc.length); // 项 2：外圈每轮一次（≈每块粒度，渲染节流）
        if (scanned < rows()) {
          let innerHits = acc.length;
          let progressDirty = false;
          for (; scanned < rows() && alive(); scanned++) {
            // 阻塞前刷新：本行所需块缺驻留 → 下方 scanLineText 会挂起（stall 门/
            // 慢网/读闸）——先把已得命中上屏（进度条 + 行级背景重绘），否则命中已
            // 入集而进度条恒 0 处、背景不上屏（CI/2 核实证）。命中即时上屏是
            // spec §4.3 契约；驻留行连扫不重绘（命中密集文本不退化为逐行 remount）
            const [spanStart, spanEnd] = lineBlockSpan(scanned);
            let willBlock = false;
            for (let b = spanStart; b <= spanEnd; b++) {
              if (!bs.has(b)) {
                willBlock = true;
                break;
              }
            }
            if (willBlock && progressDirty) {
              progressDirty = false;
              updateScanProgress(scanned, acc.length);
              remountOrRefresh();
            }
            const text = await scanLineText(scanned, failedBlocks, markFailedBlock);
            if (!alive()) return acc;
            if (text === null) continue; // 项 F：缺失行不中断扫描，游标回退点已记
            if (text === '') continue;
            for (const m of searchCode([text], query, { caseSensitive })) {
              acc.push({ line: scanned, start: m.start, end: m.end, preview: m.preview });
              const arr = searchHitsByLine.get(scanned);
              if (arr) arr.push({ start: m.start, end: m.end });
              else searchHitsByLine.set(scanned, [{ start: m.start, end: m.end }]);
            }
            if (acc.length !== innerHits) {
              innerHits = acc.length;
              progressDirty = true;
              updateScanProgress(scanned, acc.length); // hits 变化免节流，进度条即时
            }
          }
          if (!alive()) return acc;
          // 项 F：收场游标不越过失败块起点（同批多块失败取最早）；无失败原样上行
          lastScanCursor = failedResume >= 0 ? Math.min(scanned, failedResume) : scanned;
          remountOrRefresh(); // 渐进落地：新行/新命中上屏（行数增长 → 重建 scroller）
          await delay(0); // 让出主线程：扫描期间滚动手感不受阻塞
          continue;
        }
        if (indexFinished) {
          // 项 F：EOF 已至但存在补块失败块——同键不得短路（部分覆盖），收场后同
          // query 重搜续扫自失败块起点重访
          lastScanComplete = failedResume < 0;
          return acc; // finishCodeIndex 已提交末尾空串条目
        }
        if (limitReached || continueFailed || encodingBroken) {
          lastScanComplete = false; // 停机收场：同键重搜不短路（续扫）
          return acc; // 停机面：已加载区间即终（项 1 判非 UTF-8 同口径：降级重渲接手）
        }
        if (pulling) {
          await delay(SCAN_POLL_MS); // 续读/回看重拉在飞：等待其落地后重评
          continue;
        }
        pulling = true; // 前向喂一块（单飞闸与续读共用：pullBlock 重入会双喂错位）
        try {
          await pullBlock();
        } catch (err) {
          if (isAbortError(err)) return acc; // 取消（AbortError 身份）：静默，闩不动（spec §3.4；pulling 由下方 finally 复位）
          continueFailed = true; // 与滚动续读同口径：停机闩，用户滚动动作解除
          lastScanComplete = false; // 同键重搜即用户动作：解除闩后续扫（见 search）
          console.debug('[code] 搜索扫描续读失败，已停机（返回已得部分结果）', err);
          return acc;
        } finally {
          pulling = false;
        }
        // SUSP-02：扫描新块落地后对可视区所需块 LRU 触新（bs.block 自带 touch）——
        // 视口 2-3 块挪表尾后，扫描前沿新块不再将其挤出（占位化闪烁根因：视口块
        // 渲染面触新随 chunk 高亮缓存接管 lineHtml 而缺席，LRU 位陈旧被逐出 →
        // lineAvailable 占位化 + pendingReload 回看重拉，SCAN-08 一次续扫内 ≥2 次）。
        // 扫描期间泵让位（pumpTick 检测 scan!==null 重评），本落地点是喂块唯一推进
        // 源，触新挂此即全覆盖。上界夹 rows()-1 防越界；空行（len=0）无块需求跳过；
        // bs.has 先行把关，触新零 IO。
        for (let v = visFirst; v <= Math.min(visLast, rows() - 1); v++) {
          const len = index.lengths[v] ?? 0;
          if (len === 0) continue;
          const [b0, b1] = lineBlockSpan(v);
          for (let b = b0; b <= b1; b++) if (bs.has(b)) bs.block(b);
        }
      }
    } finally {
      // 项 B：收场末次必写（属主才写——非属主不得覆盖新扫描已接管的进度文本，
      // 项 A）；随后统一移除（destroy 即时收口另行直调）
      if (scanBarOwnerSeq === mySeq) updateScanProgress(scanned, acc.length, true);
      hideScanProgress(mySeq);
    }
  }

  const handle: RenderCodeHandle = {
    destroy() {
      // 项 1：降级产物（全量重渲实例）随宿主一并销毁（ViewerPane 只持本 handle）
      if (fullInst !== null) fullInst.destroy();
      destroyed = true;
      readAbort.abort(); // 在飞块读即时取消（DEG-08 排队根因的修复面）
      if (pumpTimer !== null) clearTimeout(pumpTimer); // 后台索引泵可取消（§4.3）
      pumpTimer = null;
      scanSeq += 1; // 在飞后台扫描令牌失效（下一检查点退出，部分结果收场）
      scan = null;
      // 项 2：取消态即时移除进度条（在途读闸挂起时 finally 不可达）；项 A：destroy
      // 终态无条件收口——此后无新扫描可接管，属主语义不适用
      scanBar?.remove();
      scanBar = null;
      scanBarOwnerSeq = -1;
      if (hitTimer !== null) clearTimeout(hitTimer);
      wantedChunks = []; // 队列作废；在-flight chunk 的回写在各 await 点被 destroyed 拦截
      scroller?.destroy();
      scroller = null;
      chunkCache.clear();
      hljsChunkCache.clear();
      pendingReload.clear();
      ro.disconnect(); // 视口 resize 解锁入口随实例销毁（jsonl 同款）
      pre.removeEventListener('scroll', onUserScroll);
      pre.remove();
      // 提示条与 flex 布局类随实例销毁清理（host 复用时不得残留）
      target.classList.remove('vv-code-oversize');
    },
    // —— 项 1：降级后的方法面转投（判非 UTF-8 后全量实例接手渲染，ViewerPane 持
    // 有的仍是本 handle——滚动宿主/引擎指示/meta/搜索/跳转全部随全量实例读写）——
    setScrollTop(top) {
      if (fullInst !== null) return fullInst.setScrollTop(top);
      pre.scrollTop = top;
    },
    scrollTop() {
      if (fullInst !== null) return fullInst.scrollTop();
      return pre.scrollTop;
    },
    getScrollHost() {
      if (fullInst !== null) return fullInst.getScrollHost();
      return pre;
    },
    getEngine: () => (fullInst !== null ? fullInst.getEngine() : engine),
    getComputeWhere: () => (fullInst !== null ? fullInst.getComputeWhere() : computeWhere),
    // 渲染期动态元数据快照。lines 为内容行数口径（展示层 wc -l，指令④）：索引已对
    // 尾终结符归一（BUG-38，EOF 后无伪空串条目），rows() 恒为真实行数；流中条目全为
    // 已提交真实行（「已加载 N 行」渐进口径，ViewerPane 首读数字形态兼容）。
    // size：已知取 ctx.size，未知取已确认字节（随续读增长）
    getMeta() {
      if (fullInst !== null) return fullInst.getMeta(); // 项 1：降级后转投全量实例（encoding 精判/行数全量）
      return {
        encoding: opts.encoding ?? 'utf-8',
        lang, // 与实际高亮语言同源（评审③同口径）
        size: ctx.size ?? bs.confirmedBytes,
        lines: rows()
      };
    },
    search(query, searchOpts?: { caseSensitive?: boolean }) {
      // 项 1：降级后转投全量实例（全文行数组扫描，索引停喂面不再参与）
      if (fullInst !== null) return fullInst.search(query, searchOpts);
      const caseSensitive = searchOpts?.caseSensitive === true;
      const key = `${caseSensitive ? '1' : '0'}\u0000${query}`;
      if (scan !== null && scan.key === key) return scan.promise; // 同键在飞：共享同一扫描
      const sameKey = scan === null && query === lastQuery && caseSensitive === lastCaseSensitive;
      // 同键短路分界（项 2）：仅全文完成（lastScanComplete）的同 query 才短路零读；
      // 停机/取消收场的部分结果不得短路——重搜触发断点续扫（自 lastScanCursor）。
      // SUSP-01：退出搜索保留了短路缓存但已清行级命中索引（视觉清理，见空 query
      // 分支）——同词重搜短路时自 lastMatches 重建（零 IO），词级 mark/行级背景
      // 随缓存命中集复现
      if (sameKey && lastScanComplete) {
        if (rebuildSearchHitsFromCache()) scroller?.refresh(true);
        return Promise.resolve(lastMatches);
      }
      const mySeq = ++scanSeq; // 令牌失效：旧扫描在下一检查点退出（新搜索/退出搜索取消）
      if (scan !== null) lastScanComplete = false; // 在飞扫描被取代：其部分命中不作完成态（SUSP-01 保留的缓存不得以半成品短路）
      scan = null;
      // 命中集/行级背景/active 重置（旧查询的视觉痕迹即刻清除，新命中随扫描渐进上屏）
      if (hitTimer !== null) {
        clearTimeout(hitTimer);
        hitTimer = null;
      }
      hitLine = -1;
      if (query === '') {
        // SUSP-01：空 query = 退出搜索——只做令牌失效（上方）与视觉清理，短路缓存
        // （lastQuery/lastCaseSensitive/lastAcc/lastMatches/lastScanComplete/
        // lastScanCursor）原样保留：同词重搜零读短路，换新词走下方换键分支全量
        // 重置。用户可见行为零变化（视觉清理照旧），仅省全文重扫 IO。
        continueFailed = false; // 退出即用户动作：解除续读停机（与同键重搜同口径）
        searchHitsByLine = new Map(); // 行级命中索引清空：refresh 后 mark/行级背景即刻消退
        // active 消退走 applyHitClass（hitTimer/hitLine 已于上方统一重置，与
        // clearHit 清理面等价且不走其内部条件 refresh）——重绘收敛到下方单次
        // refresh(true)，与全量路径退出分支同款（deferred 卫生：双刷合并）
        applyHitClass();
        scroller?.refresh(true);
        return Promise.resolve([]);
      }
      if (!sameKey) {
        // 换键：命中集/行级背景/进度游标全量重置（lastMatches 引用随 lastAcc 更新）
        lastAcc = [];
        lastMatches = lastAcc;
        searchHitsByLine = new Map();
        lastQuery = query;
        lastCaseSensitive = caseSensitive;
        lastScanCursor = 0;
      } else {
        // 停机收场后同 query 重搜：续扫。重搜即用户动作，解除续读停机闩（「下次
        // 用户动作才重试」）；命中集与游标保持，扫描自断点合并推进
        continueFailed = false;
        // SUSP-01 fix wave：扫描中途退出→同词重搜续扫路径——退出清空了行级命中
        // 索引而 lastAcc/lastScanCursor 保留，runScan 截断只删 >= startFrom，游标前
        // 既有命中若不在此重建，计数/gotoMatch 仍报告它们而行内 mark/行级背景消失
        // （且续扫产出新命中后索引非空，无自愈）。补 line < lastScanCursor：
        if (rebuildSearchHitsFromCache(lastScanCursor)) scroller?.refresh(true);
      }
      const promise = runScan(lastAcc, query, caseSensitive, mySeq, lastScanCursor).catch(
        (err: unknown) => {
          // 项 E（W2-1）：异常收场非全文完成——不回写则残留 true（上次全文完成的
          // 旗标跨换键不重置），后续同键搜索会以部分结果短路
          lastScanComplete = false;
          console.debug('[code] 后台全文扫描异常（返回已得部分结果）', err);
          return lastAcc;
        }
      );
      scan = { seq: mySeq, key, promise };
      void promise.then(() => {
        if (scan !== null && scan.seq === mySeq) scan = null; // 完成制：短路缓存恢复生效
      });
      scroller?.refresh(true);
      return promise;
    },
    gotoMatch(matchIndex) {
      // 项 1：降级后转投全量实例（全量行表定位）
      if (fullInst !== null) return fullInst.gotoMatch(matchIndex);
      const match = lastMatches[matchIndex];
      if (!match) return;
      revealLoadedLine(match.line);
    },
    revealLine(line, col) {
      void col;
      // 项 1：降级后转投全量实例（全量行表定位）
      if (fullInst !== null) return fullInst.revealLine(line, col);
      if (!Number.isInteger(line) || line < 0) return;
      if (line < rows()) {
        revealLoadedLine(line); // 已加载行：与 gotoMatch 同款 ensure 补块后跳转
        return;
      }
      // 未加载行（BUG-09 全局搜索跳转对大文件的回归面：ViewerPane 消费 pendingLine
      // 即清，本调用是唯一补读机会，静默丢弃即跳转失效）：对齐 gotoMatch 的异步路径
      // ——驱动续读（循环 pullBlock 至该行入索引，单飞闸 pulling 与滚动续读/扫描共用，
      // 在飞时轮询等待；受既有停机口径约束 indexFinished/limitReached/continueFailed/
      // destroyed）后 jumpToLine；停机未达或行号确越出 EOF（EOF 确认后仍不在索引）
      // 才静默兜底，与全量路径越界同口径。签名 void 不变。
      void (async () => {
        await ready.catch(() => {}); // 与首拉串行（start 未设 pulling 闸，双喂会使索引错位）；首拉失败面已由 whenReady 上抛，此处吞掉防 unhandled
        const rowsBefore = rows();
        while (!destroyed && line >= rows() && !indexFinished && !limitReached && !continueFailed && !encodingBroken) {
          if (pulling) {
            await delay(SCAN_POLL_MS); // 续读/回看在飞：等待其落地后重评（扫描同款）
            continue;
          }
          pulling = true;
          try {
            await pullBlock();
          } catch (err) {
            // 取消（destroy 在飞读 abort）不置闩（六处收紧同款第七处收口，spec
            // §2 T5）：停机闩仅属真实读失败——abort 后 destroyed 即将成立或由
            // 用户滚动动作重启，闩上会把取消当失败冻结续读
            if (!isAbortError(err)) {
              continueFailed = true; // 与滚动续读同口径：停机闩，用户滚动动作解除
              console.debug('[code] revealLine 续读失败（跳转静默兜底，滚动后重试）', err);
            } else {
              console.debug('[code] revealLine 续读被取消（destroy）', err);
            }
          } finally {
            pulling = false;
          }
        }
        if (destroyed) return;
        if (rows() !== rowsBefore) remountOrRefresh(); // 行数已增长：重建 scroller（spacer 总高对齐已加载行数，跳转定位才可达）
        if (line >= rows()) return; // 停机面未达/越出 EOF：静默兜底不跳转
        jumpToLine(line);
      })();
    }
  };
  // 首拉完成面：codeRenderer.render await 它——首块/本地化排空失败 → 销毁半装配实例
  // 后 rethrow（渲染期读失败面）；resolve 后实例已 mount，滚动期失败走自兜底（上方闩）。
  // 捕获引用供 revealLine 的未加载行续读路径 await（与其串行，防双喂）
  const ready = start();
  (handle as { whenReady?: Promise<void> }).whenReady = ready;
  codeWindowedPumpControls.set(handle, {
    pause: () => setPumpPaused(true),
    resume: () => setPumpPaused(false)
  });
  return handle;
}

/** 窗口流式后台索引泵的测试开关（jsonlWindowedInternals 同款先例）：pause 冻结后台
 * 推进，使 code.test.ts 既有「首屏最小 IO / 滚动驱动续读 / 扫描自驱动 IO」契约面
 * 在泵语义下逐字保持可断言；resume 恢复。生产路径不使用。 */
export const codeWindowedPumpControls = new WeakMap<RenderCodeHandle, { pause(): void; resume(): void }>();
