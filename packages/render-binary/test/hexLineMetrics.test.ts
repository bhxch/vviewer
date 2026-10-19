// hex 行尺度协议（字体系统 Task 2，spec 2026-10-19 §3）：行高来源实读形态 =
// 「行内样式锁定字号/行高 + HEX_LINE_HEIGHT 常量喂虚拟滚动/跳转坐标」（非纯 CSS
// 派生）——两者必须同源，故 lineMetrics 同时替换 cssText 字号行高与滚动常数。
// 缺省回落现值 12px/18px（直调兼容面，跨包零破坏）；应用内归一由 ViewerPane 经
// render 第 6 参透传 codeSize 行尺度达成。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSource } from '@vviewer/core';
import { hexRenderer, HEX_LINE_HEIGHT, renderHex } from '../src/hex';

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
  document.body.innerHTML = '';
});

const BYTES = new Uint8Array(64); // 4 行

function mount(lineMetrics?: { fontSize: number; lineHeight: number }): { inst: ReturnType<typeof renderHex>; target: HTMLElement; dump: HTMLElement } {
  const target = document.createElement('div');
  document.body.append(target);
  const inst = renderHex(BYTES, target, { createWorker: () => null, lineMetrics });
  return { inst, target, dump: target.querySelector('.vv-hex-dump') as HTMLElement };
}

describe('renderHex lineMetrics（hex 虚拟化行高参数化）', () => {
  it('lineMetrics：行内字号/行高锁定为透传值，spacer 总高 = 行数×lineHeight', () => {
    const { inst, target, dump } = mount({ fontSize: 16, lineHeight: 24 });
    expect(dump.style.cssText).toContain('font-size: 16px');
    expect(dump.style.cssText).toContain('line-height: 24px');
    const spacer = dump.querySelector<HTMLElement>('.vv-virtual-spacer');
    expect(spacer?.style.height).toBe(`${4 * 24}px`);
    inst.destroy();
    target.remove();
  });

  it('缺省回落现值：12px / 18px（HEX_LINE_HEIGHT），滚动坐标同常数', () => {
    const { inst, target, dump } = mount(undefined);
    expect(dump.style.cssText).toContain('font-size: 12px');
    expect(dump.style.cssText).toContain('line-height: 18px');
    const spacer = dump.querySelector<HTMLElement>('.vv-virtual-spacer');
    expect(spacer?.style.height).toBe(`${4 * HEX_LINE_HEIGHT}px`);
    inst.destroy();
    target.remove();
  });

  it('跳转虚拟坐标按 lineMetrics 换算（goto 输入 → scrollTop）', () => {
    const { inst, target, dump } = mount({ fontSize: 16, lineHeight: 24 });
    const goto = target.querySelector<HTMLInputElement>('.vv-hex-goto');
    goto!.value = '0x20'; // 行 2
    goto!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(dump.scrollTop).toBe(2 * 24); // jsdom clientHeight=0 → 行顶对齐
    inst.destroy();
    target.remove();
  });

  it('hexRenderer.render 第 6 参 opts.lineMetrics 透传（协议锚）', async () => {
    vi.stubGlobal('Worker', undefined); // jsdom 无 Worker：hexRenderer 内建 createWorker 降级 null
    const target = document.createElement('div');
    document.body.append(target);
    const source: FileSource = { storeId: 's', storeLabel: 's', path: 'a.bin', name: 'a.bin', store: {} as never };
    const instance = await hexRenderer.render(BYTES, target, source, { ext: 'bin' }, undefined, {
      lineMetrics: { fontSize: 16, lineHeight: 24 }
    });
    const dump = target.querySelector('.vv-hex-dump') as HTMLElement;
    expect(dump.style.cssText).toContain('font-size: 16px');
    expect(dump.style.cssText).toContain('line-height: 24px');
    instance.destroy();
  });
});
