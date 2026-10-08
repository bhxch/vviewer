import type { Renderer, Encoding, Detection, FileSource, RenderedInstance, SearchMatch, ComputeSource, ComputeWhere } from '@vviewer/core';
import { getRemoteBase, getRemoteMeta, RemoteComputeError, showErrorCard } from '@vviewer/core';
import { detectLanguage, HighlightCanceledError, captureToCssClass, type HighlightInterval } from '@vviewer/highlight';

export type { HighlightInterval };
/** hljs 动态导入的默认导出类型（HLJSApi） */
type HLJS = (typeof import('highlight.js'))['default'];
import { virtualScroller, type VirtualScrollerHandle } from './virtualScroller';
import { searchCode } from './search';

/**
 * hljs 别名桥接：helix 语言名 → hljs 语言 id（仅收录 hljs.getLanguage 直查失败的键；
 * sh/shell/zsh/golang/rb/md/yml/c++ 等 hljs 自带别名已直查命中，不在此列）。
 * 目标 id 全部经 hljs.getLanguage 实测命中；hljs 无对应语言的键（zig/wgsl 等）不收录，
 * 回落 highlightAuto。
 */
export const HLJS_ALIASES: Readonly<Record<string, string>> = {
  'c-sharp': 'csharp',
  'objective-c': 'objectivec',
  'fish': 'bash', // fish 语法近似 POSIX shell
  'htmldjango': 'django',
  'ocaml-interface': 'ocaml',
  'textproto': 'protobuf',
  'docker-compose': 'yaml', // compose 文件即 YAML 语法
  'vue': 'xml', // SFC 模板为 XML 形态（hljs 11 无 vue 语言）
  'svelte': 'html',
  'astro': 'html',
  'markdown.inline': 'markdown',
  'markdown-rustdoc': 'markdown',
  'common-lisp': 'lisp',
  'elisp': 'lisp',
  'fennel': 'lisp',
  'racket': 'scheme',
  'purescript': 'haskell',
  'env': 'ini',
  'gdscript': 'python',
  'starlark': 'python', // starlark 为 Python 方言
  'gomod': 'go',
  'gotmpl': 'jinja' // 模板语法近似
};

/**
 * helix 语言名 → hljs 可用语言 id：直查命中原样返回，否则查桥接表；
 * 都无返回 null（调用方回落 highlightAuto）。
 */
export function resolveHljsLang(hljs: HLJS, lang: string | null): string | null {
  if (lang === null) return null;
  if (hljs.getLanguage(lang)) return lang;
  const mapped = HLJS_ALIASES[lang];
  return mapped !== undefined && hljs.getLanguage(mapped) ? mapped : null;
}

/** 降级链阈值：≤2MB tree-sitter；≤20MB hljs 按可视块；更大纯文本。
 * tree-sitter 阈值 2MB 的依据：实测 ~2.1-2.4s/MB，2MB≈4-5s，与移动端预算同量级；
 * 据 spec 5.11 预算校准，worker 取消传播落地后可再上调。 */
export const TREE_SITTER_MAX_BYTES = 2 * 1024 * 1024;
export const HLJS_MAX_BYTES = 20 * 1024 * 1024;
/** markdown/html 富文本渲染输入上限（与 hljs 阈值同源 20MB）：净化与 DOM 遍历
 * 管线无分块，超大输入会长时间阻塞主线程；超限跳过富文本管线，降级为代码/纯
 * 文本视图（renderDegradedCode）。 */
export const MARKUP_MAX_BYTES = 20 * 1024 * 1024;
export const LINE_HEIGHT = 20;

export type HighlightStrategy = 'tree-sitter' | 'hljs-block' | 'plain';

/** 降级链（按字节大小）：≤2MB tree-sitter（失败→hljs 整文件）；2–20MB hljs 分块；>20MB 纯文本 */
export function resolveStrategy(size: number): HighlightStrategy {
  if (size <= TREE_SITTER_MAX_BYTES) return 'tree-sitter';
  if (size <= HLJS_MAX_BYTES) return 'hljs-block';
  return 'plain';
}

/** Encoding → TextDecoder 标签（code/markdown/html 渲染器共用；导出避免重复表） */
export const DECODERS: Record<Encoding, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030'
};

/** hljs 分块缓存行数上限：超出最早淘汰（被逐出的行滚动回来时按需重算） */
export const BLOCK_CACHE_MAX_ROWS = 5000;

