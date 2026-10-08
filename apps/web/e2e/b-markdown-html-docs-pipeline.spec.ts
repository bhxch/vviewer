import { test, expect } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * markdown-html-docs 域补缺（管线五步的既有套件未覆盖面）：
 * - MD-02 callout 全类型矩阵（已知 ≥5 类型各异色边框 + caution + 未知类型灰色兜底不崩）
 *   ——m3.spec 只覆盖 [!note] 单类型，多类型色与未知兜底缺位；
 * - MD-03 非法公式原文保留（m3 只覆盖合法 katex）；
 * - MD-04 非法 mermaid 错误样式且不阻塞后续管线（复制按钮仍产出，m3 只覆盖合法块）；
 * - MD-06 front matter 合法剥离元数据 / 非法原文渲染（完全缺位）；
 * - MD-13 媒体链接增强 .mp4/.mp3 → 内联 video/audio 且原 a 不保留（完全缺位）。
 * 场景来源：docs/e2e/markdown-html-docs.md 第 2 节场景清单表。
 */

const FENCE = '```';

test('MD-02 callout：已知类型各异色卡片（含 caution），未知类型灰色兜底不崩', async ({
  page
}) => {
  test.setTimeout(60_000);
  // 每张卡片两行：标记行（含类型与标题）+ 内容行；未知类型标记行无剩余文本 → 空标题回退
  const cards: Array<[string, string, string]> = [
    ['NOTE', 'note 标题', 'note 正文'],
    ['TIP', 'tip 标题', 'tip 正文'],
    ['IMPORTANT', 'important 标题', 'important 正文'],
    ['WARNING', 'warning 标题', 'warning 正文'],
    ['CAUTION', 'caution 标题', 'caution 正文'],
    ['mystery', '', '未知类型正文']
  ];
  const md = cards
    .flatMap(([type, title, body]) =>
      title === ''
        ? [`> [!${type}]`, `> ${body}`, '']
        : [`> [!${type}] ${title}`, `> ${body}`, '']
    )
    .join('\n');
  await injectDir(page, [{ name: 'callouts.md', content: md }]);
  await openTreeFile(page, 'callouts.md');
  const md2 = page.locator('.vv-markdown');
  await expect(md2).toBeVisible({ timeout: 20_000 });

  // 六种类型各渲染为 markdown-alert 卡片（5 已知 + 1 未知兜底），应用不崩
  const types = ['note', 'tip', 'important', 'warning', 'caution', 'mystery'];
  await expect(md2.locator('div.markdown-alert')).toHaveCount(types.length);
  for (const t of types) {
    await expect(md2.locator(`div.markdown-alert.markdown-alert-${t}`)).toHaveCount(1);
    await expect(md2.locator(`div.markdown-alert-${t} .markdown-alert-title`)).toBeVisible();
  }
  // 已知类型标题为标记行剩余文本；未知类型空标题回退类型大写名（enrich.ts 兜底）
  await expect(md2.locator('.markdown-alert-note .markdown-alert-title')).toContainText(
    'note 标题'
  );
  await expect(md2.locator('.markdown-alert-mystery .markdown-alert-title')).toHaveText(
    /Mystery/
  );

  // 类型色边框：5 个已知类型左边框两两异色（app.css 固定色），未知类型灰兜底与全部已知异色
  const colors = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll('.vv-markdown .markdown-alert'))) {
      const t = (Array.from(el.classList).find((c) => c.startsWith('markdown-alert-')) ?? '').slice(
        'markdown-alert-'.length
      );
      out[t] = getComputedStyle(el).borderLeftColor;
    }
    return out;
  });
  const known = types.slice(0, 5);
  expect(new Set(known.map((t) => colors[t])).size).toBe(5);
  for (const t of known) {
    expect(colors['mystery']).not.toBe(colors[t]);
  }
});

