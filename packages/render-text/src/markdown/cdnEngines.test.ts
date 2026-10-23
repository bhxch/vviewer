// cdnEngines.test.ts — CDN 直链引擎（spec §6）：mock loader 断言精确版本 URL 与
// 渲染产物；负结果不缓存（可重试）；bpmn destroy finally 语义；分发委派四 engine。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiagramEngine } from './diagramEngines';

// 分发委派（diagramEngines switch → cdnEngines 动态 import）：vi.mock 拦截模块边界；
// 真实现经 importActual 供直测组使用（mock 工厂 spread real 保底）。
vi.mock('./cdnEngines', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    renderExcalidrawCdn: vi.fn(async () => '<svg>exc-via-switch</svg>'),
    renderBpmnCdn: vi.fn(async () => '<svg>bpmn-via-switch</svg>'),
    renderVegaCdn: vi.fn(async () => '<svg>vega-via-switch</svg>')
  };
});

// 真函数：直测组走 mock loader，不触网
const { __setCdnLoaderForTest, renderExcalidrawCdn, renderBpmnCdn, renderVegaCdn } = await vi.importActual<
  typeof import('./cdnEngines')
>('./cdnEngines');

const seen: string[] = [];

beforeEach(() => {
  seen.length = 0;
  // 安全默认：未显式注入 mock loader 的用例一旦触 loader 立即炸（防真网络）
  __setCdnLoaderForTest(async () => {
    throw new Error('loader 未在该用例注入');
  });
});
afterEach(() => {
  __setCdnLoaderForTest(null);
});

describe('CDN 引擎直测（mock loader）', () => {
  it('excalidraw：精确版本 URL + markpad 归一化（data 包裹 + 导出背景默认）', async () => {
    const seenOpts: { data: Record<string, unknown> }[] = [];
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        exportToSvg: async (opts: { data: Record<string, unknown> }) => {
          seenOpts.push(opts);
          return { outerHTML: '<svg>exc</svg>' };
        }
      };
    });
    expect(
      await renderExcalidrawCdn('{"elements":[{"id":1}],"appState":{"viewBackgroundColor":"#fff"}}')
    ).toBe('<svg>exc</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/@excalidraw/utils@0.1.5/+esm']);
    const data = seenOpts[0]!.data as { elements: unknown[]; appState: Record<string, unknown> };
    expect(data.elements).toEqual([{ id: 1 }]);
    expect(data.appState).toMatchObject({ viewBackgroundColor: '#fff', exportBackground: true });
  });

  it('excalidraw：空/缺省源仍包出合法 data（viewBackgroundColor 默认白）', async () => {
    const seenOpts: { data: Record<string, unknown> }[] = [];
    __setCdnLoaderForTest(async () => ({
      exportToSvg: async (opts: { data: Record<string, unknown> }) => {
        seenOpts.push(opts);
        return { outerHTML: '<svg/>' };
      }
    }));
    await renderExcalidrawCdn('{}');
    const data = seenOpts[0]!.data as { elements: unknown[]; appState: Record<string, unknown> };
    expect(data.elements).toEqual([]);
    expect(data.appState).toEqual({ exportBackground: true, viewBackgroundColor: '#ffffff' });
  });

  it('bpmn：子路径 +esm URL + importXML/saveSVG 产物 + destroy 收尾', async () => {
    const calls: string[] = [];
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        default: function () {
          return {
            importXML: async (xml: string) => {
              calls.push(`importXML:${xml}`);
            },
            saveSVG: async () => ({ svg: '<svg>bpmn</svg>' }),
            destroy: () => {
              calls.push('destroy');
            }
          };
        }
      };
    });
    expect(await renderBpmnCdn('<definitions/>')).toBe('<svg>bpmn</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/bpmn-js@18.31.0/lib/NavigatedViewer.js/+esm']);
    expect(calls).toEqual(['importXML:<definitions/>', 'destroy']);
  });

  it('bpmn：importXML 失败仍 destroy（finally），错误上抛', async () => {
    const calls: string[] = [];
    __setCdnLoaderForTest(async () => ({
      default: function () {
        return {
          importXML: async () => {
            throw new Error('bad xml');
          },
          saveSVG: async () => ({ svg: '' }),
          destroy: () => {
            calls.push('destroy');
          }
        };
      }
    }));
    await expect(renderBpmnCdn('<bad/>')).rejects.toThrow('bad xml');
    expect(calls).toEqual(['destroy']);
  });

  it('vega：精确版本 URL + svg renderer 容器产物', async () => {
    const seenCall: { el: HTMLElement; spec: unknown; opts: unknown }[] = [];
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        default: async (el: HTMLElement, spec: unknown, opts: unknown) => {
          seenCall.push({ el, spec, opts });
          el.innerHTML = '<svg>vega</svg>';
        }
      };
    });
    expect(await renderVegaCdn('{"mark":"bar"}')).toBe('<svg>vega</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/vega-embed@7.3.0/+esm']);
    expect(seenCall[0]!.spec).toEqual({ mark: 'bar' });
    expect(seenCall[0]!.opts).toMatchObject({ renderer: 'svg' });
  });

  it('vega：容器无 svg 时抛错（错误卡片兜底）', async () => {
    __setCdnLoaderForTest(async () => ({ default: async () => {} }));
    await expect(renderVegaCdn('{}')).rejects.toThrow('vega 渲染失败');
  });

  it('负结果不缓存：连续两次失败各走一次 loader（可重试）', async () => {
    let n = 0;
    __setCdnLoaderForTest(async () => {
      n += 1;
      throw new Error(`cdn miss #${n}`);
    });
    await expect(renderExcalidrawCdn('{}')).rejects.toThrow('#1');
    await expect(renderExcalidrawCdn('{}')).rejects.toThrow('#2');
    expect(n).toBe(2);
  });
});

describe('分发委派：renderDiagramEngine 四新 engine 走 cdnEngines', () => {
  it('excalidraw/bpmn/vega/vegalite 分别委派对应 CDN 函数', async () => {
    expect(await renderDiagramEngine('excalidraw', 'x')).toBe('<svg>exc-via-switch</svg>');
    expect(await renderDiagramEngine('bpmn', 'x')).toBe('<svg>bpmn-via-switch</svg>');
    expect(await renderDiagramEngine('vega', 'x')).toBe('<svg>vega-via-switch</svg>');
    expect(await renderDiagramEngine('vegalite', 'x')).toBe('<svg>vega-via-switch</svg>');
  });
});
