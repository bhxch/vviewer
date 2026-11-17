// webviewHtml.test.ts — webview HTML 模板契约（spec H T2）。
//
// 覆盖面（计划 T2 验收锚）：**CSP 七 directive + cspSource 出现在 script-src 与
// media-src**；样式内联块含关键类名（`.vv-markdown` / `.ts-keyword` / `.md-lightbox` +
// 壳类名）。
//
// 本模块 vscode-free（评审订正⑧）→ 可直测（测试内禁 import 'vscode'）。
import { describe, expect, it } from 'vitest';
import {
  CSP_DIRECTIVES,
  buildCsp,
  composeStyleText,
  escapeHtml,
  renderWebviewHtml
} from '../src/host/webviewHtml';

const CSP_SOURCE = 'vscode-webview://abc123';
const NONCE = 'deadbeefdeadbeef';

function html(styleText = '/* styles */'): string {
  return renderWebviewHtml({
    cspSource: CSP_SOURCE,
    nonce: NONCE,
    scriptUri: 'https://webview/dist/webview/main.js',
    styleText,
    title: 'a.md'
  });
}

describe('HTML 模板 · CSP 七 directive', () => {
  it('七条 directive 齐备（缺一即对应功能面静默失效）', () => {
    const csp = buildCsp(CSP_SOURCE, NONCE);
    for (const directive of CSP_DIRECTIVES) {
      expect(csp, `CSP 缺 ${directive}`).toContain(`${directive} `);
    }
    expect(CSP_DIRECTIVES).toHaveLength(8); // default-src + 七条放行项
  });

  it('default-src 为 none（默认全禁，逐条放开）', () => {
    expect(buildCsp(CSP_SOURCE, NONCE)).toContain("default-src 'none'");
  });

  it('cspSource 出现在 script-src 与 media-src（回归锚）', () => {
    const csp = buildCsp(CSP_SOURCE, NONCE);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    const mediaSrc = csp.split('; ').find((d) => d.startsWith('media-src'))!;
    expect(scriptSrc).toContain(CSP_SOURCE);
    expect(mediaSrc).toContain(CSP_SOURCE);
  });

  it('script-src 含 wasm-unsafe-eval（tree-sitter wasm 实例化）与 nonce', () => {
    const csp = buildCsp(CSP_SOURCE, NONCE);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
  });

  it('media-src / worker-src / connect-src / font-src / img-src 各自放行所需源', () => {
    const csp = buildCsp(CSP_SOURCE, NONCE);
    expect(csp).toMatch(/media-src [^;]*blob:/);
    expect(csp).toMatch(/worker-src [^;]*blob:/);
    expect(csp).toMatch(/connect-src [^;]*blob:/);
    expect(csp).toMatch(/font-src [^;]*data:/);
    expect(csp).toMatch(/img-src [^;]*data:/);
    expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
  });

  it('HTML 内的 CSP meta 与 buildCsp 同值（单引号在属性值内为字面量，不转义）', () => {
    expect(html()).toContain(`content="${buildCsp(CSP_SOURCE, NONCE)}"`);
  });
});

describe('HTML 模板 · 样式内联供给面', () => {
  it('单一 <style nonce> 块承载内联样式', () => {
    const out = html('/* my styles */');
    expect(out).toContain(`<style nonce="${NONCE}">/* my styles */</style>`);
    expect(out.match(/<style/g)).toHaveLength(1);
  });

  it('合成样式文本含 markdown 排版与壳类名（评审订正①）', () => {
    const styleText = composeStyleText();
    expect(styleText.length).toBeGreaterThan(0);
    // markdown 排版面
    expect(styleText).toContain('.vv-markdown');
    expect(styleText).toContain('.ts-keyword');
    expect(styleText).toContain('.md-lightbox');
    // 壳面（T1 的 SHELL_CSS）
    expect(styleText).toContain('.vv-shell');
    expect(styleText).toContain('.vv-shell__toc');
    expect(styleText).toContain('.vv-shell__notice');
  });

  it('样式文本随 HTML 注入（composeStyleText 的产物进 style 块）', () => {
    const out = html(composeStyleText());
    expect(out).toContain('.vv-markdown');
    expect(out).toContain('.vv-shell__toc');
  });
});

describe('HTML 模板 · 结构与转义', () => {
  it('外链 ESM 入口脚本（chunk 由 esbuild code splitting 产出，同目录相对解析）', () => {
    expect(html()).toContain('<script type="module" src="https://webview/dist/webview/main.js"></script>');
  });

  it('壳挂载点存在', () => {
    expect(html()).toContain('<div id="vv-root"></div>');
  });

  it('标题与 lang 转义（宿主数据入模板前必过）', () => {
    const out = renderWebviewHtml({
      cspSource: CSP_SOURCE,
      nonce: NONCE,
      scriptUri: 'https://webview/main.js',
      styleText: '',
      title: '<script>alert(1)</script>',
      lang: 'zh-CN'
    });
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('<html lang="zh-CN">');
  });

  it('escapeHtml 覆盖五类危险字符', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
