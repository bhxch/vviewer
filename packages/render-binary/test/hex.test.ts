// hex.test.ts — hex dump 行格式纯函数单测（renderHexBytes）+ 虚拟滚动 DOM 渲染（renderHex）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHexBytes, HEX_ROW_BYTES } from '../src/hexBytes';

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

// ---- renderHex DOM 渲染：worker 不可用/出错时的主线程降级（jsdom 下直测 DOM 结构）----
import { renderHex } from '../src/hex';

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
