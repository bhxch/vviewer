/**
 * JSON Lines 渲染器（.jsonl/.ndjson）：行卡片 + 可变高度窗口 + 卡片级懒高亮。
 *
 * IO/解析裁决（spec D §2.3）：IO 全量——上层 dispatcher 交付的是整文件 buffer，
 * TextDecoder 一次解码 + CRLF 归一（与 code.ts 同款）；解析流式——splitJsonlLines
 * 只切行不解析，JSON.parse 在卡片首次进入窗口时惰性执行。解析缓存
 * Map<number, JsonlLineState> 不设上限：结果字符串体积与原文本同阶（pretty 放大
 * 有限），行数已知可全持，逐出只会导致滚动回看时重复解析，无收益。
 *
 * 高亮裁决：卡片级——每张 ok 卡片对自身 pretty 全文调一次
 * getHighlightClient().highlight(pretty, 'json')，窗口外的行永不解析/高亮；
 * 区间 → 行 HTML 复用 code.ts 导出的 assignIntervalsToLines + renderLineHtml
 * （两者即 code.ts tree-sitter 整文件路径的同一管线，无需本地副本；code.ts 的
 * splitHighlightedLines 面向 hljs HTML 字符串输出，本处 client 产出 intervals，
 * 不合用）。取消语义沿用 code.ts：HighlightCanceledError 静默，不写 DOM、不兜底。
 *
 * 高度模型：复用 window.ts 的 HeightModel/visibleRange（实测前缀和 + 估算外推），
 * DOM 适配层在本模块——rAF 合并一帧内的批量 measure 修正（一帧消费一次 dirty）。
 */
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';
import { HighlightCanceledError, type HighlightInterval } from '@vviewer/highlight';
import {
  assignIntervalsToLines,
  buildLineOffsets,
  DECODERS,
  getHighlightClient,
  PLAIN_MAX_BYTES,
  renderCode,
  renderLineHtml,
  type CodeFileMeta
} from '../code';
import {
  collapseFor,
  JSONL_COLLAPSE_LINES,
  parseJsonlLine,
  splitJsonlLines,
  type JsonlLineState
} from './parse';
import { HeightModel, visibleRange } from './window';

/** 封顶卡片的 body 内滚动最大高度（px）：400 行 × 20px 全展开会顶爆窗口滚动
 * 定位（translateY 前缀和失效），封顶展开放卡片内滚动。CSS 缺位时的行为兜底。 */
const JSONL_CAPPED_BODY_MAX_HEIGHT = 480;

/**
 * >200MB 委托 code 纯文本视图的阈值判断（纯函数，导出供单测；真构造 200MB buffer
 * 不现实——计划裁决：阈值单测 + e2e 不覆盖降级路径）。阈值 import 自 code.ts 的
 * PLAIN_MAX_BYTES 同源常量，无本地副本。
 */
export function shouldDelegateToCode(size: number): boolean {
  return size > PLAIN_MAX_BYTES;
}

/** 卡片滚动容器 / 窗口 overscan（与 visibleRange 缺省一致，显式书写便于调参） */
const OVERSCAN = 5;

/**
 * JSONL 渲染本体：构建 .vv-jsonl DOM（状态条 + 滚动容器）并驱动可变高度窗口循环。
 * 返回实例含 destroy 与 getMeta（CodeFileMeta 同形状，ViewerPane 鸭子探测自动消费）。
 */
