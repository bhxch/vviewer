import type { TreeStore } from '@vviewer/core';

/**
 * worker 型 store 的释放接线（M4 T7）：被关 tab 持有的 store 若实现了 close()
 * （libarchive：终止 worker + 释放 wasm 堆）且已无其他 tab 持有同一实例，则关闭之。
 * 以对象身份比较而非 storeId——同名归档会产生 id 相同的不同实例；
 * zip/localfiles 等 store 无 close，可选调用为 no-op。
 * 独立纯函数（终审 M4 deferred minor：可不经 Svelte runes 模块直接单测）；
 * openFlow 的 TabCollection.close 以当前 tab 列表调用。
 */
export function releaseStoreIfLast(
  tabs: ReadonlyArray<{ source: { store: TreeStore } }>,
  store: TreeStore
): void {
  if (typeof store.close !== 'function') return;
  if (tabs.some((t) => t.source.store === store)) return;
  store.close();
}
