import type { Tab } from './openFlow.svelte';
import type { WorkspaceSource } from './workspaceStore';

/**
 * 行内来源徽标（T6）：仅多源 workspace 显示（单源省略），且只给已登记来源的
 * tab——openFiles 的单文件 tab 不登记来源，无徽标（名称即身份）。
 * 远端单文件来源（遗留项 E-徽标）：storeLabel 即文件名 basename，文件 tab 的
 * 徽标与 tab 名同文退化重复——仅该形态抑制（remote + 文件 tab）；目录 tab
 * （path===''）的 name 本就是 displayName、与 label 同文属常态（WS-02 锁定），
 * 不受影响。tab 形状无法区分「单文件来源」与「目录源内文件名恰与源 label 同文」
 * 的病理形态，后者被一并抑制（缺徽标，可接受）。显示层修复：storeLabel 参与
 * storeId hash，不可改值。
 */
export function badgeOf(sources: WorkspaceSource[], tab: Tab): string | null {
  if (sources.length < 2) return null;
  const src = sources.find((s) => s.storeId === tab.source.storeId);
  const label = src?.storeLabel ?? null;
  if (src?.kind === 'remote' && tab.source.path !== '' && label === tab.source.name) return null;
  return label;
}
