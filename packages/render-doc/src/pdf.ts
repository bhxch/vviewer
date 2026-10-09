// pdf.ts — PDF 渲染器（M4 Task 1）。pdfjs-dist 动态 import（重依赖不进主包、SSR 不加载），
// worker 以 vite 原生资产 URL 提供（new URL + import.meta.url，vite ≥5.1 支持裸说明符，
// build 时输出为哈希资产——实测见任务报告）。
// 渲染结构：工具条（页码/缩放）+ 滚动容器内逐页 canvas；前 3 页立即渲染，
// 其余 IntersectionObserver 懒渲染；缩放在 0.5x-3x 预设档位间步进并全量重渲染。
// 搜索：search 时懒提取各页 textContent 并缓存，跨页扫描用 pdfText 纯函数；gotoMatch 跳页。
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
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
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, _det: Detection) {
    const pdfjs = await loadPdfjs();
    // BUG-04 握手点 2 代工：size 须在 getDocument 前捕获——pdfjs 会 transfer 该 buffer
    // 到 worker（detach），detach 后 byteLength 归零，getMeta 再读就是 0
    const size = buffer.length;
    // pdfjs 会 transfer 该 buffer 到 worker（detach）：调用方每次 dispatch 前重新 read，无复用问题。
    // pdfjs 6 起移除 PDFDocumentProxy.prototype.destroy（api-major，upstream PR 21245）：
    // 资源释放改走 loadingTask.destroy()，故保留 loadingTask 引用
    const loadingTask = pdfjs.getDocument({ data: buffer });
    const doc: PDFDocumentProxy = await loadingTask.promise;

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
