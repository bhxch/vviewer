import type { OutlineEntry } from '@bhxch/vviewer-highlight';

/**
 * 大纲门限截断（>2000 条折叠 + 展开全部）：2MB python 可产数千定义行，OutlineView
 * 全量 li+button 渲染 + activeLine 变化全行重求值在数千条时卡顿——未展开时显示集
 * 恒取前 OUTLINE_TRUNCATE_LIMIT 条，截断提示 + 「全部展开」一键取消切片。
 * 常量自诞生即导出（B10 教训：门限值/文案埋在组件内不可对齐，消费方与 e2e 只能散抄
 * 魔法数）；切片纯函数单点在册，渲染端（AppShell → OutlineView entries）与滚动跟随
 * 二分端（AppShell 跟随 effect）同吃一份，截断态高亮落点必有对应渲染行。
 */

/** 截断门限：显示集上限（恰等于门限不截断） */
export const OUTLINE_TRUNCATE_LIMIT = 2000;

// Task 10 域 G：截断提示与「全部展开」文案迁移 i18n viewer.outline.*（OutlineView
// 内 t() 现取，目录值带 {limit} 占位）。原模块级 TEXT 常量在装配时刻锁 locale
// （Task 7/8 提示常量裁决同款问题），故删除；文案单点语义由目录值承载，本文件
// 保留门限数值与切片算法单点。

/**
 * 门限截断显示集：未展开且超门限时取前 OUTLINE_TRUNCATE_LIMIT 条，其余（未超门限
 * 或已展开）原数组透传（引用稳定——Svelte keyed each 前 N 个 key 不变仅追加节点，
 * 派生 diff 不触发无谓重建）。文档序 = line 升序（T1 输出契约），前 N 条即行号最
 * 小的前缀，跟随二分在此前缀上落点恒有渲染行可挂。
 */
export function outlineDisplaySlice(entries: OutlineEntry[], expanded: boolean): OutlineEntry[] {
  if (expanded || entries.length <= OUTLINE_TRUNCATE_LIMIT) return entries;
  return entries.slice(0, OUTLINE_TRUNCATE_LIMIT);
}
