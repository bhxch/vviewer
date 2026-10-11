import { describe, it, expect, vi } from 'vitest';

// globalSearch.test.ts — BUG-11/CMP-11：截断引导文案的裁决纯函数 + T4 多源本地
// grep 合并。globalSearch.ts 经 openFlow.svelte.ts 间接依赖 svelte runes（$state），
// vitest 无 svelte 插件无法编译该模块——以 vi.mock 隔离（远程 ripgrep 主链路由
// e2e CMP-08~11 覆盖，本测试只验证本地路径与裁决纯函数）。

vi.mock('./openFlow.svelte', () => ({
  loadLastServer: () => null,
  loadCapabilities: () => []
}));

import type { TreeStore, TreeNode } from '@vviewer/core';
import { isRemoteStore, serverSearchHint, runGlobalSearch, SERVER_SEARCH_HINT } from './globalSearch';

function makeStore(id: string, withWatch: boolean): TreeStore {
  return {
    id,
    displayName: () => id,
    listChildren: async () => [],
    read: async () => new Uint8Array(),
    ...(withWatch ? { watch: () => () => {} } : {})
  } as TreeStore;
}

describe('serverSearchHint（BUG-11 截断引导裁决；T4 起作用于来源列表）', () => {
  it('纯前端（本地）来源：返回服务器模式引导文案', () => {
    const sources = [{ label: 'a', store: makeStore('localfs:x', false) }];
    expect(serverSearchHint(sources)).toBe(SERVER_SEARCH_HINT);
    expect(SERVER_SEARCH_HINT).toContain('建议在顶栏连接服务器');
    expect(SERVER_SEARCH_HINT).toContain('2000');
    expect(SERVER_SEARCH_HINT).toContain('200MB');
  });

  it('含远程来源（带 watch）：null——已是服务器模式，CMP-08 截断不引导（回归护栏）', () => {
    const remote = makeStore('remote:abc', true);
    expect(isRemoteStore(remote)).toBe(true);
    expect(serverSearchHint([{ label: 'r', store: remote }])).toBeNull();
    // 本地 + 远程混合：存在服务器模式来源即不引导
    expect(
      serverSearchHint([
        { label: 'a', store: makeStore('localfs:x', false) },
        { label: 'r', store: remote }
      ])
    ).toBeNull();
  });

  it('来源为空/未打开任何目录：null', () => {
    expect(serverSearchHint(null)).toBeNull();
    expect(serverSearchHint([])).toBeNull();
  });
});

// ---------- T4 多源本地 grep 合并 ----------

/** 带文件内容的 fake store：grepStoreLocal 走 listChildren 逐层 + read 扫描。 */
function storeWithFiles(id: string, files: Record<string, string>): TreeStore {
  const nodes = new Map<string, TreeNode>();
  const dirs = new Set<string>(['']);
  for (const [path, content] of Object.entries(files)) {
    nodes.set(path, { name: path.split('/').pop()!, path, kind: 'file', size: content.length });
    const segs = path.split('/');
    segs.pop();
    let dir = '';
    for (const seg of segs) {
      dir = dir === '' ? seg : `${dir}/${seg}`;
      dirs.add(dir);
    }
  }
  for (const d of dirs) {
    if (d !== '') nodes.set(d, { name: d.split('/').pop()!, path: d, kind: 'dir' });
  }
  return {
    id,
    displayName: () => id,
    listChildren: async (dirPath: string) =>
      [...nodes.values()].filter((n) => n.path.split('/').slice(0, -1).join('/') === dirPath),
    read: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`路径不存在: ${path}`);
      return new TextEncoder().encode(content);
    }
  };
}

describe('runGlobalSearch 多源本地合并（T4：grepStoreLocal 逐源扫描合并）', () => {
  const s1 = storeWithFiles('localfs:one', { 'a.txt': 'alpha hit\nnothing', 'sub/b.log': 'skip' });
  const s2 = storeWithFiles('localfs:two', { 'c.md': 'bravo hit here' });

  it('命中按源拼接、storeId 归属各源', async () => {
    const res = await runGlobalSearch(
      [
        { label: 'one', store: s1 },
        { label: 'two', store: s2 }
      ],
      'hit',
      { caseSensitive: false, regex: false },
      undefined,
      () => false,
      new AbortController().signal
    );
    expect(res.where).toBe('local');
    expect(res.degraded).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.matches.map((m) => ({ storeId: m.storeId, path: m.path, line: m.line }))).toEqual([
      { storeId: 'localfs:one', path: 'a.txt', line: 1 },
      { storeId: 'localfs:two', path: 'c.md', line: 1 }
    ]);
  });

  it('进度跨源累加（第二源的计数含第一源已扫文件数）', async () => {
    const seen: number[] = [];
    await runGlobalSearch(
      [
        { label: 'one', store: s1 },
        { label: 'two', store: s2 }
      ],
      'hit',
      { caseSensitive: false, regex: false },
      (done) => seen.push(done),
      () => false,
      new AbortController().signal
    );
    // s1 扫 a.txt + sub/b.log（.log 在白名单）计 1、2；s2 的 c.md 累计计 3
    expect(seen).toContain(2);
    expect(seen).toContain(3);
    expect(Math.max(...seen)).toBe(3);
  });

  it('空来源列表：返回空结果不抛错', async () => {
    const res = await runGlobalSearch(
      [],
      'hit',
      { caseSensitive: false, regex: false },
      undefined,
      () => false,
      new AbortController().signal
    );
    expect(res.matches).toEqual([]);
    expect(res.where).toBe('local');
  });
});
