// markdownLinks.test.ts — spec D §3.2 相对链接站内解析（app 侧纯函数，markdownImages.ts
// 抽出模式同款：无 $app 依赖可 vitest 直测）。resolveRelativeLinkPath=解析式（decode/
// 剥 query-hash/resolveInStorePath join）；resolveRelativeLinkTarget=存在性探测五态
// （listChildren 命中按 TreeNode.kind 分流/未命中裸名试 .md 变体/listChildren 失败
// read 兜底/未命中 missing 带 path）。
import { describe, expect, it } from 'vitest';
import type { TreeStore, TreeNode } from '@bhxch/vviewer-core';
import { resolveRelativeLinkPath, resolveRelativeLinkTarget } from './markdownLinks';

type NodeSpec = { path: string; kind: TreeNode['kind'] };

/** TreeStore 结构 fake（listChildren 按目录前缀过滤；read 仅命中 file 成功） */
function fakeStore(
  nodes: NodeSpec[],
  opts: { listFail?: boolean; readFail?: (path: string) => boolean } = {}
): TreeStore {
  const store: Pick<TreeStore, 'id' | 'displayName' | 'listChildren' | 'read'> = {
    id: 's1',
    displayName: () => 'fake',
    listChildren: async (dir: string) => {
      if (opts.listFail) throw new Error('flat store');
      return nodes
        .filter((n) => {
          const d = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
          return d === dir;
        })
        .map((n) => ({ name: n.path.split('/').pop()!, path: n.path, kind: n.kind }));
    },
    read: async (path: string) => {
      if (opts.readFail?.(path)) throw new Error('read failed');
      const n = nodes.find((x) => x.path === path);
      if (!n || n.kind !== 'file') throw new Error('not a file');
      return new Uint8Array([1]);
    }
  };
  return store as TreeStore;
}

describe('resolveRelativeLinkPath——解析式（decode/剥 query-hash/resolveInStorePath join）', () => {
  it('同目录：./d.md 与裸名 → 当前文件目录下；上级 ../ 归一', () => {
    expect(resolveRelativeLinkPath('a/b/c.md', './d.md')).toBe('a/b/d.md');
    expect(resolveRelativeLinkPath('a/b/c.md', 'd.md')).toBe('a/b/d.md');
    expect(resolveRelativeLinkPath('a/b/c.md', '../d/e.md')).toBe('a/d/e.md');
  });

  it('URL 编码还原（markdown-it 对 CJK/空格 href 百分号编码）：%20 与 CJK', () => {
    expect(resolveRelativeLinkPath('a/b/c.md', 'my%20file.md')).toBe('a/b/my file.md');
    expect(resolveRelativeLinkPath('a/b/c.md', '%E4%B8%AD%E6%96%87.md')).toBe('a/b/中文.md');
  });

  it('query/hash 剥离（跨文件 fragment hash 丢弃——§6 落定 4 MVP 不自动定位）；纯 # 剥后空 → null', () => {
    expect(resolveRelativeLinkPath('a/b/c.md', 'd.md?token=x#frag')).toBe('a/b/d.md');
    expect(resolveRelativeLinkPath('a/b/c.md', 'd.md#section')).toBe('a/b/d.md');
    expect(resolveRelativeLinkPath('a/b/c.md', '#frag')).toBeNull();
    expect(resolveRelativeLinkPath('a/b/c.md', '')).toBeNull();
  });

  it('越根（../ 弹空）返回 null（探测后 missing，非站内目标——markdownImages.ts:27-29 `..` 弹空）；非法百分号序列保留原串', () => {
    // 根文件（无目录）出发 ../ 弹空越根 → null；a/b/c.md 弹两级仅到根（x.md 合法）
    expect(resolveRelativeLinkPath('a.md', '../x.md')).toBeNull();
    expect(resolveRelativeLinkPath('a/b/c.md', '../../x.md')).toBe('x.md');
    // decodeURIComponent('bad%2.md') 抛 URIError → catch 保留原串再 join
    expect(resolveRelativeLinkPath('a/b/c.md', 'bad%2Z.md'.replace('Z', ''))).toBe('a/b/bad%2.md');
    // 剥后 './'（弹空）→ resolveInStorePath 返回空串 → null（非站内目标）
    expect(resolveRelativeLinkPath('a/b/c.md', '../..')).toBeNull();
  });
});

describe('resolveRelativeLinkTarget——存在性探测五态（§6 落定 6：listChildren 探测 + read 兜底）', () => {
  const nodes: NodeSpec[] = [
    { path: 'sub/b.md', kind: 'file' },
    { path: 'sub', kind: 'dir' },
    { path: 'sub/c.md', kind: 'file' }
  ];

  it('file 命中：listChildren(父目录).find 按 TreeNode.kind 分流，storeId 取 store.id', async () => {
    const store = fakeStore(nodes);
    await expect(resolveRelativeLinkTarget(store, 'sub/a.md', './b.md')).resolves.toEqual({
      kind: 'file',
      storeId: 's1',
      path: 'sub/b.md'
    });
  });

  it('directory 命中：dir 目标按 directory 分流（根文件出发 ./sub → store 根下的 sub 目录）', async () => {
    const store = fakeStore(nodes);
    await expect(resolveRelativeLinkTarget(store, 'a.md', './sub')).resolves.toEqual({
      kind: 'directory',
      storeId: 's1',
      path: 'sub'
    });
  });

  it('missing：未命中返回 { kind: "missing", path: 解析后完整路径 }（提示文案含完整解析路径）', async () => {
    const store = fakeStore(nodes);
    await expect(resolveRelativeLinkTarget(store, 'sub/a.md', './missing.md')).resolves.toEqual({
      kind: 'missing',
      path: 'sub/missing.md'
    });
    // 越根解析 null → missing（无 path——非站内目标无解析路径可示）
    await expect(resolveRelativeLinkTarget(store, 'a.md', '../..')).resolves.toEqual({ kind: 'missing' });
  });

  it('.md 变体探测：未命中且末段无扩展名 → 试 path+".md"（wikilink [[file]] 无扩展名形态）', async () => {
    const store = fakeStore(nodes);
    await expect(resolveRelativeLinkTarget(store, 'sub/a.md', './b')).resolves.toEqual({
      kind: 'file',
      storeId: 's1',
      path: 'sub/b.md'
    });
    // 变体也未命中 → missing 带 path（原路径，非 .md 变体路径）
    await expect(resolveRelativeLinkTarget(store, 'sub/a.md', './nope')).resolves.toEqual({
      kind: 'missing',
      path: 'sub/nope'
    });
    // 有扩展名的未命中不试变体
    await expect(resolveRelativeLinkTarget(store, 'sub/a.md', './nope.txt')).resolves.toEqual({
      kind: 'missing',
      path: 'sub/nope.txt'
    });
  });

  it('read 兜底：listChildren 失败（平铺 store）→ read 成功=file；read 失败=missing（AbortError 等不误报）', async () => {
    const flatOk = fakeStore([{ path: 'sub/b.md', kind: 'file' }], { listFail: true });
    await expect(resolveRelativeLinkTarget(flatOk, 'sub/a.md', './b.md')).resolves.toEqual({
      kind: 'file',
      storeId: 's1',
      path: 'sub/b.md'
    });
    const flatFail = fakeStore([{ path: 'sub/b.md', kind: 'file' }], {
      listFail: true,
      readFail: () => true
    });
    await expect(resolveRelativeLinkTarget(flatFail, 'sub/a.md', './b.md')).resolves.toEqual({
      kind: 'missing',
      path: 'sub/b.md'
    });
  });
});