test('MD-03 katex：行内 + 块级渲染，非法公式原文保留不崩', async ({ page }) => {
  test.setTimeout(60_000);
  const content = [
    '行内公式 $E = mc^2$ 与块级公式：',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx',
    '$$',
    '',
    '非法公式 $\\notacommand{xx}$ 应保留原文。',
    ''
  ].join('\n');
  await injectDir(page, [{ name: 'math.md', content }]);
  await openTreeFile(page, 'math.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // 合法：行内 + 块级各渲染一个 .katex，块级另有 .katex-display
  await expect(md.locator('.katex')).toHaveCount(2, { timeout: 20_000 });
  await expect(md.locator('.katex-display')).toHaveCount(1);

  // 非法：throwOnError 抛错被管线吞掉 → 原文保留、katex 总数仍为 2、页面不崩
  await expect(md).toContainText('$\\notacommand{xx}$');
  await expect(md.locator('.katex')).toHaveCount(2);
});

test('MD-04 mermaid：合法块 svg 渲染，非法块错误样式保留原文且不阻塞复制按钮', async ({
  page
}) => {
  test.setTimeout(60_000);
  const content = [
    `${FENCE}mermaid`,
    'graph TD; A[合法图] --> B[渲染];',
    FENCE,
    '',
    `${FENCE}mermaid`,
    'graph TD; A[ --> B',
    FENCE,
    '',
    `${FENCE}js`,
    'const ok = "后续管线不受阻";',
    FENCE,
    ''
  ].join('\n');
  await injectDir(page, [{ name: 'diagram.md', content }]);
  await openTreeFile(page, 'diagram.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // 合法块：md-mermaid 容器（无错误类）内真实 svg（动态 import + 渲染留足超时）
  const okBox = md.locator('div.md-mermaid:not(.md-mermaid-error)');
  await expect(okBox).toHaveCount(1, { timeout: 30_000 });
  await expect(okBox.locator('svg')).toBeVisible({ timeout: 30_000 });

  // 非法块：md-mermaid-error 错误样式 + 原文保留（data-mermaid 与文本）
  const badBox = md.locator('div.md-mermaid.md-mermaid-error');
  await expect(badBox).toHaveCount(1);
  await expect(badBox).toHaveAttribute('data-mermaid', /A\[ --> B/);
  await expect(badBox).toContainText('A[ --> B');

  // 不阻塞后续管线：其后的 js 围栏仍产出复制按钮（copyCode 步正常执行）
  const copyBtn = md.locator('pre .md-copy-btn');
  await expect(copyBtn).toHaveCount(1, { timeout: 20_000 });
  await expect(copyBtn).toBeVisible();
});

test('MD-06 front matter：合法映射剥离元数据不进正文，非法样例原文渲染不崩', async ({
  page
}) => {
  test.setTimeout(60_000);
  const valid = [
    '---',
    'title: vv-secret-meta',
    'tags:',
    '  - e2e',
    '---',
    '',
    '# 合法 front matter 正文',
    '',
    '元数据不应出现在渲染正文。',
    ''
  ].join('\n');
  const invalid = [
    '---',
    '{this is : not : valid yaml [',
    '---',
    '',
    '# 非法 front matter 之后',
    '',
    '非法样例正文按原文渲染。',
    ''
  ].join('\n');
  await injectDir(page, [
    { name: 'fm-valid.md', content: valid },
    { name: 'fm-bad.md', content: invalid }
  ]);

  // 合法：正文渲染、元数据键值不出现
  await openTreeFile(page, 'fm-valid.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await expect(md.locator('h1', { hasText: '合法 front matter 正文' })).toBeVisible();
  await expect(md).not.toContainText('vv-secret-meta');
  await expect(md).not.toContainText('title:');

  // 非法（YAML 解析抛错）：原文整体渲染，应用不崩、正文可读
  await openTreeFile(page, 'fm-bad.md');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await expect(md).toContainText('{this is : not : valid yaml [');
  await expect(md.locator('h1', { hasText: '非法 front matter 之后' })).toBeVisible();
  await expect(md).toContainText('非法样例正文按原文渲染。');
});

test('MD-13 媒体链接增强：.mp4/.mp3 链接转内联 video/audio，原 a 元素不保留', async ({
  page
}) => {
  test.setTimeout(60_000);
  const content = [
    '[播放视频](clip.mp4)',
    '',
    '[播放音频](note.mp3)',
    '',
    '[普通外链](https://example.com/docs)',
    ''
  ].join('\n');
  await injectDir(page, [{ name: 'media-links.md', content }]);
  await openTreeFile(page, 'media-links.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // .mp4 → video[controls]、.mp3 → audio[controls]，src 指向原链接目标
  const video = md.locator('video[controls]');
  const audio = md.locator('audio[controls]');
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute('src', /clip\.mp4$/);
  await expect(audio).toHaveCount(1);
  await expect(audio).toHaveAttribute('src', /note\.mp3$/);

  // 原链接不再以 a 元素存在；普通非媒体链接不受增强影响
  await expect(md.locator('a[href$=".mp4"], a[href$=".mp3"]')).toHaveCount(0);
  await expect(md.locator('a[href="https://example.com/docs"]')).toHaveCount(1);
});
