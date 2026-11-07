// bridge.test.ts — 桥接契约面单测（spec §6.1）：wrapFileViewerRenderer 产出 Renderer
// 的逐字透传 + streaming:false；render 实装（计划 3 Task 2）：Uint8Array→File 物化、
// signal 贯穿、destroy 对接、renderNested→装配注入回调与 depth 3 上限（显式 depth
// 形参贯穿——T2 评审 M1 精化：并发兄弟互不复位/不累积、超限落下载）；
// createSiblingResolver 的 sibling 读取语义（store stub 命中 / 无 read / 目录 join /
// 目录型来源 / store 缺失 / 读失败兜 null / 契约外 name 拒读与 join 后规范化——残余 A4）。
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Detection, FileSource, TreeStore } from '@bhxch/vviewer-core';
import {
  wrapFileViewerRenderer,
  createSiblingResolver,
  disposeForeignRendered,
  downloadNestedAttachment,
  markForeignNestedDepth,
  FOREIGN_NESTED_DEPTH_LIMIT,
  type ForeignMountArgs
} from '../src/bridge';

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

/** blob URL 兜底面桩（saveAs.test.ts 同款，jsdom 无 createObjectURL）：捕获 download 名与 blob 字节 */
function stubBlobDownload(): { downloads: string[]; sizes: number[]; restore: () => void } {
  const downloads: string[] = [];
  const sizes: number[] = [];
  const co = vi.fn((b: Blob) => {
    sizes.push(b.size);
    return `blob:mock:${sizes.length}`;
  });
  const rv = vi.fn(() => {});
  URL.createObjectURL = co as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = rv as unknown as typeof URL.revokeObjectURL;
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  return {
    downloads,
    sizes,
    restore: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
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

  it('render 占位桩：参数校验后抛 TypeError（buffer/target/source/det 必填）', async () => {
    const r = wrapFileViewerRenderer({ id: 'f', label: 'F', extensions: ['x'], mount: async () => ({}) });
    const el = document.createElement('div');
    const source = sourceWithStore('a/b.xlsx', {});
    const det = { ext: 'xlsx' } as Detection;
    await expect(
      r.render(new Uint8Array(8), undefined as unknown as HTMLElement, source, det)
    ).rejects.toThrow(TypeError);
    await expect(
      r.render(undefined as unknown as Uint8Array, el, source, det)
    ).rejects.toThrow(TypeError);
  });
});

