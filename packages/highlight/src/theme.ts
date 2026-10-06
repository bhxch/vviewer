/** 单个捕获（capture）的样式。 */
export interface ThemeStyle {
  fg?: string;
  bg?: string;
  modifiers?: string[];
}

/** 主题表：capture 名 → 样式（如 themes.json 中单个主题的值）。 */
export type ThemeTable = Record<string, ThemeStyle>;

/**
 * 解析 capture 的最终样式：最长前缀回退。
 * `function.builtin` 未命中则逐段剥 `.xxx` 回退（试 `function`），全部未命中返回 `{}`。
 */
export function resolveCapture(theme: ThemeTable, capture: string): ThemeStyle {
  let key = capture;
  for (;;) {
    const hit = theme[key];
    if (hit) return hit;
    const dot = key.lastIndexOf('.');
    if (dot < 0) return {};
    key = key.slice(0, dot);
  }
}

/** capture 名转 CSS 变量名：点转 `-`，统一前缀 `--vv-ts-`（前端唯一来源）。 */
export function captureToCssVar(capture: string): string {
  return `--vv-ts-${capture.replace(/\./g, '-')}`;
}

/**
 * 为给定 captures 生成 CSS 变量声明文本：每行 `--vv-ts-<capture>: <color>;`。
 * 经 resolveCapture 最长前缀回退；无 fg 的 capture 跳过。
 */
export function themeToCssVars(theme: ThemeTable, captures: string[]): string {
  const lines: string[] = [];
  for (const capture of captures) {
    const fg = resolveCapture(theme, capture).fg;
    if (!fg) continue;
    lines.push(`${captureToCssVar(capture)}: ${fg};`);
  }
  return lines.join('\n');
}
