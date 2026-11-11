// index.svelte.ts — i18n 响应式胶水（D4 双模块裁决的 .svelte.ts 侧）：$state
// locale 镜像 + t() 包装（读 $state 后委托 core.translate）+ setLocale 双写。
// 组件/.svelte.ts 消费契约（Interfaces 钉死）：
//   `import { t, setLocale, getLocale } from '.../i18n/index.svelte'`
// 硬约束：本文件不得被 vitest 直测导入（根 vitest 无 svelte 插件，$state 在纯
// .ts 加载链上 ReferenceError——仓库先例），形态由 index.svelte.contract.test.ts
// 文本锚锁死；全部单测落 core.ts（纯侧）。
import {
  getLocale as coreGetLocale,
  setLocaleInternal,
  translate as coreTranslate,
  type Locale,
  type TFunction
} from './core';
import { messages as zhMessages } from './catalogs/zh-CN';

export type { Locale, MessageKey, MessageCatalog, Placeholders, TFunction } from './core';

/** locale 的 $state 镜像（初值取 core 当前值；启动接线 AppShell→setLocale 前为
 * zh-CN 缺省兜底，与 app.html 静态 lang="zh-CN" 同口径） */
let locale = $state<Locale>(coreGetLocale());

type LooseTranslate = (key: string, ...args: readonly unknown[]) => string;
const coreTranslateLoose = coreTranslate as unknown as LooseTranslate;

/**
 * 响应式 t（Interfaces 钉死签名，同 core.translate）：读 $state locale 锚定响应式
 * 依赖——模板/effect 内调用自动追踪，locale 切换即重渲；查表插值委托 core 纯层。
 */
export const t = ((key: string, ...args: readonly unknown[]) => {
  void locale; // 依赖锚：模板内 t() 必须读到 $state locale 才能被追踪
  return coreTranslateLoose(key, ...args);
}) as TFunction<typeof zhMessages>;

/** 响应式 locale 读取（组件/.svelte.ts 面；纯 .ts 用 core.getLocale） */
export function getLocale(): Locale {
  return locale;
}

/**
 * 响应式 locale 写入（D3）：$state 镜像（模板重渲）+ core 纯变量（format.ts 等
 * 非响应式模块取当下值）+ html[lang] 同步（静态兜底 zh-CN 运行时覆盖）。
 * SSR/构建期无 document，守卫跳过。
 */
export function setLocale(l: Locale): void {
  locale = l;
  setLocaleInternal(l);
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}
