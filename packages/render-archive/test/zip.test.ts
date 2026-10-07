// zip.test.ts — zipStore 单测：jszip 造内存 zip，断言目录聚合/自然排序/read/深度限制/错误转换。
// jszip 不支持生成加密 zip：加密错误路径以导出的 normalizeZipError 纯函数直接断言。
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@vviewer/core';
import { createZipStore, normalizeZipError } from '../src/zipStore';

async function makeZip(): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('hello.txt', 'hello vviewer');
  zip.file('z10.txt', 'natural sort');
  zip.file('z9.txt', 'natural sort');
  zip.file('nested/inner.txt', 'inner content');
  zip.file('nested/deep/leaf.md', '# leaf');
  zip.folder('empty-dir');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes;
}

describe('createZipStore', () => {
  it('listChildren 根层：目录优先 + 自然排序 + 虚拟目录聚合', async () => {
    const store = await createZipStore(await makeZip());
    const kids = await store.listChildren('');
    expect(kids.map((n: TreeNode) => `${n.kind}:${n.name}`)).toEqual([
      'dir:empty-dir',
      'dir:nested',
      'file:hello.txt',
      'file:z9.txt',
      'file:z10.txt' // 自然排序：z9 < z10
    ]);
  });

  it('listChildren 子目录层级', async () => {
    const store = await createZipStore(await makeZip());
    const nested = await store.listChildren('nested');
    expect(nested.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:deep', 'file:inner.txt']);
    const deep = await store.listChildren('nested/deep');
    expect(deep.map((n) => n.name)).toEqual(['leaf.md']);
    // 文件节点带 size
    expect(nested.find((n) => n.name === 'inner.txt')?.size).toBe('inner content'.length);
  });

  it('read 返回条目原始字节', async () => {
    const store = await createZipStore(await makeZip());
    const bytes = await store.read('hello.txt');
    expect(new TextDecoder().decode(bytes)).toBe('hello vviewer');
  });

  it('read 目录条目/未知路径抛错', async () => {
    const store = await createZipStore(await makeZip());
    await expect(store.read('nested')).rejects.toThrow('目录');
    await expect(store.read('no/such.txt')).rejects.toThrow('未知路径');
  });

  it('displayName 与 id：顶层为 zip:<名字>', async () => {
    const store = await createZipStore(await makeZip(), undefined, 'bundle.zip');
    expect(store.displayName()).toBe('bundle.zip');
    expect(store.id).toMatch(/^zip:bundle\.zip$/);
  });

  it('parentChain 体现嵌套层级 id', async () => {
    const inner = await createZipStore(await makeZip(), 'zip');
    expect(inner.id).toMatch(/^zip:zip:/);
    const deepest = await createZipStore(await makeZip(), 'zip:zip');
    expect(deepest.id).toMatch(/^zip:zip:zip:/);
  });

  it('深度 ≥3 的 store read 抛"嵌套层数超限"', async () => {
    const store = await createZipStore(await makeZip(), 'zip:zip:zip');
    await expect(store.read('hello.txt')).rejects.toThrow('嵌套层数超限');
  });

  it('超 200MB 输入直接拒绝', async () => {
    const fake = { length: 201 * 1024 * 1024 } as Uint8Array;
    await expect(createZipStore(fake)).rejects.toThrow('200MB');
  });
});

describe('normalizeZipError', () => {
  it('加密条目错误转换为中文提示', () => {
    const converted = normalizeZipError(new Error('Encrypted ZIP: file is encrypted with unsupported algorithm'));
    expect(converted).toBeInstanceOf(Error);
    expect((converted as Error).message).toBe('该条目已加密，无法解密预览');
  });

  it('其他错误原样透传', () => {
    const err = new Error('corrupt zip');
    expect(normalizeZipError(err)).toBe(err);
    expect(normalizeZipError('boom')).toBe('boom');
  });
});
