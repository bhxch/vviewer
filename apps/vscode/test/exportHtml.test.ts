// exportHtml.test.ts — 导出 HTML 组装与图片 data URI 解析契约（spec H T5）。
//
// 覆盖面：`collectExportHtml` 的**真实选项名**（`title` / `styleCss` / `katexCss?` /
// `resolveImage`——**无 `inlineCss` 选项名**，初版误写已订正）；`resolveExportImage` 的
// 六态（data: 保留 / 外域保留 / blob 成功 / 同源 http 成功 / 非 image 类型保留 /
// fetch 失败保留）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExportHtml, exportFileName, resolveExportImage } from '../src/webview/exportHtml';

function imageResponse(type: string, bytes: number[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': type }),
    arrayBuffer: async () => new Uint8Array(bytes).buffer
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('导出 · resolveExportImage 六态', () => {
  it('data: 已内联 → null（原样保留）', async () => {
    expect(await resolveExportImage('data:image/png;base64,AAAA')).toBeNull();
  });

  it('外域 http(s) → null（CORS 不可控不强拉）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveExportImage('https://example.com/a.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blob: → 成功转 data URI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse('image/png', [1, 2, 3])));
    const out = await resolveExportImage('blob:vscode-webview://abc/xyz');
    expect(out).toBe('data:image/png;base64,AQID');
  });

  it('同源 http → 成功转 data URI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse('image/png', [1])));
    const out = await resolveExportImage(`${globalThis.location.origin}/a.png`);
    expect(out).toBe('data:image/png;base64,AQ==');
  });

  it('非 image 内容型 → null（保留原 URL）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse('text/html', [1])));
    expect(await resolveExportImage('blob:vscode-webview://abc/x')).toBeNull();
  });

  it('fetch 失败 / 非 2xx → null（降级保留原 URL）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    expect(await resolveExportImage('blob:vscode-webview://abc/x')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response)));
    expect(await resolveExportImage('blob:vscode-webview://abc/x')).toBeNull();
  });

  it('空内容型回退 image/png（blob 的 MIME 可为空串）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse('', [65])));
    expect(await resolveExportImage('blob:vscode-webview://abc/x')).toBe('data:image/png;base64,QQ==');
  });
});

describe('导出 · buildExportHtml（选项名对齐真实 API）', () => {
  it('产物含标题、内联样式与 katex 排印样式；无 inlineCss 选项名', async () => {
    const source = document.createElement('div');
    source.innerHTML = '<h1>标题</h1><p>正文</p>';
    const html = await buildExportHtml(source, {
      title: 'doc.md',
      themeCss: ':root{--ui-bg:#ffffff}',
      katexCss: '.katex{color:red}'
    });
    expect(html).toContain('<title>doc.md</title>');
    expect(html).toContain('--ui-bg:#ffffff');
    expect(html).toContain('.katex{color:red}');
    expect(html).toContain('标题');
  });

  it('图片经 resolveImage 转 data URI（注入面消费）', async () => {
    const source = document.createElement('div');
    source.innerHTML = '<img src="pic.png" alt="p" />';
    const resolveImage = vi.fn(async () => 'data:image/png;base64,AAAA');
    const html = await buildExportHtml(source, {
      title: 'doc.md',
      themeCss: '',
      katexCss: '',
      resolveImage
    });
    expect(resolveImage).toHaveBeenCalledWith('pic.png');
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('空 katexCss → 不嵌排印样式（无空 style 块）', async () => {
    const source = document.createElement('div');
    source.innerHTML = '<p>x</p>';
    const html = await buildExportHtml(source, { title: 'a.md', themeCss: '', katexCss: '' });
    expect(html).not.toContain('.katex{');
  });
});

describe('导出 · 文件名', () => {
  it('剥单一扩展名；无名回退 export', () => {
    expect(exportFileName('doc.md')).toBe('doc.html');
    expect(exportFileName('a.b.md')).toBe('a.b.html');
    expect(exportFileName('README')).toBe('README.html');
    expect(exportFileName('')).toBe('export.html');
  });
});
