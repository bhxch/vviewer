// saveAs.test.ts — 另存为统一管线（计划 2 Task 7，spec §6.4 另存为双形态 + tab 级
// 第七动作）。saveAsBlob 双路（picker 主/blob URL 兜底）+ picker 关闭双语义
// （AbortError 用户取消 → 'cancelled' 静默、NotAllowedError 浏览器拒绝 → 'denied'
// 交调用方状态条提示）；saveAsStreamToDisk writable 生命周期（close/abort）；
// saveAsTab 三取数路径（在手/远端泵/zipStore——前两者经 store 调用形态区分：本地
// 单次 read 无 opts、远端 range 分块）+ 确认门钩子 + 远端面 picker-first 时序锚
// （残余 A2：picker 先弹再取数；无 FS Access 环境降级面单独标注）；
// saveAsDisabledOf 置灰判定（占位/错误/目录）。jsdom：picker 桩挂 window，blob URL
// 兜底以 URL.createObjectURL 桩 + a.download 属性锚断言。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  saveDeniedNotice,
  saveAsBlob,
  saveAsStreamToDisk,
  saveAsTab,
  saveAsDisabledOf,
  pumpToWritable,
  type SaveAsTabHooks
} from './saveAs';
import type { FileSource, TreeStore } from '@bhxch/vviewer-core';
// i18n 目录（Task 4 域 A 抽取）：TabBar 第七动作文案迁入目录，源码锚改指 t() key +
// zh 值逐字节等价断言（e2e 中文锚零回归的保证面）
import { messages as zhTabs } from './i18n/catalogs/zh-CN/tabs';
// i18n 目录（Task 7 域 D 抽取）：saveDeniedNotice 文案目录双锁
import { messages as zhViewer } from './i18n/catalogs/zh-CN/viewer';

// 双 cwd 兼容根/apps/web（downloadProgressUi.test.ts readSrc 同款）
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

// ---------- 桩具 ----------

/** 字节等值锚（加权校验和，页面/节点/e2e 同式；大数组免 jsdom toEqual 深比较慢面） */
function byteHash(bytes: Uint8Array): number {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h + bytes[i]! * ((i % 97) + 1)) >>> 0;
  return h >>> 0;
}

interface FakeWritable {
  written: Array<Blob | Uint8Array>;
  closes: number;
  aborts: number;
}

/** FS Access handle 桩：createWritable 产出可观测 writable（write/close/abort 计数） */
function fakeHandle(): { handle: FileSystemFileHandle; ws: FakeWritable } {
  const ws: FakeWritable = { written: [], closes: 0, aborts: 0 };
  const handle = {
    createWritable: async () => ({
      write: async (c: Blob | Uint8Array) => {
        ws.written.push(c);
      },
      close: async () => {
        ws.closes += 1;
      },
      abort: async () => {
        ws.aborts += 1;
      }
    })
  } as unknown as FileSystemFileHandle;
  return { handle, ws };
}

function mountPicker(impl: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>): void {
  (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(impl);
}

/** blob URL 兜底面桩（jsdom 无 createObjectURL）：捕获 a.download 与 href */
function stubBlobUrl(): { urls: string[]; downloads: string[]; restore: () => void } {
  const urls: string[] = [];
  const downloads: string[] = [];
  const co = vi.fn((b: Blob) => {
    urls.push(`blob:mock:${urls.length}:${b.size}`);
    return urls[urls.length - 1]!;
  });
  const rv = vi.fn(() => {});
  URL.createObjectURL = co as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = rv as unknown as typeof URL.revokeObjectURL;
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    downloads.push(this.download);
  });
  return {
    urls,
    downloads,
    restore: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  };
}

function pickerErr(name: string): DOMException {
  return new DOMException(name, name);
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'showSaveFilePicker');
  vi.restoreAllMocks();
  localStorage.removeItem('vviewer:settings');
});

/** store 桩：read 记录调用形态（path 与 opts 有无——本地单次 vs 远端 range 的分形锚）；
 * rangeCapable 缺省 false（终审修复波 I-2 泵门控后，远端泵行为组须显式传 true） */
