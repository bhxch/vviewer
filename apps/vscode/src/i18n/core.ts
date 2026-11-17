// core.ts — 扩展 i18n 纯层门面（spec H T2）。
//
// 纪律（沿 docs/design/frontend-conventions.md §3.1/§3.4）：
// - 消费方一律经本模块的 `t()` / `translate()` 取值，**禁直读 catalogs**（ESLint
//   `no-restricted-imports` 执法：`apps/vscode/src/**` 覆盖块，catalogs 目录本体豁免）。
// - key 三段 `{域}.{模块}.{语义}`；域为扩展自有四域（shell / viewer / notice / errors）。
// - zh/en 键集逐键对齐（编译期由 en.ts 的 `Record<keyof typeof zhCN, string>` 锁），
//   占位符集合逐键相等（运行期由 i18n.test.ts 锁）。
// - 非显示串禁入目录：event kind / 枚举 / id 等稳定标识符不进目录。
//
// locale 来源：VSCode 的 `vscode.env.language`（host 侧在 activate 时读入并经
// `setLocale(pickLocale(language))` 注入）——**本模块保持 vscode-free**（`import * as
// vscode from 'vscode'` 在运行时不存在，vitest 直解析会红——评审订正⑧同款纪律）。
//
// 已知边界（非响应式，同 apps/web 纯层口径）：locale 切换只对新消息生效，历史消息不回写。
import { en } from './catalogs/en';
import { zhCN } from './catalogs/zh-CN';

/** 扩展 i18n 键（以 zh-CN 目录为键集单源） */
export type MessageKey = keyof typeof zhCN;

/** 占位符参数值 */
export type MessageParams = Record<string, string | number>;

/** 扩展自有 locale 集 */
export type Locale = 'zh-CN' | 'en';

/** 双目录（zh-CN 为键集单源，en 由编译期对齐约束） */
export const CATALOGS: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  en
};

/**
 * locale 选取：`zh*` → zh-CN，其余 → en（计划 i18n 条目）。
 * 例：`zh-CN` / `zh` / `zh-TW` → zh-CN；`en-US` / `de` / undefined → en。
 */
export function pickLocale(language: string | undefined | null): Locale {
  return typeof language === 'string' && language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 当前 locale（host 侧在 activate 时经 setLocale 注入） */
let currentLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * 取文案。未知 key 回落 key 本身（可发现，不静默空串）；未提供的占位符保留 `{name}` 原样。
 */
export function translate(key: MessageKey, params?: MessageParams, locale?: Locale): string {
  const table = CATALOGS[locale ?? currentLocale];
  const template = table[key] ?? CATALOGS['zh-CN'][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params?.[name];
    return value === undefined ? match : String(value);
  });
}

/** 当前 locale 下的取文案（消费方主入口） */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(key, params, currentLocale);
}
