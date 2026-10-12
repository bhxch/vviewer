/**
 * 代码主题（helix 全量 themes.json）状态与注入。
 * 零重解析契约：切主题只整体替换 style#vv-code-theme 里的 CSS 变量（--vv-ts-*），
 * DOM span 的类名（ts-<capture>）不触碰——已渲染文本即时换色。
 * themes.json（~1.1MB）经动态 import 惰性加载为独立 chunk，不进主包；
 * 各 API 变 async，内部缓存同一份加载 promise（并发调用只请求一次）。
 */
import {
  colorsToUiVars,
  resolveCapture,
  themeToCssVars,
  tokenColorsToThemeTable,
  type ThemeTable,
  type VscodeThemeJson
} from '@vviewer/highlight';
import type { Settings } from './stores/settings';
import { listThemes as listImportedThemes } from './stores/session';

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
 * 注入规则的选择器（review fix：暗色级联提权）。
 * app.css 的暗色块 `:root[data-theme-mode="dark"]` 与 `@media (prefers-color-scheme:
 * dark) :root[data-theme-mode="system"]` 的 specificity 是 (0,2,0)，裸 `:root`（0,1,0）
 * 注入的 --hljs-*（及 --vv-ts-*）在暗色/系统深色下会被打回 GitHub-dark 默认值。
 * 选择器列出全部四种 root 形态：暗色形态拿到同等 (0,2,0)，本 style 节点运行时
 * append、文档序更后 → 稳定胜出；亮色形态维持 (0,1,0) 靠文档序胜出。
 */
export const THEME_ROOT_SELECTOR =
  ':root, :root[data-theme-mode="light"], :root[data-theme-mode="dark"], :root[data-theme-mode="system"]';

/**
 * 外观主题引用（spec B §2.1）：'default' | 'vscode:Dark Modern' 等内置名 |
 * 'imported:<id>'（导入管线，Task 3 接入存储）。
 */
export type AppearanceRef = string;

/**
 * VSCode 内置外观清单：主题名 → vendor JSON 动态加载器（两种 theme 名都在清单）。
 * 与 loadTables 同款动态 import 模式：vendor JSON 独立 chunk，不进主包。
 */
const BUILTIN_APPEARANCES: Record<string, () => Promise<{ default: unknown }>> = {
  'vscode:Dark Modern': () => import('@vviewer/highlight/assets/vscode/dark_modern.json'),
  'vscode:Light Modern': () => import('@vviewer/highlight/assets/vscode/light_modern.json')
};

/**
 * 解析外观引用为 VSCode 主题 JSON；未知 ref 返回 null（调用方 warn 并回退 default）。
 * 内置名查清单；`imported:<id>` 查 IndexedDB 主题库（session themes store，Task 3），
 * 未命中（已删除/损坏 id）同样返回 null 走回退。
 */
async function resolveAppearance(ref: string): Promise<VscodeThemeJson | null> {
  const loader = BUILTIN_APPEARANCES[ref];
  if (loader) return ((await loader()) as { default: VscodeThemeJson }).default;
  if (ref.startsWith('imported:')) {
    const hit = (await listImportedThemes()).find((t) => t.id === ref);
    if (hit) return { name: hit.name, type: hit.kind, colors: hit.colors, tokenColors: hit.tokenColors };
  }
  return null;
}

/** 确保 style#vv-code-theme 单节点存在（首次注入创建，后续复用）。 */
function ensureStyleEl(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.append(el);
  }
  return el;
}

/**
 * default 外观的注入体（即旧 applyCodeTheme 全量逻辑）：helix 代码主题表 + hljs
 * 近似映射。主题名不存在（残留下架主题等）→ console.warn 并回退该亮暗槽位的
 * 默认主题，不再"保持现状"——保持现状会让 UI 下拉与实际生效主题不一致。
 * 注入文本与 applyAppearance 引入前逐字节等价（单测 legacyExpectedText 与 e2e
 * 注释头断言共同锁定），勿改动格式。isCurrent（弃单守卫）：loadTables 等待期
 * 可能被更新的 applyAppearance 调用超越——await 恢复后、写 textContent 前核对，
 * 返回 false 即静默返回（不写 style）；fallback 递归透传同一守卫。
 */
