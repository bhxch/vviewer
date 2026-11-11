// gitFs.test.ts — GitFsAdapter 结构测试（git 信息面板 Task 1 Step 1）：路径映射含
// repoPrefix、resolve 语义越界 throw、写面/读链接只读承诺 throw、readFile 走 store.read
// 的 encoding 形态、readdir 走 listChildren 名单、stat 经父目录列表推导 kind/size。
// fake store 记录调用路径（断言「调用路径含 repoPrefix」）与调用计数。
import { describe, expect, it } from 'vitest';
import type { TreeNode, TreeStore } from '@bhxch/vviewer-core';
import { messages as zhGit } from '../i18n/catalogs/zh-CN/git';
import { GitFsAdapter, resolveRelPath } from './gitFs';

const enc = new TextEncoder();

interface FakeStore extends TreeStore {
  reads: string[];
  lists: string[];
}

function makeFake(opts: {
  files?: Record<string, string | Uint8Array<ArrayBuffer>>;
  dirs?: Record<string, Array<{ name: string; kind: 'file' | 'dir'; size?: number }>>;
}): FakeStore {
  const reads: string[] = [];
  const lists: string[] = [];
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [k, v] of Object.entries(opts.files ?? {})) files.set(k, typeof v === 'string' ? enc.encode(v) : v);
  const dirs = new Map<string, TreeNode[]>();
  for (const [k, entries] of Object.entries(opts.dirs ?? {})) {
    dirs.set(
      k,
      entries.map((e) => ({
        name: e.name,
        path: k === '' ? e.name : `${k}/${e.name}`,
        kind: e.kind,
        ...(e.size !== undefined ? { size: e.size } : {})
      }))
    );
  }
  return {
    id: 'fake',
    displayName: () => 'fake',
    reads,
    lists,
    async listChildren(path: string) {
      lists.push(path);
      const hit = dirs.get(path);
      if (!hit) throw new Error(`目录不存在: ${path}`);
      return hit;
    },
    async read(path: string) {
      reads.push(path);
      const hit = files.get(path);
      if (!hit) throw new Error(`文件不存在: ${path}`);
      return hit;
    }
  };
}

describe('GitFsAdapter 路径映射', () => {
  it('readFile 映射 repoPrefix + normalize：无/有前导斜杠同归一', async () => {
    const store = makeFake({ files: { 'repo/a/b.txt': 'hello' } });
    const adapter = new GitFsAdapter(store, 'repo');
    const data = (await adapter.readFile('a/b.txt')) as Uint8Array;
    expect(store.reads).toEqual(['repo/a/b.txt']);
    expect(data).toEqual(enc.encode('hello'));
    await adapter.readFile('/a/b.txt');
    expect(store.reads).toEqual(['repo/a/b.txt', 'repo/a/b.txt']);
  });

  it('repoPrefix 前导/尾随斜杠归一；store 根仓库（repoPrefix /）前缀为空', async () => {
    const store = makeFake({ files: { '.git/HEAD': 'ref: refs/heads/main\n' } });
    const adapter = new GitFsAdapter(store, '/');
    await adapter.readFile('.git/HEAD');
    expect(store.reads).toEqual(['.git/HEAD']);

    const store2 = makeFake({ files: { 'w/sub/.git/HEAD': 'x' } });
    const adapter2 = new GitFsAdapter(store2, '/w/sub/');
    await adapter2.readFile('/.git/HEAD');
    expect(store2.reads).toEqual(['w/sub/.git/HEAD']);
  });

  it('resolveRelPath resolve 语义向量：消 . 与 ..、丢空段、逃逸 null', () => {
    expect(resolveRelPath('.git/objects/pack/pack-1.idx')).toBe('.git/objects/pack/pack-1.idx');
    expect(resolveRelPath('/.git/HEAD')).toBe('.git/HEAD');
    expect(resolveRelPath('a/./b')).toBe('a/b');
    expect(resolveRelPath('a/b/../c')).toBe('a/c');
    expect(resolveRelPath('a/../../b')).toBeNull(); // a/.. 到根，再 .. 逃逸
    expect(resolveRelPath('../x')).toBeNull();
    expect(resolveRelPath('/..//x')).toBeNull();
    expect(resolveRelPath('')).toBe('');
  });

  it('越界路径 readFile/stat/readdir throw，且不触达 store', async () => {
    const store = makeFake({ files: {} });
    const adapter = new GitFsAdapter(store, 'repo');
    await expect(adapter.readFile('../x')).rejects.toThrow(/越界/);
    await expect(adapter.readFile('a/../../x')).rejects.toThrow(/越界/);
    await expect(adapter.stat('/../x')).rejects.toThrow();
    await expect(adapter.readdir('/../x')).rejects.toThrow();
    expect(store.reads).toEqual([]);
    expect(store.lists).toEqual([]);
  });
});

describe('GitFsAdapter 只读承诺', () => {
  it('写五件与 readlink 一律 throw', async () => {
    const adapter = new GitFsAdapter(makeFake({}), 'repo');
    await expect(adapter.writeFile()).rejects.toThrow(/只读/);
    await expect(adapter.mkdir()).rejects.toThrow(/只读/);
    await expect(adapter.rmdir()).rejects.toThrow(/只读/);
    await expect(adapter.unlink()).rejects.toThrow(/只读/);
    await expect(adapter.symlink()).rejects.toThrow(/只读/);
    await expect(adapter.readlink('.git/HEAD')).rejects.toThrow(/readlink/);
  });
});

