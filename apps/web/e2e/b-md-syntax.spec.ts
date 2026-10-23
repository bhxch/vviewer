import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-md-syntax 扩展语法冒烟（md-katex-syntax 计划 Task 8）：
 * - ==mark==/++ins++/描述列表/行内脚注 渲染（本地引擎三插件 + footnote_inline）；
 * - callout 折叠后缀：[!note]- 默认收起（markdown-alert-collapsed）→ 标题点击展开；
 * - wikilink：[[#目标]] 锚跳（remapHeadingHashLinks 改写 href 为 user-content- 前缀，
 *   点击后 hash 变化且目标 heading 滚入视口）+ ![[img|宽]] 嵌入 img 元素；
 * - 代码块语言徽标 .md-code-lang 可见（.md-code-bar 内唯一 button，徽标即复制）；
 * - 数学四形态渲染 .katex：$..$ 行内、\(..\) 行内与 \[..\] 块级（前置改写为 $
 *   词汇，引擎层语义——本地/远程引擎同效）、\ce{} mhchem（宏缺失时该段抛错保留
 *   原文，katex 计数即宏存在性证明，markdownPipeline.test.ts 同口径）。
 * 注入通道与 b-md-diagrams 组一致（injectDir + openTreeFile，抽屉适配移动视口）；
 * 夹具落 samples/md/（readFileSync 注入，样例库与 e2e 共用）。无图表围栏，无需
 * kroki 拦截。
 */
const samplerPath = fileURLToPath(new URL('../../../samples/md/syntax-sampler.md', import.meta.url));
const SAMPLER = readFileSync(samplerPath, 'utf-8');

async function openSampler(page: Parameters<typeof injectDir>[0]): Promise<void> {
  await injectDir(page, [{ name: 'syntax-sampler.md', content: SAMPLER }]);
  await openTreeFile(page, 'syntax-sampler.md');
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

test.describe('b-md-syntax 扩展语法', () => {
  test('mark/ins/描述列表/行内脚注 渲染', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    const md = page.locator('.vv-markdown');
    await expect(md.locator('mark', { hasText: '高亮标记' })).toBeVisible();
    await expect(md.locator('ins', { hasText: '插入文本' })).toBeVisible();
    const dl = md.locator('dl');
    await expect(dl.locator('dt')).toHaveText(['术语']);
    await expect(dl.locator('dd').first()).toContainText('描述列表定义行');
    await expect(md.locator('sup.footnote-ref')).toHaveCount(1);
  });

  test('callout [!note]- 默认收起，标题点击展开', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    const alert = page.locator('.vv-markdown .markdown-alert').first();
    await expect(alert).toHaveClass(/markdown-alert-foldable/);
    // - 后缀：预置收起态，标题外内容 CSS 隐藏（内容仍在 DOM）
    await expect(alert).toHaveClass(/markdown-alert-collapsed/);
    const content = alert.locator('.markdown-alert-content');
    await expect(content).toBeHidden();
    await alert.locator('.markdown-alert-title').click();
    await expect(alert).not.toHaveClass(/markdown-alert-collapsed/);
    await expect(content).toBeVisible();
    await expect(content).toContainText('收起后展开才可见的正文内容');
  });

  test('wikilink 锚跳 user-content- 前缀 hash + 嵌入 img', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    const md = page.locator('.vv-markdown');
    // [[#目标]] → href 原样 slug，经 remapHeadingHashLinks 统一改写 user-content- 前缀
    const link = md.locator('a[data-wikilink="anchor"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '#user-content-目标');
    // 跨文件 wikilink 降级不可点原文（span 而非 a）
    await expect(md.locator('.md-wikilink-dead', { hasText: '[[Other.md]]' })).toBeVisible();
    // ![[img|120]] → img 元素（src 原文相对路径，样例库无该文件不解析——仅断言元素契约）
    const embed = md.locator('img[src="syntax-sampler-embed.png"]');
    await expect(embed).toHaveCount(1);
    await expect(embed).toHaveAttribute('width', '120');
    // 锚跳：点击后 hash 带前缀（浏览器对 CJK 百分号编码，解码后核对）且 heading 入视口
    await link.click();
    const hash = await page.evaluate(() => decodeURIComponent(location.hash));
    expect(hash).toBe('#user-content-目标');
    await expect(md.locator('h2#user-content-目标')).toBeInViewport();
  });

  test('代码徽标可见 + 数学四形态渲染 katex', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    const md = page.locator('.vv-markdown');
    // 徽标即复制单入口（spec 2026-10-23 §5）：pre 顶栏 .md-code-bar 内唯一 button
    // 即语言徽标本体（rust），点击复制、无独立复制钮
    const bar = md.locator('.md-code-bar').first();
    await expect(bar.locator('.md-code-lang')).toHaveText('rust');
    await expect(bar.locator('.md-code-lang')).toBeVisible();
    await expect(bar.locator('button')).toHaveCount(1);
    // 四形态各产 .katex：$..$、\ce{}（mhchem）、\(..\)（前置改写）、\[..\]（块级）
    await expect(md.locator('.katex')).toHaveCount(4, { timeout: 30_000 });
    await expect(md.locator('.katex-display .katex')).toHaveCount(1);
  });
});
