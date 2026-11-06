// pdf.ts — PDF 渲染器（M4 Task 1）。pdfjs-dist 动态 import（重依赖不进主包、SSR 不加载），
// worker 以 vite 原生资产 URL 提供（new URL + import.meta.url，vite ≥5.1 支持裸说明符，
// build 时输出为哈希资产——实测见任务报告）。
// 渲染结构：工具条（页码/缩放）+ 滚动容器内逐页 canvas；前 3 页立即渲染，
// 其余 IntersectionObserver 懒渲染；缩放在 0.5x-3x 预设档位间步进并全量重渲染。
// 搜索：search 时懒提取各页 textContent 并缓存，跨页扫描用 pdfText 纯函数；gotoMatch 跳页。
// 流式（io-streaming 计划 5 Task 1，spec §6.6）：声明 streaming 后 dispatcher 交付
// head 探测块 + StreamCtx；capable 且 size 已知且 buffer 短于 size 时走
// PDFDataRangeTransport（requestRange → ctx.read 窗段）渐进加载，回退矩阵见 render 入口注释。
import { isAbortError } from '@bhxch/vviewer-core';
import type { Detection, FileSource, RenderedInstance, Renderer, StreamCtx } from '@bhxch/vviewer-core';
import type { PDFDataRangeTransport, PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { extractPageText, searchPdfPages, type PdfSearchMatch, type PdfTextItem } from './pdfText';

type Pdfjs = typeof import('pdfjs-dist');

/** 缩放预设档位（0.5x-3x），工具条 −/＋ 在档位间步进 */
const SCALE_PRESETS = [0.5, 0.75, 1, 1.5, 2, 3];
/** 打开文件后立即渲染的页数，其余懒渲染 */
const IMMEDIATE_PAGES = 3;
/** 懒渲染预热边距：提前渲染视口外 200px 内的页，翻页不露白 */
const LAZY_ROOT_MARGIN = '200px';
/** gotoMatch 跳页后命中页的高亮时长（ms） */
const HIT_FLASH_MS = 1200;

let pdfjsPromise: Promise<Pdfjs> | null = null;

/** pdfjs 懒加载（单例）：getDocument 前必须设好 workerSrc，避免走主线程假 worker */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString();
    return pdfjs;
  })();
  return pdfjsPromise;
}

function isCancelledError(e: unknown): boolean {
  return e instanceof Error && e.name === 'RenderingCancelledException';
}

// ---------- Range transport（spec §6.6，io-streaming 计划 5 Task 1） ----------

/**
 * 守卫补拉记忆（render-text/blockStream.ts memoizedFullRead 同源形态；终审 I-2 分歧备案）：
 * size 未知回退的 {0, MAX_SAFE_INTEGER} 全量补拉按 ctx 记忆——错误卡片 retry 重入 render
 * （同一 renderCtx 透传，评审指令②）不再重复全量下载；失败不记忆（retry 可重新发起）。
 * 与 text 侧的关键分歧：pdfjs getDocument 会 transfer data.buffer 到 worker（主线程副本
 * detach 归零）——memo 直存/直还 Promise 值实例时，重试即命中零长 buffer → getDocument
 * 必抛（transfer 毒化，重试恒败且错误文案被换）。故 memo 存字节本体、每次消费返回
 * .slice() 新副本（首消费同样拷贝：getDocument transfer 的是副本，memo 保有体不 detach）。
 */
const fullReadMemo = new WeakMap<StreamCtx, Uint8Array<ArrayBuffer>>();

async function memoizedFullRead(ctx: StreamCtx): Promise<Uint8Array<ArrayBuffer>> {
  const memo = fullReadMemo.get(ctx);
  if (memo !== undefined) return memo.slice(); // 消费即拷贝（重入拿到的恒是非零新副本）
  // 全量读端点 {0, MAX_SAFE_INTEGER}：远端 Range 超界由服务端钳制返回整文件、本地
  // slice 越界自然钳制（hex.ts size-null 回退同款单发读，signal 不传——与 code 全量
  // 补拉同口径，读失败经 dispatcher ctx.read 包装标 DispatchReadError 向上 reject）
  const bytes = await ctx.read({ start: 0, end: Number.MAX_SAFE_INTEGER });
  fullReadMemo.set(ctx, bytes);
  return bytes.slice(); // 首消费同样交副本：memo 保有体与 getDocument transfer 面分离
}