/** Map 插入序淘汰：把 m 裁到 ≤max 条（最早写入的先删） */
export function evictOldestEntries<K, V>(m: Map<K, V>, max: number): void {
  let excess = m.size - max;
  while (excess-- > 0) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    m.delete(oldest.value);
  }
}

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

/** 行 HTML 文本段的已知实体（renderLineHtml 与 hljs 的 escapeHTML 均只转 & < >） */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt);/g, (s) => (s === '&amp;' ? '&' : s === '&lt;' ? '<' : '>'));
}

/**
 * 把搜索命中区间叠加到行 HTML 上（BUG-18 词级高亮，纯函数）：
 * 命中段包 `<mark class="vv-search-hit">`（不套语法 span，样式以 mark 为主），
 * 非命中段保持原 HTML 语义——span 在命中边界处闭合、命中后按原序重开
 * （与 splitHighlightedLines 的跨行重开同一惯例）。
 * baseHtml 必须只含 <span …> 标签与已转义文本（renderLineHtml/hljs 输出均满足）；
 * 文本实体（&amp;/&lt;/&gt;）解码后按显示字符切分，输出统一重新转义。
 * hits 须按 start 升序且互不重叠（searchCode 产出保证）。
 */
export function overlaySearchHits(
  html: string,
  hits: ReadonlyArray<{ start: number; end: number }>
): string {
  if (hits.length === 0) return html;
  const tokenRe = /<[^>]+>|[^<]+/g;
  const out: string[] = [];
  const stack: string[] = []; // 打开的 <span …> 原文（命中处临时闭合、之后按序重开）
  let inMark = false;
  let pos = 0; // 已消费的显示字符数（UTF-16）
  let hitIdx = 0;
  const inHit = (g: number): boolean => {
    while (hitIdx < hits.length && hits[hitIdx]!.end <= g) hitIdx++;
    const h = hits[hitIdx];
    return h !== undefined && h.start <= g && g < h.end;
  };
  const closeSpans = (): void => {
    if (stack.length > 0) out.push('</span>'.repeat(stack.length));
  };
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const tok = m[0]!;
    if (tok.startsWith('<')) {
      if (tok.startsWith('</span')) stack.pop();
      else if (tok.startsWith('<span')) stack.push(tok);
      out.push(tok); // 非约定标签不预期出现，原样透传
      continue;
    }
    const text = decodeHtmlEntities(tok);
    let tPos = 0;
    while (tPos < text.length) {
      const hit = inHit(pos + tPos);
      let len = 1;
      while (tPos + len < text.length && inHit(pos + tPos + len) === hit) len++;
      if (hit && !inMark) {
        closeSpans();
        out.push('<mark class="vv-search-hit">');
        inMark = true;
      } else if (!hit && inMark) {
        out.push('</mark>');
        inMark = false;
        for (const tag of stack) out.push(tag);
      }
      out.push(escapeHtml(text.slice(tPos, tPos + len)));
      tPos += len;
    }
    pos += text.length;
  }
  if (inMark) {
    out.push('</mark>');
    for (const tag of stack) out.push(tag);
  }
  return out.join('');
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

/** 单次高亮调用的路由上下文（M6 compute 路由；不参与渲染结果本身） */
export interface HighlightCallContext {
  /** 计算来源：远程 store 的文件带服务端 path（auto 策略据此走远程），本地文件缺省 */
  src?: ComputeSource;
  /** 执行位置回调：路由结果（local/remote）到达后调用（状态栏执行位置指示） */
  onWhere?: (where: ComputeWhere) => void;
}

/** tree-sitter 高亮客户端最小接口（HighlightClient 结构兼容；测试可注 fake） */
export interface CodeHighlightClient {
  highlight(text: string, lang: string, ctx?: HighlightCallContext): Promise<HighlightInterval[]>;
}

let attachedClient: CodeHighlightClient | null = null;

/** 应用侧注入 HighlightClient 单例（apps/web 启动时调用；传 null 解绑） */
export function attachHighlightClient(client: CodeHighlightClient | null): void {
  attachedClient = client;
}

/** 读取已注入的高亮客户端单例（markdownRenderer 的围栏高亮复用同一注入，无需二次接线） */
export function getHighlightClient(): CodeHighlightClient | null {
  return attachedClient;
}

