import type { Renderer, Encoding, Detection, FileSource, RenderedInstance, SearchMatch, ComputeSource, ComputeWhere, StreamCtx } from '@vviewer/core';
import { getRemoteBase, getRemoteMeta, redetectWithFull, RemoteComputeError, showErrorCard } from '@vviewer/core';
import { detectLanguage, HighlightCanceledError, captureToCssClass, type HighlightChunk, type HighlightInterval } from '@vviewer/highlight';
import { STREAM_MAX_BYTES, createBlockStream, isSuspiciousUtf8Block, memoizedFullRead } from './blockStream';
import { createTextWindow } from './textWindow';
import { advanceCodeIndex, createCodeIndex, finishCodeIndex } from './codeIndexStream';

export type { HighlightInterval };
/** hljs 动态导入的默认导出类型（HLJSApi） */
type HLJS = (typeof import('highlight.js'))['default'];
import { virtualScroller, type VirtualScrollerHandle } from './virtualScroller';
import { searchCode, type SearchMatchWithPreview } from './search';

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

/** 降级链阈值：≤2MB tree-sitter 整文件；≤200MB lazy（可视区 chunk 懒高亮）；更大纯文本。
 * tree-sitter 阈值 2MB 的依据：实测 ~2.1-2.4s/MB，2MB≈4-5s，与移动端预算同量级，
 * 据 spec 5.11 预算校准。plain 上限 200MB：lazy 化后不再有整文件解析成本，上限只防
 * 解码文本的内存失控（Uint8Array+string ≈ 字节数的 3-4 倍持有）。 */
export const TREE_SITTER_MAX_BYTES = 2 * 1024 * 1024;
export const HLJS_MAX_BYTES = 20 * 1024 * 1024;
/** 纯文本降级上限（参数化，spec §5.2）：>此值不做任何语法高亮 */
export const PLAIN_MAX_BYTES = 200 * 1024 * 1024;
/** markdown/html 富文本渲染输入上限（与 hljs 阈值同源 20MB）：净化与 DOM 遍历
 * 管线无分块，超大输入会长时间阻塞主线程；超限跳过富文本管线，降级为代码/纯
 * 文本视图（renderDegradedCode）。 */
export const MARKUP_MAX_BYTES = 20 * 1024 * 1024;
export const LINE_HEIGHT = 20;

export type HighlightStrategy = 'tree-sitter' | 'lazy' | 'plain';

/** 降级链（按字节大小）：≤2MB tree-sitter（失败→hljs 整文件）；2MB–200MB lazy
 * （可视区驱动 chunk，tree-sitter 质量、chunk 失败行级 hljs 兜底）；>200MB 纯文本 */
export function resolveStrategy(size: number): HighlightStrategy {
  if (size <= TREE_SITTER_MAX_BYTES) return 'tree-sitter';
  if (size <= PLAIN_MAX_BYTES) return 'lazy';
  return 'plain';
}

/** Encoding → TextDecoder 标签（code/markdown/html 渲染器共用；导出避免重复表） */
export const DECODERS: Record<Encoding, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030'
};

/** lazy chunk 缓存总行数上限（chunk 粒度逐出，原 hljs-block blockCache 的 5000 行等价）：
 * 超出按插入序整 chunk 淘汰，被逐出的行滚动回来时按需重算 */
export const CHUNK_CACHE_MAX_LINES = 5000;
/** lazy chunk 行粒度：chunk 边界按 200 行对齐，减少窗口移动的重复解析（spec §5.2） */
export const CHUNK_LINES = 200;
/** chunk 请求的额外裕量：virtualScroller 的 overscan(10) + 重叠 2 行——滚动连发时
 * 「请求发出→chunk 完成」间隙内越过的边界行仍落在已请求/已缓存区间 */
export const CHUNK_OVERSCAN_LINES = 10;
export const CHUNK_OVERLAP_LINES = 2;

