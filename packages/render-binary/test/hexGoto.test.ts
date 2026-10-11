// hexGoto.test.ts — Task 1（hex 增强 spec §2.1）：跳转偏移解析纯函数（parseGotoInput）
// + 工具条跳转 DOM 行为（定位/clamp/状态位/瞬时高亮）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHex, parseGotoInput, HEX_LINE_HEIGHT } from '../src/hex';
import { HEX_ROW_BYTES } from '../src/hexBytes';

// jsdom 无 ResizeObserver（虚拟滚动依赖），全文件 stub（照 hex.test.ts 惯例）
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

describe('parseGotoInput', () => {
  it('0x 前缀按十六进制', () => {
    expect(parseGotoInput('0x1A')).toBe(26);
  });

  it('其余按十进制', () => {
    expect(parseGotoInput('16')).toBe(16);
  });

  it('非法/负数/空 → null', () => {
    expect(parseGotoInput('abc')).toBeNull();
    expect(parseGotoInput('-5')).toBeNull();
    expect(parseGotoInput('')).toBeNull();
    expect(parseGotoInput('0xZZ')).toBeNull();
  });
});

// ---- 工具条与跳转（jsdom：scrollTop 直接赋值 + refresh 同步重绘，视口高度 0）----

const MB = new Uint8Array(1 << 20);

function setup(buffer: Uint8Array): {
  inst: ReturnType<typeof renderHex>;
  target: HTMLElement;
  dump: HTMLElement;
  input: HTMLInputElement;
} {
  const target = document.createElement('div');
  document.body.append(target);
  const inst = renderHex(buffer, target, { createWorker: () => null });
  return {
    inst,
    target,
    dump: target.querySelector('.vv-hex-dump') as HTMLElement,
    input: target.querySelector('.vv-hex-goto') as HTMLInputElement
  };
}

function pressEnter(el: HTMLInputElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('renderHex：工具条与跳转', () => {
  it('工具条渲染于 dump 之外（防 scroller replaceChildren 清空），placeholder 注明 0x/dec', () => {
    const { inst, target, dump } = setup(MB);
    const toolbar = target.querySelector('.vv-hex-toolbar');
    expect(toolbar).not.toBeNull();
    expect(dump.contains(toolbar)).toBe(false);
    const input = target.querySelector('.vv-hex-goto') as HTMLInputElement;
    expect(input.placeholder).toBe('跳转 (0x10 或 16)');
    expect(target.querySelector('.vv-hex-toolbar-status')).not.toBeNull();
    inst.destroy();
    target.remove();
  });

  it('Enter 跳转 0x100：定位第 16 行（scrollTop = row×行高 − 视口半高，jsdom 视口 0），目标行已渲染', () => {
    const { inst, target, dump, input } = setup(MB);
    input.value = '0x100';
    pressEnter(input);
    const row = Math.floor(0x100 / HEX_ROW_BYTES);
    expect(dump.scrollTop).toBe(row * HEX_LINE_HEIGHT);
    expect(
      [...dump.querySelectorAll('.vv-hex-row')].some((r) => r.textContent!.startsWith('00000100'))
    ).toBe(true);
    inst.destroy();
    target.remove();
  });

  it('十进制与十六进制等价：16 与 0x10 同一目标行', () => {
    const { inst, target, dump, input } = setup(MB);
    input.value = '16';
    pressEnter(input);
    expect(dump.scrollTop).toBe(18); // row 1 × 18
    input.value = '0x10';
    pressEnter(input);
    expect(dump.scrollTop).toBe(18);
    inst.destroy();
    target.remove();
  });

  it('超界 clamp 到最后字节：状态位提示「已跳至文件尾」，末行 0xfffff 已渲染', () => {
    const { inst, target, dump, input } = setup(MB);
    input.value = '0x99999999';
    pressEnter(input);
    expect(target.querySelector('.vv-hex-toolbar-status')?.textContent).toBe('已跳至文件尾');
    const rows = [...dump.querySelectorAll('.vv-hex-row')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]!.textContent!.startsWith('000ffff0')).toBe(true);
    inst.destroy();
    target.remove();
  });

  it('界内跳转清空状态位；非法/空输入不动作（滚动位置不变）', () => {
    const { inst, target, dump, input } = setup(MB);
    input.value = '0x40';
    pressEnter(input);
    expect(target.querySelector('.vv-hex-toolbar-status')?.textContent).toBe('');
    const before = dump.scrollTop;
    input.value = 'abc';
    pressEnter(input);
    expect(dump.scrollTop).toBe(before);
    input.value = '';
    pressEnter(input); // spec：空输入不动作
    expect(dump.scrollTop).toBe(before);
    inst.destroy();
    target.remove();
  });

  it('目标行瞬时高亮：.vv-hex-goto-flash 1s 后移除（行级近似，Task 3 升级字节级）', () => {
    vi.useFakeTimers();
    try {
      const { inst, target, dump, input } = setup(MB);
      input.value = '0x100';
      pressEnter(input);
      const flashed = dump.querySelectorAll('.vv-hex-goto-flash');
      expect(flashed).toHaveLength(1);
      expect(flashed[0]!.textContent!.startsWith('00000100')).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(dump.querySelectorAll('.vv-hex-goto-flash')).toHaveLength(0);
      inst.destroy();
      target.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('空 buffer：跳转不动作、不抛错', () => {
    const { inst, target, dump, input } = setup(new Uint8Array(0));
    input.value = '0x10';
    pressEnter(input);
    expect(dump.scrollTop).toBe(0);
    inst.destroy();
    target.remove();
  });
});
