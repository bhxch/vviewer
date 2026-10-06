import type { Renderer, Encoding, Detection, FileSource, RenderedInstance } from '@vviewer/core';
import { detectLanguage, HighlightCanceledError, captureToCssClass, type HighlightInterval } from '@vviewer/highlight';

export type { HighlightInterval };
/** hljs 动态导入的默认导出类型（HLJSApi） */
type HLJS = (typeof import('highlight.js'))['default'];
import { virtualScroller, type VirtualScrollerHandle } from './virtualScroller';

/** 降级链阈值：≤5MB tree-sitter；≤20MB hljs 按可视块；更大纯文本 */
export const TREE_SITTER_MAX_BYTES = 5 * 1024 * 1024;
export const HLJS_MAX_BYTES = 20 * 1024 * 1024;
export const LINE_HEIGHT = 20;

export type HighlightStrategy = 'tree-sitter' | 'hljs-block' | 'plain';

/** 降级链（按字节大小）：≤5MB tree-sitter（失败→hljs 整文件）；5–20MB hljs 分块；>20MB 纯文本 */
export function resolveStrategy(size: number): HighlightStrategy {
  if (size <= TREE_SITTER_MAX_BYTES) return 'tree-sitter';
  if (size <= HLJS_MAX_BYTES) return 'hljs-block';
  return 'plain';
}

const DECODERS: Record<Encoding, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030'
};

export function buildLineIndex(text: string): string[] {
  return text.split('\n');
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

/** 把 hljs 高亮 HTML 按行切分；跨行 span 在每行末尾全部闭合、下一行开头按原序重开 */
export function splitHighlightedLines(html: string, lineCount: number): string[] {
  const out: string[] = new Array(lineCount).fill('');
  const stack: string[] = []; // 打开的 <span ...> 标签
  const re = /<span [^>]*>|<\/span>|\n|[^<\n]+/g;
  let line = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tok = m[0] ?? '';
    if (tok === '\n') {
      out[line] = (out[line] ?? '') + stack.map(() => '</span>').join('');
      line += 1;
      if (line >= lineCount) break;
      out[line] = (out[line] ?? '') + stack.join('');
      continue;
    }
    if (tok === '</span>') {
      stack.pop();
      out[line] = (out[line] ?? '') + tok;
      continue;
    }
    if (tok.startsWith('<span')) {
      stack.push(tok);
      out[line] = (out[line] ?? '') + tok;
      continue;
    }
    out[line] = (out[line] ?? '') + tok;
  }
  return out;
}

/** 行内片段：相对行首的 UTF-16 偏移，左闭右开 */
export interface LineSeg {
  start: number;
  end: number;
  capture: string;
}

/** 单行分配结果：line 为行号，segs 按起点升序且互不重叠 */
export interface LineAssignment {
  line: number;
  segs: LineSeg[];
}

/** 二分：最大的 l 使 lineOffsets[l] <= pos */
function lineOf(lineOffsets: number[], pos: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lineOffsets[mid] ?? 0) <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 候选中更"内"的 tie 裁决：区间更短者优先（更局部的捕获更具体），再按 capture 字典序保证确定性 */
function innerTie(a: HighlightInterval, b: HighlightInterval): boolean {
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la !== lb) return la < lb;
  return a.capture < b.capture;
}

