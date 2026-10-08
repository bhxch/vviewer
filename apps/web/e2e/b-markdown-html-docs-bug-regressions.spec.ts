import { test, expect, type Page } from '@playwright/test';
import { injectDir, openTreeFile, PIXEL_PNG_B64 } from './b-markdown-html-docs-helpers';

/**
 * markdown-html-docs 域缺陷回归护栏（docs/e2e/markdown-html-docs.md 第 3 节验收行为）：
 * - BUG-17（MD-11）：markdown/HTML 渲染视图中外部 http 图片不再发起 GET——外域 img
 *   src 被共享净化策略移除（sanitize.ts 钩子 + data-vv-blocked-external 标记）、
 *   srcdoc 另加 CSP img-src data: blob: 双保险；高危向量（script、on* 属性、javascript: 链接）
 *   不回退；重开文件二次复验；with-script.html 对照外链脚本零请求。
 * - BUG-06 本域关联面（MD-05）：markdown rust 围栏走 tree-sitter 主路径（ts-* span
 *   > 0，非仅 hljs 兜底），grammar wasm 按需 fetch。缓存矩阵/断网复渲染等完整验收
 *   归 code-highlight-degrade 域（fix-pwa.spec.ts 已覆盖客户端主链）。
 */

/** 外部不可解析保留域名（DNS 失败无状态码；验收判据是「请求被发起」= 网络层出现 GET） */
const EXTERNAL_HOSTS = /external\.example\.com|tracker\.example\.org|cdn\.example\.net/;

const DANGER_HTML = `<!DOCTYPE html>
<html>
<head><title>danger</title></head>
<body>
<h1>危险样例</h1>
<script>window.__vvDangerExecuted = true;</script>
<img src="http://external.example.com/track.png" onerror="window.__vvOnErrorFired = true">
<img src="https://tracker.example.org/pixel.gif" alt="pixel">
<a href="javascript:alert('xss')">js 链接</a>
<a href="https://cdn.example.net/page">普通外链</a>
<p style="color:crimson">行内样式文本</p>
</body>
</html>`;

const WITH_SCRIPT_HTML = `<!DOCTYPE html>
<html>
<body>
<script>window.__vvInlineExecuted = true;</script>
<script src="https://cdn.example.net/evil.js"></script>
<p>对照件正文</p>
</body>
</html>`;

const DANGER_MD = [
  '# 危险 markdown',
  '',
  '![track](http://external.example.com/track.png)',
  '',
  `![内嵌图](data:image/png;base64,${PIXEL_PNG_B64})`,
  '',
  '[普通外链](https://example.org/page)',
  ''
].join('\n');

/** 收集全部网络请求 URL（含失败请求——request 事件在发起时即触发，不依赖响应） */
function trackRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}

/** 等待 srcdoc 文档解析完成（frame 元素 visible ≠ srcdoc 已解析，contentDocument 可能仍空壳） */
async function waitFrameDocReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const f = document.querySelector('.vv-html-frame') as HTMLIFrameElement | null;
      return f !== null && f.contentDocument !== null && (f.contentDocument.body?.textContent ?? '').length > 0;
    },
    { timeout: 10_000 }
  );
}

/** iframe contentDocument 的净化统计（sandbox="allow-same-origin" 父页面可读，偏差 #1 形态） */
function readFrameStats(page: Page): Promise<{
  scripts: number;
  onAttrs: number;
  jsHrefs: number;
  httpImgs: string[];
  blockedImgs: number;
  inlineStyleKept: boolean;
  bodyText: string;
  executedFlags: string[];
}> {
  return page.evaluate(() => {
    const f = document.querySelector('.vv-html-frame') as HTMLIFrameElement;
    const doc = f.contentDocument;
    if (!doc) throw new Error('contentDocument 不可读');
    let scripts = 0;
    let onAttrs = 0;
    let jsHrefs = 0;
    const httpImgs: string[] = [];
    const executedFlags: string[] = [];
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      if (el.tagName === 'SCRIPT') scripts += 1;
      for (const a of Array.from(el.attributes)) {
        if (/^on/i.test(a.name)) onAttrs += 1;
      }
    }
    for (const a of Array.from(doc.querySelectorAll('a'))) {
      if ((a.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:')) {
        jsHrefs += 1;
      }
    }
    for (const i of Array.from(doc.querySelectorAll('img'))) {
      const src = (i.getAttribute('src') ?? '').trim();
      if (/^https?:/i.test(src)) httpImgs.push(src);
    }
    const win = f.contentWindow as unknown as Record<string, unknown> | null;
    for (const k of ['__vvDangerExecuted', '__vvInlineExecuted', '__vvOnErrorFired']) {
      if (win && win[k] === true) executedFlags.push(k);
    }
    return {
      scripts,
      onAttrs,
      jsHrefs,
      httpImgs,
      blockedImgs: doc.querySelectorAll('img[data-vv-blocked-external]').length,
      inlineStyleKept: doc.querySelector('p[style]') !== null,
      bodyText: doc.body?.textContent ?? '',
      executedFlags
    };
  });
}

