import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { injectDir, openTreeFile, PIXEL_PNG_B64 } from './b-markdown-html-docs-helpers';

/**
 * markdown-html-docs 域补缺（TOC / 代码复制 / 灯箱的既有套件未覆盖面）：
 * - MD-07 TOC active 高亮随滚动跟随（m3.spec 只覆盖项数与点击滚动，跟随缺位）；
 * - MD-08 代码块复制按钮 hook clipboard.writeText，写入内容与代码块逐字符一致（完全缺位）；
 * - MD-09 灯箱 Esc 关闭路径（m3.spec 只覆盖 overlay 点击关闭，Esc 缺位）。
 * 场景来源：docs/e2e/markdown-html-docs.md 第 2 节场景清单表。
 */

const samples = fileURLToPath(new URL('../../../samples/m3', import.meta.url));
const DEMO_MD = readFileSync(`${samples}/demo.md`, 'utf-8');

test('MD-07 TOC active 跟随：初始高亮首项，滚动到中部章节后 active 切换对应项', async ({
  page
}, testInfo) => {
  test.setTimeout(60_000);
  // 手机宽度（≤600px）右栏退出（AppShell 响应式），TOC 无入口 → mobile project 跳过（同 m3）
  const vp = page.viewportSize();
  testInfo.skip(vp !== null && vp.width <= 600, '手机宽度抽屉不含右栏，TOC 无入口');

  await injectDir(page, [{ name: 'demo.md', content: DEMO_MD }]);
  await openTreeFile(page, 'demo.md');
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('nav.toc li button')).toHaveCount(9);

  // 初始（scrollTop 0）：IntersectionObserver 选视口顶部带内最贴顶标题 = 首项
  const firstText = (await page.locator('nav.toc li button').first().textContent())!.trim();
  await expect(page.locator('nav.toc li button.active')).toHaveText(firstText, {
    timeout: 10_000
  });

  // 滚动到中部「## 公式」小节（标题置顶 → 落在视口顶部 35% 带内）→ active 跟随切换
  await page
    .locator('.vv-markdown h2', { hasText: '公式' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(page.locator('nav.toc li button.active')).toHaveText('公式', { timeout: 10_000 });
  await expect(page.locator('nav.toc li button.active')).not.toHaveText(firstText);
});

test('MD-08 代码复制：hook clipboard.writeText，写入内容与代码块 textContent（去尾换行）逐字符一致', async ({
  page
}) => {
  test.setTimeout(60_000);
  const content = ['```js', 'const greeting = "你好 vviewer";', 'console.log(greeting);', '```', ''].join(
    '\n'
  );
  await injectDir(page, [{ name: 'copy.md', content }]);
  await openTreeFile(page, 'copy.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // hook 剪贴板写入（实例属性遮蔽原型方法；无 clipboard 环境则整体替换）
  await page.evaluate(() => {
    const w = window as unknown as { __vvCopied?: string[] };
    w.__vvCopied = [];
    const spy = (text: string): Promise<void> => {
      w.__vvCopied!.push(text);
      return Promise.resolve();
    };
    const clip = (navigator as { clipboard?: Clipboard }).clipboard;
    if (clip) {
      Object.defineProperty(clip, 'writeText', { configurable: true, value: spy });
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: spy }
      });
    }
  });

  const btn = md.locator('pre .md-copy-btn');
  await expect(btn).toHaveCount(1, { timeout: 20_000 });
  await btn.click();

  // 反馈文案翻转证明 writeText 的 Promise 走到 then（复制成功分支）
  await expect(btn).toHaveText('已复制');

  const copied = await page.evaluate(() => (window as { __vvCopied?: string[] }).__vvCopied);
  const codeText = await page.evaluate(
    () => (document.querySelector('.vv-markdown pre code') as HTMLElement).textContent ?? ''
  );
  expect(copied).toHaveLength(1);
  // 与渲染管线同一口径：去尾部格式性换行后逐字符一致（pipeline.ts copyCode 步）
  expect(copied![0]).toBe(codeText.replace(/\n$/, ''));
  expect(copied![0]).toContain('你好 vviewer');
});

test('MD-09 灯箱 Esc 关闭：开 → Esc 关 → 复开（Esc 监听随重建可用）→ Esc 再关', async ({
  page
}) => {
  test.setTimeout(60_000);
  const content = `![像素图](data:image/png;base64,${PIXEL_PNG_B64})\n`;
  await injectDir(page, [{ name: 'lightbox.md', content }]);
  await openTreeFile(page, 'lightbox.md');
  const img = page.locator('.vv-markdown img[data-md-lightbox]');
  await expect(img).toHaveCount(1);
  const overlay = page.locator('#md-lightbox-overlay');

  // Esc 关闭路径（m3.spec 已覆盖 overlay 点击关闭，此处不重复）
  await img.click();
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);

  // 复开：Esc 监听在 overlay 重建时重新挂载，Esc 仍可关闭
  await img.click();
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});
