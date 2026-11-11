// core.ts — i18n 纯 TS 核心（设计 §4.2 / D4 双模块裁决）：目录查表、translate、
// locale 纯变量与发布订阅全部落本文件——根 vitest 无 svelte 插件，纯 .ts 模块
// 导入含 $state 的 .svelte.ts 直接 ReferenceError（实测），且 vitest 直测纯模块
// 禁 runes（仓库 AGENTS.md 后缀纪律），故响应式镜像拆在 index.svelte.ts 胶水，
// 本文件保持零 runes 可直测。
//
// 消费契约（Interfaces 钉死，Task 4-10 全量消费）：
// - 纯 .ts：`import { translate as t } from '.../i18n/core'`（同 t() 签名，非响应式
//   ——调用时取当下 locale，切换后对新消息生效）；
// - 组件/.svelte.ts：`import { t, setLocale, getLocale } from '.../i18n/index.svelte'`。
import { messages as enMessages } from './catalogs/en';
import { messages as zhMessages } from './catalogs/zh-CN';

/** locale 全集（D3：默认 zh-CN，不设 'auto'——CI 浏览器默认 locale 为 en-US，
 * auto 语义会使全量 e2e 中文锚整体翻转；en 覆盖是显式升级路径） */
export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export type MessageCatalog = Record<string, string>;

/** 从文案串推导占位符名集合（aelrova t.ts 逐字移植）：'{page} / {total} 页' → 'page' | 'total' */
export type Placeholders<S extends string> =
  S extends `${string}{${infer K}}${infer Rest}` ? K | Placeholders<Rest> : never;

/**
 * 规范签名（aelrova t.ts 逐字移植）：无占位符文案 args 为空元组（禁止传参），
 * 有占位符文案 args 为单一参数对象（键与占位符严格对齐——传错名即编译失败，
 * 占位符名由模板字面量类型从文案串推导）。
 */
export type TFunction<M extends MessageCatalog> = <K extends Extract<keyof M, string>>(
  key: K,
  ...args: Placeholders<M[K]> extends never
    ? readonly []
    : readonly [{ readonly [P in Placeholders<M[K]>]: string | number }]
) => string;

/** 全量 zh 目录 key 集（Interfaces：key: MessageKey = keyof typeof 全量 zh 目录；
 * en 键集与 zh 全等由 catalogs.aggregate.test.ts 机检锁死） */
export type MessageKey = keyof typeof zhMessages;

const CATALOGS: Record<Locale, MessageCatalog> = { 'zh-CN': zhMessages, en: enMessages };

/**
 * 双级查表（translate 的纯核，aelrova lookup.ts 同构）：locale 缺键回落 'zh-CN'
 * （D15 安全网——回落机制是安全网不是欠账通道，全量覆盖由聚合机检锁），两侧皆缺
 * 返回 undefined（translate 据此抛错）。catalogs 参数仅供单测注入模拟目录
 * （「en 缺键回落」在交付态 en 键集==zh 键集的目录上不可构造，core.test.ts 注入
 * 缺键目录直测机制），生产路径零传参。
 */
export function lookupMessage(
  locale: Locale,
  key: string,
  catalogs: Readonly<Record<Locale, MessageCatalog>> = CATALOGS
): string | undefined {
  return catalogs[locale]?.[key] ?? catalogs['zh-CN']?.[key];
}

/** 替换 {placeholder}（aelrova interpolate 逐字移植：未提供的占位符保留原样，漏参可发现） */
export function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return template;
  return template.replaceAll(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

// ---------- locale 状态（纯变量 + 发布订阅；响应式镜像在 index.svelte.ts） ----------

let currentLocale: Locale = 'zh-CN';

export function getLocale(): Locale {
  return currentLocale;
}

type LocaleListener = (locale: Locale) => void;

const localeListeners = new Set<LocaleListener>();

/** locale 写入（纯变量侧）：响应式镜像由 index.svelte.ts 的 setLocale 双写 $state */
export function setLocaleInternal(locale: Locale): void {
  currentLocale = locale;
  for (const cb of localeListeners) cb(locale);
}

/** 订阅 locale 变更（非响应式消费方在切换后显式重取的通道）；返回退订函数 */
export function onChange(cb: LocaleListener): () => void {
  localeListeners.add(cb);
  return () => localeListeners.delete(cb);
}

/**
 * 纯层 translate（Interfaces 钉死签名）：查表 + 插值，未知 key 抛错
 * （aelrova「未知 key 抛错」同款——错误信息内联 key 便于定位目录缺口）。
 */
export const translate = ((key: string, ...args: readonly unknown[]) => {
  const template = lookupMessage(currentLocale, key);
  if (template === undefined) throw new Error(`i18n: 未知文案 key（${key}）`);
  return interpolate(template, args[0] as Readonly<Record<string, string | number>> | undefined);
}) as TFunction<typeof zhMessages>;