/**
 * 可视区 [first,last] → 200 行对齐的 chunk 区间（纯函数）：先外扩 overscan+2 行裕量
 * 并夹到文件边界，再按 CHUNK_LINES 对齐（下界向下取整、上界向上取整），chunkKey=startLine。
 * 空文件（虚拟滚动对 0 行传 -1,-1）返回 lineCount 0。
 */
export function chunkRangeFor(
  first: number,
  last: number,
  totalLines: number
): { startLine: number; lineCount: number } {
  if (totalLines <= 0) return { startLine: 0, lineCount: 0 };
  const lo = Math.max(0, Math.min(first, last) - CHUNK_OVERSCAN_LINES - CHUNK_OVERLAP_LINES);
  const hi = Math.min(totalLines - 1, Math.max(first, last) + CHUNK_OVERSCAN_LINES + CHUNK_OVERLAP_LINES);
  if (hi < lo) return { startLine: 0, lineCount: 0 };
  const startLine = Math.floor(lo / CHUNK_LINES) * CHUNK_LINES;
  const endLine = Math.min(totalLines - 1, (Math.floor(hi / CHUNK_LINES) + 1) * CHUNK_LINES - 1);
  return { startLine, lineCount: endLine - startLine + 1 };
}

/** Map 插入序淘汰：把 m 裁到 ≤max 条（最早写入的先删） */
export function evictOldestEntries<K, V>(m: Map<K, V>, max: number): void {
  let excess = m.size - max;
  while (excess-- > 0) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    m.delete(oldest.value);
  }
}

/** chunkCoverage 条目上限（R-1 加界）：覆盖率条目与 chunk 缓存同阶只增不减，
 * 512MB 流式上限 × 短行（~16B）理论可达数万条目——与 chunk 缓存逐出联动加界：
 * 超出按插入序清最旧。被清条目的 chunk 若其高亮缓存仍在，hasChunkData 的覆盖率
 * 裁决视为未处理而重发（覆盖式整 chunk 重算、set 回写条目，无正确性影响，代价
 * 仅为极端长文件下最旧 chunk 的一次重高亮）；与「缓存缺席面兜底重发」同语义 */
export const CHUNK_COVERAGE_MAX_ENTRIES = 4096;

/** chunkCoverage 加界（纯函数，导出供单测）：超出上限按插入序清最旧（evictOldestEntries 复用） */
export function capChunkCoverage(coverage: Map<number, number>): void {
  evictOldestEntries(coverage, CHUNK_COVERAGE_MAX_ENTRIES);
}

/**
 * chunk 粒度逐出（纯函数）：把 chunk 缓存（startLine → 行 map）总行数裁到 ≤maxLines，
 * 超出版的最早 chunk 整个删除（行级半删会让 chunkKey 缓存标记失真——hasChunkData 按
 * 键判断「已处理」，整删才能保证被逐出的 chunk 下次完整重算）。
 */
