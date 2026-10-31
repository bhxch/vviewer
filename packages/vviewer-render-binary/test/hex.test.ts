// hex.test.ts — hex dump 行格式纯函数单测（renderHexBytes）+ 虚拟滚动 DOM 渲染（renderHex）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHexBytes, HEX_ROW_BYTES } from '../src/hexBytes';
import type { HexHighlight, HexRow } from '../src/hexBytes';

// jsdom 无 ResizeObserver（虚拟滚动依赖），全文件 stub（照 render-text code.test.ts 惯例）
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderHexBytes', () => {
  it('经典三列：8 位偏移 + 16 字节十六进制 + ASCII', () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = i;
    const rows = renderHexBytes(bytes, 0);
    expect(rows).toEqual([
      '00000000  00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f  |................|'
    ]);
  });

  it('可打印 ASCII 原样、不可打印以点占位', () => {
    const bytes = new Uint8Array([0x41, 0x7e, 0x00, 0x1f, 0x7f]);
    const rows = renderHexBytes(bytes, 0);
    expect(rows[0]!.endsWith('|A~...           |')).toBe(true); // ASCII 列补齐 16 宽
  });

  it('不足一行的尾行：十六进制列以空格对齐，总宽与完整行一致', () => {
    const rows = renderHexBytes(new Uint8Array([0xde, 0xad]), 0);
    expect(rows[0]!.startsWith('00000000  de ad')).toBe(true);
    expect(rows[0]!.endsWith('|..              |')).toBe(true);
    const full = renderHexBytes(new Uint8Array(16), 0)[0]!;
    expect(rows[0]!.length).toBe(full.length);
  });

  it('offset 参数决定首行偏移列值，行间偏移步进 16', () => {
    const bytes = new Uint8Array(32);
    const rows = renderHexBytes(bytes, 0x10000);
    expect(rows[0]!.slice(0, 8)).toBe('00010000');
    expect(rows[1]!.slice(0, 8)).toBe('00010010');
    expect(rows).toHaveLength(2);
  });

  it('空输入返回空数组', () => {
    expect(renderHexBytes(new Uint8Array(0), 0)).toEqual([]);
  });
});

// ---- Task 2：renderHexBytes 可选命中高亮（两档 span 切分；无区间逐字节一致锁定）----

describe('renderHexBytes 高亮', () => {
  const data = new Uint8Array(32);
  for (let i = 0; i < 32; i++) data[i] = i;

  it('无 highlights 与显式 undefined 输出逐字节一致（锁定）', () => {
    expect(renderHexBytes(data, 0)).toEqual(renderHexBytes(data, 0, undefined));
    expect(renderHexBytes(data, 0, [])).toEqual(renderHexBytes(data, 0)); // 空区间同义
  });

  it('两档区间：hex 列与 ASCII 列对应字节同档，切分无损、非命中区整串', () => {
    const hls: HexHighlight[] = [
      { start: 2, end: 4, active: false },
      { start: 5, end: 6, active: true }
    ];
    const rows = renderHexBytes(data, 0, hls) as HexRow[];
    expect(rows).toHaveLength(2);
    const r0 = rows[0]!;
    expect(r0.text).toBe(renderHexBytes(data, 0)[0]); // 整行文本不变
    expect(r0.spans.map((s) => s.text).join('')).toBe(r0.text); // 切分无损
    expect(r0.spans[0]).toEqual({ text: '00000000  00 01 ' }); // 前缀+未命中字节整串
    expect(r0.spans.filter((s) => s.active === false).map((s) => s.text)).toEqual(['02 03', '..']);
    expect(r0.spans.filter((s) => s.active === true).map((s) => s.text)).toEqual(['05', '.']);
  });

  it('跨行命中按行裁剪（17 字节命中跨两行，end 独占）', () => {
    const rows = renderHexBytes(data, 0, [{ start: 14, end: 31, active: false }]) as HexRow[];
    expect(rows[0]!.spans.filter((s) => s.active === false).map((s) => s.text)).toEqual(['0e 0f', '..']);
    // 第二行命中 abs 16..30 → 行内 15 字节；abs 31（'1f'）不在区间
    expect(rows[1]!.spans.filter((s) => s.active === false).map((s) => s.text)).toEqual([
      '10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e',
      '...............'
    ]);
  });

  it('尾行（不足 16 字节）命中：行宽不变、命中段列位正确', () => {
    const tail = data.subarray(0, 3);
    const plain = renderHexBytes(tail, 0)[0]!;
    const rows = renderHexBytes(tail, 0, [{ start: 1, end: 3, active: true }]) as HexRow[];
    expect(rows[0]!.text.length).toBe(plain.length);
    expect(rows[0]!.text).toBe(plain);
    expect(rows[0]!.spans.filter((s) => s.active === true).map((s) => s.text)).toEqual(['01 02', '..']);
  });
});

