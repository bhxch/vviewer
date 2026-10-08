// markdownImages.test.ts — 相对图片解析（路径规范 + L4 大小上限）单测。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode, TreeStore } from '@vviewer/core';
import { IMAGE_MAX_BYTES, resolveImageBlobUrl, resolveInStorePath } from './markdownImages';

// jsdom 无 URL.createObjectURL/revokeObjectURL：补桩（blob 语义不在本测范围）
const createObjectURL = vi.fn(() => 'blob:stub-1');
const revokeObjectURL = vi.fn();
Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
afterEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

/** 目录树桩：nodes 为已知清单（带 size），files 为可读内容；记录 read 调用 */
function storeStub(nodes: TreeNode[], files: Record<string, Uint8Array>) {
  const reads: string[] = [];
  const store: TreeStore = {
    id: 'stub',
    displayName: () => 'stub',
    listChildren: async () => nodes,
    read: async (path: string) => {
      reads.push(path);
      const f = files[path];
      if (!f) throw new Error(`not found: ${path}`);
      return f;
    }
  };
  return { store, reads };
}

describe('resolveInStorePath', () => {
  it('以当前文件目录为基逐段规范 ./ 与 ../，越出根返回 null', () => {
    expect(resolveInStorePath('docs/readme.md', 'img/a.png')).toBe('docs/img/a.png');
    expect(resolveInStorePath('readme.md', 'a.png')).toBe('a.png');
    expect(resolveInStorePath('docs/a/b.md', '../c.png')).toBe('docs/c.png');
    expect(resolveInStorePath('docs/md', './x.png')).toBe('docs/x.png');
    expect(resolveInStorePath('readme.md', '../escape.png')).toBeNull();
  });
});

describe('resolveImageBlobUrl', () => {
  it('命中：读 store 生成 blob URL，扩展名映射 MIME', async () => {
    const { store } = storeStub(
      [{ name: 'a.png', path: 'docs/img/a.png', kind: 'file', size: 3 }],
      { 'docs/img/a.png': new Uint8Array([1, 2, 3]) }
    );
    const url = await resolveImageBlobUrl(store, 'docs/readme.md', 'img/a.png');
    expect(url).toBe('blob:stub-1');
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('image/png');
  });

  it('TreeNode.size 超上限：零读取跳过（保留原 src 的语义，不生成 blob）', async () => {
    const { store, reads } = storeStub(
      [{ name: 'huge.png', path: 'huge.png', kind: 'file', size: IMAGE_MAX_BYTES + 1 }],
      { 'huge.png': new Uint8Array(1) }
    );
    const url = await resolveImageBlobUrl(store, 'readme.md', 'huge.png');
    expect(url).toBeNull();
    expect(reads).toEqual([]); // read 前置检查：未发生读取
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('size 缺失的 store：read 后按字节数兜底拒绝', async () => {
    // 真实超限缓冲一次构造（size 字段缺省模拟不报大小的 store）
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    const { store, reads } = storeStub(
      [{ name: 'big.png', path: 'big.png', kind: 'file' }],
      { 'big.png': big }
    );
    const url = await resolveImageBlobUrl(store, 'readme.md', 'big.png');
    expect(url).toBeNull();
    expect(reads).toEqual(['big.png']);
  });

  it('越出根/找不到：返回 null', async () => {
    const { store } = storeStub([], {});
    expect(await resolveImageBlobUrl(store, 'readme.md', '../escape.png')).toBeNull();
    await expect(resolveImageBlobUrl(store, 'readme.md', 'missing.png')).rejects.toThrow('not found');
  });

  it('listChildren 抛错不阻断：退回 read 后检查照常命中', async () => {
    const store: TreeStore = {
      id: 'flat',
      displayName: () => 'flat',
      listChildren: vi.fn(async () => {
        throw new Error('flat store');
      }),
      read: async () => new Uint8Array([1])
    };
    const url = await resolveImageBlobUrl(store, 'readme.md', 'a.png');
    expect(url).toBe('blob:stub-1');
  });
});