describe('GitFsAdapter readFile encoding 形态', () => {
  it('字符串第二参（discoverGitdir 的 utf8 形）返回 string', async () => {
    const store = makeFake({ files: { 'repo/.git': 'gitdir: ../main/.git\n' } });
    const adapter = new GitFsAdapter(store, 'repo');
    const s = (await adapter.readFile('.git', 'utf8')) as string;
    expect(s).toBe('gitdir: ../main/.git\n');
    expect(typeof s).toBe('string');
  });

  it('{encoding:"utf8"} 返回 string；无 encoding 返回原始字节', async () => {
    const store = makeFake({ files: { 'repo/.git/HEAD': 'ref: refs/heads/main\n' } });
    const adapter = new GitFsAdapter(store, 'repo');
    expect(await adapter.readFile('.git/HEAD', { encoding: 'utf8' })).toBe('ref: refs/heads/main\n');
    const raw = (await adapter.readFile('.git/HEAD')) as Uint8Array;
    expect(raw).toEqual(enc.encode('ref: refs/heads/main\n'));
    expect(await adapter.readFile('.git/HEAD', { encoding: null })).toEqual(raw);
  });

  it('缺失路径转写 code:ENOENT（isogit 存在性探测/包回落链消费）', async () => {
    const adapter = new GitFsAdapter(makeFake({ files: {} }), 'repo');
    const err = await adapter.readFile('.git/objects/ab/cdef').catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('ENOENT');
  });
});

describe('GitFsAdapter readdir/stat', () => {
  it('readdir 走 listChildren 名单，调用路径含 repoPrefix', async () => {
    const store = makeFake({
      dirs: {
        repo: [
          { name: '.git', kind: 'dir' },
          { name: 'src', kind: 'dir' },
          { name: 'README.md', kind: 'file', size: 3 }
        ],
        'repo/.git/objects/pack': [{ name: 'pack-abc.pack', kind: 'file' }]
      }
    });
    const adapter = new GitFsAdapter(store, 'repo');
    expect(await adapter.readdir('')).toEqual(['.git', 'src', 'README.md']);
    expect(store.lists).toEqual(['repo']);
    expect(await adapter.readdir('/.git/objects/pack')).toEqual(['pack-abc.pack']);
    expect(store.lists).toEqual(['repo', 'repo/.git/objects/pack']);
  });

  it('stat 经父目录列表推导：file 带 size / dir / 缺失 ENOENT', async () => {
    const store = makeFake({
      files: { 'repo/README.md': 'abc' },
      dirs: {
        repo: [
          { name: '.git', kind: 'dir' },
          { name: 'README.md', kind: 'file', size: 12 }
        ]
      }
    });
    const adapter = new GitFsAdapter(store, 'repo');
    const f = await adapter.stat('README.md');
    expect(f.isFile()).toBe(true);
    expect(f.isDirectory()).toBe(false);
    expect(f.size).toBe(12);
    const d = await adapter.stat('.git');
    expect(d.isDirectory()).toBe(true);
    const root = await adapter.stat('/');
    expect(root.isDirectory()).toBe(true);
    const miss = await adapter.stat('nope.md').catch((e: { code?: string }) => e);
    expect((miss as { code?: string }).code).toBe('ENOENT');
  });

  it('lstat 与 stat 同形（store 无符号链接语义）', async () => {
    const store = makeFake({ dirs: { repo: [{ name: 'f.txt', kind: 'file', size: 1 }] } });
    const adapter = new GitFsAdapter(store, 'repo');
    const l = await adapter.lstat('f.txt');
    expect(l.isFile()).toBe(true);
    expect(l.isSymbolicLink()).toBe(false);
  });
});

// ---------- 目录双锁（Task 9 域 F S5）：适配层错误串入目录后的锚定面 ----------
// 运行时 zh 断言（上文 /越界/、/只读/ 等子串正则）全部保留——vitest 缺省
// locale=zh-CN，translate 取目录 zh 值 = 原字面量逐字节；本节锁目录键字节。

describe('git 域目录双锁（Task 9：gitFs 错误面键）', () => {
  it('越界/只读/ENOENT 骨架键 zh 逐字节', () => {
    expect(zhGit['git.fs.pathEscape']).toBe('git fs 路径越界（逃出仓库根）: {p}');
    expect(zhGit['git.fs.pathEscapeCause']).toBe('路径越界');
    expect(zhGit['git.fs.writeBanned']).toBe('git fs 只读承诺：{name} 不可用');
    expect(zhGit['git.fs.enoent']).toBe('git fs ENOENT: {path}{detail}');
    expect(zhGit['git.fs.causeDetail']).toBe('（{message}）');
    expect(zhGit['git.fs.dirListSuffix']).toBe('（目录列表失败）');
  });

  it('写五件 name 参数与目录模板拼合渲染逐字节（writeFile 代表向量）', async () => {
    const { translate } = await import('../i18n/core');
    expect(translate('git.fs.writeBanned', { name: 'writeFile' })).toBe('git fs 只读承诺：writeFile 不可用');
  });
});
