// cdnEngines.test.ts — CDN 直链引擎（spec §6/§10）：mock loader 断言精确版本 URL 与
// 渲染产物；负结果不缓存（可重试）；bpmn destroy finally 语义；分发委派八 engine。
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
    renderVegaCdn: vi.fn(async () => '<svg>vega-via-switch</svg>'),
    renderGraphvizHpcc: vi.fn(async () => '<svg>hpcc-via-switch</svg>'),
    renderWavedromCdn: vi.fn(async () => '<svg>wavedrom-via-switch</svg>'),
    renderBytefieldCdn: vi.fn(async () => '<svg>bytefield-via-switch</svg>'),
    renderDbmlCdn: vi.fn(async () => '<svg>dbml-via-switch</svg>'),
    renderD2Cdn: vi.fn(async () => '<svg>d2-via-switch</svg>')
  };
});

// 真函数：直测组走 mock loader，不触网
const {
  __setCdnLoaderForTest,
  renderExcalidrawCdn,
  renderBpmnCdn,
  renderVegaCdn,
  renderGraphvizHpcc,
  renderWavedromCdn,
  renderBytefieldCdn,
  renderDbmlCdn,
  renderD2Cdn
} = await vi.importActual<typeof import('./cdnEngines')>('./cdnEngines');

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

  it('excalidraw：空/缺省源仍包出合法 data（viewBackgroundColor 空串同回退白——markpad || 对齐）', async () => {
    const seenOpts: { data: Record<string, unknown> }[] = [];
    __setCdnLoaderForTest(async () => ({
      exportToSvg: async (opts: { data: Record<string, unknown> }) => {
        seenOpts.push(opts);
        return { outerHTML: '<svg/>' };
      }
    }));
    await renderExcalidrawCdn('{"appState":{"viewBackgroundColor":""}}');
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

describe('graphviz hpcc 渲染器（spec 2026-10-23 §9.1，mock loader）', () => {
  it('精确版本 URL + Graphviz.load() → layout(source, svg, dot) 产物', async () => {
    const calls: string[] = [];
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        Graphviz: {
          load: async () => {
            calls.push('load');
            return {
              layout: async (src: string, fmt?: string, engine?: string) => {
                calls.push(`layout:${src}:${fmt}:${engine}`);
                return '<svg>hpcc</svg>';
              },
              dispose: () => {
                calls.push('dispose');
              }
            };
          }
        }
      };
    });
    expect(await renderGraphvizHpcc('digraph { a -> b }')).toBe('<svg>hpcc</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/@hpcc-js/wasm-graphviz@1.30.0/+esm']);
    expect(calls).toEqual(['load', 'layout:digraph { a -> b }:svg:dot', 'dispose']);
  });

  it('layout 失败仍 dispose（finally），错误上抛', async () => {
    const calls: string[] = [];
    __setCdnLoaderForTest(async () => ({
      Graphviz: {
        load: async () => ({
          layout: async () => {
            throw new Error('bad dot');
          },
          dispose: () => {
            calls.push('dispose');
          }
        })
      }
    }));
    await expect(renderGraphvizHpcc('digraph { a ->')).rejects.toThrow('bad dot');
    expect(calls).toEqual(['dispose']);
  });
});

