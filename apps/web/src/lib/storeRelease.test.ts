import { describe, it, expect, vi } from 'vitest';
import { STORE_UID, type TreeStore } from '@bhxch/vviewer-core';
import { releaseStoreIfLast, sameStoreInstance, storeRetained } from './storeRelease';

/** 构造带/不带 close 的 store 桩：close 记录调用次数。 */
function mkStore(id: string, withClose: boolean): TreeStore {
  return {
    id,
    displayName: () => id,
    listChildren: async () => [],
    read: async () => new Uint8Array(),
    ...(withClose ? { close: vi.fn() } : {})
  } as TreeStore;
}

/** 远端 store 桩：注入与 remote.ts createRemoteStore 同形的实例身份令牌。 */
function mkRemoteStore(id: string, uid: number): TreeStore {
  const store = mkStore(id, true) as TreeStore & Record<typeof STORE_UID, number>;
  (store as Record<typeof STORE_UID, number>)[STORE_UID] = uid;
  return store;
}

const tabOf = (store: TreeStore) => ({ source: { store } });

describe('releaseStoreIfLast', () => {
  it('store 无 close（localfs/localfiles 等无 close 型）：no-op 不抛错', () => {
    const store = mkStore('localfiles:demo', false);
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

  it('CMP-02/2 令牌判定：$state 代理分裂（同实例异代理对象）仍认作持有者，不提前 close', () => {
    // 缺陷复现形状：remote store 实例 uid=1 的「代理 A」被目录 tab 持有，
    // 关文件 tab 传入的是同实例的「代理 B」——对象 === 为 false（copy-on-write
    // 重新包裹），令牌原值相等必须判同实例，否则 close() 清 remoteBaseById、
    // 重开同文件 computeSrc 缺失静默本地。
    const raw = mkRemoteStore('remote:abc', 1);
    const proxyA = { ...raw }; // 模拟重新包裹：同令牌不同对象
    const proxyB = { ...raw };
    releaseStoreIfLast([tabOf(proxyA as TreeStore)], proxyB as TreeStore);
    expect(proxyB.close).not.toHaveBeenCalled();
  });

  it('CMP-02/2 令牌判定：异实例（异 uid 同 id）不互认，照常 close', () => {
    const released = mkRemoteStore('remote:abc', 1);
    const alive = mkRemoteStore('remote:abc', 2); // 同 id 的另一实例（重连新实例）
    releaseStoreIfLast([tabOf(alive)], released);
    expect(released.close).toHaveBeenCalledTimes(1);
    expect(alive.close).not.toHaveBeenCalled();
  });
});

describe('sameStoreInstance（持有者判定的身份语义）', () => {
  it('令牌实例：同 uid 判同（对象不同）、异 uid 判异（对象相同也不互认）', () => {
    const a = mkRemoteStore('remote:x', 7);
    const aProxy = { ...a } as TreeStore; // 同实例异代理
    const b = mkRemoteStore('remote:x', 8);
    expect(sameStoreInstance(a, aProxy)).toBe(true);
    expect(sameStoreInstance(a, b)).toBe(false);
  });

  it('无令牌实例：退回对象身份（同名归档异实例不互认，既有裁决 M4 T7）', () => {
    const store = mkStore('archive:a.7z', true);
    const namesake = mkStore('archive:a.7z', true);
    expect(sameStoreInstance(store, store)).toBe(true);
    expect(sameStoreInstance(store, namesake)).toBe(false);
  });

  it('混合（一方无令牌）：对象不等即非同实例，不误判', () => {
    const remote = mkRemoteStore('remote:x', 3);
    const local = mkStore('localfs:demo', false);
    expect(sameStoreInstance(remote, local)).toBe(false);
  });
});

describe('storeRetained（撤销栈实例捕获判据，I-1）', () => {
  it('无 close 桩（localfs/localfiles/url 无 close 型）：捕获（close 不终结，实例恒存活）', () => {
    // 桩 id 须与真实类型的 close 形态一致：无 close 型仅 localfs/localfiles/single/url。
    // remote 实现 close（remote.ts close()，终结 SSE 流）属终结型不捕获；zip 同
    // （zipStore.ts close() 接线 libarchive worker）——不可用无 close 桩冒充其 id。
    expect(storeRetained(mkStore('localfs:demo', false))).toBe(true);
    expect(storeRetained(mkStore('localfiles:demo', false))).toBe(true);
    expect(storeRetained(mkStore('url:https://x', false))).toBe(true);
  });

  it('实现 close（libarchive worker 型）：跳过——将被 releaseStoreIfLast 终结，缓存即僵尸', () => {
    expect(storeRetained(mkStore('archive:a.7z', true))).toBe(false);
  });

  it('与 releaseStoreIfLast 的终结判据互补：retained 者永不触发 close', () => {
    // 桩 id 用无 close 型（localfs）：zip/archive 型实现 close、属终结型，
    // 不可用无 close 桩冒充其 id（同上注释口径）
    const store = mkStore('localfs:demo', false);
    expect(storeRetained(store)).toBe(true);
    releaseStoreIfLast([], store); // 无 close：终结路径 no-op
    expect(storeRetained(store)).toBe(true); // 实例仍可用
  });
});