describe('wrapFileViewerRenderer render 实装（计划 3 Task 2）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mount 调用：data 同引用、File 物化字节等值且名取 source.name、target/name 贯穿', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    let received: ForeignMountArgs | undefined;
    const r = wrapFileViewerRenderer({
      id: 'f',
      label: 'F',
      extensions: ['x'],
      mount: async (args) => {
        received = args;
        return {};
      },
    });
    const el = document.createElement('div');
    await r.render(bytes, el, sourceWithStore('d/msg.eml', {}), { ext: 'eml' } as Detection);
    expect(received).toBeDefined();
    expect(received!.data).toBe(bytes);
    expect(received!.name).toBe('msg.eml');
    expect(received!.file.name).toBe('msg.eml');
    expect(new Uint8Array(await received!.file.arrayBuffer())).toEqual(bytes);
    expect(received!.target).toBe(el);
    expect(typeof received!.resolveSibling).toBe('function');
    expect(typeof received!.renderNested).toBe('function');
  });

  it('signal 贯穿：render 第 6 参 opts.signal 原样进 mount args', async () => {
    const controller = new AbortController();
    let received: ForeignMountArgs | undefined;
    const r = wrapFileViewerRenderer({
      id: 'f',
      label: 'F',
      extensions: ['x'],
      mount: async (args) => {
        received = args;
        return {};
      },
    });
    await r.render(
      new Uint8Array(4),
      document.createElement('div'),
      sourceWithStore('a.bin', {}),
      { ext: 'bin' } as Detection,
      undefined,
      { signal: controller.signal }
    );
    expect(received!.signal).toBe(controller.signal);
  });

  it('signal 缺省：mount 拿到独立未中止 signal（不与既有实例串线）', async () => {
    const signals: AbortSignal[] = [];
    const r = wrapFileViewerRenderer({
      id: 'f',
      label: 'F',
      extensions: ['x'],
      mount: async (args) => {
        signals.push(args.signal);
        return {};
      },
    });
    const render = () =>
      r.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.bin', {}), { ext: 'bin' } as Detection);
    await render();
    await render();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(false);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('assetBaseUrl 透传进 mount args', async () => {
    let received: ForeignMountArgs | undefined;
    const r = wrapFileViewerRenderer({
      id: 'f',
      label: 'F',
      extensions: ['x'],
      assetBaseUrl: 'https://cdn.example.com/viewer/',
      mount: async (args) => {
        received = args;
        return {};
      },
    });
    await r.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.bin', {}), { ext: 'bin' } as Detection);
    expect(received!.assetBaseUrl).toBe('https://cdn.example.com/viewer/');
  });

  it('destroy 对接：mount 返回 {destroy} → RenderedInstance.destroy 委托（同步/异步皆收）', async () => {
    const syncDestroy = vi.fn();
    const asyncDestroy = vi.fn(async () => {});
    const r1 = wrapFileViewerRenderer({
      id: 'f1',
      label: 'F',
      extensions: ['x'],
      mount: async () => ({ destroy: syncDestroy }),
    });
    const inst1 = await r1.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.bin', {}), { ext: 'bin' } as Detection);
    inst1.destroy();
    expect(syncDestroy).toHaveBeenCalledExactlyOnceWith();
    const r2 = wrapFileViewerRenderer({
      id: 'f2',
      label: 'F',
      extensions: ['x'],
      mount: async () => ({ destroy: asyncDestroy }),
    });
    const inst2 = await r2.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.bin', {}), { ext: 'bin' } as Detection);
    inst2.destroy();
    expect(asyncDestroy).toHaveBeenCalledExactlyOnceWith();
  });

  it('mount 无 destroy（占位返回 {}）：RenderedInstance.destroy 空操作不抛', async () => {
    const r = wrapFileViewerRenderer({ id: 'f', label: 'F', extensions: ['x'], mount: async () => ({}) });
    const inst = await r.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.bin', {}), { ext: 'bin' } as Detection);
    expect(() => inst.destroy()).not.toThrow();
  });

  it('renderNested → nestedDispatch(data, name, target, signal, depth)：同 signal 贯穿，顶层链首个嵌套 depth 1', async () => {
    const nestedDispatch = vi.fn(async () => {});
    let captured: ForeignMountArgs | undefined;
    const r = wrapFileViewerRenderer({
      id: 'f',
      label: 'F',
      extensions: ['x'],
      nestedDispatch,
      mount: async (args) => {
        captured = args;
        return {};
      },
    });
    await r.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.eml', {}), { ext: 'eml' } as Detection);
    const data = new Uint8Array([9, 9]);
    const child = document.createElement('div');
    await captured!.renderNested(data, 'attachment.pdf', child);
    expect(nestedDispatch).toHaveBeenCalledExactlyOnceWith(data, 'attachment.pdf', child, captured!.signal, 1);
  });

  it('depth 递归上限 3（FOREIGN_NESTED_DEPTH_LIMIT）：显式 depth 链式重入第 4 层落下载、nestedDispatch 不再调用', async () => {
    const stub = stubBlobDownload();
    try {
      // 模拟 viewer.ts foreignNestedDispatch：登记 target 深度（markForeignNestedDepth，
      // 桥接 render 读回）→ 重入渲染；depth 形参显式贯穿替代 signal 键簿记
      const nestedDispatch = vi.fn(
        async (data: Uint8Array, _name: string, target: HTMLElement, signal: AbortSignal, depth: number) => {
          markForeignNestedDepth(target, depth);
          await renderer.render(data, target, sourceWithStore('nested.eml', {}), { ext: 'eml' } as Detection, undefined, { signal });
        }
      );
      let levels = 0;
      const renderer = wrapFileViewerRenderer({
        id: 'f',
        label: 'F',
        extensions: ['eml'],
        nestedDispatch,
        mount: async (args) => {
          levels++;
          if (levels <= 8) await args.renderNested(new Uint8Array([levels]), 'attachment.eml', document.createElement('div'));
          return {};
        },
      });
      await renderer.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('root.eml', {}), { ext: 'eml' } as Detection);
      // 根（depth 0）→ 3 层嵌套渲染（depth 1..3，各自 renderNested 请求均放行）→
      // 第 4 层渲染（depth 3）的请求 3+1 > 3 超限：落下载、不再重入
      expect(FOREIGN_NESTED_DEPTH_LIMIT).toBe(3);
      expect(levels).toBe(4);
      expect(nestedDispatch.mock.calls.map((c) => c[4])).toEqual([1, 2, 3]);
      expect(stub.downloads).toEqual(['attachment.eml']);
      expect(stub.sizes).toEqual([1]); // 第 4 层请求的字节（[levels]=[4]，单字节）
    } finally {
      stub.restore();
    }
  });

  it('depth 兄弟调用不累积：同一 render 作用域内 5 次嵌套请求每次都以 depth 1 分派', async () => {
    const nestedDispatch = vi.fn(async (_data: Uint8Array, _name: string, _target: HTMLElement, _signal: AbortSignal, _depth: number) => {});
    let captured: ForeignMountArgs | undefined;
    const r = wrapFileViewerRenderer({
      id: 'f',
      label: 'F',
      extensions: ['eml'],
      nestedDispatch,
      mount: async (args) => {
        captured = args;
        return {};
      },
    });
    await r.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.eml', {}), { ext: 'eml' } as Detection);
    for (let i = 0; i < 5; i++) {
      await captured!.renderNested(new Uint8Array([i]), `att-${i}.pdf`, document.createElement('div'));
    }
    expect(nestedDispatch).toHaveBeenCalledTimes(5);
    expect(nestedDispatch.mock.calls.every((c) => c[4] === 1)).toBe(true);
  });

  it('depth 并发兄弟互不复位（T2 评审 M1 边缘）：并发嵌套链各携显式深度，上限在并发下依然封顶', async () => {
    const stub = stubBlobDownload();
    try {
      const depths: number[] = [];
      let mounts = 0;
      // 测试侧深度镜像（与 markForeignNestedDepth 同登记）——mount 按「自身渲染深度」
      // 决定行为，兄弟链各自独立推进
      const depthOf = new WeakMap<HTMLElement, number>();
      const nestedDispatch = vi.fn(
        async (data: Uint8Array, _name: string, target: HTMLElement, signal: AbortSignal, depth: number) => {
          depths.push(depth);
          depthOf.set(target, depth);
          // 模拟 viewer.ts foreignNestedDispatch：登记 target 深度 → 重入渲染
          markForeignNestedDepth(target, depth);
          await renderer.render(data, target, sourceWithStore('nested.eml', {}), { ext: 'eml' } as Detection, undefined, { signal });
        }
      );
      const renderer = wrapFileViewerRenderer({
        id: 'f',
        label: 'F',
        extensions: ['eml'],
        nestedDispatch,
        mount: async (args) => {
          mounts++;
          const d = depthOf.get(args.target) ?? 0;
          if (d === 0) {
            // 根：并发两个兄弟附件（各持独立 target），各自继续一层链
            await Promise.all([
              args.renderNested(new Uint8Array([1]), 'b1.eml', document.createElement('div')),
              args.renderNested(new Uint8Array([2]), 'b2.eml', document.createElement('div'))
            ]);
          } else if (d === 1) {
            await args.renderNested(new Uint8Array([2]), `c${mounts}.eml`, document.createElement('div'));
          } else if (d === 2) {
            await args.renderNested(new Uint8Array([3]), `e${mounts}.eml`, document.createElement('div'));
          } else if (d === 3) {
            // depth 3 渲染请求第 4 层：3+1 > 3 超限落下载（上限在并发下依然封顶）
            await args.renderNested(new Uint8Array([4]), `f${mounts}.eml`, document.createElement('div'));
          }
          return {};
        },
      });
      await renderer.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('root.eml', {}), { ext: 'eml' } as Detection);
      // 两条并发链对称：depth 1 → 2 → 3 各自分派（互不复位/不累积）；第 4 层请求
      // 双双落下载、不再重入
      expect(depths).toEqual([1, 2, 3, 1, 2, 3]);
      expect(mounts).toBe(7);
      expect(stub.downloads).toEqual(['f4.eml', 'f7.eml']);
    } finally {
      stub.restore();
    }
  });

  it('无 nestedDispatch：嵌套请求直接落下载（downloadNestedAttachment 兜底）', async () => {
    const stub = stubBlobDownload();
    try {
      let captured: ForeignMountArgs | undefined;
      const r = wrapFileViewerRenderer({
        id: 'f',
        label: 'F',
        extensions: ['eml'],
        mount: async (args) => {
          captured = args;
          return {};
        },
      });
      await r.render(new Uint8Array(4), document.createElement('div'), sourceWithStore('a.eml', {}), { ext: 'eml' } as Detection);
      const data = new Uint8Array([7, 7, 7]);
      await captured!.renderNested(data, 'attachment.bin', document.createElement('div'));
      expect(stub.downloads).toEqual(['attachment.bin']);
      expect(stub.sizes).toEqual([3]);
    } finally {
      stub.restore();
    }
  });
});