function fakeStore(id: string, bytes: () => Uint8Array, rangeCapable?: boolean): { store: TreeStore; calls: Array<{ path: string; opts: unknown }> } {
  const calls: Array<{ path: string; opts: unknown }> = [];
  const store = {
    id,
    displayName: () => id,
    listChildren: async () => [],
    read: async (path: string, opts?: unknown) => {
      calls.push({ path, opts });
      return bytes();
    },
    rangeCapable
  } as unknown as TreeStore;
  return { store, calls };
}

function sourceOf(store: TreeStore, over: Partial<FileSource> = {}): FileSource {
  return {
    storeId: store.id,
    storeLabel: '桩源',
    path: 'dir/file.bin',
    name: 'file.bin',
    store,
    ...over
  };
}

// ---------- saveAsBlob ----------

describe('saveAsBlob（picker 主路 / blob URL 兜底 / 取消静默）', () => {
  it('picker 主路：suggestedName 透传、blob 写入 writable、close 落盘 → saved', async () => {
    const { handle, ws } = fakeHandle();
    const picker = vi.fn(async () => handle);
    mountPicker(picker);
    const blob = new Blob([new Uint8Array([1, 2, 3])]);

    await expect(saveAsBlob(blob, 'a.bin')).resolves.toBe('saved');

    expect(picker).toHaveBeenCalledWith({ suggestedName: 'a.bin' });
    expect(ws.written).toHaveLength(1);
    expect(ws.closes).toBe(1);
  });

  it('picker AbortError（用户取消）→ cancelled 静默：不落兜底、不写盘', async () => {
    mountPicker(async () => {
      throw pickerErr('AbortError');
    });
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([1])]), 'a.bin')).resolves.toBe('cancelled');

    expect(fb.downloads).toHaveLength(0);
    fb.restore();
  });

  it('picker NotAllowedError（浏览器拒绝授权/激活过期）→ denied：不静默、不落兜底（调用方状态条提示）', async () => {
    // 行为变更锚（原断言 NotAllowedError → 'cancelled' 静默已翻转）：用户没关任何
    // 对话框却回到原状即「点了没反应」困惑面，拒绝语义交调用方提示（SAVE_DENIED_NOTICE）
    mountPicker(async () => {
      throw pickerErr('NotAllowedError');
    });
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([1])]), 'a.bin')).resolves.toBe('denied');

    expect(fb.downloads).toHaveLength(0); // 拒绝不降级兜底：语义交调用方提示面
    fb.restore();
  });

  it('无 showSaveFilePicker → blob URL + a.download 兜底（download 属性锚）', async () => {
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([9, 9])]), 'copy.bin')).resolves.toBe('saved');

    expect(fb.downloads).toEqual(['copy.bin']);
    expect(fb.urls[0]).toMatch(/^blob:mock:0:2$/); // href=objectURL 且 blob 尺寸 2
    fb.restore();
  });

  it('picker 后写盘失败（磁盘满）→ abort 半成品再兜底（终审修复波 M-5：.crswap 不残留）', async () => {
    const { ws } = fakeHandle();
    // picker 成功、createWritable 成功、write 失败的盘满形态
    mountPicker(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw new Error('盘满');
        },
        close: async () => {
          ws.closes += 1;
        },
        abort: async () => {
          ws.aborts += 1;
        }
      })
    }) as unknown as FileSystemFileHandle);
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([1])]), 'a.bin')).resolves.toBe('saved');

    expect(ws.aborts).toBe(1); // 兜底前中止半成品（abort 先于 blob URL 兜底）
    expect(ws.closes).toBe(0); // 未 close（未落盘成功）
    expect(fb.downloads).toEqual(['a.bin']); // 降级兜底：数据不丢
    fb.restore();
  });

  it('createWritable 自身失败（句柄失效）→ 无可 abort 面，直接 blob URL 兜底', async () => {
    const { ws } = fakeHandle();
    mountPicker(async () => ({
      createWritable: async () => {
        throw new Error('句柄失效');
      }
    }) as unknown as FileSystemFileHandle);
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([1])]), 'a.bin')).resolves.toBe('saved');

    expect(ws.aborts).toBe(0); // 无 writable 实例：不误计 abort
    expect(fb.downloads).toEqual(['a.bin']);
    fb.restore();
  });
});

