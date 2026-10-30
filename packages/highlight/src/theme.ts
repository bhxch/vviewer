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

/** capture → span 类名的类前缀（`ts-<capture>`，app.css `.ts-*` 规则与
 * renderLineHtml 的 span 共用；前端唯一来源）。 */
export const CAPTURE_CLASS_PREFIX = 'ts-';

/** capture → CSS 变量的变量前缀（`--vv-ts-<capture>`，themeToCssVars 注入与
 * app.css var() 消费共用；前端唯一来源）。 */
export const CAPTURE_VAR_PREFIX = '--vv-ts-';

/**
 * capture 名转无前缀 CSS 类片段：点转 `-`。'string.special' → 'string-special'。
 * 渲染 span 的类名（`${CAPTURE_CLASS_PREFIX}${captureToCssClass(c)}`）与 CSS 变量
 * （captureToCssVar）共用此转义——两端统一唯一来源。
 */
export function captureToCssClass(capture: string): string {
  return capture.replace(/\./g, '-');
}

/** capture 名转 CSS 变量名：点转 `-`，统一前缀 CAPTURE_VAR_PREFIX（前端唯一来源）。 */
export function captureToCssVar(capture: string): string {
  return `${CAPTURE_VAR_PREFIX}${captureToCssClass(capture)}`;
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

/**
 * 代码高亮常用捕获全集（顶层 + 常用子捕获，53 个）——BUG-50 修复的归约目标集。
 * 三面对齐契约：span 类名（resolveCaptureClass 归约后）⊂ 此清单 = 注入变量清单
 * （themeToCssVars 消费方传入）= app.css .ts-* 规则清单（app 侧 theme.test.ts
 * 双向校验）。各语言 highlights.scm 的实际 capture 集远多于此（约 240 语言各有
 * 超集），渲染端 resolveCaptureClass 按「最长前缀命中本清单」归约——未入清单的
 * 细粒度 capture（constant.numeric.integer、keyword.storage.modifier.mut 等）
 * 落到最近语义父级（constant.numeric、keyword），任何语言都能拿到最近似着色而非
 * 恒 inherit；无前缀命中的私有/杂项 capture（_ann 等）原样透传（无规则 → inherit，
 * 与既有行为一致）。
 */
export const CODE_CAPTURES: readonly string[] = [
  'attribute',
  'comment',
  'comment.line',
  'comment.block',
  'constant',
  'constant.builtin',
  'constant.character',
  'constant.character.escape',
  'constant.numeric',
  'constructor',
  'function',
  'function.builtin',
  'function.call',
  'function.macro',
  'function.method',
  'keyword',
  'keyword.control',
  'keyword.control.conditional',
  'keyword.control.import',
  'keyword.control.repeat',
  'keyword.directive',
  'keyword.function',
  'keyword.operator',
  'label',
  'markup.bold',
  'markup.heading',
  'markup.italic',
  'markup.link',
  'markup.list',
  'markup.raw',
  'module',
  'namespace',
  'number',
  'operator',
  'property',
  'punctuation',
  'punctuation.bracket',
  'punctuation.delimiter',
  'punctuation.special',
  'special',
  'string',
  'string.escape',
  'string.special',
  'tag',
  'type',
  'type.builtin',
  'type.enum.variant',
  'variable',
  'variable.builtin',
  'variable.parameter',
  'diff.delta',
  'diff.minus',
  'diff.plus'
];

const CODE_CAPTURE_SET: ReadonlySet<string> = new Set(CODE_CAPTURES);

/**
 * capture → span 类名片段（BUG-50）：先按最长前缀归约到 CODE_CAPTURES 内最近
 * 语义父级，再经 captureToCssClass 点转 `-`。清单内 capture 恒等返回——常用
 * token 类名与旧行为逐字节一致；未命中逐段剥 `.后缀`（resolveCapture 同款回退），
 * 全剥尽仍未命中则原样转义返回。渲染端唯一类名出口（render-text renderLineHtml）
 * 改走本函数：类名 ⊂ 清单 ⇒ 每个 ts-span 都有 CSS 规则与注入变量。
 */
export function resolveCaptureClass(capture: string): string {
  let key = capture;
  for (;;) {
    if (CODE_CAPTURE_SET.has(key)) return captureToCssClass(key);
    const dot = key.lastIndexOf('.');
    if (dot < 0) return captureToCssClass(capture);
    key = key.slice(0, dot);
  }
}