/**
 * ctx.read 窗段 → pdfjs 渐进交付的 transport 装配（可测纯装配形态，spec §6.6）。
 *
 * pdfjs API 实态（pdfjs-dist 6.4.299，types/src/display/api.d.ts:758）：基类形参序为
 * `constructor(length, initialData, progressiveDone?, contentDispositionFilename?)`——
 * length 在前、initialData 在后（spec 行文「PDFDataRangeTransport(head, size)」系笔误，
 * 实装按真实 API 逆序传入）；基类 requestDataRange 为抽象抛错，须子类覆写。
 *
 * 窗段语义换算（本实现的唯一跨域换算点）：pdfjs 的 requestDataRange(begin, end) 端点
 * 为 [begin, end) 不含端（worker ChunkedStreamManager._requestChunks：`end =
 * Math.min(endChunk * chunkSize, length)`，即 end 指向末字节后一位置）；core ByteRange
 * 端点为 end 含（types.ts:16）→ 请求时换算 `end - 1`。交付以 pdfjs 原始 begin 回调
 * onDataRange（PDFDataTransportStream 按 `r._begin === begin` 匹配 range reader，
 * 不得改写）；窗段为单块交付语义（PDFDataTransportStreamRangeReader._enqueue 后即
 * _done）：一次 requestDataRange 恰对应一次 onDataRange 完整窗段。
 *
 * BaseCtor 经参注入而非静态 import：pdf.ts 对 pdfjs-dist 保持纯动态加载（重依赖不进
 * 主包、SSR 不加载），子类在装配期才触达基类。
 */
export function createPdfRangeTransport(
  BaseCtor: typeof PDFDataRangeTransport,
  opts: {
    size: number;
    head: Uint8Array;
    read: StreamCtx['read'];
    signal?: AbortSignal;
    /** 非 abort 读失败回调（M1）：mid-load 收口钩子，render 侧据 docOpened 门控 destroy */
    onReadFailure?: () => void;
  }
): PDFDataRangeTransport & { requestRange(begin: number, end: number): Promise<void> } {
  const { size, head, read, signal, onReadFailure } = opts;
  class CtxReadTransport extends BaseCtor {
    constructor() {
      // progressiveDone=false：initialData 是探测头前缀而非完整文件（head 即全量的
      // 文件走 data 路径，不入本分支）
      super(size, head, false);
    }
    /** 可测面：读窗段并交付；reject 原样透传（abort 身份/读失败身份层不变） */
    async requestRange(begin: number, end: number): Promise<void> {
      // [begin, end) 不含端 → ByteRange {start: begin, end: end - 1} 含端
      const chunk = await read({ start: begin, end: end - 1 }, signal);
      this.onDataRange(begin, chunk);
    }
    requestDataRange(begin: number, end: number): void {
      // pdfjs transport API 无 per-chunk 错误回传通道：读失败/取消无法直接让
      // loadingTask.promise reject。收口分两路（M1 评审）：
      // - abort 身份（signal 取消，store 层统一抛 abortReadError）：静默——render 失败
      //   清理与实例 destroy 均前置 signal abort，在飞 ctx.read 先行 reject，无字节再
      //   交付，挂起的 range reader 由 loadingTask.destroy() 收口；
      // - 非 abort 读失败（DispatchReadError/网络错）：交 onReadFailure（render 侧
      //   docOpened 门控）——文档未开时 destroy 使 promise reject 进 render 既有 catch
      //   → 错误卡片路径（否则 range reader 永久 pending → render 挂死且无 destroy
      //   路径）；doc 已开后懒页 chunk 读失败维持静默（单页空白不渲染，可接受）。
      // 错误身份在此不改写（isAbortError 纯身份判定，见 core/dispatch/errors）。
      void this.requestRange(begin, end).catch((err: unknown) => {
        if (isAbortError(err)) return;
        onReadFailure?.();
      });
    }
  }
  return new CtxReadTransport();
}