// ---------- saveAsStreamToDisk ----------

describe('saveAsStreamToDisk（FS Access writable 直写 + 生命周期）', () => {
  it('pump 直写 writable → close → saved（writable 传给 pump、字节面不校验）', async () => {
    const { handle, ws } = fakeHandle();
    mountPicker(async () => handle);
    const seen: Array<WritableStream | undefined> = [];

    const result = await saveAsStreamToDisk(sourceOf(fakeStore('x:1', () => new Uint8Array(0)).store), 'big.bin', async (writable) => {
      seen.push(writable);
      await writable.write(new Uint8Array([1]));
      return new File([new Uint8Array([1])], 'big.bin');
    });

    expect(result).toBe('saved');
    expect(seen).toHaveLength(1);
    expect(ws.written).toHaveLength(1);
    expect(ws.closes).toBe(1); // close 由管线收口（pump 不负责）
    expect(ws.aborts).toBe(0);
  });

  it('pump 抛错 → abort 丢弃半成品且原错误上抛', async () => {
    const { handle, ws } = fakeHandle();
    mountPicker(async () => handle);

    await expect(
      saveAsStreamToDisk(sourceOf(fakeStore('x:1', () => new Uint8Array(0)).store), 'big.bin', async () => {
        throw new Error('盘满');
      })
    ).rejects.toThrow('盘满');
    expect(ws.aborts).toBe(1);
    expect(ws.closes).toBe(0);
  });

  it('picker 取消（AbortError）→ cancelled（pump 不启动）', async () => {
    mountPicker(async () => {
      throw pickerErr('AbortError');
    });
    let pumped = false;
    await expect(
      saveAsStreamToDisk(sourceOf(fakeStore('x:1', () => new Uint8Array(0)).store), 'big.bin', async () => {
        pumped = true;
        return new File([], 'big.bin');
      })
    ).resolves.toBe('cancelled');
    expect(pumped).toBe(false);
  });

  it('picker 浏览器拒绝（NotAllowedError）→ denied（pump 不启动）——与用户取消分语义', async () => {
    mountPicker(async () => {
      throw pickerErr('NotAllowedError');
    });
    let pumped = false;
    await expect(
      saveAsStreamToDisk(sourceOf(fakeStore('x:1', () => new Uint8Array(0)).store), 'big.bin', async () => {
        pumped = true;
        return new File([], 'big.bin');
      })
    ).resolves.toBe('denied');
    expect(pumped).toBe(false);
  });
});

// ---------- saveAsTab ----------

