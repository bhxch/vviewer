import type { Tab } from './openFlow.svelte';
import type { WorkspaceSource } from './workspaceStore';

/**
 * 行内来源徽标（T6）：仅多源 workspace 显示（单源省略），且只给已登记来源的
 * tab——openFiles 的单文件 tab 不登记来源，无徽标（名称即身份）。
 * 远端单文件来源的 storeLabel 即文件名 basename，与 tab 名同文，徽标退化为
 * 重复——同文时不显示（显示层修复：storeLabel 参与 storeId hash，不可改值）。
 */
export function badgeOf(sources: WorkspaceSource[], tab: Tab): string | null {
  if (sources.length < 2) return null;
  const label = sources.find((s) => s.storeId === tab.source.storeId)?.storeLabel ?? null;
  return label !== null && label !== tab.source.name ? label : null;
}