describe('spec §10 四新引擎直测（mock loader）', () => {
  it('wavedrom：精确版本 URL + renderAny(seq, JSON.parse(source), waveSkin) + onml.stringify 产物', async () => {
    const calls: unknown[][] = [];
    const skin = { default: ['svg', {}] };
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        renderAny: (index: number, source: unknown, waveSkin: unknown) => {
          calls.push([index, source, waveSkin]);
          return ['svg', { id: `svgcontent_${index}` }];
        },
        waveSkin: skin,
        onml: { stringify: (tree: unknown[]) => `<out>${(tree[1] as { id: string }).id}</out>` }
      };
    });
    expect(await renderWavedromCdn('{"signal":[{"name":"clk","wave":"p"}]}')).toBe('<out>svgcontent_1</out>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/wavedrom@3.7.0/+esm']);
    // 实测口径：renderAny 首参 seq 递增（svg id 唯一化）、源经 JSON.parse、皮肤走模块自带 waveSkin
    expect(calls[0]![0]).toBe(1);
    expect(calls[0]![1]).toEqual({ signal: [{ name: 'clk', wave: 'p' }] });
    expect(calls[0]![2]).toBe(skin);
    // seq 递增：同进程第二次渲染 id 不重复
    await renderWavedromCdn('{"signal":[]}');
    expect(calls[1]![0]).toBe(2);
  });

  it('wavedrom：非法 JSON 抛错走回退链；非 signal 源（renderAny 回落 div 树）守卫抛错', async () => {
    __setCdnLoaderForTest(async () => ({
      renderAny: () => ['div', {}],
      waveSkin: {},
      onml: { stringify: () => '<div></div>' }
    }));
    await expect(renderWavedromCdn('{signal:')).rejects.toThrow(); // JSON.parse 失败
    await expect(renderWavedromCdn('{}')).rejects.toThrow('wavedrom 渲染失败'); // div 树守卫
  });

  it('bytefield：精确版本 URL + default(source, {embedded:true}) 产物', async () => {
    const calls: unknown[][] = [];
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        default: (src: string, opts?: { embedded?: boolean }) => {
          calls.push([src, opts]);
          return '<svg>bytefield</svg>';
        }
      };
    });
    expect(await renderBytefieldCdn('(draw-column-headers)')).toBe('<svg>bytefield</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/bytefield-svg@1.11.0/+esm']);
    expect(calls[0]).toEqual(['(draw-column-headers)', { embedded: true }]); // 去 <?xml?> 序言口径
  });

  it('dbml：精确版本 URL + run(source, svg) 同步产物 + <?xml?> 序言剥离', async () => {
    const calls: unknown[][] = [];
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        run: (src: string, format: string) => {
          calls.push([src, format]);
          return '<?xml version="1.0" encoding="UTF-8"?>\n<svg>dbml</svg>';
        }
      };
    });
    expect(await renderDbmlCdn('Table users {}')).toBe('<svg>dbml</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/@softwaretechnik/dbml-renderer@1.0.31/+esm']);
    expect(calls[0]).toEqual(['Table users {}', 'svg']);
  });

  it('d2：精确版本 URL + compile→render(diagram, renderOptions+noXMLTag)→dispose（finally）', async () => {
    const calls: string[] = [];
    let renderOpts: unknown;
    const diagram = { name: 'root' };
    __setCdnLoaderForTest(async (url) => {
      seen.push(url);
      return {
        D2: function () {
          return {
            compile: async (src: string) => {
              calls.push(`compile:${src}`);
              return { diagram, renderOptions: { pad: 100 } };
            },
            render: async (d: unknown, opts?: Record<string, unknown>) => {
              calls.push('render');
              renderOpts = opts;
              expect(d).toBe(diagram); // 官方 README：render 首参必传 compile 产物 diagram
              return '<svg>d2</svg>';
            },
            dispose: async () => {
              calls.push('dispose');
            }
          };
        }
      };
    });
    expect(await renderD2Cdn('x -> y')).toBe('<svg>d2</svg>');
    expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/@d2lang/d2@0.1.34/+esm']);
    expect(calls).toEqual(['compile:x -> y', 'render', 'dispose']); // dispose 收尾
    expect(renderOpts).toEqual({ pad: 100, noXMLTag: true }); // 合并 renderOptions + 内联嵌入口径
  });

  it('d2：compile 失败仍 dispose（finally），错误上抛', async () => {
    const calls: string[] = [];
    __setCdnLoaderForTest(async () => ({
      D2: function () {
        return {
          compile: async () => {
            throw new Error('bad d2');
          },
          render: async () => '<svg/>',
          dispose: async () => {
            calls.push('dispose');
          }
        };
      }
    }));
    await expect(renderD2Cdn('x ->')).rejects.toThrow('bad d2');
    expect(calls).toEqual(['dispose']);
  });
});

describe('分发委派：renderDiagramEngine 四新 engine 走 cdnEngines', () => {
  it('excalidraw/bpmn/vega/vegalite 分别委派对应 CDN 函数', async () => {
    expect(await renderDiagramEngine('excalidraw', 'x')).toBe('<svg>exc-via-switch</svg>');
    expect(await renderDiagramEngine('bpmn', 'x')).toBe('<svg>bpmn-via-switch</svg>');
    expect(await renderDiagramEngine('vega', 'x')).toBe('<svg>vega-via-switch</svg>');
    expect(await renderDiagramEngine('vegalite', 'x')).toBe('<svg>vega-via-switch</svg>');
  });

  it('wavedrom/bytefield/dbml/d2 分别委派对应 CDN 函数（spec §10）', async () => {
    expect(await renderDiagramEngine('wavedrom', 'x')).toBe('<svg>wavedrom-via-switch</svg>');
    expect(await renderDiagramEngine('bytefield', 'x')).toBe('<svg>bytefield-via-switch</svg>');
    expect(await renderDiagramEngine('dbml', 'x')).toBe('<svg>dbml-via-switch</svg>');
    expect(await renderDiagramEngine('d2', 'x')).toBe('<svg>d2-via-switch</svg>');
  });

  it('graphviz renderer=hpcc 委派 renderGraphvizHpcc；缺省/viz-js 不委派（既有 viz 路径，spec §9.1）', async () => {
    const { renderGraphvizHpcc } = await import('./cdnEngines');
    const hpccMock = vi.mocked(renderGraphvizHpcc);
    expect(await renderDiagramEngine('graphviz', 'x', { renderer: 'hpcc' })).toBe('<svg>hpcc-via-switch</svg>');
    expect(hpccMock).toHaveBeenCalledTimes(1);
    // 缺省（rendererOf undefined = settings.renderers 空）与显式 viz-js 均走 viz 路径
    //（viz 真渲染环境相关，失败容差——断言只看 hpcc mock 零追加调用）
    await renderDiagramEngine('graphviz', 'x').catch(() => {});
    await renderDiagramEngine('graphviz', 'x', { renderer: 'viz-js' }).catch(() => {});
    expect(hpccMock).toHaveBeenCalledTimes(1);
  });
});
