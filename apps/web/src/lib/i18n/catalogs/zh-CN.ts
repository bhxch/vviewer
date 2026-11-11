// catalogs/zh-CN.ts — zh 目录聚合（D5）：显式 spread 全部域文件（禁通配/动态
// 注入——spread 静默覆盖同名 key 时总计数必不等，由 catalogs.aggregate.test.ts
// 机检 ① 锁死）。MESSAGE_PACKS（domain→pack 记录）供聚合机检逐域计数与首段锁
// （②）。Task 4-10 逐域追加：新增域文件 import + MESSAGE_PACKS/messages 两处登记。
// 本文件是「禁直读 catalogs」ESLint 规则（D6，Task 10 激活）在 i18n 包内的
// 豁免点之一；消费方一律经 ../core（纯）或 ../index.svelte（响应式）。
import { messages as settings } from './zh-CN/settings';
import { messages as a11y } from './zh-CN/a11y';
import { messages as shell } from './zh-CN/shell';
import { messages as tabs } from './zh-CN/tabs';

/** domain→pack 记录（聚合机检逐域面；键序即注册序，无运行时注入层——单 app 直读目录） */
export const MESSAGE_PACKS = {
  settings,
  a11y,
  shell,
  tabs
} as const;

export const messages = { ...settings, ...a11y, ...shell, ...tabs } as const;
