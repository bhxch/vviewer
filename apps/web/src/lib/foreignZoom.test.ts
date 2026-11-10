// foreignZoom.test.ts — ctrl+wheel 缩放接线单测（jsdom 直驱 DOM 面，无 runes 纯 .ts）。
// 被测对象是 wheel 事件→zoom provider 的驱动数学与生命周期（preventDefault 边界、
// deltaMode 归一、乘性累积、rAF 合并、min/max 钳制与 no-op 跳过、setZoom 缺席兜底、
// detach 摘除幂等）——provider 发现（core findFileViewerZoomProvider）在装配层
// （foreignRenderers pluginMount），不在本测面。jsdom 无 rAF：实现回落 setTimeout
// （16ms），测试以短等待等帧。
import { describe, expect, it, vi } from 'vitest';
import { wireForeignZoom, type ForeignZoomProvider } from './foreignZoom';

/** 受控 provider 桩：记录调用 + 可编程当前态。 */
function makeProvider(scale = 1, bounds: { minScale?: number; maxScale?: number } = {}) {
  const calls: Array<{ kind: 'setZoom' | 'zoomIn' | 'zoomOut'; value?: number }> = [];
  const provider: ForeignZoomProvider = {
    zoomIn: () => {
      calls.push({ kind: 'zoomIn' });
      return {};
    },
    zoomOut: () => {
      calls.push({ kind: 'zoomOut' });
      return {};
    },
    setZoom: (next) => {
      calls.push({ kind: 'setZoom', value: next });
      scale = next;
      return {};
    },
    getState: () => ({ scale, minScale: bounds.minScale, maxScale: bounds.maxScale })
  };
  return { provider, calls, setScale: (s: number) => (scale = s) };
}

/** 派发 wheel 事件到 target（bubbles 不必需——监听挂 target 本体；cancelable 必需）。 */
function wheel(target: HTMLElement, init: WheelEventInit & { ctrlKey?: boolean }): boolean {
  const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

/** 等一帧（实现回落 setTimeout 16ms；rAF 环境同窗内）。 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe('wireForeignZoom（ctrl+wheel → zoom provider 驱动）', () => {
  it('ctrl+wheel 放大：preventDefault + setZoom(乘性步进)——deltaY -120 → scale×e^0.12', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    const prevented = wheel(target, { ctrlKey: true, deltaY: -120, deltaMode: 0 });
    await tick();

    expect(prevented).toBe(true); // 阻断浏览器整页缩放（触控板捏合同通道）
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ kind: 'setZoom', value: expect.closeTo(Math.exp(120 / 1000), 5) });

    detach();
  });

  it('非 ctrl wheel 不拦截不缩放（渲染器自滚动照常）', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    const prevented = wheel(target, { deltaY: -120 });
    await tick();

    expect(prevented).toBe(false);
    expect(calls).toEqual([]);

    detach();
  });

  it('同帧多事件合并：两次 ctrl+wheel 恰一次 setZoom（累积乘性）', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    wheel(target, { ctrlKey: true, deltaY: -100 });
    wheel(target, { ctrlKey: true, deltaY: -100 });
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ kind: 'setZoom', value: expect.closeTo(Math.exp(200 / 1000), 5) });

    detach();
  });

  it('跨帧不合并：逐帧各调一次 setZoom（连续滚动的多步缩放）', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    wheel(target, { ctrlKey: true, deltaY: -100 });
    await tick();
    wheel(target, { ctrlKey: true, deltaY: -100 });
    await tick();

    expect(calls).toHaveLength(2);

    detach();
  });

  it('deltaMode 1（行）按 16px/行归一（tabScroll 同约定）', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    wheel(target, { ctrlKey: true, deltaY: -3, deltaMode: 1 });
    await tick();

    expect(calls[0]).toEqual({ kind: 'setZoom', value: expect.closeTo(Math.exp(48 / 1000), 5) });

    detach();
  });

  it('min/max 钳制：越界 no-op 跳过 setZoom（无谓全量重布局不发生）', async () => {
    const { provider, calls } = makeProvider(2, { minScale: 0.25, maxScale: 2 });
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    wheel(target, { ctrlKey: true, deltaY: -120 }); // 请求放大越 max
    await tick();
    expect(calls).toEqual([]); // next 钳后 == 当前 → 跳过

    wheel(target, { ctrlKey: true, deltaY: 240 }); // 缩小落 [min, max] 内
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ kind: 'setZoom', value: expect.closeTo(2 * Math.exp(-240 / 1000), 5) });

    detach();
  });

  it('setZoom 缺席：zoomIn/zoomOut 方向兜底（provider 契约 setZoom 可选）', async () => {
    const calls: string[] = [];
    const provider: ForeignZoomProvider = {
      zoomIn: () => {
        calls.push('in');
        return {};
      },
      zoomOut: () => {
        calls.push('out');
        return {};
      },
      getState: () => ({ scale: 1 })
    };
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    wheel(target, { ctrlKey: true, deltaY: -100 });
    await tick();
    wheel(target, { ctrlKey: true, deltaY: 100 });
    await tick();

    expect(calls).toEqual(['in', 'out']);

    detach();
  });

  it('detach 摘除：后续 wheel 不拦截不缩放；重复 detach 幂等', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);
    detach();
    detach(); // 幂等

    const prevented = wheel(target, { ctrlKey: true, deltaY: -120 });
    await tick();

    expect(prevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it('零 delta 不触发缩放（但仍拦截浏览器默认）', async () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    const prevented = wheel(target, { ctrlKey: true, deltaY: 0 });
    await tick();

    expect(prevented).toBe(true);
    expect(calls).toEqual([]);

    detach();
  });

  it('metaKey 不触发（浏览器整页缩放仅 ctrl 通道；Mac pinch 亦发 ctrlKey）', () => {
    const { provider, calls } = makeProvider(1);
    const target = document.createElement('div');
    const detach = wireForeignZoom(target, provider);

    const prevented = wheel(target, { metaKey: true, deltaY: -120 });

    expect(prevented).toBe(false);
    expect(calls).toEqual([]);

    detach();
  });

  it('setZoom 同步抛错不毒化后续帧（下一 wheel 照常驱动）', async () => {
    const calls: string[] = [];
    const provider: ForeignZoomProvider = {
      zoomIn: () => ({}),
      zoomOut: () => ({}),
      setZoom: () => {
        throw new Error('boom');
      },
      getState: () => ({ scale: 1 })
    };
    const target = document.createElement('div');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detach = wireForeignZoom(target, provider);

    wheel(target, { ctrlKey: true, deltaY: -120 });
    await tick();
    wheel(target, { ctrlKey: true, deltaY: -120 });
    await tick();

    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();

    detach();
    void calls;
  });
});
