// foreignRenderersMount.test.ts — mount 串行队列行为锚（终审修复波 I1）。
// foreignRenderers.test.ts 锁装配注册面（构造期零 mount），本文件锁 mount 期：
// ① 两个顶层 mount 并发调用 → handler 调用严格先后且基座切换不交叉（可控 promise
//   mock 门控 handler 挂起窗口）；
// ② 嵌套 foreign mount（handler 内经 context.renderNestedBuffer 再入）豁免队列
//   内联执行——外层挂起期间嵌套完成，无死锁，且嵌套 finally 恢复祖先基座。
//
// mock 面：@file-viewer/core 换最小桩（基座 setter 记事件 + dispatcher 返回统一
// 受控 handler），renderer-spreadsheet/renderer-chm 换空插件——被测对象是装配层
// 队列与基座簿记，非 foreign 包本体。事件统一落 h.events（base/start/end 三类），
// 全序列断言即「严格先后 + 不交叉」的复合锚。
import { describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, Renderer } from '@bhxch/vviewer-core';
import { markForeignNestedDepth, type NestedDispatch } from '@bhxch/vviewer-render-foreign';
import { createForeignFileRenderers } from './foreignRenderers';

const h = vi.hoisted(() => ({
  events: [] as string[],
  gates: new Map<string, Promise<void>>(),
  releases: new Map<string, () => void>(),
  // dbf handler 是否发起嵌套渲染（锚 2 置 true；锚 1 保持 false 保持全序列确定）
  nestedOnDbf: false,
  // mount 期 zoom provider 交付桩（锚 3 置桩；缺省 null = 无 provider 组形态）
  zoomProvider: null as unknown
}));

vi.mock('@file-viewer/core', () => {
  const tag = (base: string) => (base.includes('assets-chm@') ? 'chm' : base.includes('assets-standard@') ? 'std' : base);
  const handler = async (
    _buffer: ArrayBuffer,
    _target: HTMLElement,
    ext: string | undefined,
    context: { renderNestedBuffer?: (b: ArrayBuffer, type: string, target: HTMLDivElement) => Promise<unknown> } | undefined
  ) => {
    const e = ext ?? '';
    h.events.push(`start:${e}`);
    if (e === 'dbf' && h.nestedOnDbf && context?.renderNestedBuffer) {
      // 外层挂起期间发起嵌套（email 附件预览 dist 的 await 形态同款）
      await context.renderNestedBuffer(new ArrayBuffer(8), 'chm', document.createElement('div'));
    }
    await h.gates.get(e);
    h.events.push(`end:${e}`);
    return { unmount: () => {} };
  };
  return {
    setDefaultFileViewerAssetBaseUrl: (base: string) => {
      h.events.push(`base:${tag(base)}`);
    },
    createRendererRegistry: (definitions: readonly unknown[]) => ({ definitions }),
    createFileViewerRendererDispatcher: () => ({ get: () => handler }),
    findFileViewerZoomProvider: () => h.zoomProvider // 锚 3 交付桩；缺省 null = 无 provider 组零干预
  };
});

vi.mock('@file-viewer/renderer-spreadsheet', () => ({
  spreadsheetRenderer: { definitions: [], handlers: [] }
}));
vi.mock('@file-viewer/renderer-chm', () => ({
  chmRenderer: { definitions: [], handlers: [] }
}));

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function gate(ext: string): void {
  const g = defer();
  h.gates.set(ext, g.promise);
  h.releases.set(ext, g.resolve);
}

/** bridge render 直调形态（viewer dispatch 同参子集：buffer/target/source/det 必填）；
 * target 缺省新建容器，嵌套链须显式透传嵌套 target（内联豁免以 target 为识别键） */
function renderOnce(renderer: Renderer, name: string, target: HTMLElement = document.createElement('div')): Promise<unknown> {
  const source = { storeId: 'foreign-mount-test', storeLabel: '测试源', path: name, name } as FileSource;
  return renderer.render(new Uint8Array([1]), target, source, {} as Detection);
}