describe('saveAsTab（三取数路径：在手/远端泵/zipStore）', () => {
  it('在手（L1/L2 本地）：store.read 单次全量（无 opts）→ saveAsBlob', async () => {
    const { store, calls } = fakeStore('localfs:docs', () => new Uint8Array([4, 5, 6]));
    const { handle, ws } = fakeHandle();
    mountPicker(async () => handle);

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'notes.txt', name: 'notes.txt' }) })
    ).resolves.toBe('saved');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: 'notes.txt', opts: undefined }); // 非远端：单次直读形
    const written = ws.written[0] as Blob;
    expect(written.size).toBe(3);
    expect(ws.closes).toBe(1);
  });

  it('zipStore（L3）：同一 store.read 通道读全量条目 → saveAsBlob（路径即条目）', async () => {
    const { store, calls } = fakeStore('zip:sample.zip', () => new TextEncoder().encode('ENTRY-BYTES'));
    const { handle } = fakeHandle();
    mountPicker(async () => handle);

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'inner/hello.txt', name: 'hello.txt' }) })
    ).resolves.toBe('saved');

    expect(calls).toEqual([{ path: 'inner/hello.txt', opts: undefined }]);
  });

  it('远端（R1）picker-first（残余 A2）：picker 先弹（激活窗内）→ 泵分块直写 writable', async () => {
    // size 2MB（>1MB 直读限，<512MB 默认阈值）：泵发 {start,end} 窗口读
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size), true);
    const { handle, ws } = fakeHandle();
    const timeline: string[] = [];
    mountPicker(async () => {
      timeline.push('picker');
      return handle;
    });
    const rawRead = (store.read as (...a: unknown[]) => Promise<Uint8Array>).bind(store);
    (store as { read: unknown }).read = async (...a: unknown[]) => {
      timeline.push('read');
      return rawRead(...a);
    };
    const ticks: Array<{ loaded: number; total: number | null }> = [];

    await expect(
      saveAsTab(
        { source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) },
        { onProgress: (p) => ticks.push(p) }
      )
    ).resolves.toBe('saved');

    expect(timeline).toEqual(['picker', 'read']); // A2 翻转锚：picker 先弹再取数
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({ range: { start: 0, end: size - 1 } }); // 远端：range 窗口形
    expect(ticks).toEqual([{ loaded: size, total: size }]);
    // 泵直写（不经 saveAsBlob blob 面）：块为 Uint8Array（byteLength 锚，Blob 才有 size）
    const first = ws.written[0]!;
    expect(first instanceof Blob ? first.size : (first as Uint8Array).byteLength).toBe(size);
    expect(ws.closes).toBe(1);
  });

  it('远端（R1）picker AbortError（用户主动取消）→ cancelled 静默：零读零写（确认门/泵未启动）', async () => {
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size), true);
    const { ws } = fakeHandle();
    mountPicker(async () => {
      throw pickerErr('AbortError');
    });

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) })
    ).resolves.toBe('cancelled');

    expect(calls).toHaveLength(0); // 用户取消：泵未启动
    expect(ws.written).toHaveLength(0);
  });

  it('远端（R1）picker NotAllowedError（浏览器拒绝）→ denied：零读零写（调用方据此上状态条）', async () => {
    // 双语义拆分锚（原 NotAllowedError → 'cancelled' 静默已翻转）：拒绝不静默，
    // 返回 'denied' 交 TabBar/ViewerPane 提示面（SAVE_DENIED_NOTICE）
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size), true);
    const { ws } = fakeHandle();
    mountPicker(async () => {
      throw pickerErr('NotAllowedError');
    });

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) })
    ).resolves.toBe('denied');

    expect(calls).toHaveLength(0); // 拒绝发生在选目标处：泵未启动
    expect(ws.written).toHaveLength(0); // writable 未创建（落盘零触碰）
  });

  it('远端超阈值 picker-first：确认门在 picker 后、泵前；拒绝 → cancelled 零读零写', async () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ storage: { remoteDownloadConfirmMb: 1 } })
    );
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size), true);
    const { handle, ws } = fakeHandle();
    const timeline: string[] = [];
    mountPicker(async () => {
      timeline.push('picker');
      return handle;
    });
    const asks: Array<{ name: string; sizeBytes: number }> = [];
    const hooks: SaveAsTabHooks = {
      confirm: (info) => {
        timeline.push('confirm');
        asks.push(info);
        return false;
      }
    };

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) }, hooks)
    ).resolves.toBe('cancelled');

    expect(timeline).toEqual(['picker', 'confirm']); // picker 先弹（激活窗内）→ 门拒绝
    expect(asks).toEqual([{ name: 'big.bin', sizeBytes: size }]);
    expect(calls).toHaveLength(0); // 门拒绝：泵未启动
    expect(ws.written).toHaveLength(0); // 目标文件零触碰（半成品零残留）
  });

  it('远端超阈值（无 FS Access 降级面，残余 A2）：确认门先于泵；拒绝 → cancelled 零读', async () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ storage: { remoteDownloadConfirmMb: 1 } })
    );
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size), true);
    const asks: Array<{ name: string; sizeBytes: number }> = [];
    const hooks: SaveAsTabHooks = {
      confirm: (info) => {
        asks.push(info);
        return false;
      }
    };

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) }, hooks)
    ).resolves.toBe('cancelled');

    expect(asks).toEqual([{ name: 'big.bin', sizeBytes: size }]);
    expect(calls).toHaveLength(0); // 门拒绝：泵未启动
  });

  it('远端超阈值 + 钩子放行（无 FS Access 降级面）：泵照走 → saveAsBlob 兜底（Task 6 门同规则）', async () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ storage: { remoteDownloadConfirmMb: 1 } })
    );
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size), true);
    const { handle } = fakeHandle();
    mountPicker(async () => handle);

    await expect(
      saveAsTab(
        { source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) },
        { confirm: () => true }
      )
    ).resolves.toBe('saved');
    expect(calls).toHaveLength(1);
  });

  it('远端 !rangeCapable（I-2 门控，picker-first 直写形）：不走泵——单次无 range 全量读 + 单条 100% 上报 + 整块一次写盘', async () => {
    // directS3/directDav Range 防线降级形态：带窗 read 退化为整对象下载再切片，
    // 泵的 N 窗循环 N× 放大传输——回落单次全量 read（无 range opts）+ 100% 单报
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('s3direct:x', () => new Uint8Array(size), false);
    const { handle, ws } = fakeHandle();
    mountPicker(async () => handle);
    const ticks: Array<{ loaded: number; total: number | null }> = [];

    await expect(
      saveAsTab(
        { source: sourceOf(store, { path: 'big.bin', name: 'big.bin', size }) },
        { onProgress: (p) => ticks.push(p) }
      )
    ).resolves.toBe('saved');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: 'big.bin', opts: undefined }); // 无 range 窗：整对象单次读
    expect(ticks).toEqual([{ loaded: size, total: size }]); // 单条 100% 上报（非泵逐块）
    // picker-first 直写：整块一次写 writable（Uint8Array byteLength 锚）
    const first = ws.written[0]!;
    expect(first instanceof Blob ? first.size : (first as Uint8Array).byteLength).toBe(size);
    expect(ws.closes).toBe(1);
  });

  it('size 未知（null）：不定态直下泵（不适用确认门，Task 6 裁决）', async () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ storage: { remoteDownloadConfirmMb: 1 } })
    );
    // 无 size 来源：泵走不定态满窗循环至 EOF（短读收口）——桩按请求窗返回短块
    const calls: Array<{ path: string; opts: unknown }> = [];
    let round = 0;
    const store = {
      id: 'remote:abc',
      displayName: () => 'remote',
      listChildren: async () => [],
      rangeCapable: true, // I-2 门控后泵行为组显式给能力旗标
      read: async (path: string, opts?: { range?: { start: number; end: number } }) => {
        calls.push({ path, opts });
        round += 1;
        const asked = opts?.range ? opts.range.end - opts.range.start + 1 : 8;
        if (round === 1) return new Uint8Array(asked); // 满窗
        return new Uint8Array(0); // 短读 → EOF
      }
    } as unknown as TreeStore;
    const { handle } = fakeHandle();
    mountPicker(async () => handle);

    await expect(
      saveAsTab({ source: sourceOf(store, { path: 'u.bin', name: 'u.bin' }) })
    ).resolves.toBe('saved');
    expect(calls.length).toBeGreaterThanOrEqual(2); // 满窗 + EOF 判定读
  });
});

