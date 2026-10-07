// closeWiring.test.ts — T7 store.close() 接线契约单测：archiveRenderer 实例 destroy 时，
// 从未派发过包内条目点击的 store（无 tab 持有）必须立即 close()（libarchive worker 终止）；
// 派发过条目的 store 由内层 tab 持有懒读，destroy 不得关闭（释放接线在 openFlow 的
// "最后一个持有 tab 关闭时"）。以 vi.mock 替换 createLibarchiveStore 观察 close 调用
// （mock 仅本文件生效，zip.test/tar.test 的真实解析路径不受影响）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Detection, FileSource, TreeStore, TreeNode } from '@vviewer/core';
import { archiveRenderer, ARCHIVE_OPEN_EVENT, type ArchiveOpenDetail } from '../src/archive';
import { createLibarchiveStore } from '../src/libarchiveStore';

vi.mock('../src/libarchiveStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/libarchiveStore')>();
  return { ...actual, createLibarchiveStore: vi.fn() };
});

const mockCreate = vi.mocked(createLibarchiveStore);

/** 构造带 close 间谍的 fake libarchive store */
function makeFakeStore(nodes: TreeNode[]): { store: TreeStore; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const store: TreeStore = {
    id: 'libarchive:sample.tar',
    displayName: () => 'sample.tar',
    listChildren: async () => nodes,
    read: async () => new TextEncoder().encode('entry'),
    close
  };
  return { store, close };
}

/** 非 PK magic 字节 → archiveRenderer 走 libarchive 分支（zip 与否仅看头两字节） */
const TARISH = new Uint8Array([0x1f, 0x8b, 0x00, 0x00]);

function makeSource(): FileSource {
  return {
    storeId: 'single:sample.tar',
    storeLabel: 'single',
    path: 'sample.tar',
    name: 'sample.tar',
    store: { id: 'single:sample.tar', displayName: () => 'single', listChildren: async () => [], read: async () => TARISH }
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('archiveRenderer store.close 接线（T7）', () => {
  it('destroy 时未派发过条目点击 → store.close 立即调用（worker 不泄漏）', async () => {
    const { store, close } = makeFakeStore([]);
    mockCreate.mockResolvedValue(store);
    const target = document.createElement('div');
    document.body.append(target);

    const instance = await archiveRenderer.render(TARISH, target, makeSource(), { ext: 'tar' } as Detection);
    expect(mockCreate).toHaveBeenCalledWith(TARISH, undefined, 'sample.tar');
    await vi.waitFor(() => {
      expect(target.querySelector('.vv-archive')).not.toBeNull();
    });

    instance.destroy();
    expect(close).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('派发过条目点击的 store：destroy 不关闭（内层 tab 仍持有懒读），close 由 tab 关闭路径触发', async () => {
    const { store, close } = makeFakeStore([{ name: 'a.txt', path: 'a.txt', kind: 'file', size: 6 }]);
    mockCreate.mockResolvedValue(store);
    const target = document.createElement('div');
    document.body.append(target);

    const details: ArchiveOpenDetail[] = [];
    const onOpen = (ev: Event): void => {
      details.push((ev as CustomEvent<ArchiveOpenDetail>).detail);
    };
    window.addEventListener(ARCHIVE_OPEN_EVENT, onOpen);
    try {
      const instance = await archiveRenderer.render(TARISH, target, makeSource(), { ext: 'tar' } as Detection);
      await vi.waitFor(() => {
        const row = target.querySelector<HTMLButtonElement>('button.vv-tree-row');
        if (!row) throw new Error('条目未渲染');
        row.click(); // 模拟用户点开 a.txt → 内层 tab 持有 store
      });
      expect(details).toHaveLength(1);
      expect(details[0]!.store).toBe(store); // 内层 tab 持有同一实例

      instance.destroy();
      expect(close).not.toHaveBeenCalled(); // 不能关：内层 tab 还要懒读

      // openFlow 接线语义：最后一个持有 tab 关闭后无引用 → 显式 close（此处直接模拟）
      store.close?.();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ARCHIVE_OPEN_EVENT, onOpen);
      target.remove();
    }
  });
});
