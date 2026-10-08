import { describe, expect, it } from 'vitest';
import type { TreeStore, TreeNode } from '@vviewer/core';
import { excludedName, fileNameOf, filterFiles, listFilesRecursively } from './quickOpen';

/** 测试树：路径 → 子节点。listChildren(path) 查表返回。 */
function fakeStore(tree: Record<string, TreeNode[]>): TreeStore {
  return {
    id: 'test:store',
    displayName: () => 'test',
    listChildren: async (path: string) => tree[path] ?? [],
    read: async () => {
      throw new Error('not implemented');
    }
  };
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

describe('listFilesRecursively（BUG-03 QuickOpen 数据源）', () => {
  it('递归收集全部文件（深度优先：子树先于后续兄弟，目录内保持原序）', async () => {
    const files = await listFilesRecursively(fakeStore(SAMPLE), []);
    expect(files).toEqual([
      'src/lib/util.ts',
      'src/lib/code.ts',
      'src/main.ts',
      'node_modules/pkg/index.js',
      'README.md'
    ]);
  });

  it('全名排除规则：命中目录整棵子树跳过', async () => {
    const files = await listFilesRecursively(fakeStore(SAMPLE), ['node_modules']);
    expect(files).toEqual(['src/lib/util.ts', 'src/lib/code.ts', 'src/main.ts', 'README.md']);
  });

  it('*.后缀排除规则：排除匹配文件', async () => {
    const files = await listFilesRecursively(fakeStore(SAMPLE), ['*.ts']);
    expect(files).toEqual(['node_modules/pkg/index.js', 'README.md']);
  });

  it('maxFiles 截断：防巨型目录树失控', async () => {
    const files = await listFilesRecursively(fakeStore(SAMPLE), [], { maxFiles: 2 });
    expect(files).toHaveLength(2);
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

describe('filterFiles（输入过滤）', () => {
  const files = ['README.md', 'src/main.ts', 'src/lib/util.ts', 'src/lib/code.ts', 'app/main.css'];

  it('空 query 返回原序全量', () => {
    expect(filterFiles(files, '')).toEqual(files);
  });

  it('子串不区分大小写过滤', () => {
    expect(filterFiles(files, 'UTIL')).toEqual(['src/lib/util.ts']);
    expect(filterFiles(files, 'main')).toEqual(['src/main.ts', 'app/main.css']);
  });

  it('文件名命中排在仅路径命中之前', () => {
    // 'ts' 同时命中文件名后缀与目录名 src；文件名命中的在前
    const out = filterFiles(files, 'ts');
    expect(out.indexOf('src/main.ts')).toBeLessThan(out.indexOf('src/lib/code.ts'));
    expect(out).toContain('src/lib/util.ts');
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
