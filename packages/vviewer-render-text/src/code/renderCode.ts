/**
 * code/renderCode.ts — renderCode 全量路径（FE-2 自 code.ts 分块迁出，函数体逐字
 * 搬移；全量/窗口两路径的纯函数层仍单源复用——见函数头「独立闭包而非参数化共用」
 * 裁决）。ctx 存在时分派 renderCodeWindowed（窗口流式路径，居中层互引方向单向）。
 * attachedClient/attachedRouter 的读取经 client.getHighlightClient/getHighlightRouter
 * （行为等价的读取面，拆分前为同模块直读）。
 */
import { RemoteComputeError, showErrorCard, type ComputeWhere, type SearchMatch } from '@bhxch/vviewer-core';
import { detectLanguage, HighlightCanceledError } from '@bhxch/vviewer-highlight';
import { virtualScroller, type VirtualScrollerHandle } from '../virtualScroller';
import { searchCode } from '../search';
import {
  LINE_HEIGHT,
  resolveStrategy,
  HLJS_MAX_BYTES,
  PLAIN_MAX_BYTES,
  resolveHljsLang,
  highlightAutoSafe,
  highlightAutoDetect,
  type HLJS
} from './strategy';
import { decodeText } from '../decodeText';
import {
  CHUNK_LINES,
  CHUNK_CACHE_MAX_LINES,
  chunkRangeFor,
  evictChunksByLines,
  buildLineIndex,
  buildLineOffsets,
  buildByteLineOffsets
} from './chunks';
import {
  type LineSeg,
  lineOf,
  escapeHtml,
  splitHighlightedLines,
  assignIntervalsToLines,
  mergeChunkLines,
  overlaySearchHits,
  renderLineHtml
} from '@bhxch/vviewer-highlight/lines';
import {
  type CodeEngine,
  type CodeRenderOptions,
  type LargeFileHighlightChunk,
  type RenderCodeHandle,
  getHighlightClient,
  getHighlightRouter,
  waitForAttachedClient
} from './client';
import { renderCodeWindowed } from './renderCodeWindowed';

