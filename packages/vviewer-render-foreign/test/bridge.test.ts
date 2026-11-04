// bridge.test.ts — 桥接契约面单测（spec §6.1）：wrapFileViewerRenderer 产出 Renderer
// 的逐字透传 + streaming:false 与占位 render 桩；createSiblingResolver 的 sibling
// 读取语义（store stub 命中 / 无 read / 目录 join / 目录型来源 / store 缺失 / 读失败兜 null）。
import { describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, TreeStore } from '@bhxch/vviewer-core';
import { wrapFileViewerRenderer, createSiblingResolver } from '../src/bridge';

/** 构造最小 FileSource 形：store 传部分形（R2 无 read / store 缺省场景单独构造） */
function sourceWithStore(path: string, store: Partial<TreeStore>): FileSource {
  return {
    storeId: 'stub-store',
    storeLabel: 'stub',
    path,
    name: path.split('/').pop() ?? path,
    store: store as TreeStore,
  };
}

describe('wrapFileViewerRenderer', () => {
  it('产出 Renderer：id/label/extensions 逐字透传，streaming:false', () => {
    const r = wrapFileViewerRenderer({
      id: 'foreign-xlsx',
      label: '电子表格（外部）',
      extensions: ['xlsx', 'xlsm'],
      mount: async () => ({}),
    });
    expect(r.id).toBe('foreign-xlsx');
    expect(r.label).toBe('电子表格（外部）');
    expect(r.extensions).toEqual(['xlsx', 'xlsm']);
    expect(r.streaming).toBe(false);
  });

  it('render 占位桩：参数校验后抛"foreign mount 由计划 3 接线"', async () => {
    const r = wrapFileViewerRenderer({ id: 'f', label: 'F', extensions: ['x'], mount: async () => ({}) });
    const el = document.createElement('div');
    const source = sourceWithStore('a/b.xlsx', {});
    const det = { ext: 'xlsx' } as Detection;
    await expect(r.render(new Uint8Array(8), el, source, det)).rejects.toThrow('foreign mount 由计划 3 接线');
    await expect(
      r.render(new Uint8Array(8), undefined as unknown as HTMLElement, source, det)
    ).rejects.toThrow(TypeError);
  });
});

describe('createSiblingResolver', () => {
  it('R1 形 store stub：read 命中返回字节', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const read = vi.fn(async () => bytes);
    const resolve = createSiblingResolver(sourceWithStore('doc/data.csv', { read }));
    await expect(resolve('schema.json')).resolves.toBe(bytes);
    expect(read).toHaveBeenCalledExactlyOnceWith('doc/schema.json');
  });

  it('store 无 read（本地 File 形）返回 null 不抛', async () => {
    const resolve = createSiblingResolver(sourceWithStore('doc/data.csv', {}));
    await expect(resolve('schema.json')).resolves.toBeNull();
  });

  it('目录条目（path 带尾段）正确 join；根级文件直接取 name', async () => {
    const read = vi.fn(async () => new Uint8Array(0));
    await createSiblingResolver(sourceWithStore('a/b/data.csv', { read }))('sib.json');
    expect(read).toHaveBeenCalledExactlyOnceWith('a/b/sib.json');
    const read2 = vi.fn(async () => new Uint8Array(0));
    await createSiblingResolver(sourceWithStore('top.csv', { read: read2 }))('sib.json');
    expect(read2).toHaveBeenCalledExactlyOnceWith('sib.json');
  });

  it('目录型来源（path 以 / 结尾）返回 null 不读', async () => {
    const read = vi.fn(async () => new Uint8Array(0));
    const resolve = createSiblingResolver(sourceWithStore('a/b/', { read }));
    await expect(resolve('sib.json')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('store 缺失（foreign 泵装配期）返回 null 不抛', async () => {
    const resolve = createSiblingResolver({
      storeId: 's',
      storeLabel: 'l',
      path: 'a/b.csv',
      name: 'b.csv',
    } as FileSource);
    await expect(resolve('sib.json')).resolves.toBeNull();
  });

  it('read 抛错 → null 不抛', async () => {
    const read = vi.fn(async () => {
      throw new Error('boom');
    });
    const resolve = createSiblingResolver(sourceWithStore('a/b/data.csv', { read }));
    await expect(resolve('sib.json')).resolves.toBeNull();
  });
});