describe('pluginMount 串行队列（终审 I1）', () => {
  it('锚一：两个顶层 mount 并发调用 → handler 严格先后且基座切换不交叉', async () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    const ss = renderers.find((r) => r.id === 'foreign-spreadsheet')!;
    const chm = renderers.find((r) => r.id === 'foreign-chm')!;
    gate('dbf');
    gate('chm');
    h.events.length = 0;

    const p1 = renderOnce(ss, 'a.dbf');
    const p2 = renderOnce(chm, 'b.chm');

    // dbf handler 先启动并挂起：chm 任务不得交叉启动，chm 基座不得提前切换
    await vi.waitFor(() => expect(h.events).toContain('start:dbf'));
    expect(h.events).not.toContain('start:chm');
    expect(h.events).not.toContain('base:chm');

    h.releases.get('dbf')!();
    await p1;
    await vi.waitFor(() => expect(h.events).toContain('start:chm'));
    h.releases.get('chm')!();
    await p2;

    // 全序列：装配初始基座 → dbf handler（assets-standard 与初始同值，切换幂等不落
    // 事件）→ dbf 完成后才切 chm 基座 → chm handler → finally 恢复进入前基座
    expect(h.events).toEqual(['base:std', 'start:dbf', 'end:dbf', 'base:chm', 'start:chm', 'end:chm', 'base:std']);
  });

  it('锚二：嵌套 foreign mount 豁免队列内联执行——外层挂起期间嵌套完成（无死锁）且恢复祖先基座', async () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    const ss = renderers.find((r) => r.id === 'foreign-spreadsheet')!;
    const chm = renderers.find((r) => r.id === 'foreign-chm')!;
    // viewer.ts foreignNestedDispatch 镜像：登记深度 → byExtension 分派（此处直连
    // chm 桥）——嵌套链终点的 mount 携嵌套 target，走内联豁免路径
    const nestedDispatch: NestedDispatch = async (_data, name, target, _signal, depth) => {
      markForeignNestedDepth(target, depth);
      await renderOnce(chm, name, target);
    };
    const renderers2 = createForeignFileRenderers({ nestedDispatch });
    const ss2 = renderers2.find((r) => r.id === 'foreign-spreadsheet')!;
    h.nestedOnDbf = true;
    h.gates.clear();
    h.releases.clear();
    h.events.length = 0;

    // 外层任务全程占队；嵌套 chm 若再入队即死锁（测试超时即红）——内联豁免使其
    // 在外层 handler 挂起窗口内完成
    await renderOnce(ss2, 'a.dbf');

    const idx = (e: string) => h.events.indexOf(e);
    expect(idx('end:chm')).toBeGreaterThan(idx('start:chm'));
    expect(idx('end:chm')).toBeLessThan(idx('end:dbf')); // 嵌套完成于外层结束前（无死锁铁证）
    expect(idx('base:chm')).toBeGreaterThan(idx('start:dbf')); // 嵌套基座切换在内联任务内
    // 嵌套 finally 恢复祖先基座（std 重现于嵌套结束与外层结束之间）
    expect(h.events.lastIndexOf('base:std')).toBeGreaterThan(idx('end:chm'));
    expect(h.events.lastIndexOf('base:std')).toBeLessThan(idx('end:dbf'));
    h.nestedOnDbf = false;
  });

  it('锚三：mount 成功接 ctrl+wheel 缩放（provider 发现→接线→destroy 摘除），无 provider 组零干预', async () => {
    // provider 桩：经 mock 的 core findFileViewerZoomProvider 交付（装配层发现缝实况）
    const zoomCalls: number[] = [];
    h.zoomProvider = {
      zoomIn: () => ({}),
      zoomOut: () => ({}),
      setZoom: (scale: number) => {
        zoomCalls.push(scale);
      },
      getState: () => ({ scale: 1 })
    };
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    const ss = renderers.find((r) => r.id === 'foreign-spreadsheet')!;
    const target = document.createElement('div');
    const wheel = (deltaY: number): boolean => {
      const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ctrlKey: true, deltaY });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

    const inst = await renderOnce(ss, 'a.xlsx', target);
    expect(wheel(-120)).toBe(true); // 有 provider：拦截浏览器整页缩放
    await tick();
    expect(zoomCalls).toHaveLength(1);
    expect(zoomCalls[0]).toBeCloseTo(Math.exp(120 / 1000), 5); // 乘性步进实况

    (inst as { destroy: () => void }).destroy();
    zoomCalls.length = 0;
    expect(wheel(-120)).toBe(false); // destroy 摘除：不再拦截不缩放
    await tick();
    expect(zoomCalls).toEqual([]);
  });
});