interface PageState {
  num: number; // 1 起
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedScale: number | null;
  rendering: boolean;
  renderTask: { cancel(): void; promise: Promise<void> } | null;
}

export const pdfRenderer: Renderer = {
  id: 'pdf',
  label: 'PDF',
  extensions: ['pdf'],
  // streaming（io-streaming 计划 5 Task 1，spec §6.6）：dispatcher 只交付 head 探测块 +
  // StreamCtx；transport/回退分流在 render 入口自处（下方判定）。本地/退化全量来源
  // 交付的 buffer 即全量，data 路径零变化。lineMetrics/langOverride（第 6 参其余字段）
  // 对 pdf 无消费面，不读即零感知。
  streaming: true,
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, _det: Detection, ctx?: StreamCtx, opts?: { signal?: AbortSignal }) {
    const pdfjs = await loadPdfjs();
    // 读取消信号（实例级）：destroy abort 在飞窗段读；外部 signal（dispatch 第 6 参，
    // effect 级取消）合并进同一 controller——两源任一触发皆取消，取消错误身份由
    // ctx.read 契约透传（store 层统一 abortReadError）
    const readAbort = new AbortController();
    const externalSignal = opts?.signal;
    const onExternalAbort = (): void => readAbort.abort();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) readAbort.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    // 分流判定（spec §6.6 回退矩阵 + dispatcher 读策略镜像，code.ts 守卫同款形态）：
    // transport 分支 = ctx 在场 && store 具备 Range 能力 && size 已知 && buffer 短于
    // size。末项即「dispatcher 只交付了 head 探测块」的充要形态（dispatcher streaming
    // 分支：capable 且 size>1MB 时 buffer=8KB probe；≤1MB 直读全量与 !capable 退化
    // 全量视图均交付全量 buffer，byteLength === size 不入本支）。StreamCtx 无
    // rangeCapable 承载字段（纯 {size, head, read}），rangeCapable 自 source.store 判
    // （与 dispatcher capable 判定同源）。回退矩阵（非 transport 态均落
    // getDocument({data}) 全量现路径）：
    // - ctx 缺失（直调兼容面）：buffer 即全量，data 路径零变化
    // - size null：head 无法确认截断与否 → memoizedFullRead 全量补拉后 data 路径
    // - !rangeCapable：dispatcher 已交付全量（退化视图 byteLength === size）→ data 路径
    //   零变化
    // - 本地 ≤1MB（localFiles/localFs 全量直读）：同上退化视图 → data 路径零变化
    // - 本地 >1MB：localFiles/localFs 同为 rangeCapable:true（File.slice 零网络）→
    //   dispatcher 8KB 探测块 + ctx → transport（终审 I-1 语义对齐：非「data 路径」，
    //   行为良性偏优——按需窗段读替代一次性全量物化）
    // typeof ctx.read === 'function'（I1 纵深防御）：对齐 dispatcher capable 判定的
    // read 在场项（`capable = store.rangeCapable === true && read !== undefined`）——
    // 渲染器无 dispatch read 直通面，以 ctx.read 在场为代理；正常 dispatcher 交付恒真，
    // 仅拦截违约 ctx（read 缺失 → 落全量守卫，memoizedFullRead 处快速失败）
    const transport =
      ctx !== undefined &&
      ctx.size !== null &&
      source.store.rangeCapable === true &&
      typeof ctx.read === 'function' &&
      buffer.byteLength < ctx.size
        ? { size: ctx.size, head: buffer, read: ctx.read }
        : null;
    if (transport === null && ctx !== undefined && (ctx.size === null || buffer.byteLength < ctx.size)) {
      // 全量守卫补拉：size 未知时 head 不可当全量用。读失败在此 await 处 reject
      // （dispatcher 已标 DispatchReadError → 调用方读取失败面）；补拉按 ctx 记忆
      // （memoizedFullRead），错误卡片 retry 重入不重复下载
      buffer = await memoizedFullRead(ctx);
    }
    // BUG-04 握手点 2 代工：size 须在 getDocument 前捕获——pdfjs 会 transfer 该 buffer
    // 到 worker（detach），detach 后 byteLength 归零，getMeta 再读就是 0。transport
    // 分支 buffer 是 head 探测块，size 取 ctx.size（全量文件字节数）
    const size = transport !== null ? transport.size : buffer.length;
    // pdfjs 会 transfer 该 buffer 到 worker（detach）：调用方每次 dispatch 前重新 read，无复用问题。
    // pdfjs 6 起移除 PDFDocumentProxy.prototype.destroy（api-major，upstream PR 21245）：
    // 资源释放改走 loadingTask.destroy()，故保留 loadingTask 引用
    // M1（评审跟进）：mid-load 读失败收口——transport 的 requestRange 非 abort 读失败
    // 时经 onReadFailure 回调（pdfjs 无 per-chunk 错误通道）；文档未开（promise 未决）
    // → loadingTask.destroy() 使 promise reject 进下方 catch（错误卡片路径），否则
    // range reader 永久 pending → render 挂死且无 destroy 路径；doc 已开后（懒页
    // chunk 读失败）维持静默——单页空白不渲染可接受，不因尾块抖动整页报错
    let loadingTask: PDFDocumentLoadingTask;
    let docOpened = false;
    // M1 收口标志：onReadFailure 触发的 destroy 与真实取消（external/readAbort）在
    // reject 身份上同形（pdfjs destroy 的 promise reject 是 AbortException）——dispatch
    // 错误身份层按 abort 归类「不上屏」，错误卡片永不出现（统一验证阶段 e2e 实证）。
    // 标志区分两条收口：M1 读失败退化剥 abort 身份上屏（下方 catch），真实取消维持静默。
    let m1ReadFailed = false;
    loadingTask =
      transport !== null
        ? pdfjs.getDocument({
            range: createPdfRangeTransport(pdfjs.PDFDataRangeTransport, {
              size: transport.size,
              head: transport.head,
              read: transport.read,
              signal: readAbort.signal,
              onReadFailure: () => {
                if (!docOpened) {
                  m1ReadFailed = true;
                  void loadingTask.destroy();
                }
              }
            })
          })
        : pdfjs.getDocument({ data: buffer });
    let doc: PDFDocumentProxy;
    try {
      doc = await loadingTask.promise;
      docOpened = true; // 文档已开：后续懒页 chunk 读失败走静默分支（onReadFailure 门控）
    } catch (e) {
      const cancelled = readAbort.signal.aborted || externalSignal?.aborted === true;
      // 打开失败（损坏 PDF/读失败）：释放 worker 端资源并取消在飞窗段读——不留孤儿
      // promise（transport 模式挂起的 range reader 随 destroy 收口）。真实取消维持
      // abort 身份（dispatch 既有分类：取消 no-op 不上屏）；M1 读失败退化（非 abort
      // 读失败且文档未开 → onReadFailure destroy）剥 abort 身份重抛——destroy 的
      // reject 是 AbortException，不改写会被归为取消而静默，错误卡片永不出现
      //（DispatchReadError/generic 经 dispatcher catch 既有分类，generic 落错误卡片 +
      // 重试，R-06 锚语义）。沿用 errors.ts 既有分类，不新造错误类别。
      readAbort.abort();
      externalSignal?.removeEventListener('abort', onExternalAbort);
      void loadingTask.destroy();
      if (m1ReadFailed && !cancelled) {
        throw new Error(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }

    let destroyed = false;
    let scaleIdx = SCALE_PRESETS.indexOf(1);
    const scale = (): number => SCALE_PRESETS[scaleIdx] ?? 1;

    const root = document.createElement('div');
    root.className = 'vv-pdf';
    const toolbar = document.createElement('div');
    toolbar.className = 'vv-pdf-toolbar';
    const pagesHost = document.createElement('div');
    pagesHost.className = 'vv-pdf-pages';
    root.append(toolbar, pagesHost);
    target.replaceChildren(root);

    // ---- 页状态与占位 ----
    // 占位尺寸统一取第一页（绝大多数 PDF 页面尺寸一致）；个别不一致的页渲染完成后
    // 以实际 viewport 修正自身 wrap 尺寸
    const firstPage = await doc.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    const pageW = firstViewport.width;
    const pageH = firstViewport.height;
    const pageCache = new Map<number, Promise<PDFPageProxy>>([[1, Promise.resolve(firstPage)]]);

    function getPage(n: number): Promise<PDFPageProxy> {
      let p = pageCache.get(n);
      if (!p) {
        p = doc.getPage(n);
        pageCache.set(n, p);
      }
      return p;
    }

    const pageStates: PageState[] = [];
    const stateByWrap = new Map<Element, PageState>();
    for (let n = 1; n <= doc.numPages; n++) {
      const wrap = document.createElement('div');
      wrap.className = 'vv-pdf-page';
      const label = document.createElement('span');
      label.className = 'vv-pdf-page-label';
      label.textContent = `${n} / ${doc.numPages}`;
      wrap.append(label);
      setPlaceholderSize(wrap);
      pagesHost.append(wrap);
      const st: PageState = {
        num: n,
        wrap,
        canvas: null,
        renderedScale: null,
        rendering: false,
        renderTask: null
      };
      pageStates.push(st);
      stateByWrap.set(wrap, st);
    }

    function setPlaceholderSize(wrap: HTMLElement): void {
      wrap.style.width = `${pageW * scale()}px`;
      wrap.style.height = `${pageH * scale()}px`;
    }

    // ---- 懒渲染 ----
    async function ensureRender(st: PageState): Promise<void> {
      if (destroyed || st.rendering || (st.canvas !== null && st.renderedScale === scale())) return;
      st.rendering = true;
      const s = scale();
      try {
        const page = await getPage(st.num);
        if (destroyed) return;
        const viewport = page.getViewport({ scale: s });
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        });
        st.renderTask = task;
        try {
          await task.promise;
        } catch (e) {
          if (!isCancelledError(e)) throw e;
          canvas.remove(); // 缩放切换/销毁取消：丢弃本次画布即可
          return;
        }
        if (destroyed || scale() !== s) {
          canvas.remove();
          return;
        }
        st.canvas?.remove();
        st.canvas = canvas;
        st.renderedScale = s;
        st.wrap.append(canvas);
        // 页面尺寸与占位（第一页）不一致时按实际修正
        st.wrap.style.width = `${viewport.width}px`;
        st.wrap.style.height = `${viewport.height}px`;
      } finally {
        st.rendering = false;
        st.renderTask = null;
      }
    }

    // 可视页集合（IO 回调维护）：页码指示与缩放后"立即重渲染可视页"都用它
    const visible = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const st = stateByWrap.get(en.target);
          if (!st) continue;
          if (en.isIntersecting) {
            visible.add(st.num);
            void ensureRender(st);
          } else {
            visible.delete(st.num);
          }
        }
        const nums = [...visible].sort((a, b) => a - b);
        if (nums.length > 0) pageIndicator.textContent = `第 ${nums[0]} / ${doc.numPages} 页`;
      },
      { root: pagesHost, rootMargin: LAZY_ROOT_MARGIN }
    );
    for (const st of pageStates) io.observe(st.wrap);

    // 前 3 页立即渲染（IO 只覆盖预热边距内的页，初始视口可能不足 3 页）
    for (const st of pageStates.slice(0, IMMEDIATE_PAGES)) void ensureRender(st);

    // ---- 工具条 ----
    const pageIndicator = document.createElement('span');
    pageIndicator.className = 'vv-pdf-page-indicator';
    pageIndicator.textContent = `第 1 / ${doc.numPages} 页`;
    const zoomBtn = document.createElement('span');
    zoomBtn.className = 'vv-pdf-zoom-label';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', '缩小');
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.textContent = '＋';
    zoomIn.setAttribute('aria-label', '放大');
    toolbar.append(zoomOut, zoomBtn, zoomIn, pageIndicator);

    function syncZoomUi(): void {
      zoomBtn.textContent = `${Math.round(scale() * 100)}%`;
      zoomOut.disabled = scaleIdx <= 0;
      zoomIn.disabled = scaleIdx >= SCALE_PRESETS.length - 1;
    }

    function applyScale(next: number): void {
      if (destroyed || next === scaleIdx) return;
      scaleIdx = Math.max(0, Math.min(SCALE_PRESETS.length - 1, next));
      syncZoomUi();
      // 全量重渲染：取消在途任务、清空已渲染画布、重设占位尺寸；
      // 可视页立即重渲染，其余交还 IO（scroll 位置不变时 IO 不会再触发）
      for (const st of pageStates) {
        st.renderTask?.cancel();
        st.canvas?.remove();
        st.canvas = null;
        st.renderedScale = null;
        setPlaceholderSize(st.wrap);
      }
      const nums = visible.size > 0
        ? [...visible]
        : pageStates.slice(0, IMMEDIATE_PAGES).map((s) => s.num);
      for (const n of nums) {
        const st = pageStates[n - 1];
        if (st) void ensureRender(st);
      }
    }

    zoomOut.onclick = () => applyScale(scaleIdx - 1);
    zoomIn.onclick = () => applyScale(scaleIdx + 1);
    syncZoomUi();

    // ---- 搜索 ----
    let pageTexts: string[] | null = null; // 首次搜索时懒提取并缓存
    let lastMatches: PdfSearchMatch[] = [];

    async function ensurePageTexts(): Promise<string[]> {
      if (pageTexts) return pageTexts;
      const out: string[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await getPage(n);
        const tc = await page.getTextContent();
        // items 联合类型含 TextMarkedContent（无 str）：in 收窄到 TextItem 后取最窄字段
        const items: PdfTextItem[] = [];
        for (const it of tc.items) {
          if ('str' in it) items.push({ str: it.str, hasEOL: it.hasEOL === true });
        }
        out.push(extractPageText(items));
      }
      pageTexts = out;
      return out;
    }

    const instance: RenderedInstance & { getMeta(): { size: number } } = {
      // BUG-04 握手点 2 代工：PDF 实例暴露大小（ViewerPane 'getMeta' in inst 探测自动消费，
      // 状态栏/MetaPanel 得以显示「大小」段）
      getMeta: () => ({ size }),
      // BUG-23：caseSensitive 透传（searchPdfPages 纯函数本就支持）；多传 opts 对
      // 旧调用方向后兼容，SearchPanel 的 Aa 开关对 PDF 视图同等生效
      async search(query: string, opts?: { caseSensitive?: boolean }): Promise<PdfSearchMatch[]> {
        if (query === '') {
          lastMatches = [];
          return [];
        }
        const texts = await ensurePageTexts();
        lastMatches = searchPdfPages(texts, query, opts);
        return lastMatches;
      },
      gotoMatch(index: number): void {
        const m = lastMatches[index];
        if (!m) return;
        // line 复用为 0 起页号（见 pdfText.ts 的 PdfSearchMatch 注释）
        const st = pageStates[m.line];
        if (!st) return;
        st.wrap.scrollIntoView({ block: 'start' });
        st.wrap.classList.add('vv-pdf-page-hit');
        setTimeout(() => st.wrap.classList.remove('vv-pdf-page-hit'), HIT_FLASH_MS);
      },
      destroy() {
        destroyed = true;
        readAbort.abort(); // 在飞窗段读（transport requestRange）取消，abort 身份经 ctx.read 契约透传
        externalSignal?.removeEventListener('abort', onExternalAbort);
        io.disconnect();
        for (const st of pageStates) st.renderTask?.cancel();
        pageStates.length = 0;
        stateByWrap.clear();
        void loadingTask.destroy(); // 释放 worker 端文档资源（pdfjs 6：destroy 移至 loadingTask）
        root.remove(); // canvas 一并移除释放
      }
    };
    return instance;
  }
};
