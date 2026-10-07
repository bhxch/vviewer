/**
 * 代码主题（helix 全量 themes.json）状态与注入。
 * 零重解析契约：切主题只整体替换 style#vv-code-theme 里的 CSS 变量（--vv-ts-*），
 * DOM span 的类名（ts-<capture>）不触碰——已渲染文本即时换色。
 * themes.json（~1.1MB）经动态 import 惰性加载为独立 chunk，不进主包；
 * 各 API 变 async，内部缓存同一份加载 promise（并发调用只请求一次）。
 */
import { themeToCssVars, resolveCapture, type ThemeTable } from '@vviewer/highlight';
import type { Settings } from './stores/settings';

/** themes.json 全量表（键为 helix 主题名）。 */
type ThemeTables = Record<string, ThemeTable>;

let tablesPromise: Promise<ThemeTables> | null = null;

/** 惰性动态加载 themes.json（结果按模块缓存）。 */
function loadTables(): Promise<ThemeTables> {
  tablesPromise ??= import('@vviewer/highlight/assets/themes.json').then((m) => m.default as ThemeTables);
  return tablesPromise;
}

const STYLE_ID = 'vv-code-theme';

/** 精选主题（下拉置顶；键名以 themes.json 实际键为准）。 */
export const CURATED_CODE_THEMES = [
  'catppuccin_mocha',
  'catppuccin_latte',
  'gruvbox',
  'tokyonight',
  'onedark',
  'onelight',
  'github_dark',
  'github_light'
] as const;

/** 默认代码主题（亮/暗，均实测存在于 themes.json）。 */
export const DEFAULT_CODE_THEME: Record<'light' | 'dark', string> = {
  light: 'onelight',
  dark: 'serika-dark'
};

/**
 * 代码高亮常用捕获全集（顶层 + 常用子捕获，53 个）：
 * 注入 CSS 变量的范围——span 可能出现的捕获远多于此（各语言 query 各异），
 * 未入集的捕获回落 `.ts-<capture>` 无规则 → inherit，不影响布局。
 * app.css 的 .ts-* 颜色规则与 此列表一一对齐（theme.test.ts 双向校验）。
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

/** 全量主题名，按字母排序。 */
export async function listThemes(): Promise<string[]> {
  return Object.keys(await loadTables()).sort();
}

/**
 * hljs 兜底近似映射（M7 Task 3）：helix 主题 capture → hljs CSS 变量。
 * 近似同名语义映射（非精确对应，注释声明近似）：hljs 兜底路径（tree-sitter
 * 不可用/超限降级）的着色由 app.css 的 .hljs-* 规则消费这些变量，Q11 的
 * "独立双主题"升级为"近似跟随当前代码主题"。
 */
export const HLJS_CAPTURE_TO_VAR: readonly (readonly [string, string])[] = [
  ['keyword', '--hljs-keyword'],
  ['string', '--hljs-string'],
  ['comment', '--hljs-comment'],
  ['constant.numeric', '--hljs-number'],
  ['function', '--hljs-title'],
  ['type', '--hljs-type'],
  ['variable', '--hljs-variable'],
  ['tag', '--hljs-tag'],
  ['attribute', '--hljs-attr']
];

/**
 * 生成 hljs 变量覆盖文本：各 capture 取 resolveCapture 最长前缀回退的 fg；
 * 未命中（无 fg）不输出——保持 app.css 亮/暗双主题默认值。
 */
function hljsThemeVars(theme: ThemeTable): string {
  return HLJS_CAPTURE_TO_VAR.map(([capture, cssVar]) => {
    const fg = resolveCapture(theme, capture).fg;
    return fg ? `${cssVar}: ${fg};` : null;
  })
    .filter((s): s is string => s !== null)
    .join('\n');
}

/** 取单个主题表；不存在返回 null。 */
export async function getTheme(name: string): Promise<ThemeTable | null> {
  return (await loadTables())[name] ?? null;
}

/** 下拉选项：精选置顶，其余按字母排序。 */
export async function themeOptions(): Promise<{ group: '精选' | '全部'; themes: string[] }[]> {
  const tables = await loadTables();
  const curated = CURATED_CODE_THEMES.filter((t) => t in tables);
  const rest = Object.keys(tables)
    .filter((t) => !(CURATED_CODE_THEMES as readonly string[]).includes(t))
    .sort();
  return [
    { group: '精选', themes: [...curated] },
    { group: '全部', themes: rest }
  ];
}

/**
 * 应用代码主题：生成常用捕获集的 CSS 变量并注入/替换 style#vv-code-theme（单节点幂等）。
 * 主题名不存在 → console.warn 并保持现状（不动已有 style）。
 */
export async function applyCodeTheme(name: string, mode: 'light' | 'dark'): Promise<void> {
  const theme = (await loadTables())[name];
  if (!theme) {
    console.warn(`未知代码主题：${name}，保持当前代码主题不变`);
    return;
  }
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.append(el);
  }
  // 整体替换 textContent（非追加）：切换主题零残留；span 类名不变 → 零重解析。
  // 同一节点内追加 --hljs-* 近似映射（M7）：hljs 兜底着色跟随当前代码主题
  el.textContent = `/* vviewer 代码主题：${name}（${mode}）——只换 CSS 变量，不重解析 */\n:root {\n${themeToCssVars(theme, [...CODE_CAPTURES])}\n${hljsThemeVars(theme)}\n}`;
  el.dataset.mode = mode;
}

/** themeMode 的 system 解析为具体亮暗（无 matchMedia 环境，如 jsdom，回落 light）。 */
export function effectiveMode(themeMode: Settings['themeMode']): 'light' | 'dark' {
  if (themeMode !== 'system') return themeMode;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
