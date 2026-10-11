/**
 * tab 动作层的纯数学（浏览器式 tab 管理计划 T1）：组内重排/pinned 区拆分/撤销关闭栈。
 * 根 vitest 无 svelte 插件，.svelte.ts 不可直测——本模块刻意保持纯逻辑零依赖
 * （仅 type 引 TabSnapshot），由 tabActions.test.ts 直测；openFlow.svelte.ts 的
 * TabCollection 方法消费这些函数再落 $state。
 */
import type { TabSnapshot } from './stores/session';

// ---------- pinned 区拆分与重排 ----------

/**
 * 按 pinned 集合把组内 id 序拆成 pinned/normal 两段（各自保持相对序）。
 * 前置：调用方（TabCollection）维护「pinned 区靠左连续」不变式；本函数不修复乱序输入。
 */
export function splitPinned(
  ids: ReadonlyArray<string>,
  pinnedSet: ReadonlySet<string>
): { pinnedIds: string[]; normalIds: string[] } {
  const pinnedIds: string[] = [];
  const normalIds: string[] = [];
  for (const id of ids) (pinnedSet.has(id) ? pinnedIds : normalIds).push(id);
  return { pinnedIds, normalIds };
}

/**
 * 组内拖拽重排：把 fromId 移到 toId 之前（before）/之后（!before）。
 * 跨 pinned 区边界拒绝返回 null——落点不得把两区分割：
 * - 普通 tab 的插入点落在 pinned 区内部（< 剩余 pinned 数）→ null；
 *   pinned 区尾之后（= 第一个普通位）及以右受理。
 * - pinned tab 的插入点越过 pinned 区尾（> 剩余 pinned 数）→ null；区内任意位受理。
 * fromId === toId 或 id 不在列表内同样返回 null（无动作）。前置：ids 满足 pinned 靠左不变式。
 */
export function reorderIds(
  ids: ReadonlyArray<string>,
  fromId: string,
  toId: string,
  before: boolean,
  pinnedSet: ReadonlySet<string>
): string[] | null {
  if (fromId === toId) return null;
  if (!ids.includes(fromId) || !ids.includes(toId)) return null;
  const rest = ids.filter((id) => id !== fromId);
  const targetIdx = rest.indexOf(toId); // 移除后重找：fromId 在 toId 左侧时落点整体左移一位
  if (targetIdx < 0) return null;
  const insertAt = before ? targetIdx : targetIdx + 1;
  const pinnedCount = rest.reduce((n, id) => (pinnedSet.has(id) ? n + 1 : n), 0);
  if (!pinnedSet.has(fromId) && insertAt < pinnedCount) return null;
  if (pinnedSet.has(fromId) && insertAt > pinnedCount) return null;
  rest.splice(insertAt, 0, fromId);
  return rest;
}

/**
 * pin/unpin 置位后的组内重排（pinnedSet 须已反映置位后的状态）：
 * pinned 区靠左且区内保持相对序——pin 的新 tab 因原在普通区自然落到 pinned 区尾
 * （与浏览器固定行为一致）；unpin 的新普通 tab 落普通区首位。
 */
export function regroupPinned(
  ids: ReadonlyArray<string>,
  tabId: string,
  nowPinned: boolean,
  pinnedSet: ReadonlySet<string>
): string[] {
  const { pinnedIds, normalIds } = splitPinned(ids, pinnedSet);
  if (nowPinned) return [...pinnedIds, ...normalIds];
  return [...pinnedIds, tabId, ...normalIds.filter((id) => id !== tabId)];
}

// ---------- 撤销关闭栈（纯数据结构，openFlow 的 pushClosed/reopenClosed 消费） ----------

/** 撤销栈容量：超出淘汰最旧（栈底）。 */
export const CLOSED_STACK_MAX = 10;

/** 撤销栈元素：关闭瞬间的会话快照 + 所属工作区（reopenClosed 的重建依据）。 */
export type ClosedTabEntry = TabSnapshot & { workspaceId: string };

/**
 * 撤销关闭栈：LIFO + 容量淘汰（超 max 弹掉栈底最旧）。
 * 纯数据结构（泛型，元素形状由消费方约束），与 runes 无关可直测。
 */
export class ClosedStack<T> {
  private items: T[] = [];

  constructor(readonly max: number = CLOSED_STACK_MAX) {}

  push(entry: T): void {
    this.items.push(entry);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  /** 栈空返回 null（区别于元素可能为假的形状，调用方以此判无动作）。 */
  pop(): T | null {
    return this.items.pop() ?? null;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