// ---------- pumpToWritable（评审 M-1：tee 限自持泵通道——字节等值锚） ----------

describe('pumpToWritable（「下载并另存为」tee 单源：落盘字节 === 源全量）', () => {
  function fakeWritable(): {
    ws: FileSystemWritableFileStream;
    written: Uint8Array[];
    aborts: number;
  } {
    const written: Uint8Array[] = [];
    let aborts = 0;
    const ws = {
      write: async (c: Uint8Array) => {
        written.push(c);
      },
      close: async () => {},
      abort: async () => {
        aborts += 1;
      }
    } as unknown as FileSystemWritableFileStream;
    return { ws, written, aborts };
  }

  /** store.read 形态桩：按请求窗精确切片并记录调用（dispatch headOnly 的真实序列
   * = 8KB 探测窗先行 + pumpFull 自 0 全量重读——探测窗先手动调一次模拟） */
  function rangedReadOf(src: Uint8Array): {
    read: (range?: { start: number; end: number }) => Promise<Uint8Array<ArrayBuffer>>;
    ranges: Array<{ start: number; end: number } | undefined>;
  } {
    const ranges: Array<{ start: number; end: number } | undefined> = [];
    const read = async (range?: { start: number; end: number }) => {
      ranges.push(range);
      if (range === undefined) return new Uint8Array(src);
      return new Uint8Array(src.slice(range.start, range.end + 1));
    };
    return { read, ranges };
  }

  it('探测窗读（dispatch head probe 形态）先于泵发生：tee 产出 === 源全量，前缀无 8KB 重复', async () => {
    const src = new Uint8Array(1024 * 1024 + 5).map((_, i) => (i * 7) & 0xff);
    const { read, ranges } = rangedReadOf(src);
    const { ws, written } = fakeWritable();
    // 模拟 dispatch headOnly 首步：8KB 探测读（不经 tee——dispatch 内部读）
    await read({ start: 0, end: 8191 });
    expect(ranges).toHaveLength(1);

    const ticks: Array<{ loaded: number; total: number | null }> = [];
    const { buffer, writeFailed } = await pumpToWritable(
      read,
      src.length,
      ws,
      (p) => ticks.push(p)
    );

    expect(writeFailed).toBe(false);
    // 字节等值锚（byteHash 加权校验和 + 长度，大数组免 jsdom 深比较慢面；e2e 同锚法）
    expect(buffer.length).toBe(src.length);
    expect(byteHash(buffer)).toBe(byteHash(src));
    // 落盘拼接 === 源全量：探测块不在 written（首块即泵的 {0, min(4MiB,size)-1} 窗）
    const flat = new Uint8Array(written.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of written) {
      flat.set(c, off);
      off += c.length;
    }
    expect(flat.length).toBe(src.length);
    expect(byteHash(flat)).toBe(byteHash(src));
    expect(written[0]!.length).toBe(Math.min(4 * 1024 * 1024, src.length)); // 首块 = 泵窗宽，非 8KB
    expect(ticks.at(-1)).toEqual({ loaded: src.length, total: src.length });
  });

  it('多块泵（>4MiB）逐块顺序写盘，拼接 === 源全量（known-size 泵精确窗收口）', async () => {
    const src = new Uint8Array(4 * 1024 * 1024 * 2 + 3).map((_, i) => (i * 13) & 0xff);
    const { read } = rangedReadOf(src);
    const { ws, written } = fakeWritable();

    const { buffer, writeFailed } = await pumpToWritable(read, src.length, ws);

    expect(writeFailed).toBe(false);
    expect(buffer.length).toBe(src.length);
    expect(byteHash(buffer)).toBe(byteHash(src));
    expect(written).toHaveLength(3); // {0,4MiB-1} + {4MiB,8MiB-1} + {8MiB,8MiB+2}（末窗 3B 独立迭代收口）
    const flat = new Uint8Array(written.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of written) {
      flat.set(c, off);
      off += c.length;
    }
    expect(flat.length).toBe(src.length);
    expect(byteHash(flat)).toBe(byteHash(src));
  });

  it('不定态（size null）满窗循环至 EOF：tee 产出 === 源全量', async () => {
    const src = new Uint8Array(4 * 1024 * 1024 + 9).map((_, i) => (i * 3) & 0xff);
    const { read } = rangedReadOf(src);
    const { ws, written } = fakeWritable();

    const { buffer, writeFailed } = await pumpToWritable(read, null, ws);

    expect(writeFailed).toBe(false);
    expect(buffer.length).toBe(src.length);
    expect(byteHash(buffer)).toBe(byteHash(src));
    const flat = new Uint8Array(written.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of written) {
      flat.set(c, off);
      off += c.length;
    }
    expect(flat.length).toBe(src.length);
    expect(byteHash(flat)).toBe(byteHash(src));
  });

  it('写失败：writeFailed 置位、buffer 完整返回不 throw（渲染主路不回灌；收口由调用方 abort）', async () => {
    const src = new Uint8Array(64).map((_, i) => i & 0xff);
    const { read } = rangedReadOf(src);
    const ws = {
      write: async () => {
        throw new Error('盘满');
      },
      close: async () => {},
      abort: async () => {}
    } as unknown as FileSystemWritableFileStream;

    const { buffer, writeFailed } = await pumpToWritable(read, src.length, ws);

    expect(writeFailed).toBe(true);
    expect(buffer).toEqual(src); // 字节流照常交付（渲染主路优先，小数组深比较直锚）
  });
});