async function injectCodeTheme(
  name: string,
  mode: 'light' | 'dark',
  isCurrent?: () => boolean
): Promise<void> {
  const tables = await loadTables();
  if (isCurrent && !isCurrent()) return; // 弃单守卫：已被更新调用超越，不写 style
  let theme = tables[name];
  if (!theme) {
    const fallback = DEFAULT_CODE_THEME[mode];
    console.warn(`未知代码主题：${name}，回退默认代码主题 ${fallback}`);
    if (fallback !== name && tables[fallback]) return injectCodeTheme(fallback, mode, isCurrent);
    return; // 默认主题也不在表内（themes.json 异常）：保持现状
  }
  const el = ensureStyleEl();
  // 整体替换 textContent（非追加）：切换主题零残留；span 类名不变 → 零重解析。
  // 同一节点内追加 --hljs-* 近似映射（M7）：hljs 兜底着色跟随当前代码主题
  el.textContent = `/* vviewer 代码主题：${name}（${mode}）——只换 CSS 变量，不重解析 */\n${THEME_ROOT_SELECTOR} {\n${themeToCssVars(theme, [...CODE_CAPTURES])}\n${hljsThemeVars(theme)}\n}`;
  el.dataset.mode = mode;
}

/**
 * 外观型（appearance ≠ default）注入：tokenColors 映射表接管代码槽——ts vars 与
 * hljs vars 均取自 TextMate→capture 映射结果（Task 1 vscode.ts），而非 helix 代码
 * 主题表；UI vars 段（colorsToUiVars 12 键白名单）仅此外观型才有。组装顺序：
 * 注释头 → UI vars → ts vars → hljs vars；某段为空（如主题无 colors）整段跳过
 * 不留空行；三段全空（validate 后仍可能：无 colors 且 tokenColors 均无
 * foreground）返回 false，由调用方回退 default 注入文案（T4 顺手项）。
 */
function injectAppearance(appearance: string, mode: 'light' | 'dark', json: VscodeThemeJson): boolean {
  const table = tokenColorsToThemeTable(json.tokenColors, CODE_CAPTURES);
  const sections = [
    colorsToUiVars(json.colors ?? {}).join('\n'),
    themeToCssVars(table, [...CODE_CAPTURES]),
    hljsThemeVars(table)
  ].filter((s) => s !== '');
  if (sections.length === 0) return false;
  const el = ensureStyleEl();
  el.textContent = `/* vviewer 外观主题：${appearance}（${mode}）——只换 CSS 变量，不重解析 */\n${THEME_ROOT_SELECTOR} {\n${sections.join('\n')}\n}`;
  el.dataset.mode = mode;
  return true;
}

// 外观注入并发序号与上次生效签名（spec 2026-10-12 §2.2）：monotonic token 弃单——
// 每个 await 恢复后比对序号，被更新调用超越即静默放弃（last-INITIATED 胜）；
// 签名仅在未被弃单、真正完成注入的同步段写入，供 applyAppearanceFromSettings diff。
let appearanceCallSeq = 0;
let lastAppearanceSig: string | null = null;

function appearanceSig(mode: 'light' | 'dark', appearance: string, codeTheme: string): string {
  return `${mode}|${appearance}|${codeTheme}`;
}

