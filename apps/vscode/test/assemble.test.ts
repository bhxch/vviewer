// assemble.test.ts — webview 装配层契约（spec H T3 Step 2）。
//
// 覆盖面（计划 T3 Step 2 明列）：注册表安装序（code → markdown → …；`md` 归 markdown）、
// **十一处 setter 逐一断言**（含 `setPdfWorkerUrlProvider` / `setHexWorkerUrlProvider`
// 两条**必须接线**的缝：断言注入后取到 worker URL，**不接即 pdf 渲染死 / hex 挂死**）、
// dispatcher 对单文件 source 选中预期渲染器。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { errorMessageOf, GENERATED_EXTENSIONS } from '@bhxch/vviewer-core';
import {
  getDiagramOptions,
  getHighlightFence,
  getMarkdownBackend,
  getMarkdownImageResolver,
  getRelativeLinkOpener,
  getRelativeLinkResolver,
  getResolveRemoteBase
} from '@bhxch/vviewer-markdown';
import { getExternalImagePolicyProvider } from '@bhxch/vviewer-sanitize';
import { getPdfWorkerUrl } from '@bhxch/vviewer-render-doc';
import { getHexWorkerUrl } from '@bhxch/vviewer-render-binary';
import { fenceToHtml } from '@bhxch/vviewer-render-text/markdown/markdownRenderer';
import { assembleViewer, type AssembleDeps } from '../src/webview/assemble';
import { createSingleFileSource } from '../src/webview/store';
import { DEFAULT_WEBVIEW_SETTINGS, type AssetUris } from '../src/host/protocol';

const ASSETS: AssetUris = {
  grammarsBase: 'https://webview/assets/grammars/',
  queriesBase: 'https://webview/assets/queries/',
  runtimeDir: 'https://webview/assets/',
  grammars: {},
  binaryWorkerUrl: 'https://webview/binary-worker.js',
  pdfWorkerModernUrl: 'https://webview/pdf/pdf.worker.min.mjs',
  pdfWorkerLegacyUrl: 'https://webview/pdf/pdf.worker.legacy.min.mjs',
  fontsBase: 'https://webview/fonts/',
  katexCssUrl: 'https://webview/katex.min.css',
  katexExportCssUrl: 'https://webview/katex.export.css',
  themesUrl: 'https://webview/assets/themes.json',
  highlightWorkerSourceUrl: 'https://webview/highlight-worker.js'
};

function makeDeps(overrides: Partial<AssembleDeps> = {}): AssembleDeps {
  return {
    settings: DEFAULT_WEBVIEW_SETTINGS,
    assets: ASSETS,
    themeKind: 'light',
    resolveImage: async () => null,
    resolveLink: async () => ({ kind: 'missing' as const }),
    openLink: () => undefined,
    text: (key) => `t:${key}`,
    ...overrides
  };
}

// jsdom 无 ResizeObserver（code 渲染器的虚拟滚动用之）——照仓内 virtualScroller.test.ts 惯例打桩
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

describe('装配层 · 注册表', () => {
  it('安装序：code → markdown → html → image → av → pdf → hex → jsonl', () => {
    const { registry } = assembleViewer(makeDeps());
    expect(registry.all().map((r) => r.id)).toEqual([
      'code',
      'markdown',
      'html',
      'image',
      'av',
      'pdf',
      'hex',
      'jsonl'
    ]);
  });

  it('md/markdown 归 markdown 渲染器（非 code）', () => {
    const { registry } = assembleViewer(makeDeps());
    expect(registry.byExtension('md')?.id).toBe('markdown');
    expect(registry.byExtension('markdown')?.id).toBe('markdown');
  });

  it('html/htm 归 html 渲染器；pdf/png/mp4/jsonl 各归其主', () => {
    const { registry } = assembleViewer(makeDeps());
    expect(registry.byExtension('html')?.id).toBe('html');
    expect(registry.byExtension('htm')?.id).toBe('html');
    expect(registry.byExtension('pdf')?.id).toBe('pdf');
    expect(registry.byExtension('png')?.id).toBe('image');
    expect(registry.byExtension('mp4')?.id).toBe('av');
    expect(registry.byExtension('jsonl')?.id).toBe('jsonl');
  });

  it.skipIf(GENERATED_EXTENSIONS.length === 0)(
    'generated 兜底补空位（未被专有渲染器认领的语法类扩展名归 code）',
    () => {
      // 生成物未生成时（干净克隆未跑 pnpm gen:sources，仓内为提交面占位空集）该认领面
      // 缺席 → 本例跳过（CI 恒有生成物 → 断言恒生效）
      const { registry } = assembleViewer(makeDeps());
      expect(registry.byExtension('zig')?.id).toBe('code');
      expect(registry.byExtension('nim')?.id).toBe('code');
    }
  );

  it('archive/foreign/Office 渲染器未装（裁量 3：MVP 裁剪）', () => {
    const { registry } = assembleViewer(makeDeps());
    const ids = registry.all().map((r) => r.id);
    expect(ids).not.toContain('archive');
    expect(ids.some((id) => id.startsWith('foreign-'))).toBe(false);
    expect(ids).not.toContain('docx');
    expect(ids).not.toContain('xlsx');
    expect(ids).not.toContain('pptx');
  });
});