export function renderJsonl(
  buffer: Uint8Array,
  target: HTMLElement,
  det: Detection
): RenderedInstance & { getMeta(): CodeFileMeta } {
  // 解码 + 归一（code.ts L537 同款：DECODERS 表 + fatal:false；标签异常容错回落 utf-8）
  let text: string;
  try {
    text = new TextDecoder(DECODERS[det.encoding ?? 'utf-8'], { fatal: false }).decode(buffer);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
  text = text.replace(/\r\n?/g, '\n'); // CRLF/CR → LF（行索引/高亮偏移全在归一文本上）
  const lines = splitJsonlLines(text); // 丢弃空行/纯空白行（JSONL 惯例）
  const totalRows = lines.length;

  target.classList.add('vv-jsonl');
  const status = document.createElement('div');
  status.className = 'vv-jsonl-status';

  // 解析缓存（惰性填充，不设上限，见模块头）与失败行计数（解析流式的代价：
  // 失败数随窗口解析渐进逼近全量，小文件首屏即终值）
  const parseCache = new Map<number, JsonlLineState>();
  let failedCount = 0;

  function refreshStatus(): void {
    if (failedCount > 0) status.setAttribute('aria-live', 'polite');
    if (failedCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'vv-jsonl-status-failed';
      badge.textContent = ` · ${failedCount} 行解析失败`;
      status.replaceChildren(document.createTextNode(`共 ${totalRows} 行`), badge);
    } else {
      status.textContent = `共 ${totalRows} 行`;
    }
  }

  const meta = (): CodeFileMeta => ({
    encoding: det.encoding,
    lang: 'json',
    size: buffer.length,
    lines: totalRows
  });

  // rows=0 守卫：全空行文件不进窗口循环（visibleRange 无行可窗口化），空状态即终态
  if (totalRows === 0) {
    refreshStatus();
    target.replaceChildren(status);
    return {
      destroy() {
        target.classList.remove('vv-jsonl');
        target.replaceChildren();
      },
      getMeta: meta
    };
  }

  // 滚动容器（.vv-jsonl-scroll）+ spacer/viewport 结构（virtualScroller 同构，
  // 可变高度版自建：offset 来自 HeightModel 前缀和而非 rows*lineHeight）
  const scroll = document.createElement('div');
  scroll.className = 'vv-jsonl-scroll';
  const spacer = document.createElement('div');
  spacer.className = 'vv-virtual-spacer'; // app.css 虚拟滚动惯例类（absolute top:0，按类名自动生效）
  const viewport = document.createElement('div');
  viewport.className = 'vv-virtual-viewport';
  scroll.replaceChildren(spacer, viewport);
  refreshStatus();
  target.replaceChildren(status, scroll);

  const model = new HeightModel();
  let curFirst = -1;
  let curLast = -1;
  let destroyed = false;
  let rafId: number | null = null;

  // 高亮三态：已缓存区间 / 在途行 / 在途 Promise（destroy 时统一 swallow，
  // 防 tab 切换 cancelAll 之后的 unhandled rejection）
  const highlightCache = new Map<number, HighlightInterval[]>();
  const pendingRows = new Set<number>();
  const inFlight = new Set<Promise<unknown>>();
  /** 已展开（点击过 .vv-jsonl-expand）的行：重渲染窗口时不回退折叠态 */
  const expandedRows = new Set<number>();

  /** 惰性解析：首次进入窗口才 JSON.parse；失败行即时入计数并刷新状态条 */
  function stateOf(i: number): JsonlLineState {
    let st = parseCache.get(i);
    if (st === undefined) {
      st = parseJsonlLine(lines[i] ?? '');
      parseCache.set(i, st);
      if (st.kind === 'failed') {
        failedCount += 1;
        refreshStatus();
      }
    }
    return st;
  }

  /**
   * 区间 → 可见行 HTML（复用 code.ts 管线）：intervals 相对 pretty 全文，行偏移表
   * 按可见切片构建——切片是全文前缀，前缀偏移与全文一致；折叠/封顶时落在切片总长
   * 之外的区间先过滤丢弃（renderLineHtml 的 end 夹紧只会把这类区间变成空 ts-* span，
   * 见下），切片内起点的区间越出末行行尾的部分仍由夹紧吸收。无缓存产出（未接
   * client / 在途 / 取消）返回 null，调用方回落纯文本转义。
   */
  function highlightedHtml(i: number, visibleLines: string[]): string | null {
    const intervals = highlightCache.get(i);
    if (intervals === undefined) return null;
    const offsets = buildLineOffsets(visibleLines);
    // 切片总长（末行起点 + 末行长）：起点越过它的区间在夹紧后产出空 ts-* span，丢弃
    const limit =
      (offsets[offsets.length - 1] ?? 0) + (visibleLines[visibleLines.length - 1]?.length ?? 0);
    const visible = intervals.filter((iv) => iv.start < limit);
    if (visible.length === 0) return null;
    const byLine = new Map(
      assignIntervalsToLines(visible, offsets).map((a) => [a.line, a.segs])
    );
    return visibleLines.map((l, k) => renderLineHtml(l, byLine.get(k))).join('\n');
  }

  /** 卡片级高亮请求（幂等）：结果到达后仅当卡片仍在窗口内才重绘 */
  function requestHighlight(i: number, pretty: string): void {
    if (pendingRows.has(i) || highlightCache.has(i)) return;
    const client = getHighlightClient();
    if (!client) return; // 未接线（App 未启动高亮/单测）：保持纯文本
    pendingRows.add(i);
    const p = client.highlight(pretty, 'json').then(
      (intervals) => {
        inFlight.delete(p);
        pendingRows.delete(i);
        if (destroyed) return;
        highlightCache.set(i, intervals);
        redrawCardIfVisible(i);
      },
      (err: unknown) => {
        inFlight.delete(p);
        pendingRows.delete(i);
        // 取消 ≠ 失败（code.ts 同语义）：静默不写 DOM；其余错误本卡保持纯文本，
        // 也不抛未处理 rejection（卡片级高亮是增强，不该以报错形态打扰），
        // 但 debug 留痕便于诊断
        if (destroyed || err instanceof HighlightCanceledError) return;
        console.debug('[jsonl] 卡片高亮失败，本卡保持纯文本', err);
      }
    );
    inFlight.add(p);
  }

  function redrawCardIfVisible(i: number): void {
    if (i < curFirst || i > curLast) return;
    const el = viewport.querySelector(`[data-line="${i}"]`);
    if (el) {
      el.replaceWith(buildCard(i));
      scheduleMeasure();
    }
  }

  /** 单卡构建：gutter(1 起行号) + pre body + 徽标/截断提示/展开按钮按状态挂载 */
  function buildCard(i: number): HTMLElement {
    const st = stateOf(i);
    const card = document.createElement('div');
    card.className = 'vv-jsonl-card';
    card.dataset.line = String(i); // e2e/重绘定位锚（0 基行号，与 data-line 惯例一致）
    const gutter = document.createElement('span');
    gutter.className = 'vv-jsonl-gutter';
    gutter.textContent = String(i + 1);
    const body = document.createElement('pre');
    body.className = 'vv-jsonl-body';
    card.append(gutter, body);

    if (st.kind === 'failed') {
      card.classList.add('vv-jsonl-card-failed');
      card.title = st.reason;
      body.textContent = st.raw;
      card.append(makeBadge('解析失败'));
      return card;
    }
    if (st.kind === 'oversize') {
      body.textContent = st.raw; // 64KB 预览（parse 层已截）
      card.append(makeBadge('行过大（>1MB）'));
      return card;
    }

    // ok 卡片：pretty 行数组切片（T1 口径：visibleLines 以「每行以换行符收尾」计，
    // 可能 = 真实行数 + 1；Array.slice 自动容忍越界，恰好全显）
    const realLines = st.pretty.split('\n');
    const c = collapseFor(st.prettyLines);
    const expanded = expandedRows.has(i);
    const visibleLines = expanded && !c.capped ? st.prettyLines : c.visibleLines;
    const slice = realLines.slice(0, visibleLines);
    const html = highlightedHtml(i, slice);
    if (html !== null) body.innerHTML = html;
    else {
      body.textContent = slice.join('\n');
      requestHighlight(i, st.pretty); // 高亮只发一次（pendingRows 幂等），到达后重绘
    }

    if (expanded && c.capped) {
      // 封顶展开：DOM 已 400 行封顶再挂卡片内滚动 + 截断提示（N = min(可见, 实际)，
      // 恰边界（visibleLines=真实+1）不虚报）
      const cap = document.createElement('div');
      cap.className = 'vv-jsonl-cap';
      cap.textContent = `已截断显示（${Math.min(visibleLines, realLines.length)} 行）`;
      card.append(cap);
      body.style.maxHeight = `${JSONL_CAPPED_BODY_MAX_HEIGHT}px`;
      body.style.overflowY = 'auto';
    }
    if (!expanded && st.prettyLines > JSONL_COLLAPSE_LINES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vv-jsonl-expand';
      btn.textContent = '展开全部';
      btn.addEventListener('click', () => {
        if (destroyed) return;
        expandedRows.add(i);
        redrawCardIfVisible(i); // 全量重渲染该卡片（简单化：不做渐进展开）
      });
      card.append(btn);
    }
    return card;
  }

  function makeBadge(text: string): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'vv-jsonl-badge';
    badge.textContent = text;
    return badge;
  }

  function renderCards(first: number, last: number): void {
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) frag.append(buildCard(i));
    viewport.replaceChildren(frag);
    scheduleMeasure();
  }

  /** 窗口循环：滚动/resize → visibleRange → 仅窗口内卡片重绘 + transform 定位 */
  function update(force = false): void {
    if (destroyed) return;
    const { first, last } = visibleRange(model, scroll.scrollTop, scroll.clientHeight, totalRows, OVERSCAN);
    if (!force && first === curFirst && last === curLast) return;
    curFirst = first;
    curLast = last;
    viewport.style.transform = `translateY(${model.offsetOf(first)}px)`;
    renderCards(first, last);
  }

  /**
   * 测量修正合并：rAF 一帧一次，批量 measure 后消费 dirty（T2 约定——公开 dirty
   * 由 DOM 适配层置回 false，内部前缀重建标记模型自清）。jsdom 无布局恒 0：跳过
   * 防 0 高污染模型（真实浏览器 offsetHeight 恒正）。
   */
  function scheduleMeasure(): void {
    if (rafId !== null || destroyed) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (destroyed) return;
      for (const el of viewport.children) {
        const h = (el as HTMLElement).offsetHeight;
        if (h > 0) model.measure(Number((el as HTMLElement).dataset.line), h);
      }
      if (model.dirty) {
        spacer.style.height = `${model.total(totalRows)}px`;
        viewport.style.transform = `translateY(${model.offsetOf(curFirst)}px)`;
        model.dirty = false;
      }
    });
  }

  const onScroll = (): void => update();
  scroll.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => update());
  ro.observe(scroll);

  spacer.style.height = `${model.total(totalRows)}px`;
  update(true);

  return {
    destroy() {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      ro.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      // 在途高亮统一 swallow（含 HighlightCanceledError）：tab 切换后 reject 落地
      // 不得成为 unhandled rejection（请求本身不发 cancel，靠 destroyed 拦回写）
      for (const p of inFlight) p.catch(() => {});
      inFlight.clear();
      pendingRows.clear();
      parseCache.clear();
      highlightCache.clear();
      expandedRows.clear();
      scroll.remove();
      target.classList.remove('vv-jsonl');
    },
    getMeta: meta
  };
}

export const jsonlRenderer: Renderer = {
  id: 'jsonl',
  label: 'JSON Lines',
  extensions: ['jsonl', 'ndjson'],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection) {
    if (shouldDelegateToCode(buffer.byteLength)) {
      // >200MB：JSONL 逐行解析/逐卡高亮的内存与主线程成本失控，委托 code 纯文本
      // 虚拟滚动（沿用其超限提示条与实例扩展；encoding/ext 透传保证非 UTF-8 解码
      // 一致与状态栏语言段正确）
      return renderCode(buffer, target, { encoding: det.encoding, ext: det.ext, highlight: false, oversizeNotice: true });
    }
    return renderJsonl(buffer, target, det);
  }
};
