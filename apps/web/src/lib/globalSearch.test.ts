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
import {
  attributeRemoteMatches,
  isRemoteStore,
  serverSearchHint,
  runGlobalSearch,
  SERVER_SEARCH_HINT
} from './globalSearch';

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

// ---------- 远端命中归属（T7：跨根 root 字段 → 来源 storeId + basePath 路径换算） ----------

describe('attributeRemoteMatches（T5 移交兑现：跨根命中按 rootIndex/basePath 归属）', () => {
  // storeId 即身份（归属改写 store.id）；label 无关
  const wholeR0 = { label: 'srv', store: makeStore('remote:whole', true) } as const;
  const subR0 = {
    label: 'srv/sub',
    store: makeStore('remote:sub0', true),
    basePath: 'sub'
  } as const;
  const wholeR1 = {
    label: 'srv · 根1',
    store: makeStore('remote:r1', true),
    rootIndex: 1
  } as const;
  const subR1 = {
    label: 'srv · 根1/sub',
    store: makeStore('remote:r1sub', true),
    rootIndex: 1,
    basePath: 'sub'
  } as const;

  it('跨根命中帧按 root 归属到对应根的来源', () => {
    const matches = [
      { storeId: 'remote:whole', path: 'a.txt', line: 1, col: 1, preview: 'x', root: 0 },
      { storeId: 'remote:whole', path: 'b.txt', line: 2, col: 1, preview: 'x', root: 1 }
    ];
    const out = attributeRemoteMatches(matches, [wholeR0, wholeR1]);
    expect(out.map((m) => ({ storeId: m.storeId, path: m.path }))).toEqual([
      { storeId: 'remote:whole', path: 'a.txt' },
      { storeId: 'remote:r1', path: 'b.txt' }
    ]);
  });

  it('单根帧（无 root 字段）视为根 0；同根多源取 basePath 前缀匹配的最具体源并剥前缀', () => {
    const matches = [
      // 帧路径相对根：sub/data.txt 落 sub 源（剥 basePath → data.txt）
      { storeId: 'remote:whole', path: 'sub/data.txt', line: 1, col: 1, preview: 'x' },
      // 根下其他路径落整根源（路径原样）
      { storeId: 'remote:whole', path: 'other.txt', line: 3, col: 1, preview: 'x' }
    ];
    const out = attributeRemoteMatches(matches, [wholeR0, subR0]);
    expect(out.map((m) => ({ storeId: m.storeId, path: m.path }))).toEqual([
      { storeId: 'remote:sub0', path: 'data.txt' },
      { storeId: 'remote:whole', path: 'other.txt' }
    ]);
  });

  it('嵌套 basePath 取最长前缀（sub/sub2 命中归 sub2 源而非 sub 源）', () => {
    const sub2 = {
      label: 'srv/sub/sub2',
      store: makeStore('remote:sub2', true),
      basePath: 'sub/sub2'
    } as const;
    const matches = [
      { storeId: 'remote:whole', path: 'sub/sub2/deep.txt', line: 1, col: 1, preview: 'x' },
      { storeId: 'remote:whole', path: 'sub/other.txt', line: 2, col: 1, preview: 'x' }
    ];
    const out = attributeRemoteMatches(matches, [subR0, sub2]);
    expect(out.map((m) => ({ storeId: m.storeId, path: m.path }))).toEqual([
      { storeId: 'remote:sub2', path: 'deep.txt' },
      { storeId: 'remote:sub0', path: 'other.txt' }
    ]);
  });

  it('该根无已登记来源 / 前缀不匹配且无整根源：保守保持 members[0] 摊派原样', () => {
    const matches = [
      // 根 2 无来源
      { storeId: 'remote:whole', path: 'x.txt', line: 1, col: 1, preview: 'x', root: 2 },
      // 根 1 只有 basePath 源，命中在 sub 外
      { storeId: 'remote:whole', path: 'outside.txt', line: 2, col: 1, preview: 'x', root: 1 }
    ];
    const out = attributeRemoteMatches(matches, [wholeR0, subR1]);
    expect(out.map((m) => ({ storeId: m.storeId, path: m.path }))).toEqual([
      { storeId: 'remote:whole', path: 'x.txt' },
      { storeId: 'remote:whole', path: 'outside.txt' }
    ]);
  });
});
