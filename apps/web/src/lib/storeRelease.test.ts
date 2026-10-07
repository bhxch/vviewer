import { describe, it, expect, vi } from 'vitest';
import type { TreeStore } from '@vviewer/core';
import { releaseStoreIfLast } from './storeRelease';

/** 构造带/不带 close 的 store 桩：closeClose 记录调用次数。 */
function mkStore(id: string, withClose: boolean): TreeStore {
  return {
    id,
    displayName: () => id,
    listChildren: async () => [],
    read: async () => new Uint8Array(),
    ...(withClose ? { close: vi.fn() } : {})
  } as TreeStore;
}

const tabOf = (store: TreeStore) => ({ source: { store } });

describe('releaseStoreIfLast', () => {
  it('store 无 close（zip/localfiles 等）：no-op 不抛错', () => {
    const store = mkStore('zip:a.zip', false);
    expect(() => releaseStoreIfLast([tabOf(store)], store)).not.toThrow();
  });

  it('无其他 tab 持有：close 恰调用一次（被关 tab 已先从列表移除）', () => {
    const store = mkStore('archive:a.7z', true);
    // 真实调用序：TabCollection.close 先 splice 掉被关 tab，再以余下列表调用
    releaseStoreIfLast([], store);
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it('仍有其他 tab 持有同一实例：不 close', () => {
    const store = mkStore('archive:a.7z', true);
    const other = tabOf(store); // 另一 tab 持有同一 store 对象
    releaseStoreIfLast([other], store);
    expect(store.close).not.toHaveBeenCalled();
  });

  it('同名不同实例（对象身份判定）：close', () => {
    const store = mkStore('archive:a.7z', true);
    const namesake = mkStore('archive:a.7z', true); // 同 id 的不同实例仍被其他 tab 持有
    releaseStoreIfLast([tabOf(namesake)], store);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(namesake.close).not.toHaveBeenCalled();
  });
});
