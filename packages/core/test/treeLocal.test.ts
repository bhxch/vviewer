import { describe, it, expect } from 'vitest';
import { createLocalFilesStore, naturalCompare } from '../src/tree/localFiles';
import { createLocalFsStore } from '../src/tree/localFs';

describe('createLocalFilesStore', () => {
  const mkFile = (rel: string, bytes: number[]) =>
    Object.assign(new File([new Uint8Array(bytes)], rel.split('/').pop()!), { webkitRelativePath: rel });
  const files = [
    mkFile('proj/README.md', [1]),
    mkFile('proj/src/main.rs', [2, 3]),
    mkFile('proj/src/lib.rs', [4]),
  ];
  it('lists top-level dir', async () => {
    const store = createLocalFilesStore(files, 'proj');
    expect(store.id).toBe('localfiles:proj');
    const nodes = await store.listChildren('');
    expect(nodes.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:src', 'file:README.md']);
  });
  it('lists nested dir and reads file', async () => {
    const store = createLocalFilesStore(files, 'proj');
    const nodes = await store.listChildren('src');
    expect(nodes.map((n) => n.name).sort()).toEqual(['lib.rs', 'main.rs']);
    expect(await store.read('src/main.rs')).toEqual(new Uint8Array([2, 3]));
  });
});

describe('naturalCompare', () => {
  it('numeric aware', () => {
    expect(naturalCompare('a2.txt', 'a10.txt')).toBeLessThan(0);
    expect(naturalCompare('b.txt', 'a.txt')).toBeGreaterThan(0);
  });
});

describe('createLocalFsStore', () => {
  it('lists and reads via injected handle tree', async () => {
    // FS Access 句柄无法在 jsdom 构造，用最小结构桩验证遍历逻辑
    // 注：实现按裁决使用 values() 遍历，桩补 values 生成器（brief 原桩只有 entries）
    type StubHandle = { name: string };
    const fileHandle = (name: string, bytes: Uint8Array<ArrayBuffer>) => ({
      kind: 'file' as const, name,
      getFile: async () => new File([bytes], name)
    });
    const dirHandle = (name: string, entries: StubHandle[]) => {
      const map = new Map(entries.map((e) => [e.name, e]));
      return {
        kind: 'directory' as const, name,
        entries: async function* () { yield* map.values(); },
        values: async function* () { yield* map.values(); },
        getDirectoryHandle: async (n: string) => map.get(n),
        getFileHandle: async (n: string) => map.get(n)
      };
    };
    const root = dirHandle('proj', [
      fileHandle('README.md', new Uint8Array([1])),
      dirHandle('src', [fileHandle('main.rs', new Uint8Array([2, 3]))])
    ]);
    const store = createLocalFsStore(root as unknown as FileSystemDirectoryHandle);
    expect(store.id).toBe('localfs:proj');
    expect((await store.listChildren('')).map((n) => `${n.kind}:${n.name}`))
      .toEqual(['dir:src', 'file:README.md']);
    expect(await store.read('src/main.rs')).toEqual(new Uint8Array([2, 3]));
  });
});
