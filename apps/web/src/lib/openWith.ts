// openWith.ts — 「打开方式」下拉候选构造（C 项入口 B）。
// 自 ViewerPane 提取为纯函数（无 runes/DOM 依赖）以便单测；registry 由调用方
// （ViewerPane）传入，Tab.overrideRenderer 以标量入参传递——避免引入 .svelte.ts
// 运行时模块（根 vitest 无 svelte 插件，先例见 metaStore.test.ts）。
import type { Registry } from '@vviewer/core';
import type { FileOpenWith } from './metaStore.svelte';

/** 候选 =「自动」+ 生效渲染器 ∪ 扩展名注册渲染器 ∪ code/markdown/hex（去重）。
 * 存在性守卫：registry.byId 未命中的 id 一律不进候选——dispatch 渲染失败返回的
 * 'error' id（registry 无此渲染器）由此滤除，label 不回退英文 id；错误卡片场景
 * current 维持 ''（自动）。detExt 为 ''（无扩展名/选路失败纠偏后仍空）时跳过
 * 扩展名候选，恒兜底 code/markdown/hex。 */
export function openWithOf(
  registry: Pick<Registry, 'byId' | 'all'>,
  overrideRenderer: string | undefined,
  rendererId: string,
  detExt: string
): FileOpenWith {
  const seen = new Set<string>(['']);
  const options: { id: string; label: string }[] = [{ id: '', label: '自动（按扩展名）' }];
  const push = (id: string): void => {
    if (seen.has(id)) return;
    const r = registry.byId(id);
    if (!r) return; // 守卫：'error' 等未注册 id 不进下拉
    seen.add(id);
    options.push({ id, label: r.label });
  };
  push(rendererId);
  for (const r of registry.all()) {
    if (detExt !== '' && r.extensions.includes(detExt)) push(r.id);
  }
  push('code');
  push('markdown'); // markdown 恒兜底（spec §3.1）：任何文件值得试 markdown 渲染，先例=hex 对 .md 出现
  push('hex');
  const all = registry.all().map((r) => ({ id: r.id, label: r.label }));
  return { current: overrideRenderer ?? '', manual: overrideRenderer !== undefined, options, all };
}