// ---- renderHex DOM 渲染：worker 不可用/出错时的主线程降级（jsdom 下直测 DOM 结构）----
import { renderHex, hexRenderer } from '../src/hex';
import type { StreamCtx, FileSource } from '@bhxch/vviewer-core';

const PNG_BYTES = (() => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  return b;
})();

describe('renderHex：worker 降级', () => {
  it('createWorker 返回 null 时降级主线程解析，结构树照常渲染', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(PNG_BYTES, target, { createWorker: () => null });
    await inst.structReady;
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('PNG');
    expect(target.querySelector('.vv-hex-struct')).not.toBeNull();
    inst.destroy();
    target.remove();
  });

  it('worker 响应错误时降级主线程解析（结果同构）', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    // fake worker：postMessage 即回错误响应 → BinaryClient reject → fallback
    const bad = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage(req: { id: number }): void {
        bad.onmessage?.({ data: { id: req.id, ok: false, error: 'worker boom' } } as MessageEvent);
      },
      terminate(): void {}
    };
    const inst = renderHex(PNG_BYTES, target, { createWorker: () => bad as unknown as Worker });
    await inst.structReady;
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('PNG');
    expect(target.querySelector('.vv-hex-struct')).not.toBeNull();
    inst.destroy();
    target.remove();
  });
});

// ---- BUG-16：hex 行虚拟滚动（jsdom 直测 DOM 结构与可视行填充）----