/** 原子段内最内层 capture：被 active 中其他区间包含数（嵌套深度）最大者优先 */
function innermostOf(active: readonly HighlightInterval[]): HighlightInterval {
  let best = active[0]!;
  let bestDepth = -1;
  for (const iv of active) {
    let depth = 0;
    for (const other of active) {
      if (other.start <= iv.start && iv.end <= other.end) depth++;
    }
    if (depth > bestDepth || (depth === bestDepth && innerTie(iv, best))) {
      best = iv;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * 嵌套区间展平为互不重叠的"内层优先"区间（纯函数）：
 * 扫描线在全部区间端点处切成原子段，每段取覆盖它的区间中最内层者。
 * 与 helix/neovim 的内层优先惯例一致——injection（markdown 代码块、rust 转义序列、
 * html script 内嵌 js）的内层样式不被外层 capture 罩住；内层之间的间隙回落外层。
 * 输出按 start 升序，相邻同 capture 段已合并。
 */
export function flattenIntervals(intervals: HighlightInterval[]): HighlightInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || b.end - a.end);
  const bounds = new Set<number>();
  for (const iv of sorted) {
    if (iv.end > iv.start) {
      bounds.add(iv.start);
      bounds.add(iv.end);
    }
  }
  const points = [...bounds].sort((a, b) => a - b);
  const active: HighlightInterval[] = [];
  const out: HighlightInterval[] = [];
  let ptr = 0;
  for (let bi = 0; bi < points.length; bi++) {
    const pos = points[bi]!;
    const next = bi + 1 < points.length ? points[bi + 1]! : pos;
    for (let j = active.length - 1; j >= 0; j--) {
      if (active[j]!.end <= pos) active.splice(j, 1);
    }
    while (ptr < sorted.length && sorted[ptr]!.start <= pos) {
      const iv = sorted[ptr]!;
      if (iv.end > pos) active.push(iv);
      ptr++;
    }
    if (next === pos || active.length === 0) continue;
    const pick = innermostOf(active);
    const last = out[out.length - 1];
    if (last && last.capture === pick.capture && last.end === pos) last.end = next;
    else out.push({ start: pos, end: next, capture: pick.capture });
  }
  return out;
}

/**
 * 区间 → 行分配（纯函数）：先 flattenIntervals 内层优先展平（互不重叠、start 升序），
 * 再逐段切到行。输出的 segs 相对行首（便于直接 slice 行文本）且互不重叠、起点升序。
 */
export function assignIntervalsToLines(
  intervals: HighlightInterval[],
  lineOffsets: number[]
): LineAssignment[] {
  if (intervals.length === 0 || lineOffsets.length === 0) return [];
  const flat = flattenIntervals(intervals);
  const byLine = new Map<number, LineSeg[]>();
  let covered = 0; // 防御：flat 理论上互不重叠
  for (const iv of flat) {
    if (iv.end <= iv.start || iv.end <= covered) continue;
    const from = Math.max(iv.start, covered);
    covered = iv.end;
    const firstLine = lineOf(lineOffsets, from);
    const lastLine = lineOf(lineOffsets, iv.end - 1);
    for (let l = firstLine; l <= lastLine; l++) {
      const lineStart = lineOffsets[l] ?? 0;
      // 行内容终点：下一行起点 -1（去掉换行符）；最后一行为无穷
      const lineEnd = l + 1 < lineOffsets.length ? (lineOffsets[l + 1] ?? 0) - 1 : Infinity;
      const segStart = Math.max(from, lineStart) - lineStart;
      const segEnd = Math.min(iv.end, lineEnd) - lineStart;
      if (segEnd <= segStart) continue;
      let segs = byLine.get(l);
      if (!segs) {
        segs = [];
        byLine.set(l, segs);
      }
      segs.push({ start: segStart, end: segEnd, capture: iv.capture });
    }
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, segs]) => ({ line, segs }));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 行文本 + 段落 → 转义后的行 HTML（段落包 `<span class="ts-<capture>">`，纯函数可测）。
 * 类名转义统一来自 @vviewer/highlight 的 captureToCssClass（与主题 CSS 变量同一唯一来源） */
export function renderLineHtml(text: string, segs: readonly LineSeg[] | undefined): string {
  if (!segs || segs.length === 0) return escapeHtml(text);
  let out = '';
  let pos = 0;
  for (const seg of segs) {
    const start = Math.min(seg.start, text.length);
    const end = Math.min(seg.end, text.length);
    if (end <= pos) continue;
    if (start > pos) out += escapeHtml(text.slice(pos, start));
    out += `<span class="ts-${captureToCssClass(seg.capture)}">${escapeHtml(text.slice(Math.max(start, pos), end))}</span>`;
    pos = end;
  }
  if (pos < text.length) out += escapeHtml(text.slice(pos));
  return out;
}

/** tree-sitter 高亮客户端最小接口（HighlightClient 结构兼容；测试可注 fake） */
export interface CodeHighlightClient {
  highlight(text: string, lang: string): Promise<HighlightInterval[]>;
}

let attachedClient: CodeHighlightClient | null = null;

/** 应用侧注入 HighlightClient 单例（apps/web 启动时调用；传 null 解绑） */
export function attachHighlightClient(client: CodeHighlightClient | null): void {
  attachedClient = client;
}

// 样式说明：虚拟滚动与代码面板的样式统一由 apps/web/src/app.css 提供（单一来源），
// 本模块不再运行时注入 CSS，避免双份定义漂移。

export interface RenderCodeHandle {
  destroy(): void;
  setScrollTop(top: number): void;
  scrollTop(): number;
  /** 内部滚动容器（.vv-code-pre）：code tab 的滚动持久化接这里而非外层容器 */
  getScrollHost(): HTMLElement;
}