describe('装配层 · 十一处 setter 逐一断言', () => {
  it('① setHighlightFence（markdown 组合包）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getHighlightFence()).toBe(seams.highlightFence);
    expect(seams.highlightFence).toBe(fenceToHtml);
  });

  it('② setMarkdownBackend（恒本地）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getMarkdownBackend()).toBe(seams.markdownBackend);
  });

  it('③ setResolveRemoteBase（扩展无远程来源 → 恒 null）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getResolveRemoteBase()).toBe(seams.resolveRemoteBase);
    expect(seams.resolveRemoteBase({ storeId: 's', path: 'p' })).toBeNull();
  });

  it('④ setMarkdownImageResolver', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getMarkdownImageResolver()).toBe(seams.markdownImageResolver);
  });

  it('⑤ setRelativeLinkResolver', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getRelativeLinkResolver()).toBe(seams.relativeLinkResolver);
  });

  it('⑥ setRelativeLinkOpener', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getRelativeLinkOpener()).toBe(seams.relativeLinkOpener);
  });

  it('⑦ setDiagramOptions（返回注入值）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getDiagramOptions()).toBe(seams.diagramOptions());
    expect(getDiagramOptions()?.mermaidTheme).toBe('default');
    expect(getDiagramOptions()?.modeOf('mermaid')).toBe('local');
  });

  it('⑧ setExternalImagePolicyProvider（sanitize 包）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getExternalImagePolicyProvider()).toBe(seams.externalImagePolicyProvider);
    expect(getExternalImagePolicyProvider()?.()).toEqual({
      policy: 'blocked',
      allowlist: []
    });
  });

  it('⑨ setRenderFailedText（错误文案走注入值）', () => {
    const { seams } = assembleViewer(makeDeps());
    // 空文案回落注入的兜底（core 的 errorMessageOf 空串分支）
    expect(errorMessageOf(new Error(''))).toBe(seams.renderFailedText());
    expect(errorMessageOf(new Error(''))).toBe('t:errors.render.failed');
  });

  it('⑩ setPdfWorkerUrlProvider（注入后取到 worker URL——不接即 pdf 渲染死）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getPdfWorkerUrl()).toBe(seams.pdfWorkerUrlProvider());
    expect([ASSETS.pdfWorkerModernUrl, ASSETS.pdfWorkerLegacyUrl]).toContain(getPdfWorkerUrl());
  });

  it('⑪ setHexWorkerUrlProvider（注入后取到 worker URL——不接即 hex 挂死）', () => {
    const { seams } = assembleViewer(makeDeps());
    expect(getHexWorkerUrl()).toBe(seams.hexWorkerUrlProvider());
    expect(getHexWorkerUrl()).toBe(ASSETS.binaryWorkerUrl);
  });
});

describe('装配层 · 数据面与 dispatcher', () => {
  it('单文件 store 注入 source（core singleFile 先例）', () => {
    const source = createSingleFileSource(new Uint8Array([1, 2, 3]), 'a.md', '/x/a.md');
    expect(source.name).toBe('a.md');
    expect(source.path).toBe('/x/a.md');
    expect(source.size).toBe(3);
    expect(source.store.id).toContain('single:a.md:3');
  });

  it('dispatcher 对单文件 source 选中预期渲染器（md → markdown）', async () => {
    const { dispatcher } = assembleViewer(makeDeps());
    const bytes = new TextEncoder().encode('# Title\n\ntext\n');
    const source = createSingleFileSource(bytes, 'a.md', '/x/a.md');
    const target = document.createElement('div');
    const result = await dispatcher.dispatch(source, bytes as Uint8Array<ArrayBuffer>, target);
    expect(result.rendererId).toBe('markdown');
    result.instance.destroy();
  });

  it('dispatcher 对单文件 source 选中预期渲染器（txt → code）', async () => {
    const { dispatcher } = assembleViewer(makeDeps());
    const bytes = new TextEncoder().encode('plain text\n');
    const source = createSingleFileSource(bytes, 'a.txt', '/x/a.txt');
    const target = document.createElement('div');
    const result = await dispatcher.dispatch(source, bytes as Uint8Array<ArrayBuffer>, target);
    expect(result.rendererId).toBe('code');
    result.instance.destroy();
  });
});
