import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * M3 E2E 验收（Task 7）：markdown 全要素管线、TOC 侧栏、html 沙箱预览、灯箱清理。
 * 文件内搜索（/ 面板）的 3 项验收保留在 m3-search.spec.ts（独立样例 fixtures，
 * Task 6 已验收，此处不合并以免 M3 spec 依赖 samples/m2）。
 * 通道同 m1/m2：页面内构造 File + webkitRelativePath 经 __vvOpenDirImpl 注入，
 * 与真实 webkitdirectory input change 走同一 openDirectoryViaInput 通道。
 */
const samples = fileURLToPath(new URL('../../../samples/m3', import.meta.url));

const PAYLOADS = [
  { name: 'demo.md', type: 'text/markdown' },
  { name: 'page.html', type: 'text/html' }
].map((f) => ({ ...f, b64: readFileSync(`${samples}/${f.name}`).toString('base64') }));

async function openDir(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, b64 }) => {
      const f = new File([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], name, { type });
      // webkitRelativePath 是原型上仅 getter 的访问器，defineProperty 写自有属性遮蔽（与真实 input 一致）
      Object.defineProperty(f, 'webkitRelativePath', { value: `m3/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, PAYLOADS);
}

async function openFile(page: Page, name: string): Promise<void> {
  // 移动视口：树行在抽屉内，开抽屉点击后关闭（drawer.ts）
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 打开目录并进入 demo.md（管线含 mermaid/katex 动态 import，挂载留足超时） */
async function openDemo(page: Page): Promise<void> {
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'demo.md');
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

test('markdown 全要素：表格/任务列表/围栏高亮/callout/katex/mermaid', async ({ page }) => {
  test.setTimeout(60_000);
  await openDemo(page);
  const md = page.locator('.vv-markdown');

  // 表格：GFM thead + 2 数据行
  await expect(md.locator('table')).toBeVisible();
  await expect(md.locator('table tr')).toHaveCount(3);

  // 任务列表：checkbox 渲染且禁用（taskLists enabled: false）
  await expect(md.locator('li.task-list-item input[type="checkbox"]')).toHaveCount(2);
  await expect(md.locator('input[type="checkbox"]').first()).toBeDisabled();

  // 围栏高亮：tree-sitter 主路径 ts-* span，注入失败时 hljs 兜底 hljs-*（两者均为高亮管线生效证据）
  await expect(
    md.locator('pre code span[class^="ts-"], pre code span[class^="hljs-"]').first()
  ).toBeVisible({ timeout: 20_000 });

  // callout：blockquote [!note] 转 markdown-alert 卡片（标题 + 内容）
  const callout = md.locator('div.markdown-alert.markdown-alert-note');
  await expect(callout).toHaveCount(1);
  await expect(callout.locator('.markdown-alert-title')).toContainText('提示');

  // katex：行内 + 块级（.katex-display 内含 .katex）
  await expect(md.locator('.katex').first()).toBeVisible();
  await expect(md.locator('.katex-display')).toHaveCount(1);

  // mermaid：容器存在，svg 真实渲染（headless chromium 可用）或错误样式兜底均可接受
  const mermaidBox = md.locator('div.md-mermaid');
  await expect(mermaidBox).toHaveCount(1);
  await expect(mermaidBox).toHaveAttribute('data-mermaid', /graph TD/);
  const viaSvg = (await mermaidBox.locator('svg').count()) > 0;
  console.log(`[m3] mermaid 渲染路径: ${viaSvg ? 'svg 真实渲染' : 'error 样式兜底'}`);
  if (!viaSvg) {
    await expect(mermaidBox).toHaveClass(/md-mermaid-error/);
  }
});

test('TOC 侧栏：项数 = demo.md h1-h4 数，点击项滚动位置变化', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  // 手机宽度（≤600px）下右栏（TOC 所在）退出抽屉（AppShell 响应式：2×300px 双栏必重叠），
  // TOC 为桌面/平板专属入口 → mobile project 跳过本断言
  const vp = page.viewportSize();
  testInfo.skip(vp !== null && vp.width <= 600, '手机宽度抽屉不含右栏，TOC 无入口');
  // 期望项数从样例源码推导（ATX 标题 /^#{1,4} /），样例增删标题时断言自适配；
  // 先剥除 ```/~~~ 围栏段再数，防未来围栏内容（如 bash 注释 #）虚增计数
  let inFence = false;
  const headingCount = readFileSync(`${samples}/demo.md`, 'utf-8')
    .split('\n')
    .filter((l) => {
      if (/^(```|~~~)/.test(l)) inFence = !inFence;
      return !inFence && /^#{1,4} /.test(l);
    }).length;
  expect(headingCount).toBe(9); // 样例自检：1×h1 + 6×h2 + 1×h3 + 1×h4

  await openDemo(page);
  await expect(page.locator('nav.toc li button')).toHaveCount(headingCount);

  // 点击最后一项（文档底部 h4）：外层滚动容器 .vv-viewer-scroll 位置前移。
  // scrollIntoView 为 smooth，poll 轮询至滚动完成
  const scroller = page.locator('.vv-viewer-scroll');
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.locator('nav.toc li button').last().click();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(before);
});

test('html 沙箱预览：iframe 无 allow-scripts、脚本未执行、源码/渲染切换', async ({ page }) => {
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'page.html');
  const frame = page.locator('.vv-html-frame');
  await expect(frame).toBeVisible();

  // sandbox 只含 allow-same-origin（父页面可读 contentWindow），绝无 allow-scripts
  expect(await frame.getAttribute('sandbox')).toBe('allow-same-origin');
  expect((await frame.getAttribute('sandbox'))!.split(/\s+/)).not.toContain('allow-scripts');

  // 脚本未执行双证据：净化剥除 <script> 标签（srcdoc 无脚本元素）+ 沙箱封死执行面
  // （page.html 原文含 <script>window.__executed = true</script>，渲染视图必须不存在）
  const srcdoc = await frame.getAttribute('srcdoc');
  expect(srcdoc).not.toContain('<script');
  const executed = await page.evaluate(() => {
    const f = document.querySelector('.vv-html-frame') as HTMLIFrameElement;
    const win = f.contentWindow as unknown as { __executed?: boolean; document: Document } | null;
    if (!win) return 'no-window';
    return Boolean(win.__executed) || win.document.body.hasAttribute('data-script-ran');
  });
  expect(executed).toBe(false);

  // 源码视图：按钮态切换 + 原始文本（未经净化）经 code 渲染链展示
  await page.locator('.vv-html-btn-source').click();
  await expect(page.locator('.vv-html-btn-source')).toHaveClass(/active/);
  const pre = page.locator('.vv-code-pre');
  await expect(pre).toBeVisible();
  await expect(pre).toContainText('__executed');

  // 切回渲染视图：iframe 回归
  await page.locator('.vv-html-btn-rendered').click();
  await expect(page.locator('.vv-html-btn-rendered')).toHaveClass(/active/);
  await expect(frame).toBeVisible();
});

test('lightbox：开-关-复开（单例复用）-切 tab destroy 清理', async ({ page }) => {
  test.setTimeout(60_000);
  await openDemo(page);
  const img = page.locator('.vv-markdown img[data-md-lightbox]');
  await expect(img).toHaveCount(1);
  const overlay = page.locator('#md-lightbox-overlay');

  // 开：点击图片 → body 级 overlay（渲染节点之外，单例 id 固定）
  await img.click();
  await expect(overlay).toBeVisible();

  // 关：点击 overlay 自身移除（openLightbox 的 click 监听；点中克隆图也冒泡到此监听）
  await overlay.click();
  await expect(overlay).toHaveCount(0);

  // 复开：img 监听仍存活可再开；此时再触发另一张"图"点击，overlay 仍为 1
  // （body 级单例复用，不叠加）。overlay 开着时底层 img 真实指针不可达（全屏层拦截），
  // 故单例检查经 dispatchEvent 触发 img 自身的 click 监听（监听就绑在 img 上，事件直生效）
  await img.click();
  await expect(overlay).toBeVisible();
  await img.dispatchEvent('click');
  await expect(overlay).toHaveCount(1);

  // 切 tab：markdown 实例 destroy → removeLightboxOverlay 清理 body 级 overlay。
  // overlay 是 fixed inset:0 的全屏层会拦截指针，真实用户先点击 overlay 关闭再操作；
  // 本断言目标是 destroy 清理链路，故经 dispatchEvent 直接触发树行 click（绕过命中测试）
  await page.locator('.vv-tree-row', { hasText: 'page.html' }).dispatchEvent('click');
  await expect(page.locator('.vv-html-frame')).toBeVisible();
  await expect(overlay).toHaveCount(0);
});