/**
 * 大文件远程高亮路由（BUG-10）：>2MB 文件在显式 remote 策略下改走远程 intervals。
 * 契约：非 null = 远程高亮区间（按 tree-sitter 路径渲染，执行位置 remote）；
 * null = 留在本地 hljs 分块（注入侧硬护栏：auto/local 策略恒 null——3MB 文件在
 * auto 下不产生 POST，维持本地默认体验）；抛错 = 显式 remote 失败（渲染端错误
 * 卡片，不静默回退，与 tree-sitter 分支的 RemoteComputeError 同语义）。
 */
export type HighlightRouterFn = (
  src: ComputeSource,
  lang: string
) => Promise<HighlightInterval[] | null>;

let attachedRouter: HighlightRouterFn | null = null;

/** 应用侧注入大文件路由回调（apps/web 启动时调用；传 null 解绑） */
export function attachHighlightRouter(fn: HighlightRouterFn | null): void {
  attachedRouter = fn;
}

// 样式说明：虚拟滚动与代码面板的样式统一由 apps/web/src/app.css 提供（单一来源），
// 本模块不再运行时注入 CSS，避免双份定义漂移。

/** 代码高亮引擎实时值：pending = tree-sitter 主路径已启动但结果未到达（或已取消） */
export type CodeEngine = 'tree-sitter' | 'hljs' | 'hljs-block' | 'plain' | 'pending';

/** 渲染实例元数据快照（BUG-04：状态栏/属性面板单一来源） */
export interface CodeFileMeta {
  encoding?: Encoding;
  lang?: string | null;
  size: number;
  /** 内容行数（与 wc -l 同口径）：以 \n 结尾的 301 行文件报 301，非 split 产物的 302 */
  lines: number;
}

export interface RenderCodeHandle {
  destroy(): void;
  setScrollTop(top: number): void;
  scrollTop(): number;
  /** 内部滚动容器（.vv-code-pre）：code tab 的滚动持久化接这里而非外层容器 */
  getScrollHost(): HTMLElement;
  /** 当前生效的高亮引擎（实时；状态栏指示器用） */
  getEngine(): CodeEngine;
  /** 高亮计算执行位置（M6：'local'|'remote'；null = 未发生计算路由，如纯文本）。状态栏指示器用 */
  getComputeWhere(): ComputeWhere | null;
  /** 元数据快照（BUG-04）：编码/语言/大小/内容行数（渲染期静态值） */
  getMeta(): CodeFileMeta;
  /** 文件内搜索：行数组扫描（缓存 query×caseSensitive），空 query 返回 []（退出搜索语义） */
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
  /** 跳到第 index 个命中：滚动到该行 + 行级临时高亮（1.5s 或直到下一次跳转） */
  gotoMatch(index: number): void;
  /** 跳到指定行（0 起）并滚动至视口中部 + 行级临时高亮（BUG-09 全局搜索跳转；独立于搜索结果） */
  revealLine(line: number, col?: number): void;
}