export function evictChunksByLines<V>(m: Map<number, Map<number, V>>, maxLines: number): void {
  let total = 0;
  for (const chunk of m.values()) total += chunk.size;
  while (total > maxLines) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    total -= m.get(oldest.value)?.size ?? 0;
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

/**
 * chunk 区间 → 绝对行行段 Map（纯函数）：intervals 相对 chunk 子文本，先按子文本行
 * 偏移表分配到相对行，再统一 +shift 平移到全文件行号（本地 chunk shift=startLine；
 * 服务端 range chunk shift=响应 baseLine）。空区间返回空 Map（chunk 已处理标记）。
 */
export function mergeChunkLines(
  intervals: HighlightInterval[],
  chunkOffsets: number[],
  shift: number
): Map<number, LineSeg[]> {
  const byLine = new Map<number, LineSeg[]>();
  for (const a of assignIntervalsToLines(intervals, chunkOffsets)) {
    byLine.set(a.line + shift, a.segs);
  }
  return byLine;
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

/** 单次高亮调用的路由上下文（M6 compute 路由 + 阶段 4 chunk 标注；不参与渲染结果本身） */
export interface HighlightCallContext {
  /** 计算来源：远程 store 的文件带服务端 path（auto 策略据此走远程），本地文件缺省 */
  src?: ComputeSource;
  /** 执行位置回调：路由结果（local/remote）到达后调用（状态栏执行位置指示） */
  onWhere?: (where: ComputeWhere) => void;
  /** chunk 子文本窗口语义标注（spec §5.1）：text 即该窗口子文本，返回区间相对 text；
   * 行号平移归渲染侧（mergeChunkLines）。仅 lazy 本地 chunk 路径携带 */
  chunk?: HighlightChunk;
}

/** tree-sitter 高亮客户端最小接口（HighlightClient 结构兼容；测试可注 fake） */
export interface CodeHighlightClient {
  highlight(text: string, lang: string, ctx?: HighlightCallContext): Promise<HighlightInterval[]>;
}

let attachedClient: CodeHighlightClient | null = null;

/** 注入相位：pending=尚未 attach（attach 竞态窗口，等待者挂起）；attached=client
 * 在位；failed=attachHighlightClient(null) 显式解绑（创建失败终态）——即刻放行
 * 等待者走 hljs 兜底，不占超时（区分「还没好」与「不会有」两种 null）。 */
type AttachPhase =
  | { phase: 'pending' }
  | { phase: 'attached' }
  | { phase: 'failed' };
let attachPhase: AttachPhase = { phase: 'pending' };

/** 等待注入的渲染实例（start() 时 client 尚未就绪的挂起点，attach/超时即放行） */
interface AttachWaiter {
  resolve: (client: CodeHighlightClient | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
let attachWaiters: AttachWaiter[] = [];

/**
 * 应用侧注入 HighlightClient 单例（apps/web 启动时调用；传 null 为创建失败解绑
 * 终态——放行全部等待者，后续 waitForAttachedClient 即刻返回 null 不再等待）
 */
export function attachHighlightClient(client: CodeHighlightClient | null): void {
  attachedClient = client;
  attachPhase = client === null ? { phase: 'failed' } : { phase: 'attached' };
  const waiters = attachWaiters;
  attachWaiters = [];
  for (const w of waiters) w.resolve(client);
}

/**
 * 等待高亮客户端注入（P2 CDN 层引入的 attach 竞态修复）：client 由 apps/web
 * 启动预热创建，但 create() 需先走 grammar 资产三层解析链——CDN 层注入后含一次
 * 真实网络 fetch（CI 假域名快速失败，本地/代理环境可耗秒级），「启动预热早于
 * 首个 code tab」不再保证。此前 start()/懒 chunk 泵/markdown 围栏同步读
 * attachedClient，未就绪即落 hljs 兜底且永不恢复（首开文件/围栏引擎错锁——
 * m6 远程高亮与 >2MB 懒高亮家族在 CDN 构建下实测竞态）。现 pending 相位挂起
 * 等待注入（或超时/failed 放行 null → 既有 hljs 兜底路径）；超时上限兜底创建期
 * 永久挂起（如 CDN fetch 无响应）不让渲染无限等。
 */
export function waitForAttachedClient(timeoutMs = 10_000): Promise<CodeHighlightClient | null> {
  if (attachedClient !== null) return Promise.resolve(attachedClient);
  if (attachPhase.phase === 'failed') return Promise.resolve(null); // 解绑终态：不会有 client
  return new Promise((resolve) => {
    const waiter: AttachWaiter = {
      resolve: (client) => {
        clearTimeout(waiter.timer);
        resolve(client);
      },
      timer: setTimeout(() => {
        attachWaiters = attachWaiters.filter((w) => w !== waiter);
        resolve(attachedClient); // 超时放行：仍为 null → 调用方走既有 hljs 兜底
      }, timeoutMs)
    };
    attachWaiters.push(waiter);
  });
}

/** 读取已注入的高亮客户端单例（markdownRenderer 的围栏高亮复用同一注入，无需二次接线） */
export function getHighlightClient(): CodeHighlightClient | null {
  return attachedClient;
}

/** 测试专用：重置注入相位为 pending（模拟「client 尚未创建」的启动窗口）——
 * 生产代码不调用；attachHighlightClient(null) 是失败终态，测试需要重新构造
 * 竞态窗口时经此恢复（code.test/markdownRenderer.test 的 attach 竞态用例）。 */
export function __resetAttachPhaseForTest(): void {
  attachedClient = null;
  attachPhase = { phase: 'pending' };
}

/**
 * 大文件远程高亮路由（BUG-10 → 阶段 4 range 契约）：>2MB lazy 文件按可视区 chunk
 * 问路由（裁决在注入侧 apps/web highlightRouter）。契约：非 null = 该 chunk 的远程
 * 高亮区间（intervals 相对 chunk 首行，baseLine 平移到绝对行；执行位置 remote）；
 * null = 留在该 chunk 的行级 hljs 兜底（注入侧硬护栏：local、本地来源、auto 服务端
 * 不可服务门均拦为 null）；抛错 = 显式 remote 失败（渲染端错误卡片，不静默回退，
 * 与 tree-sitter 分支的 RemoteComputeError 同语义）。
 */
/** 大文件路由 chunk 级结果（spec §5.1）：intervals 相对 chunk 首行；baseLine 为该
 * 首行的全文件 0 基行号（旧服务端响应无此字段时兜 0，此时按全文件区间解释） */
export interface LargeFileHighlightChunk {
  intervals: HighlightInterval[];
  baseLine: number;
}

export type HighlightRouterFn = (
  src: ComputeSource,
  lang: string,
  range?: { startLine: number; lineCount: number }
) => Promise<LargeFileHighlightChunk | null>;

let attachedRouter: HighlightRouterFn | null = null;

/** 应用侧注入大文件路由回调（apps/web 启动时调用；传 null 解绑） */
export function attachHighlightRouter(fn: HighlightRouterFn | null): void {
  attachedRouter = fn;
}

// 样式说明：虚拟滚动与代码面板的样式统一由 apps/web/src/app.css 提供（单一来源），
// 本模块不再运行时注入 CSS，避免双份定义漂移。

/** 代码高亮引擎实时值：pending = tree-sitter 主路径（整文件或 lazy chunk）已启动但
 * 首个产出未到达（或已取消）；'hljs-block' 类型值保留（历史状态栏兼容）但不再产生 */
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

/** renderCode 选项（双模式共用）：全量模式（现状）与窗口流式模式的差异全部经
 * ctx 字段表达——其余字段语义两模式一致（encoding/highlight/ext/lang/computeSrc/
 * oversizeNotice）。 */
export interface CodeRenderOptions {
  encoding?: Encoding;
  highlight?: boolean;
  ext?: string;
  lang?: string;
  computeSrc?: ComputeSource;
  /** >20MB 纯文本降级的超限提示条开关（BUG-20）；缺省跟随 highlight。
   * renderDegradedCode 传 false：降级卡已存在，不重复提示。 */
  oversizeNotice?: boolean;
  /** 流式读上下文（io-streaming 计划 3 Task 4，spec §4.3）：存在时 renderCode 走
   * 窗口流式模式（buffer 形参仅作语言探测头部样本，不参与渲染）。前置条件：编码
   * 须为 UTF-8（codeRenderer.render 守卫——窗口模式仅 UTF-8/ASCII，见其注释）；
   * ≤2MB 全量走现状路径的守卫补拉同样在 codeRenderer.render 入口完成。 */
  ctx?: StreamCtx;
  /** 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8 的降级出口（codeRenderer.render 注入）：
   * 实现走「判出的非 UTF-8」入口回退同路径（memoizedFullRead 补拉 + redetectWithFull
   * 精判 + 全量重渲）并返回全量重渲实例——窗口实例的方法面转投该实例。缺省（直接
   * 调用面）不嗅探不降级，行为与现状一致。 */
  onEncodingBroken?: () => Promise<RenderCodeHandle>;
}

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
    scroller = virtualScroller(pre, lines.length, LINE_HEIGHT, (first, last, viewport) => {
      if (strategy === 'lazy') scheduleChunks(first, last); // 可视区驱动 chunk 请求
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
    const router = attachedRouter;
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
    let client = attachedClient;
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
    hljsLang = hljsLang ?? resolveHljsLang(hljs, lang); // 别名桥接；null → highlightAuto
    const chunkText = subLines.join('\n');
    let value: string;
    try {
      value = hljsLang
        ? hljs.highlight(chunkText, { language: hljsLang, ignoreIllegals: true }).value
        : hljs.highlightAuto(chunkText).value;
    } catch {
      value = hljs.highlightAuto(chunkText).value; // 指定语言高亮异常（罕见）仍兜住
    }
    if (destroyed) return;
    const parts = splitHighlightedLines(value, lineCount);
    const byLine = new Map<number, string>();
    for (let k = 0; k < parts.length; k++) byLine.set(startLine + k, parts[k] ?? '');
    hljsChunkCache.set(startLine, byLine);
    evictChunksByLines(hljsChunkCache, CHUNK_CACHE_MAX_LINES);
    if (engine !== 'tree-sitter') {
      // 产出仍是 hljs（首个 chunk 即兜底/无 client）→ engine=hljs 本地；
      // 已有 tree-sitter chunk 产出则保持主导引擎不变（混合 chunk 不回退指示）
      engine = 'hljs';
      computeWhere = 'local';
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
      const client = attachedClient ?? (await waitForAttachedClient());
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
/** 流式上限提示条（spec §4.3 防线换代：非失败态，不复用错误卡片；建议 hex 与 jsonl
 * STREAM_LIMIT_NOTICE 同口径） */
const CODE_STREAM_LIMIT_NOTICE =
  '文件超过 512MB，已达流式渲染上限（索引停止推进），建议以 hex 打开';

function renderCodeWindowed(
  ctx: StreamCtx,
  buffer: Uint8Array,
  target: HTMLElement,
  opts: CodeRenderOptions
): RenderCodeHandle {
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
  const bs = createBlockStream(ctx, CODE_WINDOW_BLOCK_BYTES, { maxBlocks: CODE_STREAM_MAX_BLOCKS });
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
  // 行数 = 索引条目数：含末尾空串条目，与全量 buildLineIndex lines.length 同值
  //（虚拟滚动 itemCount/chunkRangeFor 的 totalLines 同口径，指令④不在索引层减 1）
  const rows = (): number => index.offsets.length;

  // lazy 路径双缓存（chunkKey=startLine → 行 map）：与全量模式同构，仅行文本来源换
  // textWindow（highlightChunk 内 subLines 构建）
  const chunkCache = new Map<number, Map<number, LineSeg[]>>();
  const hljsChunkCache = new Map<number, Map<number, string>>();
  let hljs: HLJS | null = null;
  let hljsLang: string | null = null;
  let scroller: VirtualScrollerHandle | null = null;
  let mountedRows = -1; // 当前 scroller 的行数（窗口模式行数动态：增长即重建）
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
      row.style.height = `${LINE_HEIGHT}px`; // 占位行同款保行高
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
    const router = attachedRouter;
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
    let client = attachedClient;
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

  /** 行级 hljs 兜底：单 chunk 主线程高亮（200 行）写 hljsChunkCache（全量路径同款） */
  async function hljsChunk(startLine: number, lineCount: number, subLines: string[]): Promise<void> {
    hljs ??= (await import('highlight.js')).default;
    if (destroyed) return;
    hljsLang = hljsLang ?? resolveHljsLang(hljs, lang);
    const chunkText = subLines.join('\n');
    let value: string;
    try {
      value = hljsLang
        ? hljs.highlight(chunkText, { language: hljsLang, ignoreIllegals: true }).value
        : hljs.highlightAuto(chunkText).value;
    } catch {
      value = hljs.highlightAuto(chunkText).value;
    }
    if (destroyed) return;
    const parts = splitHighlightedLines(value, lineCount);
    const byLine = new Map<number, string>();
    for (let k = 0; k < parts.length; k++) byLine.set(startLine + k, parts[k] ?? '');
    hljsChunkCache.set(startLine, byLine);
    chunkCoverage.set(startLine, lineCount);
    capChunkCoverage(chunkCoverage); // R-1 加界：与 chunk 缓存逐出联动（见常量注）
    evictChunksByLines(hljsChunkCache, CHUNK_CACHE_MAX_LINES);
    if (engine !== 'tree-sitter') {
      engine = 'hljs';
      computeWhere = 'local';
    }
  }

  function onRange(first: number, last: number, viewport: HTMLElement): void {
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
    scroller = virtualScroller(pre, n, LINE_HEIGHT, onRange);
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
  };
  pre.addEventListener('scroll', onUserScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    onUserScroll(); // 与 scroll 同一解锁入口：清续读/回看双闩
    scroller?.refresh(true); // 单次重评：重绘可视行并重估续读/回看（maybeContinue）
  });
  ro.observe(pre);

  /**
   * 启动：首块拉取（失败上抛——经 whenReady 到 codeRenderer.render 的渲染期读失败
   * 面）；已本地化（!rangeCapable 全量视图 head 预置全部块 / 200-回退切全量底座 /
   * 短读已确认 EOF）时排空剩余已确认块——零 IO，仅把索引喂到文件尾。首块在手即
   * mount（首屏首块即可渲染），其余交滚动续读。
   */
  async function start(): Promise<void> {
    await pullBlock();
    while (!destroyed && !indexFinished && !limitReached && !encodingBroken && bs.atEnd()) await pullBlock();
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
  }

  function jumpToLine(line: number): void {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitLine = line;
    const center = line * LINE_HEIGHT - pre.clientHeight / 2 + LINE_HEIGHT / 2;
    pre.scrollTop = Math.max(0, center);
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
  function updateScanProgress(scannedRow: number, hits: number, force = false): void {
    if (scanBar === null) return;
    const now = Date.now();
    if (!force && now - lastProgressWriteAt < SCAN_PROGRESS_THROTTLE_MS) return;
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
    let scanned = startFrom; // 已扫描行数（索引已提交行的前缀指针：断点续扫不重复）
    showScanProgress(mySeq); // 项 2：扫描开始即挂进度条（同键续扫/接管复用同一元素，项 A 属主切换）
    try {
      for (;;) {
        if (!alive()) return acc;
        updateScanProgress(scanned, acc.length); // 项 2：外圈每轮一次（≈每块粒度，渲染节流）
        if (scanned < rows()) {
          for (; scanned < rows() && alive(); scanned++) {
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
          continueFailed = true; // 与滚动续读同口径：停机闩，用户滚动动作解除
          lastScanComplete = false; // 同键重搜即用户动作：解除闩后续扫（见 search）
          console.debug('[code] 搜索扫描续读失败，已停机（返回已得部分结果）', err);
          return acc;
        } finally {
          pulling = false;
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
    // 渲染期动态元数据快照。lines 为内容行数口径（展示层 wc -l，指令④）：索引
    // offsets.length 含末尾空串条目（=全量 lines.length 同值），EOF 后末条目空串才在
    // 此减 1——流中条目全为已提交真实行不减（「已加载 N 行」渐进口径，ViewerPane
    // 首读数字形态兼容）。size：已知取 ctx.size，未知取已确认字节（随续读增长）
    getMeta() {
      if (fullInst !== null) return fullInst.getMeta(); // 项 1：降级后转投全量实例（encoding 精判/行数全量）
      const lastLen = index.lengths[index.lengths.length - 1] ?? -1;
      return {
        encoding: opts.encoding ?? 'utf-8',
        lang, // 与实际高亮语言同源（评审③同口径）
        size: ctx.size ?? bs.confirmedBytes,
        lines: indexFinished && lastLen === 0 ? rows() - 1 : rows()
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
      // 停机/取消收场的部分结果不得短路——重搜触发断点续扫（自 lastScanCursor）
      if (sameKey && lastScanComplete) return Promise.resolve(lastMatches);
      const mySeq = ++scanSeq; // 令牌失效：旧扫描在下一检查点退出（新搜索/退出搜索取消）
      scan = null;
      // 命中集/行级背景/active 重置（旧查询的视觉痕迹即刻清除，新命中随扫描渐进上屏）
      if (hitTimer !== null) {
        clearTimeout(hitTimer);
        hitTimer = null;
      }
      hitLine = -1;
      if (sameKey) {
        // 停机收场后同 query 重搜：续扫。重搜即用户动作，解除续读停机闩（「下次
        // 用户动作才重试」）；命中集与游标保持，扫描自断点合并推进
        continueFailed = false;
      } else {
        // 换键：命中集/行级背景/进度游标全量重置（lastMatches 引用随 lastAcc 更新）
        lastAcc = [];
        lastMatches = lastAcc;
        searchHitsByLine = new Map();
        lastQuery = query;
        lastCaseSensitive = caseSensitive;
        lastScanCursor = 0;
      }
      if (query === '') {
        clearHit(); // 空 query = 退出搜索：active 与全部行级背景立即消退
        scroller?.refresh(true);
        return Promise.resolve([]);
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
            continueFailed = true; // 与滚动续读同口径：停机闩，用户滚动动作解除
            console.debug('[code] revealLine 续读失败（跳转静默兜底，滚动后重试）', err);
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
  return handle;
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
  // streaming（io-streaming 计划 3 Task 4，spec §4.3）：dispatcher 只交付 head +
  // StreamCtx，code 打开即走窗口流式（>2MB/size 未知）或入口守卫补拉全量（≤2MB/非
  // UTF-8）。回退面均在 render 内自处（下方守卫）；!rangeCapable 的全量视图 ctx 属
  // 窗口模式退化形态，BlockStream 零 IO 排空。
  streaming: true,
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection, ctx?: StreamCtx) {
    // 远端文件（M5 RemoteStore）的服务端检测头纠偏：X-VV-Lang/X-VV-Encoding
    // 与 languages.json 同源，比本地扩展名表/编码启发式更准（无扩展名脚本等）。
    // opts.lang 有值时 renderCode 直接采用、跳过 detectLanguage；服务端无检测头时
    // 回落 det.lang（dispatcher 的 extless 回退链写入的 shebang 语言，握手点 1）。
    const meta = getRemoteMeta(source.storeId, source.path);
    // M6 compute 路由：只有远程 store 的文件带服务端 path（auto 策略据此走远程高亮）
    const computeSrc: ComputeSource | undefined =
      getRemoteBase(source.storeId) !== undefined ? { path: source.path, storeId: source.storeId } : undefined;
    let encoding = meta?.encoding ?? det.encoding;
    const renderOpts = {
      encoding,
      highlight: true,
      ext: det.ext,
      lang: meta?.lang ?? det.lang ?? undefined,
      computeSrc
    };
    // 窗口流式候选：ctx 存在且 UTF-8 且 size>2MB 或 size 未知（spec §4.3 高亮分界）。
    // detect 收口：窗口模式仅 UTF-8/ASCII（Encoding 无 ascii——ASCII 为 UTF-8 子集，
    // 探测即 utf-8）；非 UTF-8 不入此分支，全量回退后 dispatcher 终审 F2 以全量重算
    // detect 编码精判——O(n) 全量扫描只发生在全量路径，设计内解决遗留
    const windowed =
      ctx !== undefined &&
      (encoding ?? 'utf-8') === 'utf-8' &&
      (ctx.size === null || ctx.size > TREE_SITTER_MAX_BYTES);
    let inst: RenderCodeHandle;
    if (windowed && ctx !== undefined) {
      inst = renderCode(buffer, target, {
        ...renderOpts,
        ctx,
        // 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8 的降级出口——与下方全量守卫的
        // 「判出的非 UTF-8」回退同路径（memoizedFullRead 补拉 + redetectWithFull 精判
        // + 全量重渲）。注入在渲染器入口：source/det（精判就地翻转 det.encoding）只在
        // 该层可见；head 样本取 ctx.head（dispatcher 交付的探测头，与入口回退同源）
        onEncodingBroken: async () => {
          const full = await memoizedFullRead(ctx);
          redetectWithFull(source, ctx.head, full, det);
          return renderCode(full, target, { ...renderOpts, encoding: det.encoding });
        }
      });
    } else {
      // 全量路径守卫补拉（回退矩阵收口，同 jsonl/hex 形态）：streaming 分支只交付
      // 8KB 探测头作 buffer（capable 且 size>1MB 或 size 未知），head 未覆盖全文件
      // （size 未知无法排除截断，或 head 短于 size）时经 ctx.read 拉全量再走下游——
      // 覆盖非 UTF-8 解码回退与 ≤2MB tree-sitter 全量两场景（指令①），否则 8KB 探测
      // 头静默截断。head 即全量（兼容路径/!capable 全量视图/capable≤1MB 直读——
      // buffer.byteLength === ctx.size）不触发，零额外读。读失败在此 await 处 reject
      //（dispatcher 已把 ctx.read 失败标为 DispatchReadError → 调用方读取失败面，
      // 评审指令①口径：不落「错误卡片 + 8KB probe 重试」截断活面）。
      if (ctx !== undefined && (ctx.size === null || buffer.byteLength < ctx.size)) {
        const head = buffer; // 探测头（head 即全量时守卫不触发，此处必为文件前缀）
        // 项 6（retry 免重拉）：补拉按 ctx 记忆——错误卡片 retry 重入 render 不再
        // 重复全量下载（memoizedFullRead，见 blockStream.ts 注）
        buffer = await memoizedFullRead(ctx);
        // I-2 补拉后编码精判：capable 且 size 未知/超限时 det 仅由 8KB head 判定，
        // 截断多字节可双向误判（误判 gb18030 直接解码即整文件 mojibake）——以全量
        // 重算翻转（dispatcher redetectWithFull 同款共享 helper），encoding 随之重取
        //（服务端 X-VV-Encoding 头仍最优先），下游 renderCode 以现值解码
        redetectWithFull(source, head, buffer, det);
        encoding = meta?.encoding ?? det.encoding;
        renderOpts.encoding = encoding;
      }
      inst = renderCode(buffer, target, renderOpts);
    }
    // 窗口模式首拉完成面：首块/本地化排空失败 → 销毁半装配实例（防空壳 scroller
    // 泄漏）后 rethrow——DispatchReadError 直抛调用方读取失败面，非读失败走渲染错误
    // 卡片（dispatcher catch，重试动作经 renderCtx 透传 ctx——评审指令②已验证）
    const ready = (inst as { whenReady?: Promise<void> }).whenReady;
    if (ready !== undefined) {
      try {
        await ready;
      } catch (err) {
        inst.destroy();
        throw err;
      }
    }
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
