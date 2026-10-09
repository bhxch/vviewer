import { describe, it, expect, vi } from 'vitest';

// globalSearch.test.ts — BUG-11/CMP-11：截断引导文案的裁决纯函数。
// globalSearch.ts 经 openFlow.svelte.ts 间接依赖 svelte runes（$state），vitest 无
// svelte 插件无法编译该模块——以 vi.mock 隔离（本测试只验证 serverSearchHint 裁决，
// 路由/搜索主链路由 e2e CMP-08~11 覆盖）。

vi.mock('./openFlow.svelte', () => ({
  loadLastServer: () => null,
  loadCapabilities: () => []
}));

import type { TreeStore } from '@vviewer/core';
import { isRemoteStore, serverSearchHint, SERVER_SEARCH_HINT } from './globalSearch';

function makeStore(id: string, withWatch: boolean): TreeStore {
  return {
    id,
    displayName: () => id,
    listChildren: async () => [],
    read: async () => new Uint8Array(),
    ...(withWatch ? { watch: () => () => {} } : {})
  } as TreeStore;
}

describe('serverSearchHint（BUG-11 截断引导裁决）', () => {
  it('纯前端（本地）store：返回服务器模式引导文案', () => {
    expect(serverSearchHint(makeStore('localfs:x', false))).toBe(SERVER_SEARCH_HINT);
    expect(SERVER_SEARCH_HINT).toContain('建议在顶栏连接服务器');
    expect(SERVER_SEARCH_HINT).toContain('2000');
    expect(SERVER_SEARCH_HINT).toContain('200MB');
  });

  it('远程 store（带 watch）：null——已是服务器模式，CMP-08 截断不引导（回归护栏）', () => {
    const remote = makeStore('remote:abc', true);
    expect(isRemoteStore(remote)).toBe(true);
    expect(serverSearchHint(remote)).toBeNull();
  });

  it('store 为 null（未打开目录）：null', () => {
    expect(serverSearchHint(null)).toBeNull();
  });
});