describe('renderHex：行虚拟滚动', () => {
  it('初始只渲染可视窗口行（≤ overscan 余量），不一次性渲染全部行（1MB 不再 6.5 万 DOM）', () => {
    const bytes = new Uint8Array(1 << 20); // 1MB → 65,536 行
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(bytes, target, { createWorker: () => null });
    const dump = target.querySelector('.vv-hex-dump') as HTMLElement;
    expect(dump.classList.contains('vv-virtual')).toBe(true);
    const domRows = dump.querySelectorAll('.vv-hex-row').length;
    expect(domRows).toBeGreaterThan(0);
    expect(domRows).toBeLessThan(64); // 初始窗口 = 0 可视 + 2×10 overscan，jsdom 高度 0
    expect(dump.querySelector('.vv-hex-more')).toBeNull(); // 分页按钮语义移除
    inst.destroy();
    target.remove();
  });

  it('滚动到底：末行覆盖至 0xfffff 与 1MB 吻合（行首偏移 0xffff0 + 末字节），无白屏', () => {
    const bytes = new Uint8Array(1 << 20);
    bytes[bytes.length - 1] = 0x5a;
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(bytes, target, { createWorker: () => null });
    const dump = target.querySelector('.vv-hex-dump') as HTMLElement;
    const rowCount = Math.ceil(bytes.length / HEX_ROW_BYTES);
    // jsdom 无布局：直接写 scrollTop 并派发 scroll 事件驱动 update()
    dump.scrollTop = (rowCount - 1) * 18;
    dump.dispatchEvent(new Event('scroll'));
    const rows = [...dump.querySelectorAll('.vv-hex-row')];
    expect(rows.length).toBeGreaterThan(0);
    const lastRow = rows[rows.length - 1] as HTMLElement;
    expect(lastRow.textContent!.slice(0, 8)).toBe('000ffff0'); // 末行起始偏移（1MB-16）
    expect(lastRow.textContent!.endsWith('|...............Z|')).toBe(true); // 末字节偏移 0xfffff = 0x5a（ASCII 列末位）
    inst.destroy();
    target.remove();
  });

  it('小文件（< 一屏）：首行偏移 0、行数即总行数', () => {
    const bytes = new Uint8Array(40); // 2.5 行 → 3 行
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(bytes, target, { createWorker: () => null });
    const rows = [...target.querySelectorAll('.vv-hex-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent!.slice(0, 8)).toBe('00000000');
    expect(rows[2]!.textContent!.slice(0, 8)).toBe('00000020'); // 尾行偏移 0x20（补齐渲染）
    inst.destroy();
    target.remove();
  });

  it('空 buffer：0 行、状态行显示 0 B，不抛错', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(new Uint8Array(0), target, { createWorker: () => null });
    expect(target.querySelectorAll('.vv-hex-row')).toHaveLength(0);
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('0 B');
    inst.destroy();
    target.remove();
  });
});

// ---- Task 5（io-streaming）：窗口模式渲染（StreamCtx 供数 + 占位/ensure/重渲）----

describe('renderHex：窗口模式（StreamCtx）', () => {
  const BLOCK = 65536;
  /** fake 全量文件：字节值 = 偏移 mod 256（任一窗口可逐字节比对） */
  const FULL = Uint8Array.from({ length: 200_000 }, (_, i) => i & 0xff);
  const HEAD = FULL.slice(0, 8192);

  /** fake read：按 ByteRange（end 含）切片并记录调用；end 超界按数据长度钳制 */
  function readOf(calls: Array<{ start: number; end: number }>, content: Uint8Array = FULL) {
    return async (r: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>> => {
      calls.push({ start: r.start, end: r.end });
      const end = Math.min(r.end, content.length - 1);
      return content.slice(r.start, end + 1);
    };
  }

  function makeCtx(calls: Array<{ start: number; end: number }>, read?: ReturnType<typeof readOf>): StreamCtx {
    return { size: FULL.length, head: HEAD, read: read ?? readOf(calls) };
  }

  function mount(ctx: StreamCtx, buffer: Uint8Array = HEAD): { inst: ReturnType<typeof renderHex>; target: HTMLElement; dump: HTMLElement } {
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(buffer, target, { createWorker: () => null }, ctx);
    return { inst, target, dump: target.querySelector('.vv-hex-dump') as HTMLElement };
  }

  it('首屏只读 head+结构树尾窗块：首屏窗口字节全部直取 head，read 不触前 128KB', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const { inst, target, dump } = mount(makeCtx(calls));
    // 首屏行渲染自 head，零窗口读
    const rows = [...dump.querySelectorAll('.vv-hex-row')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toBe(renderHexBytes(FULL.subarray(0, 16), 0)[0]);
    // read 仅结构树尾窗触发：全部落在文件尾两块内（≥ block 2），字节数 ≤ 2 块
    expect(calls.length).toBeLessThanOrEqual(2);
    for (const c of calls) {
      expect(c.start).toBeGreaterThanOrEqual(2 * BLOCK);
      expect(c.end - c.start + 1).toBeLessThanOrEqual(BLOCK);
    }
    await inst.structReady;
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('未知二进制');
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('195.3 KB'); // 200000B 状态行用 src.size
    inst.destroy();
    target.remove();
  });

  it('滚动到远处窗口：先占位保行高，ensure 拉覆盖块后重渲为正确字节（区间断言）', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const { inst, target, dump } = mount(makeCtx(calls));
    dump.scrollTop = 2000 * 18; // 行 2000 → 偏移 32000，超出 head（8KB）
    dump.dispatchEvent(new Event('scroll'));
    // 占位行保行高（占位文本为单个空格）
    const placeholders = [...dump.querySelectorAll('.vv-hex-row')];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.every((r) => r.textContent === ' ')).toBe(true);
    // ensure 到位后重渲：行 2000 文本与全量模式逐字节一致（首行含 overscan 上探，
    // 按偏移列定位行 2000 断言）
    const expectedRow = renderHexBytes(FULL.subarray(32000, 32016), 32000)[0];
    await vi.waitFor(() => {
      const rows = [...dump.querySelectorAll('.vv-hex-row')];
      const row2000 = rows.find((r) => r.textContent!.startsWith('00007d00'));
      expect(row2000?.textContent).toBe(expectedRow);
    });
    expect([...dump.querySelectorAll('.vv-hex-row')].some((r) => r.textContent === ' ')).toBe(false);
    expect(calls).toContainEqual({ start: 0, end: BLOCK - 1 }); // block 0 整块拉取
    inst.destroy();
    target.remove();
  });

  it('size null（hexRenderer 全量回退）：一次全量读后行为与全量模式等价', async () => {
    vi.stubGlobal('Worker', undefined); // hexRenderer 内建 createWorker 在 jsdom 降级 null
    try {
      const SMALL = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
      const calls: Array<{ start: number; end: number }> = [];
      const target = document.createElement('div');
      document.body.append(target);
      const source: FileSource = { storeId: 's', storeLabel: 's', path: 'a.bin', name: 'a.bin', store: {} as never };
      const instance = await hexRenderer.render(SMALL.slice(0, 8192), target, source, { ext: 'bin' }, {
        size: null,
        head: SMALL.slice(0, 8192),
        read: readOf(calls, SMALL)
      });
      // 全量回退读：单次 MAX_SAFE_INTEGER 端点（远端由服务端钳制、本地自然钳制）
      expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]);
      const rows = [...target.querySelectorAll('.vv-hex-row')];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.textContent).toBe(renderHexBytes(SMALL.subarray(0, 16), 0)[0]);
      expect(target.querySelector('.vv-hex-status')?.textContent).toContain('300 B');
      expect(instance.destroy).toBeTypeOf('function');
      instance.destroy();
      target.remove();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('行文本与全量模式逐字节一致：同 buffer 同滚动位置两种模式输出 diff 为空', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    // 全量模式（现状路径）
    const legacyTarget = document.createElement('div');
    document.body.append(legacyTarget);
    const legacy = renderHex(FULL, legacyTarget, { createWorker: () => null });
    // 窗口模式（head 8KB + 块拉取）
    const { inst, target: windowTarget, dump } = mount(makeCtx(calls));
    dump.scrollTop = 5000 * 18; // 行 5000 → 偏移 80000（block 1，超出 head）
    const legacyDump = legacyTarget.querySelector('.vv-hex-dump') as HTMLElement;
    legacyDump.scrollTop = dump.scrollTop;
    legacyDump.dispatchEvent(new Event('scroll'));
    dump.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      const winRows = [...dump.querySelectorAll('.vv-hex-row')];
      expect(winRows.some((r) => r.textContent!.startsWith('00013880'))).toBe(true); // 80000 = 0x13880，窗口已就绪
    });
    const winRows = [...dump.querySelectorAll('.vv-hex-row')].map((r) => r.textContent);
    const legacyRows = [...legacyDump.querySelectorAll('.vv-hex-row')].map((r) => r.textContent);
    expect(winRows).toEqual(legacyRows); // 逐字节一致（含行数、占位无残留）
    expect(winRows.length).toBeGreaterThan(0);
    legacy.destroy();
    inst.destroy();
    legacyTarget.remove();
    windowTarget.remove();
  });

  it('窗口读失败自兜底（评审指令①）：占位保留 + 工具条状态位提示，不落错误卡片', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const { inst, target, dump } = mount(makeCtx(calls, async () => {
      throw new Error('io gone');
    }));
    await inst.structReady; // 结构树尾窗同样失败 → status「结构解析失败」（既有自兜底面）
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('结构解析失败');
    dump.scrollTop = 2000 * 18;
    dump.dispatchEvent(new Event('scroll'));
    // 占位保留（无崩溃、无重试活面），失败提示在工具条状态位
    await vi.waitFor(() => {
      expect(target.querySelector('.vv-hex-toolbar-status')?.textContent).toBe('窗口读取失败');
    });
    const rows = [...dump.querySelectorAll('.vv-hex-row')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textContent === ' ')).toBe(true);
    expect(target.querySelector('.vv-error-card')).toBeNull();
    inst.destroy();
    target.remove();
  });

  it('Range-less 服务器（终审 F3）：块读超返回 → 抛错切换全量模式，行输出正确且后续零读', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    // fake read 忽略 Range：任意区间请求回 200 全量（响应体 = 整文件）
    const { inst, target, dump } = mount(makeCtx(calls, async (r) => {
      calls.push({ start: r.start, end: r.end });
      return FULL.slice(0);
    }));
    // 结构树尾窗块读先触发超返回 → adoptFull 切换全量底座：解析照常，不落「结构解析失败」
    await inst.structReady;
    expect(target.querySelector('.vv-hex-status')?.textContent).toContain('195.3 KB');
    expect(target.querySelector('.vv-hex-status')?.textContent).not.toContain('结构解析失败');
    // 同步滚动（早于 read promise 落定）：远处窗口先占位、ensure 超返回后经窗口渲染
    // 路径 catch 切换全量并重渲——行输出与全量模式逐字节一致
    dump.scrollTop = 2000 * 18;
    dump.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      const row2000 = [...dump.querySelectorAll('.vv-hex-row')].find((r) => r.textContent!.startsWith('00007d00'));
      expect(row2000?.textContent).toBe(renderHexBytes(FULL.subarray(32000, 32016), 32000)[0]);
    });
    expect([...dump.querySelectorAll('.vv-hex-row')].some((r) => r.textContent === ' ')).toBe(false);
    expect(target.querySelector('.vv-hex-toolbar-status')?.textContent).toBe(''); // 无「窗口读取失败」
    // 全量底座就绪后 slice 恒命中：再滚动不再触发任何 read
    const reads = calls.length;
    dump.scrollTop = 5000 * 18;
    dump.dispatchEvent(new Event('scroll'));
    expect([...dump.querySelectorAll('.vv-hex-row')].some((r) => r.textContent!.startsWith('00013880'))).toBe(true);
    expect(calls.length).toBe(reads);
    inst.destroy();
    target.remove();
  });

  it('无 Worker 兜底路径：窗口模式搜索降级主线程扫描，命中与高亮照常（head 已含全量时零额外读）', async () => {
    // createWorker: () => null 钉住无 Worker 降级路径；head 覆盖全文件（≤1MB 策略
    // 形态）时兜底扫描直用 buffer，不触发任何 read（need/chunk 主路径由 worker 用例覆盖）
    const CONTENT = new Uint8Array(256);
    CONTENT.set([0xde, 0xad, 0xbe, 0xef], 100); // 唯一命中
    const calls: Array<{ start: number; end: number }> = [];
    const target = document.createElement('div');
    document.body.append(target);
    const inst = renderHex(CONTENT, target, { createWorker: () => null }, {
      size: CONTENT.length,
      head: CONTENT, // head 即全量：src 全部块预置，read 永不触发
      read: readOf(calls, CONTENT)
    });
    await inst.structReady;
    const search = target.querySelector('.vv-hex-search') as HTMLInputElement;
    const status = target.querySelector('.vv-hex-search-status') as HTMLElement;
    search.value = 'deadbeef';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(status.textContent).toBe('1/1 处命中'); // 主线程兜底扫描（无 worker）照常出命中
    expect(target.querySelectorAll('.vv-hex-hit-active').length).toBeGreaterThan(0);
    expect(calls).toStrictEqual([]); // head 已是全量：搜索零额外读
    inst.destroy();
    target.remove();
  });

  it('窗口模式装饰叠加 DOM：命中/光标/flash 三档 span 切分同行输出（T5 评审 Minor 补钉）', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const { inst, target, dump } = mount(makeCtx(calls));
    await inst.structReady;
    // 命中：字节 @100（0x64 0x65 → hex '6465'；模式每 256 字节重复，首个命中在行 6）
    const search = target.querySelector('.vv-hex-search') as HTMLInputElement;
    search.value = '6465';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // flash：跳转 0x68（104，与命中同行 6）
    const goto = target.querySelector('.vv-hex-goto') as HTMLInputElement;
    goto.value = '0x68';
    goto.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // cursor：mock 行矩形（jsdom 无布局）后点击行 6 列 0 → byteIndexAtColumn 落行首字节 96
    const row6 = [...dump.querySelectorAll('.vv-hex-row')].find((r) => r.textContent!.startsWith('00000060'));
    expect(row6).toBeDefined();
    row6!.getBoundingClientRect = () =>
      ({ width: 77 * 8, left: 0, top: 0, right: 616, bottom: 18, height: 18, x: 0, y: 0 }) as DOMRect;
    row6!.dispatchEvent(new MouseEvent('click', { clientX: 0, bubbles: true }));
    // 点击触发 refresh 会整窗重建行元素：重新查询行 6 再断言
    const row6After = [...dump.querySelectorAll('.vv-hex-row')].find((r) => r.textContent!.startsWith('00000060'))!;
    // 行 6（偏移 96..111）三档装饰齐备：命中 @100（active）、flash @104、cursor @96
    const spans = [...row6After.querySelectorAll('span')];
    expect(spans.filter((s) => s.classList.contains('vv-hex-hit-active')).map((s) => s.textContent)).toEqual([
      '64 65',
      'de'
    ]); // hex 列与 ASCII 列同档（0x64/0x65 恰为可打印 'de'）
    expect(spans.some((s) => s.classList.contains('vv-hex-goto-flash'))).toBe(true);
    expect(spans.some((s) => s.classList.contains('vv-hex-cursor'))).toBe(true);
    // span 切分无损：各段文本拼接 = 整行文本（行格式与全量模式逐字节一致）
    const joined = [...row6After.childNodes].map((n) => n.textContent).join('');
    expect(joined).toBe(row6After.textContent);
    inst.destroy();
    target.remove();
  });
});
