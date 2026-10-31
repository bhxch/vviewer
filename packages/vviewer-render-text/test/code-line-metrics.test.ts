// code 行尺度协议（字体系统 Task 2，spec 2026-10-19 §3）：opts.lineMetrics 替换
// LINE_HEIGHT 常量的全部消费点（虚拟滚动装配 spacer/行占位高度/跳转虚拟坐标，
// 全量与窗口两路径），缺省回落 20——跨包零破坏。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamCtx } from '@bhxch/vviewer-core';
import { LINE_HEIGHT, renderCode } from '../src/code';

function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const TEXT_50 = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');

describe('renderCode opts.lineMetrics（行高联动）', () => {
  it('全量：scroller 行高按 lineMetrics 换算（spacer 总高 + 行占位高度）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const inst = renderCode(new TextEncoder().encode(TEXT_50), host, {
      highlight: false,
      lineMetrics: { fontSize: 16, lineHeight: 24 }
    });
    const spacer = host.querySelector<HTMLElement>('.vv-virtual-spacer');
    expect(spacer?.style.height).toBe(`${50 * 24}px`);
    const row = host.querySelector<HTMLElement>('.vv-code-line');
    expect(row?.style.height).toBe('24px');
    inst.destroy();
  });

  it('全量：缺省回落 LINE_HEIGHT=20（跨包零破坏）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const inst = renderCode(new TextEncoder().encode(TEXT_50), host, { highlight: false });
    const spacer = host.querySelector<HTMLElement>('.vv-virtual-spacer');
    expect(spacer?.style.height).toBe(`${50 * LINE_HEIGHT}px`);
    inst.destroy();
  });

  it('跳转虚拟坐标按 lineMetrics 换算（jumpToLine：line×LH−clientH/2+LH/2）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const inst = renderCode(new TextEncoder().encode('a\nb\nc\nd'), host, {
      highlight: false,
      lineMetrics: { fontSize: 16, lineHeight: 24 }
    });
    inst.revealLine(2); // jsdom clientHeight=0 → center = 2×24 − 0 + 12 = 60
    const pre = host.querySelector<HTMLElement>('.vv-code-pre');
    expect(pre?.scrollTop).toBe(60);
    inst.destroy();
  });

  it('窗口模式同样以 lineMetrics 装配（spacer 总高随行高）', async () => {
    stubResizeObserver();
    const lines = Array.from({ length: 300 }, (_, i) => `{"i":${i}}`);
    const full = new TextEncoder().encode(lines.join('\n'));
    // size null → 窗口路由（spec §4.3：size 未知恒窗口）
    const ctx: StreamCtx = {
      size: null,
      head: full.slice(0, 8192),
      read: async (r) => full.slice(r.start, r.end + 1)
    };
    const host = document.createElement('div');
    document.body.append(host);
    const inst = renderCode(full.slice(0, 8192), host, {
      ctx,
      highlight: false,
      lineMetrics: { fontSize: 16, lineHeight: 24 }
    });
    try {
      await vi.waitFor(() => expect(inst.getMeta().lines).toBe(300));
      const spacer = host.querySelector<HTMLElement>('.vv-virtual-spacer');
      expect(spacer?.style.height).toBe(`${300 * 24}px`);
    } finally {
      inst.destroy();
    }
  });
});
