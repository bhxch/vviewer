// protocol.test.ts — host ↔ webview 消息协议契约（spec H T2）。
//
// 覆盖面（计划 T2 Step 1 明列）：消息判别 kind 穷尽、read-file/export-html 的 id
// 单调性、WebviewSettings 归一（缺省面）。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBVIEW_SETTINGS,
  HOST_TO_WEBVIEW_KINDS,
  MAX_BYTES,
  WEBVIEW_TO_HOST_KINDS,
  createRequestIdFactory,
  isHostToWebview,
  isWebviewToHost,
  type AssetUris,
  type HostToWebview,
  type WebviewToHost
} from '../src/host/protocol';

describe('协议 · kind 穷尽', () => {
  it('host → webview 的 kind 集与类型声明一致（新增 kind 须同步）', () => {
    const samples: HostToWebview[] = [
      {
        kind: 'init',
        doc: { name: 'a.md', path: '/a.md', size: 3, bytes: new Uint8Array([1, 2, 3]) },
        theme: { kind: 'light', cssVars: {} },
        settings: DEFAULT_WEBVIEW_SETTINGS,
        assets: emptyAssets(),
        toc: { collapsed: true }
      },
      { kind: 'settings', settings: DEFAULT_WEBVIEW_SETTINGS },
      { kind: 'theme', theme: { kind: 'dark', cssVars: {} } },
      { kind: 'file-bytes', id: 1, bytes: null },
      { kind: 'file-stat', id: 1, exists: true },
      { kind: 'export-request' },
      { kind: 'export-result', id: 1, ok: true }
    ];
    expect(new Set(samples.map((m) => m.kind))).toEqual(new Set(HOST_TO_WEBVIEW_KINDS));
    for (const sample of samples) expect(isHostToWebview(sample)).toBe(true);
  });

  it('webview → host 的 kind 集与类型声明一致', () => {
    const samples: WebviewToHost[] = [
      { kind: 'ready' },
      { kind: 'read-file', id: 1, path: 'sub/other.md' },
      { kind: 'stat-file', id: 1, path: 'sub/other.md' },
      { kind: 'export-html', id: 2, html: '<p>x</p>', suggestedName: 'a.html' },
      { kind: 'open-external', url: 'https://example.com' },
      { kind: 'navigate', path: 'sub/other.md' },
      { kind: 'toc-collapsed', collapsed: true },
      { kind: 'report', level: 'warn', message: 'boom' }
    ];
    expect(new Set(samples.map((m) => m.kind))).toEqual(new Set(WEBVIEW_TO_HOST_KINDS));
    for (const sample of samples) expect(isWebviewToHost(sample)).toBe(true);
  });

  it('非消息与未知 kind 一律不判别为协议消息（不静默吞）', () => {
    expect(isHostToWebview(null)).toBe(false);
    expect(isHostToWebview('init')).toBe(false);
    expect(isHostToWebview({ kind: 'unknown' })).toBe(false);
    expect(isWebviewToHost({ kind: 'init' })).toBe(false);
    expect(isWebviewToHost({ nope: 1 })).toBe(false);
  });
});

describe('协议 · 请求 id 单调性', () => {
  it('id 从 1 起严格递增（read-file / export-html 按 id 配对）', () => {
    const nextId = createRequestIdFactory();
    const ids = [nextId(), nextId(), nextId()];
    expect(ids).toEqual([1, 2, 3]);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    }
  });

  it('两个分配器各自独立（跨会话不撞号）', () => {
    const a = createRequestIdFactory();
    const b = createRequestIdFactory();
    expect(a()).toBe(1);
    expect(b()).toBe(1);
    expect(a()).toBe(2);
  });
});

describe('协议 · 设置缺省与归一面', () => {
  it('缺省值与 spec §4.5 / 计划一致', () => {
    expect(DEFAULT_WEBVIEW_SETTINGS).toEqual({
      tocSide: 'right',
      tocDefaultCollapsed: true,
      highlightEngine: 'tree-sitter',
      diagramMode: 'local',
      allowRemoteServices: false,
      externalImages: 'blocked',
      externalImageAllowlist: []
    });
  });

  it('大文件上限 200MB（对齐 web 端 PLAIN_MAX_BYTES）', () => {
    expect(MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('协议 · 资产 URI 族', () => {
  it('三个 worker 各有专名，无悬空 workerUrl 字段（Errata ⑦）', () => {
    const keys = Object.keys(emptyAssets());
    expect(keys).toContain('highlightWorkerSourceUrl');
    expect(keys).toContain('binaryWorkerUrl');
    expect(keys).toContain('pdfWorkerModernUrl');
    expect(keys).toContain('pdfWorkerLegacyUrl');
    expect(keys).not.toContain('workerUrl');
  });

  it('资产 URI 字段齐备（RF 5：三段基址 + 三 worker + 字体与 katex）', () => {
    expect(Object.keys(emptyAssets()).sort()).toEqual(
      [
        'binaryWorkerUrl',
        'fontsBase',
        'grammars',
        'grammarsBase',
        'highlightWorkerSourceUrl',
        'katexCssUrl',
        'katexExportCssUrl',
        'pdfWorkerLegacyUrl',
        'pdfWorkerModernUrl',
        'queriesBase',
        'runtimeDir',
        'themesUrl'
      ].sort()
    );
  });
});

function emptyAssets(): AssetUris {
  return {
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
}
