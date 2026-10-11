import { describe, expect, it } from 'vitest';
import type { TreeStore, TreeNode } from '@vviewer/core';
import { excludedName, fileNameOf, filterFiles, listFilesRecursively } from './quickOpen';

/** 测试树：路径 → 子节点。listChildren(path) 查表返回。 */
function fakeStore(id: string, tree: Record<string, TreeNode[]>): TreeStore {
  return {
    id,
    displayName: () => id,
    listChildren: async (path: string) => tree[path] ?? [],
    read: async () => {
      throw new Error('not implemented');
    }
  };
}

/** 多源扫描的来源包装（与 FileTree/AppShell 的 sources 同形）。 */
function source(id: string, tree: Record<string, TreeNode[]>) {
  const store = fakeStore(id, tree);
  return { label: `label-${id}`, store };
}

function dir(path: string): TreeNode {
  return { name: path.split('/').pop()!, path, kind: 'dir' };
}

function file(path: string): TreeNode {
  return { name: path.split('/').pop()!, path, kind: 'file' };
}

const SAMPLE: Record<string, TreeNode[]> = {
  '': [dir('src'), dir('node_modules'), file('README.md')],
  src: [dir('src/lib'), file('src/main.ts')],
  'src/lib': [file('src/lib/util.ts'), file('src/lib/code.ts')],
  node_modules: [dir('node_modules/pkg')],
  'node_modules/pkg': [file('node_modules/pkg/index.js')]
};

describe('listFilesRecursively（单源，BUG-03 QuickOpen 数据源）', () => {
  it('递归收集全部文件（深度优先：子树先于后续兄弟，目录内保持原序）', async () => {
    const files = await listFilesRecursively([source('test:store', SAMPLE)], []);
    expect(files.map((f) => f.path)).toEqual([
      'src/lib/util.ts',
      'src/lib/code.ts',
      'src/main.ts',
      'node_modules/pkg/index.js',
      'README.md'
    ]);
    expect(files.every((f) => f.storeId === 'test:store')).toBe(true);
  });

  it('全名排除规则：命中目录整棵子树跳过', async () => {
    const files = await listFilesRecursively([source('test:store', SAMPLE)], ['node_modules']);
    expect(files.map((f) => f.path)).toEqual(['src/lib/util.ts', 'src/lib/code.ts', 'src/main.ts', 'README.md']);
  });

  it('*.后缀排除规则：排除匹配文件', async () => {
    const files = await listFilesRecursively([source('test:store', SAMPLE)], ['*.ts']);
    expect(files.map((f) => f.path)).toEqual(['node_modules/pkg/index.js', 'README.md']);
  });

  it('maxFiles 截断：防巨型目录树失控', async () => {
    const files = await listFilesRecursively([source('test:store', SAMPLE)], [], { maxFiles: 2 });
    expect(files).toHaveLength(2);
  });
});

describe('listFilesRecursively 多源扫描（workspace T4：结果带 storeId）', () => {
  const A = source('store:a', {
    '': [file('a1.md'), dir('sub')],
    sub: [file('sub/a2.md')]
  });
  const B = source('store:b', {
    '': [file('b1.md'), file('b2.md')]
  });

  it('双源各 2 文件 → 结果 4 条按源序拼接、各带 storeId（源内保持 DFS 原序）', async () => {
    const files = await listFilesRecursively([A, B], []);
    expect(files).toEqual([
      { storeId: 'store:a', path: 'a1.md', name: 'a1.md' },
      { storeId: 'store:a', path: 'sub/a2.md', name: 'a2.md' },
      { storeId: 'store:b', path: 'b1.md', name: 'b1.md' },
      { storeId: 'store:b', path: 'b2.md', name: 'b2.md' }
    ]);
  });

  it('排除规则跨源生效（任一源命中即排除）', async () => {
    expect((await listFilesRecursively([A, B], ['b1.md'])).map((f) => f.path)).toEqual([
      'a1.md',
      'sub/a2.md',
      'b2.md'
    ]);
    expect((await listFilesRecursively([A, B], ['sub'])).map((f) => f.storeId)).toEqual([
      'store:a',
      'store:b',
      'store:b'
    ]);
  });

  it('maxFiles 为跨源全局上限（前源打满即止，不溢出到后源）', async () => {
    const files = await listFilesRecursively([A, B], [], { maxFiles: 3 });
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.storeId)).toEqual(['store:a', 'store:a', 'store:b']);
  });

  it('空来源列表返回空结果', async () => {
    expect(await listFilesRecursively([], [])).toEqual([]);
  });
});

describe('excludedName（与 FileTree/TreeNodeRow 同规则的纯函数化）', () => {
  it('全名相等命中', () => {
    expect(excludedName('.git', ['.git'])).toBe(true);
    expect(excludedName('.github', ['.git'])).toBe(false);
  });

  it('*.后缀通配命中', () => {
    expect(excludedName('a.log', ['*.log'])).toBe(true);
    expect(excludedName('log', ['*.log'])).toBe(false);
  });

  it('空规则不排除', () => {
    expect(excludedName('node_modules', [])).toBe(false);
  });
});

describe('filterFiles（输入过滤；T4 起作用于带 storeId 的扫描结果）', () => {
  const files = [
    { storeId: 's', path: 'README.md', name: 'README.md' },
    { storeId: 's', path: 'src/main.ts', name: 'main.ts' },
    { storeId: 's', path: 'src/lib/util.ts', name: 'util.ts' },
    { storeId: 's', path: 'src/lib/code.ts', name: 'code.ts' },
    { storeId: 's', path: 'app/main.css', name: 'main.css' }
  ];
  const paths = (out: Array<{ path: string }>): string[] => out.map((f) => f.path);

  it('空 query 返回原序全量', () => {
    expect(paths(filterFiles(files, ''))).toEqual(paths(files));
  });

  it('子串不区分大小写过滤', () => {
    expect(paths(filterFiles(files, 'UTIL'))).toEqual(['src/lib/util.ts']);
    expect(paths(filterFiles(files, 'main'))).toEqual(['src/main.ts', 'app/main.css']);
  });

  it('文件名命中排在仅路径命中之前', () => {
    // 'ts' 同时命中文件名后缀与目录名 src；文件名命中的在前
    const out = filterFiles(files, 'ts');
    expect(out.findIndex((f) => f.path === 'src/main.ts')).toBeLessThan(out.findIndex((f) => f.path === 'src/lib/code.ts'));
    expect(paths(out)).toContain('src/lib/util.ts');
  });

  it('maxResults 限制返回条数', () => {
    expect(filterFiles(files, '', 3)).toHaveLength(3);
  });
});

describe('fileNameOf', () => {
  it('取最后一段', () => {
    expect(fileNameOf('src/lib/util.ts')).toBe('util.ts');
    expect(fileNameOf('README.md')).toBe('README.md');
  });
});