test('MD-11/BUG-17 HTML 渲染视图：高危向量净化达标，外部图片零网络请求', async ({ page }) => {
  test.setTimeout(60_000);
  const urls = trackRequests(page);
  await injectDir(page, [{ name: 'danger.html', content: DANGER_HTML }]);
  await openTreeFile(page, 'danger.html');
  const frame = page.locator('.vv-html-frame');
  await expect(frame).toBeVisible({ timeout: 20_000 });
  await waitFrameDocReady(page);

  const stats = await readFrameStats(page);
  // 高危向量（验收判据 3，不回退）：script=0、on*=0、javascript: href 移除、无 alert 执行痕迹
  expect(stats.scripts).toBe(0);
  expect(stats.onAttrs).toBe(0);
  expect(stats.jsHrefs).toBe(0);
  expect(stats.executedFlags).toEqual([]);
  expect(stats.bodyText).not.toContain('alert');
  // BUG-17 核心：外域 img 原始 src 不保留（占位标记 data-vv-blocked-external ×2）
  expect(stats.httpImgs).toEqual([]);
  expect(stats.blockedImgs).toBe(2);
  // 净化不误伤：行内样式保留（MD-10/11 既有达标项）
  expect(stats.inlineStyleKept).toBe(true);

  // 网络层验收判据 1：external.example / tracker.example / cdn.example 零命中
  // （渲染完成后留出余量：任何外域 GET 都会在 iframe 解析期发起）
  await page.waitForTimeout(1_500);
  expect(urls.filter((u) => EXTERNAL_HOSTS.test(u))).toEqual([]);
});

test('MD-11/BUG-17 重开二次复验 + with-script 对照：外链脚本同样零请求', async ({ page }) => {
  test.setTimeout(60_000);
  const urls = trackRequests(page);
  await injectDir(page, [
    { name: 'danger.html', content: DANGER_HTML },
    { name: 'with-script.html', content: WITH_SCRIPT_HTML }
  ]);

  // 对照件（验收判据 4）：内联 + 外链 script 均被剥除，cdn 零请求、内联脚本未执行
  await openTreeFile(page, 'with-script.html');
  await expect(page.locator('.vv-html-frame')).toBeVisible({ timeout: 20_000 });
  await waitFrameDocReady(page);
  const ctrl = await readFrameStats(page);
  expect(ctrl.scripts).toBe(0);
  expect(ctrl.executedFlags).toEqual([]);
  expect(ctrl.bodyText).toContain('对照件正文');

  // 重开路径（验收判据 2）：切回 danger.html 重挂 iframe，二次复验仍零外域请求
  await openTreeFile(page, 'danger.html');
  await expect(page.locator('.vv-html-frame')).toBeVisible({ timeout: 20_000 });
  await waitFrameDocReady(page);
  const stats = await readFrameStats(page);
  expect(stats.scripts).toBe(0);
  expect(stats.blockedImgs).toBe(2);
  expect(stats.httpImgs).toEqual([]);

  await page.waitForTimeout(1_500);
  expect(urls.filter((u) => EXTERNAL_HOSTS.test(u))).toEqual([]);
});

test('MD-11/BUG-17 markdown 渲染视图：外域图片 src 移除打拦截标记，data:image 不误伤且零请求', async ({
  page
}) => {
  test.setTimeout(60_000);
  const urls = trackRequests(page);
  await injectDir(page, [{ name: 'danger.md', content: DANGER_MD }]);
  await openTreeFile(page, 'danger.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // 外域 img：src 移除 + data-vv-blocked-external 标记（title 保留域名供悬停提示）
  const blocked = md.locator('img[data-vv-blocked-external]');
  await expect(blocked).toHaveCount(1);
  await expect(blocked).toHaveAttribute('title', /external\.example\.com/);
  await expect(md.locator('img[src^="http"]')).toHaveCount(0);

  // 合法内嵌图不受影响（data:image 白名单内，src 保留可渲染）
  const dataImg = md.locator('img[src^="data:image/png"]');
  await expect(dataImg).toHaveCount(1);
  // 普通外链 <a href> 不拦（用户主动导航型，非被动外泄）
  await expect(md.locator('a[href="https://example.org/page"]')).toHaveCount(1);

  // 网络层：markdown 视图挂主文档无 CSP 兜底，净化移除 src 是唯一防线 → 零外域 GET
  await page.waitForTimeout(1_500);
  expect(urls.filter((u) => EXTERNAL_HOSTS.test(u))).toEqual([]);
});

test('MD-05/BUG-06 markdown rust 围栏走 tree-sitter 主路径（ts-* span > 0，非仅 hljs 兜底）', async ({
  page
}) => {
  test.setTimeout(90_000);
  const wasmRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('.wasm')) wasmRequests.push(r.url());
  });
  const content = [
    '# rust 围栏',
    '',
    '```rust',
    'fn main() {',
    '    let x = 42;',
    '    println!("hello {}", x);',
    '}',
    '```',
    ''
  ].join('\n');
  await injectDir(page, [{ name: 'rust-fence.md', content }]);
  await openTreeFile(page, 'rust-fence.md');
  const code = page.locator('.vv-markdown pre code');
  await expect(code).toBeVisible({ timeout: 20_000 });

  // 缺陷态是 language-rust hljs + hljs-* 兜底；修复后 tree-sitter 主路径产出 ts-* span
  await expect(code.locator('span[class^="ts-"]').first()).toBeVisible({ timeout: 30_000 });
  expect(await code.locator('span[class^="ts-"]').count()).toBeGreaterThan(0);
  // 非 hljs 兜底：code 元素不得带 hljs 类（hljs.highlightElement 会挂 hljs 类）
  expect(await code.getAttribute('class')).not.toContain('hljs');

  // grammar wasm 按需 fetch（验收判据 2 的本域面：网络层出现 rust.wasm GET）
  expect(
    wasmRequests.some((u) => u.includes('/grammars/') && u.endsWith('/rust.wasm'))
  ).toBe(true);
});