describe('disposeForeignRendered（foreign 实例销毁归一：unmount → $destroy → destroy）', () => {
  it('unmount 优先', async () => {
    const unmount = vi.fn();
    const destroy = vi.fn();
    await disposeForeignRendered({ unmount, destroy });
    expect(unmount).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('$destroy 次之、destroy 再次', async () => {
    const $destroy = vi.fn();
    const destroy = vi.fn();
    await disposeForeignRendered({ $destroy, destroy });
    expect($destroy).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await disposeForeignRendered({ destroy });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('undefined/空对象不抛', async () => {
    expect(await disposeForeignRendered(undefined)).toBeUndefined();
    expect(await disposeForeignRendered({})).toBeUndefined();
  });
});

describe('downloadNestedAttachment（嵌套附件下载兜底）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blob URL + a[download] 点击，revoke 延迟不阻塞', async () => {
    vi.useFakeTimers();
    const stub = stubBlobDownload();
    try {
      downloadNestedAttachment(new Uint8Array([1, 2, 3]), 'att.pdf');
      expect(stub.downloads).toEqual(['att.pdf']);
      expect(stub.sizes).toEqual([3]);
      vi.advanceTimersByTime(30_000);
    } finally {
      stub.restore();
      vi.useRealTimers();
    }
  });

  it('空名回落 attachment', () => {
    const stub = stubBlobDownload();
    try {
      downloadNestedAttachment(new Uint8Array(0), '');
      expect(stub.downloads).toEqual(['attachment']);
    } finally {
      stub.restore();
    }
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

  // 残余 A4（posixJoin 规范化收紧）：契约外 name 拒读 + join 后规范化
  it('契约外 name 拒读（残余 A4）：前导 / 与 .. 穿越段 → null 不读（防父目录/根逃逸）', async () => {
    const read = vi.fn(async () => new Uint8Array(0));
    const resolve = createSiblingResolver(sourceWithStore('a/b/data.csv', { read }));
    await expect(resolve('../escape.json')).resolves.toBeNull();
    await expect(resolve('sub/../../escape.json')).resolves.toBeNull();
    await expect(resolve('..')).resolves.toBeNull();
    await expect(resolve('/etc/passwd')).resolves.toBeNull();
    await expect(resolve('')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    // '..' 仅作独立段才算穿越：'..foo'/'...' 是合法文件名放行
    await expect(resolve('..foo')).resolves.not.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith('a/b/..foo');
  });

  it('join 后规范化（残余 A4）：dirname 退化形 // 与 . 段折叠，不解引用 ..（上游已拒）', async () => {
    const read = vi.fn(async () => new Uint8Array(0));
    await createSiblingResolver(sourceWithStore('a//b.csv', { read }))('sib.json');
    expect(read).toHaveBeenCalledExactlyOnceWith('a/sib.json');
    const read2 = vi.fn(async () => new Uint8Array(0));
    await createSiblingResolver(sourceWithStore('./a/b.csv', { read: read2 }))('./sib.json');
    expect(read2).toHaveBeenCalledExactlyOnceWith('a/sib.json');
  });
});
