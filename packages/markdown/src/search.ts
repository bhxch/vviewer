// search.ts — markdown 渲染视图搜索的 preview 纯函数（自 render-text/src/search.ts
// 迁入最小消费面：渲染视图的命中上下文；行级 searchCode 属 code 渲染器不迁）。
// 大小写折叠用 toLowerCase（简单折叠）：个别 Unicode 字符折叠后长度会变，行内
// 偏移可能偏移——编辑器惯例同此，不做映射修正。

/**
 * 带上下文的命中（渲染视图搜索返回形状）：
 * markdown 渲染视图无行概念，line 复用为文档序命中序号（gotoMatch 按同序定位），
 * start/end 恒 0，preview 为命中文本节点的前后 40 字符上下文。
 */
export interface SearchMatchWithPreview {
  line: number;
  start: number;
  end: number;
  preview: string;
}

/** preview 在命中前后各保留的字符数 */
export const PREVIEW_CONTEXT = 40;

/** 命中行截断前后 PREVIEW_CONTEXT 字符：截断侧加省略号，未截断侧不加 */
export function makePreview(line: string, start: number, end: number): string {
  const from = Math.max(0, start - PREVIEW_CONTEXT);
  const to = Math.min(line.length, end + PREVIEW_CONTEXT);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < line.length ? '…' : '';
  return `${prefix}${line.slice(from, to)}${suffix}`;
}
