import { describe, it, expect, vi } from 'vitest';
import type { TreeStore } from '@vviewer/core';
import { releaseStoreIfLast, storeRetained } from './storeRelease';

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

describe('storeRetained（撤销栈实例捕获判据，I-1）', () => {
  it('无 close（zip/localfiles/remote/url/single）：捕获（close 不终结，实例恒存活）', () => {
    expect(storeRetained(mkStore('localfs:demo', false))).toBe(true);
    expect(storeRetained(mkStore('remote:abcd1234', false))).toBe(true);
    expect(storeRetained(mkStore('url:https://x', false))).toBe(true);
  });

  it('实现 close（libarchive worker 型）：跳过——将被 releaseStoreIfLast 终结，缓存即僵尸', () => {
    expect(storeRetained(mkStore('archive:a.7z', true))).toBe(false);
  });

  it('与 releaseStoreIfLast 的终结判据互补：retained 者永不触发 close', () => {
    const store = mkStore('zip:a.zip', false);
    expect(storeRetained(store)).toBe(true);
    releaseStoreIfLast([], store); // 无 close：终结路径 no-op
    expect(storeRetained(store)).toBe(true); // 实例仍可用
  });
});
