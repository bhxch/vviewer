// catalogs/en.ts — en 目录聚合（zh-CN.ts 同构：显式 spread 全部域文件 +
// MESSAGE_PACKS）。键集必须与 zh 全等（聚合机检 ③）、逐 key 占位符集合相等（④）。
import { messages as settings } from './en/settings';
import { messages as a11y } from './en/a11y';
import { messages as shell } from './en/shell';
import { messages as tabs } from './en/tabs';
import { messages as tree } from './en/tree';
import { messages as quickopen } from './en/quickopen';
import { messages as viewer } from './en/viewer';
import { messages as errors } from './en/errors';

/** domain→pack 记录（聚合机检逐域面；与 zh 同构） */
export const MESSAGE_PACKS = {
  settings,
  a11y,
  shell,
  tabs,
  tree,
  quickopen,
  viewer,
  errors
} as const;

export const messages = {
  ...settings,
  ...a11y,
  ...shell,
  ...tabs,
  ...tree,
  ...quickopen,
  ...viewer,
  ...errors
} as const;