export function renderCode(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: CodeRenderOptions = {}
): RenderCodeHandle {
  // 窗口流式模式（ctx 存在）：索引流式推进 + textWindow 窗口解码 + lazy chunk 高亮。
  // 独立闭包而非参数化共用全量闭包——两模式数据源（静态 lines 数组 vs 动态索引+块
  // 缓存）差异贯穿行渲染/行数/搜索/meta 各面，参数化需给生产稳定基座（全量路径）
  // 加贯穿性开关，风险大于约 300 行复用收益（codeIndexStream 独立于 jsonlIndex 的
  // 同款裁决）；纯函数层（renderLineHtml/chunkRangeFor/mergeChunkLines/evict* 等）
  // 仍单源复用。
  if (opts.ctx !== undefined) return renderCodeWindowed(opts.ctx, buffer, target, opts);
  // 行尺度（字体系统 Task 2）：局部 lineHeight 单源供全部消费点（fillRows/mount/
  // jumpToLine 闭包捕获），缺省回落 LINE_HEIGHT
  const lineHeight = opts.lineMetrics?.lineHeight ?? LINE_HEIGHT;
  // CRLF/CR → LF 归一化：行索引（buildLineIndex/lineOffsets）、高亮区间偏移、搜索
  // 全部在归一化文本上计算——解码后、一切索引前做一次，保证偏移一致性（否则
  // \r 计入前一行长度，区间错位一行；tree-sitter/hljs 的输出同样按归一化文本对齐）
  const text = decodeText(buffer, opts.encoding).replace(/\r\n?/g, '\n');
  const lines = buildLineIndex(text);
  const lineOffsets = buildLineOffsets(lines);
  const byteLineOffsets = buildByteLineOffsets(buffer); // 字节域行索引（lineAtByteOffset 用，post-BOM）
  // 实际生效的高亮语言（与 start() 同一表达式、同步可预算）：getMeta 的 lang 取此
  // 单源——本地扩展名文件（无服务端 x-vv-lang、det.lang 为空）按 detectLanguage
  // 高亮后，状态栏/属性面板的语言段与实际引擎一致（评审③）
  const lang = opts.lang ?? (opts.ext ? detectLanguage(opts.ext, text) : null);
  const strategy = opts.highlight === false ? 'plain' : resolveStrategy(buffer.byteLength);
  target.classList.add('vv-code');
  const pre = document.createElement('div');
  pre.className = 'vv-code-pre'; // 即 virtualScroller 的滚动容器
  // 超限提示条（BUG-20 模式）：plain（>PLAIN_MAX_BYTES）与 lazy（>HLJS_MAX_BYTES）
  // 各一条一次性提示，顶部插入、不阻断滚动/搜索。提示条是 pre 的兄弟节点而非子
  // 节点——virtualScroller 会 replaceChildren 滚动容器，提示条放里面会被清掉且
  // spacer 定位被顶偏。
  const noticeEnabled = opts.oversizeNotice ?? opts.highlight !== false;
  let noticeText: string | null = null;
  if (noticeEnabled && strategy === 'plain' && buffer.byteLength > PLAIN_MAX_BYTES) {
    noticeText = `文件超过 ${PLAIN_MAX_BYTES / 1024 / 1024}MB，已按纯文本虚拟滚动显示（不做语法高亮）`;
  } else if (noticeEnabled && strategy === 'lazy' && buffer.byteLength > HLJS_MAX_BYTES) {
    noticeText = `文件超过 ${HLJS_MAX_BYTES / 1024 / 1024}MB，已按可视区懒高亮显示（滚动到即增量解析，稍候即着色）`;
  }
  if (noticeText !== null) {
    const bar = document.createElement('div');
    bar.className = 'vv-error-card vv-oversize-card vv-code-oversize-card';
    const title = document.createElement('div');
    title.className = 'vv-error-title';
    title.textContent = noticeText;
    bar.append(title);
    target.classList.add('vv-code-oversize');
    target.replaceChildren(bar, pre);
  } else {
    target.replaceChildren(pre);
  }
  let hlLines: string[] | null = null; // hljs 整文件路径的行 HTML（≤2MB tree-sitter 失败兜底）
  let lineSegs: Map<number, LineSeg[]> | null = null; // tree-sitter 整文件路径的行段落
  // lazy 路径双缓存（chunkKey=startLine → 行 map）：tree-sitter 成功写 chunkCache，
  // chunk 失败/无 client 的行级 hljs 兜底写 hljsChunkCache（互斥，hasChunkData 视为已处理）
  const chunkCache = new Map<number, Map<number, LineSeg[]>>();
  const hljsChunkCache = new Map<number, Map<number, string>>();
  let hljs: HLJS | null = null;
  let hljsLang: string | null = null;
  let scroller: VirtualScrollerHandle | null = null;
  let destroyed = false;
  // 引擎实时值：tree-sitter/lazy 主路径在首个产出到达前为 pending；plain 策略即终值。
  // lazy 的 chunk 全走行级 hljs 兜底时置 'hljs'（首个 tree-sitter chunk 产出后保持主导引擎）
  let engine: CodeEngine = strategy === 'plain' ? 'plain' : 'pending';
  // 高亮计算执行位置（M6）：null = 未发生计算路由（纯文本/lazy 首 chunk 前）；
  // tree-sitter 主路径等路由结果回填；lazy 按 chunk 来源回填 remote/local。状态栏指示读这里。
  let computeWhere: ComputeWhere | null = null;
  // 文件内搜索状态（BUG-18/23）：query×caseSensitive 双键缓存 + 行→命中偏移索引
  //（fillRows 据此渲染词级 mark 与全部命中行的行级背景，虚拟滚动重绘天然保持）
  let lastQuery: string | null = null;
  let lastCaseSensitive = false;
  let lastMatches: SearchMatch[] = [];
  let searchHitsByLine = new Map<number, Array<{ start: number; end: number }>>();
  let hitLine = -1;
  let hitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 把 hitLine 的行级类同步到已渲染行 DOM（refresh 范围未变时 fillRows 不重跑，
   * 手动兜底）。类语义（BUG-18/09）：vv-search-hit-line = 命中行/跳转目标行的行级
   * 背景；vv-search-hit-line-active = 当前命中（加深，1.5s 后消退）。
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
    applyHitClass(); // active 行级高亮立即消退（直接改 DOM）
    // 仅因 hitLine 加了 vv-search-hit-line 的行（非搜索命中）随重绘消退；
    // 搜索命中行的背景由 searchState 驱动保持，不受 1.5s 计时影响
    if (prev >= 0 && !searchHitsByLine.has(prev)) scroller?.refresh(true);
  }

  /**
   * 行级读值统一入口：tree-sitter（整文件段落 → chunk 段落）→ hljs（整文件行 →
   * chunk 行）→ null（无高亮产出，调用方回落纯文本转义）。fillRows 与搜索 overlay
   * 都经此取行 HTML，lazy 双缓存/整文件多路来源对渲染逻辑透明。
   */
  function lineHtml(i: number): string | null {
    const segs = lineSegs?.get(i);
    if (segs) return renderLineHtml(lines[i] ?? '', segs);
    if (hlLines) return hlLines[i] ?? '';
    const chunkKey = Math.floor(i / CHUNK_LINES) * CHUNK_LINES;
    const chunkSegs = chunkCache.get(chunkKey)?.get(i);
    if (chunkSegs) return renderLineHtml(lines[i] ?? '', chunkSegs);
    const cached = hljsChunkCache.get(chunkKey)?.get(i);
    return cached !== undefined ? cached : null;
  }

  function fillRows(first: number, last: number, viewport: HTMLElement): void {
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const row = document.createElement('div');
      row.className = 'vv-code-line';
      row.style.height = `${lineHeight}px`;
      row.dataset.line = String(i); // 搜索跳转按行号定位行 DOM
      const hits = searchHitsByLine.get(i);
      // BUG-18：全部命中行都有行级背景（可见范围内，由 searchState 驱动）；
      // 当前命中/跳转行额外叠 active（BUG-09 revealLine 在无搜索时也走这条）
      if (hits !== undefined || i === hitLine) row.classList.add('vv-search-hit-line');
      if (i === hitLine) row.classList.add('vv-search-hit-line-active');
      const gutter = document.createElement('span');
      gutter.className = 'vv-code-gutter';
      gutter.textContent = String(i + 1);
      const body = document.createElement('span');
      body.className = 'vv-code-body';
      const html = lineHtml(i);
      if (hits !== undefined) {
        // BUG-18 词级 mark：命中段包 mark（overlaySearchHits 内语法 span 在命中
        // 边界闭合/重开），非命中段保持原语法高亮 HTML
        body.innerHTML = overlaySearchHits(html ?? escapeHtml(lines[i] ?? ''), hits);
      } else if (html !== null) body.innerHTML = html;
      else body.textContent = lines[i] ?? '';
      row.append(gutter, body);
      frag.append(row);
    }
    viewport.replaceChildren(frag);
  }

  function mount(): void {
    if (scroller || destroyed) return;
    scroller = virtualScroller(pre, lines.length, lineHeight, (first, last, viewport) => {
      if (strategy === 'lazy') scheduleChunks(first, last); // 可视区驱动 chunk 请求
      fillRows(first, last, viewport);
    });
  }