export function renderCode(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: {
    encoding?: Encoding;
    highlight?: boolean;
    ext?: string;
    lang?: string;
    computeSrc?: ComputeSource;
    /** >20MB 纯文本降级的超限提示条开关（BUG-20）；缺省跟随 highlight。
     * renderDegradedCode 传 false：降级卡已存在，不重复提示。 */
    oversizeNotice?: boolean;
  } = {}
): RenderCodeHandle {
  const enc = DECODERS[opts.encoding ?? 'utf-8'];
  // CRLF/CR → LF 归一化：行索引（buildLineIndex/lineOffsets）、高亮区间偏移、搜索
  // 全部在归一化文本上计算——解码后、一切索引前做一次，保证偏移一致性（否则
  // \r 计入前一行长度，区间错位一行；tree-sitter/hljs 的输出同样按归一化文本对齐）
  const text = new TextDecoder(enc, { fatal: false }).decode(buffer).replace(/\r\n?/g, '\n');
  const lines = buildLineIndex(text);
  const lineOffsets = buildLineOffsets(lines);
  // 实际生效的高亮语言（与 start() 同一表达式、同步可预算）：getMeta 的 lang 取此
  // 单源——本地扩展名文件（无服务端 x-vv-lang、det.lang 为空）按 detectLanguage
  // 高亮后，状态栏/属性面板的语言段与实际引擎一致（评审③）
  const lang = opts.lang ?? (opts.ext ? detectLanguage(opts.ext, text) : null);
  const strategy = opts.highlight === false ? 'plain' : resolveStrategy(buffer.byteLength);
  target.classList.add('vv-code');
  const pre = document.createElement('div');
  pre.className = 'vv-code-pre'; // 即 virtualScroller 的滚动容器
  // BUG-20：>20MB 纯文本虚拟滚动无语法高亮，顶部插一次性提示条（不阻断滚动/搜索）。
  // 提示条是 pre 的兄弟节点而非子节点——virtualScroller 会 replaceChildren 滚动容器，
  // 提示条放里面会被清掉且 spacer 定位被顶偏。
  if (
    strategy === 'plain' &&
    (opts.oversizeNotice ?? opts.highlight !== false) &&
    buffer.byteLength > HLJS_MAX_BYTES
  ) {
    const bar = document.createElement('div');
    bar.className = 'vv-error-card vv-oversize-card vv-code-oversize-card';
    const title = document.createElement('div');
    title.className = 'vv-error-title';
    title.textContent = `文件超过 ${HLJS_MAX_BYTES / 1024 / 1024}MB，已按纯文本虚拟滚动显示（不做语法高亮）`;
    bar.append(title);
    target.classList.add('vv-code-oversize');
    target.replaceChildren(bar, pre);
  } else {
    target.replaceChildren(pre);
  }
  let hlLines: string[] | null = null; // hljs 整文件路径的行 HTML
  let lineSegs: Map<number, LineSeg[]> | null = null; // tree-sitter 路径的行段落
  const blockCache = new Map<number, string>(); // hljs-block 路径：行号 → 行 HTML
  let hljs: HLJS | null = null;
  let hljsLang: string | null = null;
  let scroller: VirtualScrollerHandle | null = null;
  let destroyed = false;
  // 引擎实时值：tree-sitter 主路径在区间到达前为 pending；hljs-block/plain 策略即终值
  let engine: CodeEngine = strategy === 'tree-sitter' ? 'pending' : strategy;
  // 高亮计算执行位置（M6）：null = 未发生计算路由（纯文本）；tree-sitter 主路径
  // 等路由结果回填；hljs-block/hljs 兜底是本地引擎，置 'local'。状态栏指示读这里。
  let computeWhere: ComputeWhere | null = strategy === 'hljs-block' ? 'local' : null;
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

  function fillRows(first: number, last: number, viewport: HTMLElement): void {
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const row = document.createElement('div');
      row.className = 'vv-code-line';
      row.style.height = `${LINE_HEIGHT}px`;
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
      const segs = lineSegs?.get(i);
      const cached = blockCache.get(i);
      if (hits !== undefined) {
        // BUG-18 词级 mark：命中段包 mark（overlaySearchHits 内语法 span 在命中
        // 边界闭合/重开），非命中段保持原语法高亮 HTML
        const baseHtml = segs
          ? renderLineHtml(lines[i] ?? '', segs)
          : cached !== undefined
            ? cached
            : hlLines
              ? (hlLines[i] ?? '')
              : escapeHtml(lines[i] ?? '');
        body.innerHTML = overlaySearchHits(baseHtml, hits);
      } else if (segs) body.innerHTML = renderLineHtml(lines[i] ?? '', segs);
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
      evictOldestEntries(blockCache, BLOCK_CACHE_MAX_ROWS); // 超上限淘汰最早条目（滚动按需重算）
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

/** hljs 整文件兜底（M1 路径）：tree-sitter 不可用/失败时使用（仅 ≤2MB 会被调度到此） */
  async function hljsWholeFile(lang: string | null): Promise<void> {
    hljs ??= (await import('highlight.js')).default;
    if (destroyed) return;
    const language = resolveHljsLang(hljs, lang); // 别名桥接（如 c-sharp→csharp）；查不到回落 auto
    let value: string;
    try {
      value = language
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
    } catch {
      value = hljs.highlightAuto(text).value; // 指定语言高亮异常（罕见）仍兜住
    }
    if (destroyed) return;
    engine = 'hljs';
    computeWhere = 'local'; // hljs 兜底是本地引擎：执行位置随之回本地
    hlLines = splitHighlightedLines(value, lines.length);
    scroller?.refresh(true);
  }

  async function start(): Promise<void> {
    if (strategy === 'hljs-block') {
      mount(); // 先渲染纯文本立即可见；hljs 到位（或远程区间到达）后 refresh 重绘
      // BUG-10：显式 remote 策略下 >2MB 文件也问路由。仅当注入了 router 且有服务端
      // path 与可识别语言时发起；**auto 策略在注入侧（apps/web highlightRouter）被
      // 硬护栏拦为 null——3MB 文件在 auto 下保持本地 hljs 分块、零 POST**（避免远程
      // 大文件拖慢默认体验的既定裁决，勿改为渲染端问路由）。
      const router = attachedRouter;
      if (router && lang !== null && opts.computeSrc?.path) {
        engine = 'pending';
        computeWhere = null;
        try {
          const intervals = await router(opts.computeSrc, lang);
          if (destroyed) return;
          if (intervals !== null) {
            // 远程区间：按 tree-sitter 路径渲染，执行位置如实标 remote
            engine = 'tree-sitter';
            computeWhere = 'remote';
            lineSegs = new Map(assignIntervalsToLines(intervals, lineOffsets).map((a) => [a.line, a.segs]));
            scroller?.refresh(true);
            return;
          }
        } catch (err) {
          if (destroyed || err instanceof HighlightCanceledError) return; // tab 已切换：静默
          // 显式 remote 失败：如实错误卡片，不静默降级本地分块（掩盖服务端故障）。
          // engine 置非 pending 终值：错误卡片已替换内容，状态栏不得停留「解析中…」
          //（'plain' = 无高亮引擎产出，最贴近错误卡片视图的终值）
          engine = 'plain';
          computeWhere = null;
          showErrorCard(target, err instanceof Error ? err.message : String(err), {
            name: opts.ext ? `.${opts.ext}` : '代码'
          });
          return;
        }
        engine = 'hljs-block'; // router 返回 null：留在本地 hljs 分块
        computeWhere = 'local';
      }
      hljs = (await import('highlight.js')).default;
      if (destroyed) return;
      hljsLang = resolveHljsLang(hljs, lang); // 别名桥接；null → 可视块 highlightAuto
      scroller?.refresh(true); // mount 已渲染纯文本，hljs 到位后重绘带高亮
      return;
    }
    if (strategy === 'tree-sitter') {
      mount(); // 先渲染纯文本立即可见，区间到达后刷新
      const client = attachedClient;
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
      scroller?.destroy();
      scroller = null;
      blockCache.clear();
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
    // BUG-04：渲染期静态的元数据快照。lines 为内容行数口径：buildLineIndex 对以
    // \n 结尾的文本产出末尾空串元素（301 行 → 302 元素），末元素为空时减 1，
    // 与 wc -l 一致（空文件 '' → [''] → 0 行）
    getMeta() {
      const lastLine = lines[lines.length - 1] ?? '';
      return {
        encoding: opts.encoding ?? 'utf-8',
        lang, // 与 start() 实际高亮语言同源（评审③：本地 .js 也显示「语言: javascript」）
        size: buffer.byteLength,
        lines: lastLine === '' ? lines.length - 1 : lines.length
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
      if (query === '') {
        clearHit(); // 空查询 = 退出搜索：active 与全部行级背景立即消退
      } else {
        // 新查询：旧 hitLine 的行号不再可靠，重置后重绘使已渲染行立即带上
        // 词级 mark 与命中行背景（虚拟滚动重绘由 searchState 驱动，天然保持）
        if (hitTimer !== null) {
          clearTimeout(hitTimer);
          hitTimer = null;
        }
        hitLine = -1;
      }
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
    }
  };

  /** 跳转共用体：目标行滚至视口中部 + 行级临时高亮（1.5s 或直到下一次跳转） */
  function jumpToLine(line: number): void {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitLine = line;
    // 目标行滚到视口中部（clientHeight 为 0（jsdom/未布局）时回落贴顶）
    const center = line * LINE_HEIGHT - pre.clientHeight / 2 + LINE_HEIGHT / 2;
    pre.scrollTop = Math.max(0, center);
    scroller?.refresh(); // 按新 scrollTop 重算可视范围（范围未变则行 DOM 已在，applyHitClass 兜底）
    applyHitClass();
    hitTimer = setTimeout(() => {
      hitTimer = null;
      clearHit();
    }, 1500);
  }
}

export const codeRenderer: Renderer = {
  id: 'code',
  label: '代码/文本',
  // 注 1：不含 'svg'——svg 归 @vviewer/render-media 的 imageRenderer（消毒预览），registry 拒绝重复注册
  // 注 2：不含 'md'/'markdown'/'html'/'htm'——M3 起归 markdownRenderer/htmlRenderer（M1-M2 期间暂由 code 承接）
  extensions: [
    'txt', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'csv',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'xml',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'sh', 'bash', 'zsh', 'fish', 'sql',
    'lua', 'php', 'pl', 'swift', 'dart', 'vue', 'svelte', 'gradle', 'cmake', 'properties', 'gitignore',
    'license', 'makefile', 'diff', 'patch'
  ],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection) {
    // 远端文件（M5 RemoteStore）的服务端检测头纠偏：X-VV-Lang/X-VV-Encoding
    // 与 languages.json 同源，比本地扩展名表/编码启发式更准（无扩展名脚本等）。
    // opts.lang 有值时 renderCode 直接采用、跳过 detectLanguage；服务端无检测头时
    // 回落 det.lang（dispatcher 的 extless 回退链写入的 shebang 语言，握手点 1）。
    const meta = getRemoteMeta(source.storeId, source.path);
    // M6 compute 路由：只有远程 store 的文件带服务端 path（auto 策略据此走远程高亮）
    const computeSrc: ComputeSource | undefined =
      getRemoteBase(source.storeId) !== undefined ? { path: source.path, storeId: source.storeId } : undefined;
    const inst = renderCode(buffer, target, {
      encoding: meta?.encoding ?? det.encoding,
      highlight: true,
      ext: det.ext,
      lang: meta?.lang ?? det.lang ?? undefined,
      computeSrc
    });
    // getScrollHost/getEngine 供 ViewerPane 接滚动持久化与引擎指示器；
    // getComputeWhere 供状态栏执行位置指示（M6）；search/gotoMatch 供 SearchPanel（Task 6）；
    // getMeta 供状态栏/属性面板元数据（BUG-04）；revealLine 供全局搜索跳转（BUG-09）。
    // 结构化扩展 RenderedInstance（Omit 去旧 search 签名避免交叉双签名冲突），不动 core。
    const instance: Omit<RenderedInstance, 'search'> & {
      getScrollHost(): HTMLElement;
      getEngine(): CodeEngine;
      getComputeWhere(): ComputeWhere | null;
      getMeta(): CodeFileMeta;
      search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
      gotoMatch(index: number): void;
      revealLine(line: number, col?: number): void;
    } = {
      destroy() {
        inst.destroy();
      },
      getScrollHost() {
        return inst.getScrollHost();
      },
      getEngine() {
        return inst.getEngine();
      },
      getComputeWhere() {
        return inst.getComputeWhere();
      },
      getMeta() {
        return inst.getMeta();
      },
      search(query, opts) {
        return inst.search(query, opts);
      },
      gotoMatch(index) {
        inst.gotoMatch(index);
      },
      revealLine(line, col) {
        inst.revealLine(line, col);
      }
    };
    return instance;
  }
};

// ---------- 超大输入降级（markdown/html 富文本渲染器共用） ----------

/**
 * 超大文件降级视图：提示卡 + 代码视图纵向排布，替代富文本渲染管线。
 * markdown/html 的净化/DOM 遍历管线对超大输入无分块能力，> MARKUP_MAX_BYTES 时
 * 调用方跳过富文本管线走这里：markdown 降级纯文本（highlight: false），html 降级
 * 源码视图——降级而非拒绝，查看器语义下内容仍可读。错误卡复用 core showErrorCard
 * 的 .vv-error-* 结构语义；.vv-degraded* 样式由 apps/web/src/app.css 提供。
 */
export function renderDegradedCode(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: { name: string; mode: string; encoding?: Encoding; ext?: string; highlight?: boolean }
): RenderCodeHandle {
  target.classList.add('vv-degraded');
  const card = document.createElement('div');
  card.className = 'vv-error-card vv-oversize-card';
  const title = document.createElement('div');
  title.className = 'vv-error-title';
  title.textContent = '文件过大，已降级显示';
  const detail = document.createElement('div');
  detail.className = 'vv-error-detail';
  detail.textContent = `文件超过 ${MARKUP_MAX_BYTES / 1024 / 1024}MB，富文本渲染已跳过（避免长时间阻塞），已降级为${opts.mode}视图（代码视图/纯文本查看）。`;
  const meta = document.createElement('div');
  meta.className = 'vv-error-meta';
  meta.textContent = opts.name;
  card.append(title, detail, meta);
  const content = document.createElement('div');
  content.className = 'vv-degraded-content';
  target.replaceChildren(card, content);
  return renderCode(buffer, content, {
    encoding: opts.encoding,
    highlight: opts.highlight,
    ext: opts.ext,
    oversizeNotice: false // 降级卡已存在：不再叠加 >20MB 纯文本提示条（BUG-20 防重复）
  });
}
