// zip.test.ts — zipStore/archiveRenderer 单测：jszip 造内存 zip，断言目录聚合/自然排序/read/
// 真实递归深度接线（经 source.storeId 推导，非手工传参）/深度限制放宽语义/错误转换。
// jszip 不支持生成加密 zip：加密错误路径以导出的 normalizeZipError 纯函数直接断言。
import { describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, TreeNode } from '@vviewer/core';
import { archiveRenderer } from '../src/archive';
import { ARCHIVE_OPEN_EVENT, type ArchiveOpenDetail } from '../src/archive';
import { createZipStore, normalizeZipError, zipChainOf } from '../src/zipStore';

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

  it('zipChainOf：由 store id 前导 zip 段推导内层父链', () => {
    expect(zipChainOf('zip:outer.zip')).toBe('zip');
    expect(zipChainOf('zip:zip:inner.zip')).toBe('zip:zip');
    expect(zipChainOf('zip:zip:zip:deep.zip')).toBe('zip:zip:zip');
    expect(zipChainOf('localfiles:samples')).toBe('');
    expect(zipChainOf('single:foo.zip')).toBe('');
  });

  it('depth ≥3 的 store：内嵌 zip 条目 read 抛"嵌套层数超限"，普通条目放行', async () => {
    const JSZip = (await import('jszip')).default;
    const inner = new JSZip();
    inner.file('plain.txt', 'still readable');
    const nested = new JSZip();
    nested.file('x.txt', 'x');
    inner.file('nested.zip', await nested.generateAsync({ type: 'uint8array' }));
    const store = await createZipStore(await inner.generateAsync({ type: 'uint8array' }), 'zip:zip:zip');
    await expect(store.read('plain.txt')).resolves.toBeInstanceOf(Uint8Array);
    await expect(store.read('nested.zip')).rejects.toThrow('嵌套层数超限');
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

describe('archiveRenderer：真实递归路径（depth 由 source.storeId 接线）', () => {
  interface Zipped { bytes: Uint8Array }
  async function zipOf(files: Record<string, string | Zipped>): Promise<Uint8Array> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      zip.file(name, typeof content === 'string' ? content : content.bytes);
    }
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** 模拟 ViewerPane：render 后点击指定条目行，捕获派发的 vv-open-entry detail。
   * name 模拟真实链路中 addTab 写入的条目名（archiveRenderer 用它做 store id 尾段）。 */
  async function renderAndClick(
    buffer: Uint8Array,
    storeId: string,
    clickName: string
  ): Promise<ArchiveOpenDetail> {
    const target = document.createElement('div');
    document.body.append(target);
    const source: FileSource = {
      storeId,
      storeLabel: 'zip-test',
      path: clickName,
      name: clickName,
      store: { id: storeId, displayName: () => 'zip-test', listChildren: async () => [], read: async () => buffer }
    };
    const det = { ext: 'zip' } as Detection;
    const details: ArchiveOpenDetail[] = [];
    const onOpen = (ev: Event): void => {
      details.push((ev as CustomEvent<ArchiveOpenDetail>).detail);
    };
    window.addEventListener(ARCHIVE_OPEN_EVENT, onOpen);
    const instance = await archiveRenderer.render(buffer, target, source, det);
    try {
      await vi.waitFor(() => {
        const row = [...target.querySelectorAll('button.vv-tree-row')].find((b) =>
          b.textContent?.includes(clickName)
        );
        if (!row) throw new Error(`条目未渲染: ${clickName}`);
        (row as HTMLButtonElement).click();
      });
      expect(details.length).toBeGreaterThan(0);
      return details[0]!;
    } finally {
      window.removeEventListener(ARCHIVE_OPEN_EVENT, onOpen);
      instance.destroy();
      target.remove();
    }
  }

  it('四层嵌套：depth 逐层接线，第 3 层 store 拒展内嵌 zip、普通文件可读', async () => {
    // L3（depth3）：普通文件 + 再嵌 zip（应被拒展）
    const l3 = await zipOf({ 'plain.txt': 'readable', 'too-deep.zip': { bytes: await zipOf({ x: 'x' }) } });
    // L2：deep.txt + L3
    const l2 = await zipOf({ 'deep.txt': 'deep', 'inner3.zip': { bytes: l3 } });
    // L1：inner2.zip 指向 L2
    const l1 = await zipOf({ 'inner2.zip': { bytes: l2 } });
    // L0：top.txt + L1
    const l0 = await zipOf({ 'top.txt': 'top', 'inner1.zip': { bytes: l1 } });

    // 顶层打开（非 zip 来源 store）：树含 inner1.zip，点击得 depth0 store；其 read 取出 L1 字节
    const d0 = await renderAndClick(l0, 'localfiles:samples', 'inner1.zip');
    expect(d0.store.id).toBe('zip:inner1.zip'); // 顶层 zip 以自身文件名入 id
    const l1Bytes = await d0.store.read('inner1.zip');

    // 打开 inner1.zip（source.storeId 已是 zip 来源）：点击 inner2.zip → depth1 store
    const d1 = await renderAndClick(l1Bytes, d0.store.id, 'inner2.zip');
    expect(d1.store.id).toBe('zip:zip:inner2.zip');
    const l2Bytes = await d1.store.read('inner2.zip'); // depth1 可读内嵌 zip

    // 打开 inner2.zip：点击 inner3.zip → depth2 store
    const d2 = await renderAndClick(l2Bytes, d1.store.id, 'inner3.zip');
    expect(d2.store.id).toBe('zip:zip:zip:inner3.zip');
    const l3Bytes = await d2.store.read('inner3.zip'); // depth2 仍可读内嵌 zip

    // 打开 inner3.zip（depth3 store）：普通条目放行、内嵌 zip 条目受限
    const d3 = await renderAndClick(l3Bytes, d2.store.id, 'too-deep.zip');
    expect(d3.store.id).toMatch(/^zip:zip:zip:zip:/);
    await expect(d3.store.read('plain.txt')).resolves.toBeInstanceOf(Uint8Array);
    await expect(d3.store.read('too-deep.zip')).rejects.toThrow('嵌套层数超限');
  });
});