/** hljs 整文件兜底（M1 路径）：tree-sitter 不可用/失败时使用（仅 ≤2MB 会被调度到此） */
  async function hljsWholeFile(lang: string | null): Promise<void> {
    hljs ??= (await import('highlight.js')).default;
    if (destroyed) return;
    const language = resolveHljsLang(hljs, lang); // 别名桥接（如 c-sharp→csharp）；查不到 auto 采样检测
    let value: string | null;
    if (language !== null) {
      try {
        value = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } catch {
        value = highlightAutoSafe(hljs, text); // 指定语言高亮异常（罕见）仍兜 auto（采样防线版）
      }
    } else {
      value = highlightAutoSafe(hljs, text);
    }
    if (destroyed) return;
    if (value === null) {
      // 采样未检出语言（纯文本面）：engine 落 plain 终态不留「解析中」，hlLines 不产出
      engine = 'plain';
      return;
    }
    engine = 'hljs';
    computeWhere = 'local'; // hljs 兜底是本地引擎：执行位置随之回本地
    hlLines = splitHighlightedLines(value, lines.length);
    scroller?.refresh(true);
  }

  // ---------- lazy 路径：可视区 chunk 懒高亮（spec §5.2，接替 hljs-block 可视块） ----------
  /**
   * 待请求的 chunk 键（startLine，200 行对齐），近视口中心优先。每次 onRange 整表
   * 重算 = 过期裁剪：滚走的窗口自然出队，最新窗口优先；在-flight 单请求由 chunkBusy
   * 保证。**必须串行化**：本地 chunk 共用 highlight client，其 pendingByLang 按 lang
   * 级去重——并发连发会让后发 chunk 取消先发（半屏静默丢失），故渲染侧单在-flight
   * 逐个泵出（评审裁决，勿改并发）。
   */
  let wantedChunks: number[] = [];
  let chunkBusy = false;
  /** HL-09/取消语义：本 chunk 以 HighlightCanceledError 结束（tab 切换 cancelAll）——
   * 只逐出在-flight，不写 hljs 兜底（hljs 首写会永久遮蔽该行的 tree-sitter 质量）、
   * 不自续队列（避免 cancel 风暴），等下次 onRange 重发。 */
  let chunkCanceled = false;
  /** 显式 remote 失败停机闩：错误卡片已替换内容，管线永久停机——否则 refresh 的
   * onRange 会把未缓存的 chunk 反复入队，每次都再抛错（风暴）。 */
  let chunkPipelineStopped = false;

  function hasChunkData(startLine: number): boolean {
    return chunkCache.has(startLine) || hljsChunkCache.has(startLine);
  }

  /** 可视区 → 未缓存的 chunk 键（对齐、去重），近视口中心者优先 */
  function wantedChunkKeys(first: number, last: number): number[] {
    const { startLine, lineCount } = chunkRangeFor(first, last, lines.length);
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

  /** 队列泵：单在-flight，逐个消化最新窗口的 chunk（见 wantedChunks 注释的串行化裁决） */
  async function pumpChunk(): Promise<void> {
    if (chunkBusy || destroyed || chunkPipelineStopped) return;
    const startLine = wantedChunks.find((s) => !hasChunkData(s));
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

  /** 单 chunk 高亮：来源选择——服务端 range 路由 → 本地 worker chunk → 行级 hljs 兜底 */
  async function highlightChunk(startLine: number): Promise<void> {
    const lineCount = Math.min(CHUNK_LINES, lines.length - startLine);
    if (lineCount <= 0) return;
    const subLines = lines.slice(startLine, startLine + lineCount);
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
        // 显式 remote 失败：如实错误卡片，不静默降级（掩盖服务端故障）。
        // engine 置非 pending 终值；管线停机闩落下（否则 onRange 反复入队反复抛错）
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
        // 区间相对 chunk 首行：按 baseLine 平移到绝对行。旧服务端无 range 支持
        //（baseLine=0 与请求 startLine 不符，或区间越出 chunk 长度）时按全文件
        // 偏移表解释（baseLine 即全文件首行）
        const maxEnd = res.intervals.reduce((m, iv) => Math.max(m, iv.end), 0);
        const wholeFile = res.baseLine !== startLine || maxEnd > chunkText.length;
        const merged = mergeChunkLines(
          res.intervals,
          wholeFile ? lineOffsets : chunkOffsets,
          wholeFile ? 0 : res.baseLine
        );
        if (wholeFile) {
          // 旧服务端 wholeFile 兜底只保留本 chunk 切片（T4 评审 Minor 的自抖动收口）：
          // lineHtml 按 chunkKey 读值，整文件行表中属其他 chunk 的条目永不可达；
          // 原样入库会让该 chunk 行数超 CHUNK_CACHE_MAX_LINES → evictChunksByLines
          // 整块逐出 → 下次 onRange 重发全文件请求 → 「写入→逐出→重发」无限自抖动。
          // 裁剪后缓存粒度与 range 路径一致，逐出预算照常成立。
          for (const line of merged.keys()) {
            if (line < startLine || line >= startLine + lineCount) merged.delete(line);
          }
        }
        chunkCache.set(startLine, merged);
        evictChunksByLines(chunkCache, CHUNK_CACHE_MAX_LINES);
        engine = 'tree-sitter';
        computeWhere = 'remote';
        return;
      }
      // router null（auto 门/失败回退，注入侧已 warn）：该 chunk 行级 hljs——
      // 不回落本地 wasm：server-served 大文件连发本地 chunk 会持续占用 worker
      //（简报裁决；可用性与 ≤2MB 整文件链路的 BUG-10 null 语义一致）
      await hljsChunk(startLine, lineCount, subLines);
      return;
    }
    // client 未就绪先等待注入（同 start() attach 竞态口径）：懒 chunk 若在此窗口
    // 直落 hljsChunk 会双锁——hljsChunkCache 使 hasChunkData 视为已处理（attach 后
    // 该 chunk 永不重发 tree-sitter）且 engine 锁定 'hljs'（BUG-20/HL-03/FSEARCH-02/
    // m2 懒高亮家族在 CDN 构建下实测竞态）
    let client = getHighlightClient();
    if (client === null && lang !== null) {
      client = await waitForAttachedClient();
      if (destroyed) return;
    }
    if (client && lang !== null) {
      try {
        // 本地 worker chunk：区间相对子文本，mergeChunkLines 平移 +startLine
        const intervals = await client.highlight(chunkText, lang, {
          chunk: { startLine, lineCount }
        });
        if (destroyed) return;
        chunkCache.set(startLine, mergeChunkLines(intervals, chunkOffsets, startLine));
        evictChunksByLines(chunkCache, CHUNK_CACHE_MAX_LINES);
        engine = 'tree-sitter';
        computeWhere = 'local';
        return;
      } catch (err) {
        if (destroyed || err instanceof HighlightCanceledError) {
          chunkCanceled = true; // 取消≠失败：仅逐出在-flight，不落 hljs 兜底
          return;
        }
        // chunk 失败（413/网络/超时/解析错误）→ 该 chunk 行级 hljs 兜底
        await hljsChunk(startLine, lineCount, subLines);
        return;
      }
    }
    await hljsChunk(startLine, lineCount, subLines); // 无 client/lang：hljs highlightAuto chunk
  }

  /** 行级 hljs 兜底：单 chunk 主线程高亮（200 行，与原 hljs-block 可视块同量级）写 hljsChunkCache */
  async function hljsChunk(startLine: number, lineCount: number, subLines: string[]): Promise<void> {
    hljs ??= (await import('highlight.js')).default;
    if (destroyed) return;
    hljsLang = hljsLang ?? resolveHljsLang(hljs, lang) ?? highlightAutoDetect(hljs, subLines.join('\n'));
    // 采样检测命中即实例级锁定：后续 chunk 同语言线性高亮，不再逐块重探；未命中
    // （纯文本 chunk）保持 null，下个 chunk 重探（特征后置文本仍可检出）
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
      evictChunksByLines(hljsChunkCache, CHUNK_CACHE_MAX_LINES);
    }
    if (engine !== 'tree-sitter') {
      // 产出 hljs（首个 chunk 即兜底/无 client）→ engine=hljs 本地；chunk 全程未检出
      // 语言 → plain 终态（不留「解析中」）。已有 tree-sitter chunk 产出则保持主导
      // 引擎不变（混合 chunk 不回退指示）
      engine = value !== null ? 'hljs' : 'plain';
      computeWhere = value !== null ? 'local' : computeWhere;
    }
  }

  async function start(): Promise<void> {
    if (strategy === 'lazy') {
      mount(); // 首个 onRange 即发起可视区 chunk 请求；chunk 到达后 refresh 重绘
      if (lines.length === 0) engine = 'plain'; // 空文件无 chunk 可请求，不留「解析中」
      return;
    }
    if (strategy === 'tree-sitter') {
      mount(); // 先渲染纯文本立即可见，区间到达后刷新
      // client 未注入（创建期资产链未完成）先等待而非直接 hljs 兜底：首开文件
      // 不得因 attach 竞态被永久错锁引擎（waitForAttachedClient doc）
      const client = getHighlightClient() ?? (await waitForAttachedClient());
      if (destroyed) return;
      if (!client || lang === null) {
        await hljsWholeFile(lang);
        return;
      }
      try {
        const intervals = await client.highlight(text, lang, {
          src: opts.computeSrc,
          onWhere: (w) => {
            computeWhere = w;
          }
        });
        if (destroyed) return;
        engine = 'tree-sitter';
        lineSegs = new Map(assignIntervalsToLines(intervals, lineOffsets).map((a) => [a.line, a.segs]));
        scroller?.refresh(true);
      } catch (err) {
        if (destroyed || err instanceof HighlightCanceledError) return; // tab 已切换：静默
        if (err instanceof RemoteComputeError) {
          // 显式 remote 失败（remote 策略，router 不回退）：真实错误如实展示错误卡，
          // 不静默降级 hljs——静默回退会掩盖服务端故障并造成"高亮结果与策略不符"的错觉
          // BUG-56：engine/computeWhere 同步置终值（与 chunk 失败路径 :927 同口径）——
          // 否则 engine 停留初始 'pending'（状态栏「解析中…」永不落定）、computeWhere
          // 停留请求期回填的 'remote'（失败后补出「执行: 远程」且不自愈）
          engine = 'plain';
          computeWhere = null;
          showErrorCard(target, err.message, { name: opts.ext ? `.${opts.ext}` : '代码' });
          return;
        }
        await hljsWholeFile(lang); // 解析失败 → hljs 整文件兜底
      }
      return;
    }
    mount(); // plain
  }

  void start();
  return {
    destroy() {
      destroyed = true;
      if (hitTimer !== null) clearTimeout(hitTimer);
      wantedChunks = []; // 队列作废；在-flight chunk 的回写在各 await 点被 destroyed 拦截
      scroller?.destroy();
      scroller = null;
      chunkCache.clear();
      hljsChunkCache.clear();
      pre.remove();
      // BUG-20 提示条与 flex 布局类随实例销毁清理（host 复用时不得残留）
      target.classList.remove('vv-code-oversize');
    },
    setScrollTop(top) {
      pre.scrollTop = top;
    },
    scrollTop() {
      return pre.scrollTop;
    },
    getScrollHost() {
      return pre;
    },
    getEngine: () => engine,
    getComputeWhere: () => computeWhere,
    // BUG-04：渲染期静态的元数据快照。lines 为内容行数口径：buildLineIndex 已对尾
    // \n 归一（BUG-38，'a\nb\n' → ['a','b']），lines.length 即 wc -l 口径（空文件
    // '' → [] → 0 行）
    getMeta() {
      return {
        encoding: opts.encoding ?? 'utf-8',
        lang, // 与 start() 实际高亮语言同源（评审③：本地 .js 也显示「语言: javascript」）
        size: buffer.byteLength,
        lines: lines.length
      };
    },
    search(query, opts?: { caseSensitive?: boolean }) {
      const caseSensitive = opts?.caseSensitive === true;
      if (query === lastQuery && caseSensitive === lastCaseSensitive) {
        return Promise.resolve(lastMatches);
      }
      lastQuery = query;
      lastCaseSensitive = caseSensitive;
      searchHitsByLine = new Map();
      lastMatches = query === '' ? [] : searchCode(lines, query, { caseSensitive });
      for (const m of lastMatches) {
        const arr = searchHitsByLine.get(m.line);
        if (arr) arr.push({ start: m.start, end: m.end });
        else searchHitsByLine.set(m.line, [{ start: m.start, end: m.end }]);
      }
      if (hitTimer !== null) {
        clearTimeout(hitTimer);
        hitTimer = null;
      }
      hitLine = -1;
      // 空查询 = 退出搜索：active 行级高亮立即消退——applyHitClass（hitLine 已置
      // -1）与 clearHit 的清理面等价，但不走其内部条件 refresh（它在此与下方统一
      // 重绘构成双刷，deferred 卫生合并为恰一次重绘）；行级背景与词级 mark 的消退
      // 由下方单次 refresh(true) 重绘完成。新查询无需此 DOM 兜底：旧 hitLine 已
      // 重置，词级 mark 与命中行背景随重绘上屏（虚拟滚动重绘由 searchState 驱动，
      // 天然保持）。hitTimer 清理对两分支同语义（对照 clearHit 实现）
      if (query === '') applyHitClass();
      // 词级 mark 在行 innerHTML 里：已渲染行必须重绘（force）才能更新/清除
      scroller?.refresh(true);
      return Promise.resolve(lastMatches);
    },
    gotoMatch(index) {
      const match = lastMatches[index];
      if (!match) return;
      jumpToLine(match.line);
    },
    // BUG-09：全局搜索跳转——复用 gotoMatch 的滚动 + 行级高亮机制，但不依赖
    // 搜索结果（col 参数预留行内定位，当前无水平滚动消费方）
    revealLine(line, col) {
      void col;
      if (!Number.isInteger(line) || line < 0 || line >= lines.length) return;
      jumpToLine(line);
    },
    // deferred 清偿 Task 5：偏移 → 物理行号二分（jsonl 委托降级锚行映射的上游；
    // 边界语义见 RenderCodeHandle.lineAtOffset 注——行尾换行符归本行、超尾钳末行）
    lineAtOffset(offset: number) {
      return lineOf(lineOffsets, offset);
    },
    // 字节域行索引二分（域与边界语义见 RenderCodeHandle.lineAtByteOffset 注）
    lineAtByteOffset(offset: number) {
      return lineOf(byteLineOffsets, offset);
    }
  };

  /** 跳转共用体：目标行滚至视口中部 + 行级临时高亮（1.5s 或直到下一次跳转） */
  function jumpToLine(line: number): void {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitLine = line;
    // 目标行滚到视口中部（clientHeight 为 0（jsdom/未布局）时回落贴顶）。
    // 经 scroller.scrollTo 以虚拟坐标定位（BUG-55：总行高超浏览器滚动域上限后
    // scrollTop 与虚拟坐标不再恒等；scroller 未挂载窗口期回落直写）
    const center = line * lineHeight - pre.clientHeight / 2 + lineHeight / 2;
    if (scroller) scroller.scrollTo(Math.max(0, center));
    else pre.scrollTop = Math.max(0, center);
    scroller?.refresh(); // 按新 scrollTop 重算可视范围（范围未变则行 DOM 已在，applyHitClass 兜底）
    applyHitClass();
    hitTimer = setTimeout(() => {
      hitTimer = null;
      clearHit();
    }, 1500);
  }
}
