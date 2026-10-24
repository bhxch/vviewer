/**
 * code/lines.ts — 区间归并到行与行 HTML 生成（FE-2 自 code.ts 分块迁出，函数体
 * 逐字搬移）。本块为子模块 DAG 底层：flattenIntervals/assignIntervalsToLines 等
 * 区间数学、splitHighlightedLines/mergeChunkLines/overlaySearchHits/renderLineHtml
 * 与 escape/decode helper。lineOf/escapeHtml 为 internal 导出（renderCode/
 * renderCodeWindowed 消费——拆分前为 code.ts 模块内私有，跨块共享升导出）。
 */
import { resolveCaptureClass, type HighlightInterval } from '@vviewer/highlight';

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

/** 二分：最大的 l 使 lineOffsets[l] <= pos（internal：renderCode 的
 * lineAtOffset/lineAtByteOffset 消费） */
export function lineOf(lineOffsets: number[], pos: number): number {
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

/** escapeHtml（internal：renderCode/renderCodeWindowed 的 fillRows 回落纯文本面消费） */
export function escapeHtml(text: string): string {
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
 * 类名经 @vviewer/highlight 的 resolveCaptureClass：先归约到 CODE_CAPTURES 最近语义
 * 父级再点转 `-`（BUG-50）——类名 ⊂ 清单 ⇒ 每个 span 都有 app.css 规则与注入变量；
 * 清单内 capture 恒等（与旧 captureToCssClass 直转逐字节一致）。 */
export function renderLineHtml(text: string, segs: readonly LineSeg[] | undefined): string {
  if (!segs || segs.length === 0) return escapeHtml(text);
  let out = '';
  let pos = 0;
  for (const seg of segs) {
    const start = Math.min(seg.start, text.length);
    const end = Math.min(seg.end, text.length);
    if (end <= pos) continue;
    if (start > pos) out += escapeHtml(text.slice(pos, start));
    out += `<span class="ts-${resolveCaptureClass(seg.capture)}">${escapeHtml(text.slice(Math.max(start, pos), end))}</span>`;
    pos = end;
  }
  if (pos < text.length) out += escapeHtml(text.slice(pos));
  return out;
}