export function renderCode(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: { encoding?: Encoding; highlight?: boolean; ext?: string; lang?: string } = {}
): RenderCodeHandle {
  const enc = DECODERS[opts.encoding ?? 'utf-8'];
  const text = new TextDecoder(enc, { fatal: false }).decode(buffer);
  const lines = buildLineIndex(text);
  const lineOffsets = buildLineOffsets(lines);
  const strategy = opts.highlight === false ? 'plain' : resolveStrategy(buffer.byteLength);
  target.classList.add('vv-code');
  const pre = document.createElement('div');
  pre.className = 'vv-code-pre'; // 即 virtualScroller 的滚动容器
  target.replaceChildren(pre);
  let hlLines: string[] | null = null; // hljs 整文件路径的行 HTML
  let lineSegs: Map<number, LineSeg[]> | null = null; // tree-sitter 路径的行段落
  const blockCache = new Map<number, string>(); // hljs-block 路径：行号 → 行 HTML
  let hljs: HLJS | null = null;
  let hljsLang: string | null = null;
  let scroller: VirtualScrollerHandle | null = null;
  let destroyed = false;

  function fillRows(first: number, last: number, viewport: HTMLElement): void {
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const row = document.createElement('div');
      row.className = 'vv-code-line';
      row.style.height = `${LINE_HEIGHT}px`;
      const gutter = document.createElement('span');
      gutter.className = 'vv-code-gutter';
      gutter.textContent = String(i + 1);
      const body = document.createElement('span');
      body.className = 'vv-code-body';
      const segs = lineSegs?.get(i);
      const cached = blockCache.get(i);
      if (segs) body.innerHTML = renderLineHtml(lines[i] ?? '', segs);
      else if (cached !== undefined) body.innerHTML = cached;
      else if (hlLines) body.innerHTML = hlLines[i] ?? '';
      else body.textContent = lines[i] ?? '';
      row.append(gutter, body);
      frag.append(row);
    }
    viewport.replaceChildren(frag);
  }

  /** hljs-block 路径：可见范围整段高亮一次并入缓存（可见行段的滚动按需计算） */
  function fillBlockCache(first: number, last: number): void {
    if (!hljs) return;
    for (let i = first; i <= last; i++) {
      if (blockCache.has(i)) continue;
      const chunk = lines.slice(first, last + 1).join('\n');
      const value = hljsLang
        ? hljs.highlight(chunk, { language: hljsLang, ignoreIllegals: true }).value
        : hljs.highlightAuto(chunk).value;
      const parts = splitHighlightedLines(value, last - first + 1);
      for (let k = 0; k < parts.length; k++) blockCache.set(first + k, parts[k] ?? '');
      return; // 一次处理整个可见范围
    }
  }

  function mount(): void {
    if (scroller || destroyed) return;
    scroller = virtualScroller(pre, lines.length, LINE_HEIGHT, (first, last, viewport) => {
      if (strategy === 'hljs-block') fillBlockCache(first, last);
      fillRows(first, last, viewport);
    });
  }

  /** hljs 整文件兜底（M1 路径）：tree-sitter 不可用/失败时使用（仅 ≤5MB 会被调度到此） */
  async function hljsWholeFile(): Promise<void> {
    hljs ??= (await import('highlight.js')).default;
    if (destroyed) return;
    const { value } = hljs.highlightAuto(text);
    if (destroyed) return;
    hlLines = splitHighlightedLines(value, lines.length);
    scroller?.refresh(true);
  }

  async function start(): Promise<void> {
    const lang = opts.lang ?? (opts.ext ? detectLanguage(opts.ext, text) : null);
    if (strategy === 'hljs-block') {
      hljs = (await import('highlight.js')).default;
      if (destroyed) return;
      hljsLang = lang !== null && hljs.getLanguage(lang) ? lang : null;
      mount(); // onRange 内按可视块同步高亮
      return;
    }
    if (strategy === 'tree-sitter') {
      mount(); // 先渲染纯文本立即可见，区间到达后刷新
      const client = attachedClient;
      if (!client || lang === null) {
        await hljsWholeFile();
        return;
      }
      try {
        const intervals = await client.highlight(text, lang);
        if (destroyed) return;
        lineSegs = new Map(assignIntervalsToLines(intervals, lineOffsets).map((a) => [a.line, a.segs]));
        scroller?.refresh(true);
      } catch (err) {
        if (destroyed || err instanceof HighlightCanceledError) return; // tab 已切换：静默
        await hljsWholeFile(); // 解析失败 → hljs 整文件兜底
      }
      return;
    }
    mount(); // plain
  }

  void start();
  return {
    destroy() {
      destroyed = true;
      scroller?.destroy();
      scroller = null;
      blockCache.clear();
      pre.remove();
    },
    setScrollTop(top) {
      pre.scrollTop = top;
    },
    scrollTop() {
      return pre.scrollTop;
    },
    getScrollHost() {
      return pre;
    }
  };
}

export const codeRenderer: Renderer = {
  id: 'code',
  label: '代码/文本',
  // 注：不含 'svg'——svg 归 @vviewer/render-media 的 imageRenderer（消毒预览），registry 拒绝重复注册
  extensions: [
    'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'csv',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'sh', 'bash', 'zsh', 'fish', 'sql',
    'lua', 'php', 'pl', 'swift', 'dart', 'vue', 'svelte', 'gradle', 'cmake', 'properties', 'gitignore',
    'license', 'makefile', 'diff', 'patch'
  ],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection) {
    void source;
    const inst = renderCode(buffer, target, { encoding: det.encoding, highlight: true, ext: det.ext });
    // getScrollHost 供 ViewerPane 把滚动持久化接进 .vv-code-pre（结构化扩展 RenderedInstance，不动 core）
    const instance: RenderedInstance & { getScrollHost(): HTMLElement } = {
      destroy() {
        inst.destroy();
      },
      getScrollHost() {
        return inst.getScrollHost();
      }
    };
    return instance;
  }
};
