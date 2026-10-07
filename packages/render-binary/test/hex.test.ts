// hex.test.ts — hex dump 行格式纯函数单测（renderHexBytes）。
import { describe, expect, it } from 'vitest';
import { renderHexBytes } from '../src/hexBytes';

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
