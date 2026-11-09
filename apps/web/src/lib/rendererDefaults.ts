// rendererDefaults.ts — 设置中心「打开方式」节的纯函数层（无 runes/DOM，vitest 直测）。
// 行集由注册表派生：注册表每扩展名唯一所有者，多渲染器格式必然来自 altExtensions
// 候选声明——「有所有者且至少一个候选」的扩展名成行。偏好落 settings.rendererDefaults，
// 由 viewer.ts 注入 registry.setPreferenceResolver 生效。
import type { Registry } from '@bhxch/vviewer-core';

/** 「打开方式」节的一行：扩展名 + 内置默认（所有者）+ 可改选的候选渲染器 */
export interface MultiRendererFormat {
  ext: string;
  owner: { id: string; label: string };
  alternatives: { id: string; label: string }[];
}

/** 列出全部多渲染器格式（按扩展名升序；候选按安装序）。无所有者的候选扩展名不成行
 * ——registry.byExtension 对无所有者扩展名不应用偏好（未知扩展名走探测链）。 */
export function multiRendererFormats(registry: Pick<Registry, 'all' | 'ownerOf' | 'candidatesOf'>): MultiRendererFormat[] {
  const exts = new Set<string>();
  for (const r of registry.all()) for (const e of r.altExtensions ?? []) exts.add(e.toLowerCase());
  const rows: MultiRendererFormat[] = [];
  for (const ext of [...exts].sort()) {
    const owner = registry.ownerOf(ext);
    if (!owner) continue;
    const alternatives = registry
      .candidatesOf(ext)
      .filter((r) => r !== owner)
      .map((r) => ({ id: r.id, label: r.label }));
    if (alternatives.length > 0) rows.push({ ext, owner: { id: owner.id, label: owner.label }, alternatives });
  }
  return rows;
}

/** 下拉显示值：偏好是该行候选之一时原样，否则（缺省/''/所有者 id/陈旧 id）显示
 * 内置默认 ''——与 registry.byExtension「非候选回落所有者」的生效语义一致。 */
export function selectedDefault(prefs: Readonly<Record<string, string>>, row: MultiRendererFormat): string {
  const id = prefs[row.ext];
  return id !== undefined && row.alternatives.some((a) => a.id === id) ? id : '';
}
