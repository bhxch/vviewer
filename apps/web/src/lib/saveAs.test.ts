// saveAs.test.ts — 另存为统一管线（计划 2 Task 7，spec §6.4 另存为双形态 + tab 级
// 第七动作）。saveAsBlob 双路（picker 主/blob URL 兜底）+ 取消静默；saveAsStreamToDisk
// writable 生命周期（close/abort）；saveAsTab 三取数路径（在手/远端泵/zipStore——前两
// 者经 store 调用形态区分：本地单次 read 无 opts、远端 range 分块）+ 确认门钩子；
// saveAsDisabledOf 置灰判定（占位/错误/目录）。jsdom：picker 桩挂 window，blob URL
// 兜底以 URL.createObjectURL 桩 + a.download 属性锚断言。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  saveAsBlob,
  saveAsStreamToDisk,
  saveAsTab,
  saveAsDisabledOf,
  type SaveAsTabHooks
} from './saveAs';
import type { FileSource, TreeStore } from '@bhxch/vviewer-core';

// 双 cwd 兼容根/apps/web（downloadProgressUi.test.ts readSrc 同款）
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

// ---------- 桩具 ----------

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

/** store 桩：read 记录调用形态（path 与 opts 有无——本地单次 vs 远端 range 的分形锚） */
function fakeStore(id: string, bytes: () => Uint8Array): { store: TreeStore; calls: Array<{ path: string; opts: unknown }> } {
  const calls: Array<{ path: string; opts: unknown }> = [];
  const store = {
    id,
    displayName: () => id,
    listChildren: async () => [],
    read: async (path: string, opts?: unknown) => {
      calls.push({ path, opts });
      return bytes();
    }
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

  it('picker NotAllowedError（授权拒绝）→ cancelled 静默（brief 指定双错误名）', async () => {
    mountPicker(async () => {
      throw pickerErr('NotAllowedError');
    });
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([1])]), 'a.bin')).resolves.toBe('cancelled');

    expect(fb.downloads).toHaveLength(0);
    fb.restore();
  });

  it('无 showSaveFilePicker → blob URL + a.download 兜底（download 属性锚）', async () => {
    const fb = stubBlobUrl();

    await expect(saveAsBlob(new Blob([new Uint8Array([9, 9])]), 'copy.bin')).resolves.toBe('saved');

    expect(fb.downloads).toEqual(['copy.bin']);
    expect(fb.urls[0]).toMatch(/^blob:mock:0:2$/); // href=objectURL 且 blob 尺寸 2
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

  it('picker 取消 → cancelled（pump 不启动）', async () => {
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

  it('远端（R1）：range 分块泵取数（read 收 range opts）→ saveAsBlob', async () => {
    // size 2MB（>1MB 直读限，<512MB 默认阈值）：泵发 {start,end} 窗口读
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size));
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
    expect(calls[0]!.opts).toMatchObject({ range: { start: 0, end: size - 1 } }); // 远端：range 窗口形
    expect(ticks).toEqual([{ loaded: size, total: size }]);
    expect((ws.written[0] as Blob).size).toBe(size);
  });

  it('远端超阈值：确认门钩子先于泵；拒绝 → cancelled 零读', async () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ storage: { remoteDownloadConfirmMb: 1 } })
    );
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size));
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

  it('远端超阈值 + 钩子放行：泵照走（Task 6 门同规则，登记后直取）', async () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ storage: { remoteDownloadConfirmMb: 1 } })
    );
    const size = 2 * 1024 * 1024;
    const { store, calls } = fakeStore('remote:abc', () => new Uint8Array(size));
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
    expect(src).toMatch(/label: '另存为'/);
    expect(src).toMatch(/disabled: saveAsDisabledOf\(tab\)/);
    expect(src).toMatch(/void saveAsTab\(tab, \{/);
    // 远端超阈值确认门钩子（window.confirm 原生确认先例）+ 失败上状态栏
    expect(src).toMatch(/confirm: \(info\) =>/);
    expect(src).toMatch(/showStatusNotice\(`另存为失败：/);
  });
});
