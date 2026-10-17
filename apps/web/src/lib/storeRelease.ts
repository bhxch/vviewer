import { storeInstanceUid, type TreeStore } from '@vviewer/core';

/**
 * worker 型 store 的释放接线（M4 T7）：被关 tab 持有的 store 若实现了 close()
 * （remote：停 SSE + 清资源表；libarchive：终止 worker + 释放 wasm 堆）且已无
 * 其他 tab 持有同一实例，则关闭之。
 * 独立纯函数（终审 M4 deferred minor：可不经 Svelte runes 模块直接单测）；
 * openFlow 的 TabCollection.close 以当前 tab 列表调用。
 *
 * 持有者判定用 [`sameStoreInstance`]（令牌优先）而非裸对象身份：tab 列表是
 * $state 深代理，copy-on-write 变更（activate 写 active、refreshPaths 写 rev）
 * 会把未变字段连同 store 一起重新包裹——同一实例的两个代理对象身份不等。
 * 实测后果（CMP-02/2 关标签重开，2026-10-17）：关掉文件 tab 时同 store 的目录
 * tab 未被认作持有者 → remote store 被提前 close()（remoteBaseById 清登记）→
 * 重开同文件 computeSrc 缺失，高亮静默落本地（状态栏「执行: 本地」与策略相悖）。
 */
export function releaseStoreIfLast(
  tabs: ReadonlyArray<{ source: { store: TreeStore } }>,
  store: TreeStore
): void {
  if (typeof store.close !== 'function') return;
  if (tabs.some((t) => sameStoreInstance(t.source.store, store))) return;
  store.close();
}

/** 同一 store 实例判定：令牌实例（remote）按单调 uid 原值比较（对 $state 深代理
 * 免疫，见上）；无令牌实例（localfs/localfiles/single/url/归档）退回对象身份——
 * 同名归档 id 相同而实例不同，不得互认持有者（既有裁决，M4 T7）。 */
export function sameStoreInstance(a: TreeStore, b: TreeStore): boolean {
  if (a === b) return true;
  const uid = storeInstanceUid(a);
  return uid !== null && uid === storeInstanceUid(b);
}

/**
 * 撤销栈实例捕获判据（F 项 fix round 1，I-1）：worker 型 store（实现 close()）在
 * 最后一个持有 tab 关闭时被 releaseStoreIfLast 终结（worker/wasm 堆已释放）——
 * 缓存其实例会让撤销重建拿到僵尸 store。仅无 close 的实例（close 不终结，对象恒存活：
 * localfs/localfiles/single/url）可被 ClosedTabEntry.store 捕获，撤销重建时
 * storeById 摘除注册表项后仍能复用拿回内容。与 releaseStoreIfLast 的终结判据
 * （typeof close === 'function'）互为反面的同一出处，改一处须对另一处。
 */
export function storeRetained(store: TreeStore): boolean {
  return typeof store.close !== 'function';
}
