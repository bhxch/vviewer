import type { OutlineEntry } from './types';

/**
 * 与 web-tree-sitter 解耦的 capture 形态：node 只暴露配对所需的三字段
 * （startIndex/endIndex 为 UTF-16 偏移，与 HighlightInterval 同口径）。
 * 纯函数层（pairsToOutline）不 import web-tree-sitter——T2/T3 消费与单测 synthetic 构造
 * 均无需运行时。
 */
export interface OutlineCapture {
  name: string;
  node: { startIndex: number; endIndex: number; text: string };
}

/** 一个 query match 的解耦形态（web-tree-sitter QueryMatch 的 captures 投影）。 */
export type OutlineMatch = readonly OutlineCapture[];

/**
 * tags 查询 matches → 大纲条目（纯函数，与 web-tree-sitter 解耦）。
 *
 * 配对语义（tree-sitter tags 惯例）：
 * - @name 与 @definition.X / @reference.X 同 match 配对：name 取 @name 节点文本，
 *   byte 范围取 definition/reference 节点（定义/引用的完整范围供 depth 嵌套与跳转行），
 *   kind 保留 capture 全名（'definition.function' / 'reference.call'——信息无损，
 *   渲染端自行映射短名与过滤引用）。
 * - 无配对 @name：用节点自身文本与范围，kind 为 'name'。
 * - 无 @name 但有 anchor：name 用 anchor 节点文本（tags.scm 中 @definition 直附节点
 *   而无 @name 的写法）。
 * - @doc 忽略：纯 @doc match 不产条目，配对 match 中的 @doc 不干扰。
 * - 同 match 多个 anchor：各产一条（罕见写法）。
 * - 无 @name 且无 anchor 的 match 跳过。
 *
 * 后处理：
 * - 输出按 byteStart 升序（与文档序一致）。
 * - depth 栈式：排序后维护开放区间栈（byteEnd 出栈），depth = 入栈时栈深
 *   （class 0 / 其内 method 1 / method 内函数 2）。O(n log n)。
 * - line（0 起）：text 给定时按 byteStart 双指针扫行；缺省恒 0（synthetic 输入无全文）。
 */
export function pairsToOutline(matches: readonly OutlineMatch[], text?: string): OutlineEntry[] {
  interface Raw {
    name: string;
    kind: string;
    byteStart: number;
    byteEnd: number;
  }
  const raw: Raw[] = [];
  for (const match of matches) {
    const names = match.filter((c) => c.name === 'name');
    const anchors = match.filter(
      (c) => c.name.startsWith('definition.') || c.name.startsWith('reference.'),
    );
    if (anchors.length > 0) {
      for (const anchor of anchors) {
        raw.push({
          name: names[0]?.node.text ?? anchor.node.text,
          kind: anchor.name,
          byteStart: anchor.node.startIndex,
          byteEnd: anchor.node.endIndex,
        });
      }
    } else {
      for (const n of names) {
        raw.push({ name: n.node.text, kind: 'name', byteStart: n.node.startIndex, byteEnd: n.node.endIndex });
      }
    }
  }

  raw.sort((a, b) => a.byteStart - b.byteStart || b.byteEnd - a.byteEnd);

  // 行首偏移表（text 给定时）；entries 已按 byteStart 升序，双指针线性归并
  let lineStarts: number[] | null = null;
  if (text !== undefined) {
    lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
  }

  const out: OutlineEntry[] = [];
  const stack: number[] = []; // 开放区间的 byteEnd
  let lineIdx = 0;
  for (const r of raw) {
    while (stack.length > 0 && stack[stack.length - 1]! <= r.byteStart) stack.pop();
    let line = 0;
    if (lineStarts) {
      while (lineIdx + 1 < lineStarts.length && lineStarts[lineIdx + 1]! <= r.byteStart) lineIdx++;
      line = lineIdx;
    }
    out.push({ name: r.name, kind: r.kind, line, byteStart: r.byteStart, byteEnd: r.byteEnd, depth: stack.length });
    stack.push(r.byteEnd);
  }
  return out;
}
