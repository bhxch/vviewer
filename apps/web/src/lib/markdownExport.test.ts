// markdownExport.test.ts — 导出触发壳可测辅助（md-export Task 2）：图片 data URI
// 解析策略（外域不强拉/失败降级）、PDF 前置 mermaid 浅色重画、导出文件名、print
// 特性检测。装配本体在 @vviewer/render-text/markdown/export（Task 1 纯函数，
// 已有独立单测）；Blob 下载与 iframe print 为纯浏览器副作用面，vitest 不真跑
//（下载断言由 e2e 承担，print 可用性仅测特性检测函数）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportFileName, printAvailable, repaintMermaidForPrint, resolveExportImage } from './markdownExport';
import { renderMermaidInto } from '@vviewer/render-text/markdown/diagramEngines';

// mermaid 真渲染是重浏览器面（jsdom 不承载）：以桩隔离，只断言重画调度
vi.mock('@vviewer/render-text/markdown/diagramEngines', () => ({
  renderMermaidInto: vi.fn(async () => true)
}));

function mockFetch(impl: (src: string) => unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl as (input: RequestInfo | URL) => unknown);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function imageResponse(bytes: Uint8Array, type = 'image/png'): Response {
  return {
    ok: true,
    headers: { get: () => type },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(renderMermaidInto).mockClear();
});

describe('resolveExportImage——图片 data URI 解析策略', () => {
  it('data: 已内联与空 src 原样保留（返回 null），不发起 fetch', async () => {
    const spy = mockFetch(() => imageResponse(new Uint8Array([0])));
    expect(await resolveExportImage('data:image/gif;base64,R0=')).toBeNull();
    expect(await resolveExportImage('')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('外域 http(s) 不强拉（CORS 不可控，spec §6）：返回 null 且不 fetch', async () => {
    const spy = mockFetch(() => imageResponse(new Uint8Array([0])));
    expect(await resolveExportImage('https://example.com/x.png')).toBeNull();
    expect(await resolveExportImage('http://elsewhere.test/y.jpg')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('同源 http(s) 相对图：fetch 转 data URI（内容型取响应头）', async () => {
    // jsdom 测试环境 location = http://localhost:3000/
    const spy = mockFetch((src) => {
      expect(src).toBe('http://localhost:3000/assets/pic.png');
      return imageResponse(new Uint8Array([1, 2, 3]));
    });
    expect(await resolveExportImage('/assets/pic.png')).toBe('data:image/png;base64,AQID');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('blob: 图 fetch 转 data URI；MIME 缺型回退 image/png（img 解码按内容嗅探）', async () => {
    mockFetch(() => imageResponse(new Uint8Array([1]), ''));
    expect(await resolveExportImage('blob:https://localhost:3000/abc')).toBe('data:image/png;base64,AQ==');
  });

  it('非 image 内容型（404 HTML 页等）不内联：保留原 URL', async () => {
    mockFetch(() => imageResponse(new Uint8Array([0x3c]), 'text/html'));
    expect(await resolveExportImage('/assets/pic.png')).toBeNull();
  });

  it('fetch 非 2xx 保留原 URL；fetch 抛错同义降级', async () => {
    mockFetch(() => ({ ok: false, headers: { get: () => null } }));
    expect(await resolveExportImage('/missing.png')).toBeNull();
    mockFetch(() => {
      throw new Error('network down');
    });
    expect(await resolveExportImage('/missing.png')).toBeNull();
  });
});

describe('repaintMermaidForPrint——PDF 浅色重画调度', () => {
  it('对克隆 doc 内每个 [data-mermaid] 以 default 主题重画；空锚跳过； detached 容器无需挂载', async () => {
    const doc = new DOMParser().parseFromString(
      `<div class="md-diagram-view" data-mermaid="graph TD; A-->B"></div>
       <div class="md-diagram-view" data-mermaid=""></div>
       <div class="md-diagram-view" data-mermaid="pie title x"></div>`,
      'text/html'
    );
    await repaintMermaidForPrint(doc);
    const calls = vi.mocked(renderMermaidInto).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toBe('graph TD; A-->B');
    expect(calls[0]![2]).toBe('default');
    expect(calls[1]![1]).toBe('pie title x');
  });
});

describe('exportFileName / printAvailable', () => {
  it('导出文件名：<原名>.html（剥单一扩展；无名回退 export）', () => {
    expect(exportFileName('notes.md', 'html')).toBe('notes.html');
    expect(exportFileName('a.b.md', 'html')).toBe('a.b.html');
    expect(exportFileName('README', 'html')).toBe('README.html');
    expect(exportFileName('', 'html')).toBe('export.html');
  });

  it('print 特性检测：contentWindow 缺失/无 print 方法视为不可用', () => {
    expect(printAvailable(null)).toBe(false);
    expect(printAvailable({} as Window)).toBe(false);
    expect(printAvailable({ print: () => {} } as unknown as Window)).toBe(true);
  });
});