/**
 * 应用外观主题（spec B §2.1/2.2）：单节点 style#vv-code-theme 幂等注入。
 * 'default' 时退化为纯代码主题注入（与旧 applyCodeTheme 文本逐字节等价，不含
 * UI vars 段）；vscode/imported 时 UI+代码一物两用——appearance 非 default 时
 * 代码槽被接管，codeTheme 参数仅作 default 路径的代码主题。未知 ref（清单外 /
 * 未注册 imported）console.warn 一次并回退 default 路径；外观 json 三段全空
 * （无变量可注入）同样回退 default 文案但不 warn（非异常，只是无事可做）。
 * 并发序（spec 2026-10-12 §2.2）：monotonic token 弃单，last-INITIATED 胜——被
 * 更新调用超越的调用不写 style、不落签名；fallback 路径签名记 effective='default'
 * （注入文本的真实形态），订阅 diff 用「请求槽值」比对，非法槽值每次都会重注入
 * 一次 default 文本（幂等无害），换取签名恒等于注入真相。「被超越调用不写
 * style」由三层检查无条件成立（冷启动窗口已封死）：① resolveAppearance 恢复
 * 后的 token 检查（default 路径无此前置 await，由 ② 兜住）；② injectCodeTheme
 * 内 loadTables 恢复后、写 textContent 前的 isCurrent 守卫（fallback 递归
 * 透传）；③ 注入完成后的 token 检查护签名簿记。
 */
export async function applyAppearance(
  appearance: AppearanceRef,
  mode: 'light' | 'dark',
  codeTheme: string
): Promise<void> {
  const token = ++appearanceCallSeq;
  const json = appearance === 'default' ? null : await resolveAppearance(appearance);
  if (token !== appearanceCallSeq) return; // 已被更新调用超越：弃单，不写 style 不落签名
  if (json && injectAppearance(appearance, mode, json)) {
    lastAppearanceSig = appearanceSig(mode, appearance, codeTheme);
    return;
  }
  if (appearance !== 'default' && !json) console.warn(`未知外观主题：${appearance}，回退 default`);
  await injectCodeTheme(codeTheme, mode, () => token === appearanceCallSeq);
  if (token !== appearanceCallSeq) return; // loadTables 等待期被超越：注入文本已被更新调用覆写，只补签名
  lastAppearanceSig = appearanceSig(mode, 'default', codeTheme);
}

/** 旧入口（薄包装）：等价 applyAppearance('default', mode, name)，注入文本不变。 */
export async function applyCodeTheme(name: string, mode: 'light' | 'dark'): Promise<void> {
  return applyAppearance('default', mode, name);
}

/**
 * 订阅系统亮暗变化（themeMode=system 时重应用代码主题用）。
 * UI 配色由 app.css 的 prefers-color-scheme 媒体查询自动跟随；代码主题 CSS 变量
 * 是 JS 注入的，需要监听后按新亮暗槽位重应用。无 matchMedia 环境（jsdom/SSR）
 * 返回 no-op 解绑函数。
 */
export function onSystemModeChange(cb: (mode: 'light' | 'dark') => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {};
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const on = (e: MediaQueryListEvent): void => cb(e.matches ? 'dark' : 'light');
  mq.addEventListener('change', on);
  return () => mq.removeEventListener('change', on);
}

/** themeMode 的 system 解析为具体亮暗（无 matchMedia 环境，如 jsdom，回落 light）。 */
export function effectiveMode(themeMode: Settings['themeMode']): 'light' | 'dark' {
  if (themeMode !== 'system') return themeMode;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * 订阅触发入口（spec 2026-10-12 §2.1）：按 settings 计算生效四元组
 * (mode, appearance, codeTheme)，与上次注入签名 diff——仅槽相关变化才注入。
 * 口径为「生效值」而非「原始槽值」：system 的亮暗解析在 effectiveMode 内完成，
 * OS 亮暗切换（不经 saveSettings）同样命中 diff；excludedPatterns 等无关字段
 * 变化零注入。非法槽值注入期回退 default（applyAppearance 既有行为）后落
 * effective 签名——同一非法槽值重复触发会幂等重注入一次，无害。签名初值
 * null 仅保证首个 FromSettings 调用必注入；其他入口先直调 applyAppearance /
 * applyCodeTheme 不破坏正确性（其写入的签名即注入文本真相），onMount 无时序特权。
 */
export function applyAppearanceFromSettings(settings: Settings): void {
  const mode = effectiveMode(settings.themeMode);
  const appearance = mode === 'dark' ? settings.appearanceDark : settings.appearanceLight;
  const codeTheme = mode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight;
  const sig = appearanceSig(mode, appearance, codeTheme);
  if (sig === lastAppearanceSig) return;
  void applyAppearance(appearance, mode, codeTheme);
}
