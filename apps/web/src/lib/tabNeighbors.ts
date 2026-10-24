/**
 * tabNeighbors.ts — 关闭/批量关闭后的激活邻位选择（FE-1 自 openFlow.svelte.ts
 * 的 TabCollection 抽出的纯函数，tabOrder.ts 同款「纯逻辑抽 .ts 以便 jsdom
 * 单测」先例——root vitest 无 svelte 插件，runes 模块内的算法不可直测）。
 * 语义与原内联实现逐字同源（先右后左取最近邻，组内作用域不跨组抢激活）。
 */

/**
 * 关闭活动 tab 后的邻位选择（TabCollection.close 消费）：在关闭后的列表上自
 * 关闭位起先右后左找同 workspace 组内最近邻 id——多根下激活限同组（不跨组抢
 * 激活；单工作区时右邻/左邻即旧的 list[min(i, len-1)]，行为一致）；组内无存活
 * 邻位（全组关闭）返回 null。
 */
export function neighborAfterClose(
  tabs: ReadonlyArray<{ id: string; workspaceId: string }>,
  closedIndex: number,
  workspaceId: string
): string | null {
  for (let j = closedIndex; j < tabs.length; j++) {
    if (tabs[j]!.workspaceId === workspaceId) return tabs[j]!.id;
  }
  for (let j = closedIndex - 1; j >= 0; j--) {
    if (tabs[j]!.workspaceId === workspaceId) return tabs[j]!.id;
  }
  return null;
}

/**
 * 批量关闭后的激活对齐（TabCollection.alignActivationAfterBatch 消费）：原活动
 * tab 已在批量中关闭时，按关闭前的组序先右后左找最近存活邻位 id（与单关 close()
 * 的邻位语义一致——级联激活的中间态不可靠，故对齐基于关闭前快照）；无存活邻位
 * 返回 null（调用方不动激活）。「原活动仍存活则不动」的前置守卫在调用方
 * （TabCollection 对全局 list 判存活）。
 */
export function neighborAfterBatch(
  beforeIds: ReadonlyArray<string>,
  survivorIds: ReadonlySet<string>,
  prevActiveId: string
): string | null {
  const from = beforeIds.indexOf(prevActiveId);
  let neighbor: string | null = null;
  for (let j = from + 1; j < beforeIds.length; j++) {
    if (survivorIds.has(beforeIds[j]!)) {
      neighbor = beforeIds[j]!;
      break;
    }
  }
  if (neighbor === null) {
    for (let j = from - 1; j >= 0; j--) {
      if (survivorIds.has(beforeIds[j]!)) {
        neighbor = beforeIds[j]!;
        break;
      }
    }
  }
  return neighbor;
}