// ---------- saveAsDisabledOf ----------

describe('saveAsDisabledOf（第七动作置灰：占位/错误/目录）', () => {
  it('占位 tab（unrestorable）→ disabled', () => {
    expect(saveAsDisabledOf({ unrestorable: true, source: { path: 'a.txt' } })).toBe(true);
  });

  it('错误 tab（lastRendererId error）→ disabled', () => {
    expect(saveAsDisabledOf({ lastRendererId: 'error', source: { path: 'a.txt' } })).toBe(true);
  });

  it('目录 tab（path 空串）→ disabled', () => {
    expect(saveAsDisabledOf({ source: { path: '' } })).toBe(true);
  });

  it('普通文件 tab → enabled（pinned/未渲染不置灰）', () => {
    expect(saveAsDisabledOf({ source: { path: 'a.txt' } })).toBe(false);
    // pinned 不在结构面（SaveAsDisabledTabLike 最小形状）：宽对象注入验证不影响判定
    expect(
      saveAsDisabledOf({ pinned: true, source: { path: 'a.txt' } } as {
        pinned?: boolean;
        source: { path: string };
      })
    ).toBe(false);
  });

  it('TabBar 第七动作组装（源码契约）：另存为项 disabled 接 saveAsDisabledOf、onClick 进 saveAsTab 管线', () => {
    const src = readSrc('src/lib/TabBar.svelte');
    expect(src).toMatch(/label: t\('tabs\.ctx\.saveAs'\)/);
    expect(zhTabs['tabs.ctx.saveAs']).toBe('另存为');
    expect(src).toMatch(/disabled: saveAsDisabledOf\(tab\)/);
    expect(src).toMatch(/void saveAsTab\(tab, \{/);
    // 远端超阈值确认门钩子（window.confirm 原生确认先例）+ 失败上状态栏
    expect(src).toMatch(/confirm: \(info\) =>/);
    expect(src).toMatch(/showStatusNotice\(\s*t\('tabs\.ctx\.saveAsFailed'/);
    expect(zhTabs['tabs.ctx.saveAsFailed']).toMatch(/^另存为失败：/);
    // picker 关闭双语义（行为变更：NotAllowedError 不再静默）：'denied' → 状态条
    // 固定文案（saveDeniedNotice 单源——Task 7 常量改函数，值迁目录键双锁钉死）；
    // 'cancelled' 静默维持现状
    expect(saveDeniedNotice()).toBe('另存为未完成：浏览器拒绝了文件保存请求');
    expect(zhViewer['viewer.save.denied']).toBe('另存为未完成：浏览器拒绝了文件保存请求');
    expect(src).toMatch(/else if \(r === 'denied'\) showStatusNotice\(saveDeniedNotice\(\)\)/);
    // 进度反馈（评审 I-3）：菜单路径轻量状态条——远端重下开始提示 + 完成提示
    //（dlProgress 为 ViewerPane 私有面，跨组件无复用缝，缝最小取状态条）
    expect(src).toMatch(/const remote = isRemoteDownload\(tab\.source\.storeId\)/);
    expect(src).toMatch(/showStatusNotice\(t\('tabs\.ctx\.saveAsFetching'\)\)/);
    expect(zhTabs['tabs.ctx.saveAsFetching']).toBe('正在拉取全量以另存为…');
    expect(src).toMatch(/showStatusNotice\(t\('tabs\.ctx\.saveAsSaved', \{ name: tab\.source\.name \}\)\)/);
    expect(zhTabs['tabs.ctx.saveAsSaved']).toBe('已另存为 {name}');
  });
});
