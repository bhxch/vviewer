/**
 * code/wrap.ts — 代码视图自动换行的列宽测量与折行行高估算（全量/窗口两路径共用）。
 * 估算只服务未渲染行的前缀外推（variableScroller 渲染后实测修正），故取简：每行列数
 * = 正文列可用宽 / 等宽字宽；折行数 = ceil(长度 / 列数)——全量路径长度取字符数，窗口
 * 路径取索引字节数（CJK 3 字节占 2 列，偏高估，实测收口）。
 */

/** 无布局（jsdom/隐藏容器）时的列数回落 */
export const WRAP_FALLBACK_COLS = 80;

/**
 * 正文列可容纳的等宽列数：探针 span（.vv-code-body 同字体）量 64 个 '0' 得字宽；
 * 可用宽 = pre.clientWidth 扣行号列（.vv-code-gutter：min-width 3.5em + padding-right
 * 1em，宽度随行号位数增长）。无布局回落 WRAP_FALLBACK_COLS。
 */
export function measureWrapColumns(pre: HTMLElement, rowCount: number): number {
  const probe = document.createElement('span');
  probe.className = 'vv-code-body';
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre';
  probe.textContent = '0'.repeat(64);
  pre.append(probe);
  const charW = probe.getBoundingClientRect().width / 64;
  probe.remove();
  const avail = pre.clientWidth;
  if (!(charW > 0) || !(avail > 0)) return WRAP_FALLBACK_COLS;
  const fontSize = parseFloat(getComputedStyle(pre).fontSize) || charW / 0.6;
  const gutter = Math.max(3.5 * fontSize, String(Math.max(1, rowCount)).length * charW) + fontSize;
  return Math.max(8, Math.floor((avail - gutter) / charW));
}

/** 折行行高估算：长度按列数折行，至少一个视觉行 */
export function wrappedRowHeight(length: number, cols: number, lineHeight: number): number {
  return lineHeight * Math.max(1, Math.ceil(length / cols));
}
