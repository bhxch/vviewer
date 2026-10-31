import type { Tab } from './openFlow.svelte';
import type { WorkspaceSource } from './workspaceStore';

/**
 * 行内来源徽标（T6；多根 spec Task 1 改语义）：仅多源 workspace 显示（单源省略），
 * 且只给已登记来源的 tab——openFiles 的单文件 tab 不登记来源，无徽标（名称即身份）。
 * 消歧语义：徽标从「多源恒显 storeLabel」改为「同名跨源才显」——恒显使每个标签
 * 都带前缀、视觉拥挤；仅当本组内存在另一已登记来源的 tab 与本 tab 同名（无法只凭
 * 名称分辨来自哪个源）时，才显示 storeLabel 区分。冲突名册（tabs）只含已登记来源
 * 的 tab，未登记 storeId 的同名 tab 不触发冲突；同源内 duplicate 同名 tab 不算冲突。
 * 远端单文件来源（遗留项 E-徽标）：storeLabel 即文件名 basename，文件 tab 的
 * 徽标与 tab 名同文退化重复——仅该形态抑制（remote + 文件 tab）；目录 tab
 * （path===''）的 name 本就是 displayName、与 label 同文属常态（WS-02 锁定），
 * 不受影响。tab 形状无法区分「单文件来源」与「目录源内文件名恰与源 label 同文」
 * 的病理形态，后者被一并抑制（缺徽标，可接受）。显示层修复：storeLabel 参与
 * storeId hash，不可改值。此为有意抑制，勿当 bug 重报（终审 R-2 留痕）。
 */
export function badgeOf(sources: WorkspaceSource[], tabs: Tab[], tab: Tab): string | null {
  if (sources.length < 2) return null;
  const eligible = tabs.filter((t) => sources.some((s) => s.storeId === t.source.storeId));
  const conflict = eligible.some(
    (t) => t.source.name === tab.source.name && t.source.storeId !== tab.source.storeId
  );
  if (!conflict) return null;
  const src = sources.find((s) => s.storeId === tab.source.storeId);
  const label = src?.storeLabel ?? null;
  if (src?.kind === 'remote' && tab.source.path !== '' && label === tab.source.name) return null;
  return label;
}
