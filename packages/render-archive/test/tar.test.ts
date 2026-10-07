// tar.test.ts — libarchiveStore/archiveRenderer tar 分支单测：手写 USTAR header 内存构造 tar，
// 经 libarchive.js（vitest 走 node worker_threads 入口）真实解析，断言目录聚合/自然排序/read/
// gz 压缩流/递归深度链（zip + libarchive 混合段）/错误映射。libarchive worker 生命周期：store
// 可选 close()（RenderedInstance.destroy 接线），单测内手动调用避免线程泄漏。
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, TreeStore, TreeNode } from '@vviewer/core';
import { archiveRenderer, ARCHIVE_OPEN_EVENT, type ArchiveOpenDetail } from '../src/archive';
import { createLibarchiveStore, normalizeLibarchiveError } from '../src/libarchiveStore';
import { archiveChainOf } from '../src/zipStore';

/** 手写 USTAR（posix tar）内存构造：512B header + 内容按 512 对齐，末尾两个全零块 */
function tarHeader(path: string, size: number, typeflag: '0' | '5'): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (off: number, s: string, len: number): void => {
    h.set(enc.encode(s).subarray(0, len), off);
  };
  put(0, path, 100); // name
  put(100, '0000644\0', 8); // mode
  put(108, '0000000\0', 8); // uid
  put(116, '0000000\0', 8); // gid
  put(124, `${size.toString(8).padStart(11, '0')}\0`, 12); // size（八进制）
  put(136, '00000000000\0', 12); // mtime
  put(148, '        ', 8); // chksum 先以空格占位参与求和
  h[156] = typeflag.charCodeAt(0);
  put(257, 'ustar\0', 6); // magic
  put(263, '00', 2); // version
  let sum = 0;
  for (const b of h) sum += b;
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `, 8);
  return h;
}

function align512(n: number): number {
  return Math.ceil(n / 512) * 512;
}

interface TarEntry {
  path: string;
  content?: string | Uint8Array;
  dir?: boolean;
}

function buildTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    if (e.dir) {
      chunks.push(tarHeader(`${e.path}/`, 0, '5'), new Uint8Array(512));
    } else {
      const body = typeof e.content === 'string' ? new TextEncoder().encode(e.content) : e.content ?? new Uint8Array(0);
      chunks.push(tarHeader(e.path, body.length, '0'));
      chunks.push(body, new Uint8Array(align512(body.length) - body.length));
    }
  }
  chunks.push(new Uint8Array(1024)); // 结束块
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function makeTar(): Uint8Array {
  return buildTar([
    { path: 'hello.txt', content: 'hello vviewer' },
    { path: 'z10.txt', content: 'natural sort' },
    { path: 'z9.txt', content: 'natural sort' },
    { path: 'nested/inner.txt', content: 'inner content' },
    { path: 'nested/deep/leaf.md', content: '# leaf' },
    { path: 'empty-dir', dir: true }
  ]);
}

async function makeTarGz(): Promise<Uint8Array> {
  return gzipSync(makeTar());
}

/** libarchive worker 在 read 时仍需存活：测试结束后统一关闭，防 worker_threads 泄漏 */
function closeQuietly(store: TreeStore): void {
  (store as { close?: () => void }).close?.();
}

describe('createLibarchiveStore（tar，libarchive.js 真实解析）', () => {
  it('listChildren 根层：目录优先 + 自然排序 + 虚拟目录聚合（tar 无显式目录条目也可）', async () => {
    const store = await createLibarchiveStore(makeTar());
    try {
      const kids = await store.listChildren('');
      expect(kids.map((n: TreeNode) => `${n.kind}:${n.name}`)).toEqual([
        'dir:empty-dir',
        'dir:nested',
        'file:hello.txt',
        'file:z9.txt',
        'file:z10.txt'
      ]);
    } finally {
      closeQuietly(store);
    }
  });

  it('listChildren 子目录层级 + 文件节点 size', async () => {
    const store = await createLibarchiveStore(makeTar());
    try {
      const nested = await store.listChildren('nested');
      expect(nested.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:deep', 'file:inner.txt']);
      const deep = await store.listChildren('nested/deep');
      expect(deep.map((n) => n.name)).toEqual(['leaf.md']);
      expect(nested.find((n) => n.name === 'inner.txt')?.size).toBe('inner content'.length);
    } finally {
      closeQuietly(store);
    }
  });

  it('read 返回条目原始字节', async () => {
    const store = await createLibarchiveStore(makeTar());
    try {
      const bytes = await store.read('hello.txt');
      expect(new TextDecoder().decode(bytes)).toBe('hello vviewer');
      const inner = await store.read('nested/inner.txt');
      expect(new TextDecoder().decode(inner)).toBe('inner content');
    } finally {
      closeQuietly(store);
    }
  });

  it('read 目录条目/未知路径抛错', async () => {
    const store = await createLibarchiveStore(makeTar());
    try {
      await expect(store.read('nested')).rejects.toThrow('目录');
      await expect(store.read('no/such.txt')).rejects.toThrow('未知路径');
    } finally {
      closeQuietly(store);
    }
  });

  it('tar.gz（gzip 压缩流）同样解析', async () => {
    const store = await createLibarchiveStore(await makeTarGz());
    try {
      const bytes = await store.read('hello.txt');
      expect(new TextDecoder().decode(bytes)).toBe('hello vviewer');
    } finally {
      closeQuietly(store);
    }
  });

  it('displayName 与 id：顶层为 libarchive:<名字>', async () => {
    const store = await createLibarchiveStore(makeTar(), undefined, 'bundle.tar');
    try {
      expect(store.displayName()).toBe('bundle.tar');
      expect(store.id).toMatch(/^libarchive:bundle\.tar$/);
    } finally {
      closeQuietly(store);
    }
  });

  it('parentChain 体现嵌套层级 id（zip 与 libarchive 段混合计数）', async () => {
    const inner = await createLibarchiveStore(makeTar(), 'zip');
    try {
      expect(inner.id).toMatch(/^libarchive:zip:/);
    } finally {
      closeQuietly(inner);
    }
    const deeper = await createLibarchiveStore(makeTar(), 'libarchive:zip');
    try {
      expect(deeper.id).toMatch(/^libarchive:libarchive:zip:/);
    } finally {
      closeQuietly(deeper);
    }
  });

  it('depth ≥3 的 store：内嵌归档条目 read 抛"嵌套层数超限"，普通条目放行', async () => {
    const innerTar = buildTar([{ path: 'x.txt', content: 'x' }]);
    const outer = buildTar([
      { path: 'plain.txt', content: 'still readable' },
      { path: 'too-deep.tar', content: innerTar }
    ]);
    const store = await createLibarchiveStore(outer, 'zip:zip:zip');
    try {
      await expect(store.read('plain.txt')).resolves.toBeInstanceOf(Uint8Array);
      await expect(store.read('too-deep.tar')).rejects.toThrow('嵌套层数超限');
    } finally {
      closeQuietly(store);
    }
  });

  it('非归档字节流（垃圾数据）抛中文格式错误', async () => {
    const junk = new TextEncoder().encode('this is definitely not an archive at all');
    await expect(createLibarchiveStore(junk)).rejects.toThrow('无法识别');
  });

  it('超 200MB 输入直接拒绝', async () => {
    const fake = { length: 201 * 1024 * 1024 } as Uint8Array;
    await expect(createLibarchiveStore(fake)).rejects.toThrow('200MB');
  });
});

describe('archiveChainOf（zip + libarchive 混合链）', () => {
  it('由 store id 前导归档段推导内层父链', () => {
    expect(archiveChainOf('zip:outer.zip')).toBe('zip');
    expect(archiveChainOf('libarchive:inner.tar')).toBe('libarchive');
    expect(archiveChainOf('zip:libarchive:mixed')).toBe('zip:libarchive');
    expect(archiveChainOf('libarchive:zip:mixed')).toBe('libarchive:zip');
    expect(archiveChainOf('localfiles:samples')).toBe('');
  });
});

describe('normalizeLibarchiveError', () => {
  it('加密/格式错误转换为中文提示，其他透传', () => {
    const enc = normalizeLibarchiveError(new Error('Encrypted data is unsupported'));
    expect(enc).toBeInstanceOf(Error);
    expect((enc as Error).message).toContain('加密');
    const fmt = normalizeLibarchiveError(new Error('Unrecognized archive format'));
    expect((fmt as Error).message).toContain('无法识别');
    const passthrough = new Error('boom');
    expect(normalizeLibarchiveError(passthrough)).toBe(passthrough);
    expect(normalizeLibarchiveError('str')).toBe('str');
  });
});

describe('archiveRenderer tar 分支（magic 分派 + 事件解耦）', () => {
  it('extensions 含 tar/gz/tgz/bz2/xz/7z/rar', () => {
    for (const ext of ['tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']) {
      expect(archiveRenderer.extensions).toContain(ext);
    }
  });

  it('render tar：树渲染 + 点击文件派发 vv-open-entry，store 可读', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const bytes = makeTar();
    const source: FileSource = {
      storeId: 'localfiles:samples',
      storeLabel: 'samples',
      path: 'sample.tar',
      name: 'sample.tar',
      store: { id: 'localfiles:samples', displayName: () => 'samples', listChildren: async () => [], read: async () => bytes }
    };
    const details: ArchiveOpenDetail[] = [];
    const onOpen = (ev: Event): void => {
      details.push((ev as CustomEvent<ArchiveOpenDetail>).detail);
    };
    window.addEventListener(ARCHIVE_OPEN_EVENT, onOpen);
    const instance = await archiveRenderer.render(bytes, target, source, { ext: 'tar' } as Detection);
    try {
      await vi.waitFor(() => {
        const row = [...target.querySelectorAll('button.vv-tree-row')].find((b) => b.textContent?.includes('hello.txt'));
        if (!row) throw new Error('hello.txt 未渲染');
        (row as HTMLButtonElement).click();
      });
      expect(details.length).toBe(1);
      const { store, path, name } = details[0]!;
      expect(path).toBe('hello.txt');
      expect(name).toBe('hello.txt');
      expect(new TextDecoder().decode(await store.read('hello.txt'))).toBe('hello vviewer');
      // destroy 不关闭 worker：包内条目 tab 仍持有 store 引用懒读（T7 接线 tab 关闭时释放）
      instance.destroy();
      expect(new TextDecoder().decode(await store.read('hello.txt'))).toBe('hello vviewer');
      // 显式 close 后 read 报已关闭
      (store as { close?: () => void }).close?.();
      await expect(store.read('hello.txt')).rejects.toThrow('已关闭');
    } finally {
      window.removeEventListener(ARCHIVE_OPEN_EVENT, onOpen);
      target.remove();
    }
  });
});
