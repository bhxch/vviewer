import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-syntax-deep 扩展语法补强（SY-01~SY-11，编号对照 docs/e2e/markdown-html-docs.md
 * 第 5 节补强场景表；第二轮 default 套件）。与既有覆盖分工：
 * - b-md-syntax 只锚 happy path（四插件渲染 / [!note]- 收起展开 / 锚跳 / 徽标 / 四形态
 *   katex），md07-09 只锚 MD-08 有语言代码块复制——本组补负路径、边界与组合面：
 *   SY-01 callout 折叠后缀保守解析（[!note]+x 非空白不折叠、[!note] -5 负号正文不误判）；
 *   SY-02 未知类型 callout 兜底（MD-02 折叠组合面）；SY-03 [!warning]+ 收起方向与多卡
 *   独立；SY-04 折叠标题内 wikilink 锚跳（a 导航不切折叠）；SY-05 wikilink 上下文混排
 *   （列表锚 / 引用 dead title 注记 / 链接内字面豁免）；SY-06 空 ^[] 本地脚注边界
 *   （markdownEngine.test 同口径）；SY-07 金额 $ 与转义 \$ 空白规则；SY-08 mhchem 块级
 *   $$ 与 \[ 形态组合 + 非法段保留 + katex.min.css 排印（0d767ae）；SY-09 代码块/行内码
 *   豁免面组合；SY-10 无语言「代码」徽标 + 复制语义（154c0c1 顶栏迁移后回归）；
 *   SY-11 CRLF 围栏 + \[\] 闭围栏回归锚（1b3f43d 的前端对偶语义）；
 * - 服务端 comrak 通道不在本轮（default 套件纯 web），双端一致性归 vitest 金标锚。
 * 时序锚：renderMarkdown 全管线 await 完成才 replaceChildren 挂载（渲染主流程中
 * runPipeline 先于挂载，class 添加与挂载间无 await），故 .vv-markdown visible 即
 * enrich + 五步管线（含 katex/copyCode）全部就绪，计数 0 断言无假绿窗口。
 * 注入通道与 b-md-syntax 组一致（injectDir + openTreeFile，mobile 抽屉适配）；夹具
 * 全部 spec 内联构造——不触碰共享样例 syntax-sampler.md，避免扰动既有 spec 的
 * .katex 计数断言环境。
 */

/** 页面注入单个 md 文件并打开，等渲染管线挂载完成 */
async function openMd(page: Page, name: string, content: string): Promise<void> {
  await injectDir(page, [{ name, content }]);
  await openTreeFile(page, name);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

test.describe('b-syntax-deep 扩展语法补强', () => {
  // 折叠后缀前瞻保护的负路径锚：未知写法从保守不折叠、正文负号不误判折叠
  test('SY-01 callout 折叠后缀保守解析：+x 紧随与 -5 负号正文均不折叠', async ({ page }) => {
    test.setTimeout(60_000);
    const content = [
      '> [!note]+x 后缀紧跟字母不算折叠',
      '> 正文甲。',
      '',
      '> [!note] -5 度是正文负号',
      '> 正文乙。',
      ''
    ].join('\n');
    await openMd(page, 'callout-conservative.md', content);
    const md = page.locator('.vv-markdown');
    // 后缀非空白（+x）与负号正文（-5 度）：仍转 note 卡片，但不带 foldable，原文留在标题
    const plusX = md.locator('.markdown-alert-note', { hasText: '+x' });
    await expect(plusX).toHaveCount(1);
    await expect(plusX).not.toHaveClass(/markdown-alert-foldable/);
    await expect(plusX.locator('.markdown-alert-title')).toContainText('+x 后缀紧跟字母不算折叠');
    const negDeg = md.locator('.markdown-alert-note', { hasText: '-5 度' });
    await expect(negDeg).toHaveCount(1);
    await expect(negDeg).not.toHaveClass(/markdown-alert-foldable/);
    await expect(negDeg.locator('.markdown-alert-title')).toContainText('-5 度是正文负号');
    // 无折叠标记即无 toggle 监听面：点击标题内容恒可见（若回归为误判折叠则此处翻红）
    await plusX.locator('.markdown-alert-title').click();
    await expect(plusX.locator('.markdown-alert-content')).toBeVisible();
    await expect(plusX).not.toHaveClass(/markdown-alert-collapsed/);
    await negDeg.locator('.markdown-alert-title').click();
    await expect(negDeg.locator('.markdown-alert-content')).toBeVisible();
    await expect(negDeg).not.toHaveClass(/markdown-alert-collapsed/);
  });

  // MD-02 未知类型兜底的组合面：类型类名挂钩 + 大写名回退 + 不崩
  test('SY-02 未知类型 callout 兜底：custom 转卡片、标题回退大写类型名、应用不崩', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const content = ['> [!custom]', '> 未知类型兜底正文。', ''].join('\n');
    await openMd(page, 'callout-unknown.md', content);
    const md = page.locator('.vv-markdown');
    const alert = md.locator('.markdown-alert-custom');
    await expect(alert).toHaveCount(1);
    await expect(alert).toHaveClass(/markdown-alert/);
    await expect(alert).not.toHaveClass(/markdown-alert-foldable/);
    // 空标题回退类型大写名（enrich 空标题回退路径），内容区正文完好
    await expect(alert.locator('.markdown-alert-title')).toContainText('Custom');
    await expect(alert.locator('.markdown-alert-content')).toBeVisible();
    await expect(alert.locator('.markdown-alert-content')).toContainText('未知类型兜底正文。');
    // MD-02 口径：未知类型不崩，渲染视图无错误卡片
    await expect(md.locator('.markdown-alert')).toHaveCount(1);
  });

  // + 方向折叠（既有仅锚 - 方向）与多卡独立切换：toggle 只作用自身卡片容器
  test('SY-03 加号折叠默认展开可收起再展开，与相邻减号卡折叠态互不影响', async ({ page }) => {
    test.setTimeout(60_000);
    const content = [
      '> [!warning]+ 可收起的提示',
      '> 展开态正文。',
      '',
      '> [!tip]- 默认收起的诀窍',
      '> 收起态正文。',
      ''
    ].join('\n');
    await openMd(page, 'callout-fold-directions.md', content);
    const md = page.locator('.vv-markdown');
    const plus = md.locator('.markdown-alert-warning');
    const minus = md.locator('.markdown-alert-tip');
    await expect(plus).toHaveClass(/markdown-alert-foldable/);
    await expect(plus).not.toHaveClass(/markdown-alert-collapsed/);
    await expect(plus.locator('.markdown-alert-content')).toBeVisible();
    await expect(minus).toHaveClass(/markdown-alert-collapsed/);
    await expect(minus.locator('.markdown-alert-content')).toBeHidden();

    // + 卡点击收起 → 内容隐藏；- 卡状态不受牵连
    await plus.locator('.markdown-alert-title').click();
    await expect(plus).toHaveClass(/markdown-alert-collapsed/);
    await expect(plus.locator('.markdown-alert-content')).toBeHidden();
    await expect(minus).toHaveClass(/markdown-alert-collapsed/);

    // 再点 + 卡展开复原；- 卡仍保持收起（toggle 只作用于自身卡片容器）
    await plus.locator('.markdown-alert-title').click();
    await expect(plus).not.toHaveClass(/markdown-alert-collapsed/);
    await expect(plus.locator('.markdown-alert-content')).toBeVisible();
    await expect(minus).toHaveClass(/markdown-alert-collapsed/);
  });

  // enrich 注册顺序（callout→wikilink）与标题内 a 导航豁免两个契约的组合锚
  test('SY-04 折叠 callout 标题内 wikilink 锚跳：按链接导航不切折叠，hash 收口前缀', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const content = [
      '页首引子。',
      '',
      '> [!note]- 折叠标题含 [[#落点]]',
      '> 收起态正文。',
      '',
      '## 落点',
      '',
      '落点正文段落。',
      ''
    ].join('\n');
    await openMd(page, 'fold-title-wikilink.md', content);
    const md = page.locator('.vv-markdown');
    const alert = md.locator('.markdown-alert');
    await expect(alert).toHaveClass(/markdown-alert-foldable/);
    await expect(alert).toHaveClass(/markdown-alert-collapsed/);
    // enrich 先 callout 后 wikilink：折叠标题内 [[#落点]] 同获改写，href 经 remap 收口
    const link = alert.locator('.markdown-alert-title a[data-wikilink="anchor"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '#user-content-落点');
    // 点击标题内链接按链接语义导航：折叠态保持，不触发标题的折叠切换
    await link.click();
    await expect(alert).toHaveClass(/markdown-alert-collapsed/);
    const hash = await page.evaluate(() => decodeURIComponent(location.hash));
    expect(hash).toBe('#user-content-落点');
    await expect(md.locator('h2#user-content-落点')).toBeInViewport();
  });

  // wikilink 四形态的上下文混排面：A 祖先豁免字面、降级 span 的 title 注记
  test('SY-05 wikilink 上下文混排：列表锚可点、引用跨文件降级注记、链接内字面不改写', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const content = [
      '- 列表项跳 [[#列表落点]]',
      '',
      '> 引用内跨文件 [[Ref.md]] 不可点',
      '',
      '已有链接 [字面 [[#内部]] 不改写](#列表落点)。',
      '',
      '## 列表落点',
      '',
      '落点段。',
      ''
    ].join('\n');
    await openMd(page, 'wikilink-contexts.md', content);
    const md = page.locator('.vv-markdown');
    // 列表项内锚 wikilink：正常改写为可点链接，点击后落点 heading 入视口
    const liLink = md.locator('li a[data-wikilink="anchor"]');
    await expect(liLink).toHaveCount(1);
    await expect(liLink).toHaveAttribute('href', '#user-content-列表落点');
    await liLink.click();
    await expect(md.locator('h2#user-content-列表落点')).toBeInViewport();
    // 引用块内跨文件 wikilink：降级 dead span 且带 title 注记，块内不产 a
    const dead = md.locator('blockquote .md-wikilink-dead');
    await expect(dead).toHaveCount(1);
    await expect(dead).toHaveText('[[Ref.md]]');
    await expect(dead).toHaveAttribute('title', '跨文件 wikilink 不支持');
    await expect(md.locator('blockquote a[data-wikilink]')).toHaveCount(0);
    // 已有链接文本内的 [[#内部]]：A 祖先豁免，字面保留不嵌套造链接
    const existing = md.locator('a', { hasText: '字面' });
    await expect(existing).toHaveCount(1);
    await expect(existing).toContainText('[[#内部]]');
    await expect(existing.locator('[data-wikilink]')).toHaveCount(0);
  });

  // 空行内脚注双端分歧的本地侧现状锚（与 markdownEngine.test 空注探针同口径）
  test('SY-06 空行内脚注 ^[]：本地引擎照产序号 ref 与空尾注条目', async ({ page }) => {
    test.setTimeout(60_000);
    const content = '空注边界：前^[]后 与 前^[ ]后。\n';
    await openMd(page, 'inline-footnote-empty.md', content);
    const md = page.locator('.vv-markdown');
    // markdown-it-footnote 内建对空/空白照产脚注（双端分歧的本地侧现状，vitest 同口径）
    const refs = md.locator('sup.footnote-ref a');
    await expect(refs).toHaveText(['[1]', '[2]']);
    const items = md.locator('section.footnotes li.footnote-item');
    await expect(items).toHaveCount(2);
    // 空注条目仅剩回链：注文本位为空，^[] 字面不泄漏进尾注
    for (const li of await items.all()) {
      await expect(li.locator('a.footnote-backref')).toHaveCount(1);
      await expect(li).not.toContainText('^[');
    }
  });

  // scanMathSegments 行内定界符空白规则的金额语义回归锚 + \$ 转义字面
  test('SY-07 金额 $ 与转义 \\$ 不触发公式：空白规则守恒，对照真公式恰渲染一处', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const content = '价格区间 $100 与 $200 之间，成本 \\$5。对照 $E = mc^2$ 公式。\n';
    await openMd(page, 'math-money.md', content);
    const md = page.locator('.vv-markdown');
    // 开/闭定界符紧邻空白不配对（scanMathSegments 金额保护）；\$ 经引擎转义为字面 $
    await expect(md).toContainText('$100 与 $200');
    await expect(md).toContainText('成本 $5。');
    // 同段真公式照常渲染，且全文恰此一处 katex、无块级形态
    await expect(md.locator('.katex')).toHaveCount(1, { timeout: 20_000 });
    await expect(md.locator('.katex-display')).toHaveCount(0);
  });

  // mhchem 块级双形态组合 + 非法公式单节点容错保留 + katex.min.css 动态加载排印锚
  test('SY-08 mhchem 块级 $$ 与 \\[ 形态组合渲染，非法公式整段保留且 css 排印生效', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const content = [
      '块级双币：',
      '',
      '$$\\ce{SO4^2- + Ba^2+ -> BaSO4 v}$$',
      '',
      '括号形态：',
      '',
      '\\[ \\ce{2H2 + O2 -> 2H2O} \\]',
      '',
      '非法段 $\\frac{1}{2$ 保留原文。',
      ''
    ].join('\n');
    await openMd(page, 'mhchem-blocks.md', content);
    const md = page.locator('.vv-markdown');
    // $$ 原生块级与 \[..\]（protectLatexDelimiters 改写为 $$ 词汇）双形态 display 渲染
    await expect(md.locator('.katex-display .katex')).toHaveCount(2, { timeout: 20_000 });
    // 非法 LaTeX（未闭合分组）：throwOnError 抛错 → 节点原文保留，不崩
    await expect(md).toContainText('$\\frac{1}{2$');
    await expect(md.locator('p', { hasText: '非法段' }).locator('.katex')).toHaveCount(0);
    // katex.min.css 动态加载（0d767ae）：排印字体族落到 KaTeX 专有字体
    await expect
      .poll(
        async () =>
          md
            .locator('.katex-display .katex')
            .first()
            .evaluate((el) => getComputedStyle(el).fontFamily),
        { timeout: 10_000 }
      )
      .toContain('KaTeX');
  });

  // protectLatexDelimiters fence 透传与 enrich/katex 的 PRE/CODE 祖先跳过豁免面组合
  test('SY-09 代码块与行内码豁免面：mark/wikilink/公式/callout 标记字面不触发', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const content = [
      '```text',
      '==高亮== 与 [[#锚]] 与 $E=mc^2$',
      '> [!note]- 假 callout',
      '\\[ 非数学 \\]',
      '```',
      '',
      '行内码 `==x== $y$ [[#z]]` 字面保留。',
      ''
    ].join('\n');
    await openMd(page, 'code-exemption.md', content);
    const md = page.locator('.vv-markdown');
    // 围栏内四类字面全保留（protectLatexDelimiters fence 透传 + enrich/katex 的 PRE/CODE 跳过）
    const code = md.locator('pre code');
    await expect(code).toContainText('==高亮== 与 [[#锚]] 与 $E=mc^2$');
    await expect(code).toContainText('> [!note]- 假 callout');
    await expect(code).toContainText('\\[ 非数学 \\]');
    await expect(md.locator('p code')).toContainText('==x== $y$ [[#z]]');
    // 徽标取围栏原始语言；文档级产物计数全零证明豁免面成立
    await expect(md.locator('.md-code-lang')).toHaveText('text');
    await expect(md.locator('mark')).toHaveCount(0);
    await expect(md.locator('[data-wikilink]')).toHaveCount(0);
    await expect(md.locator('.markdown-alert')).toHaveCount(0);
    await expect(md.locator('.katex')).toHaveCount(0);
  });

  // 无语言围栏徽标回退取词源契约 + MD-08 复制语义在 154c0c1 顶栏迁移后的无语言变体回归
  test('SY-10 无语言代码块「代码」徽标与复制钮语义回归', async ({ page }) => {
    test.setTimeout(60_000);
    const content = ['```', '无语言围栏行一', '行二 const x = 1;', '```', ''].join('\n');
    await openMd(page, 'code-no-lang.md', content);
    const md = page.locator('.vv-markdown');
    // 无语言 fence：data-md-lang 为空串 → 徽标回退「代码」（hljs 侦测类不污染取词源）
    const bar = md.locator('.md-code-bar');
    await expect(bar.locator('.md-code-lang')).toHaveText('代码');
    const btn = bar.locator('.md-copy-btn');
    await expect(btn).toHaveText('复制');
    // 复制语义（MD-08 同口径）：hook 剪贴板写入，内容与代码块 textContent 去尾换行一致
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
    await btn.click();
    await expect(btn).toHaveText('已复制');
    const copied = await page.evaluate(() => (window as { __vvCopied?: string[] }).__vvCopied);
    const codeText = await page.evaluate(
      () => (document.querySelector('.vv-markdown pre code') as HTMLElement).textContent ?? ''
    );
    expect(copied).toHaveLength(1);
    expect(copied![0]).toBe(codeText.replace(/\n$/, ''));
    expect(copied![0]).toBe('无语言围栏行一\n行二 const x = 1;');
  });

  // 1b3f43d 前端对偶语义（protectLatexDelimiters 入口 CRLF 归一化）的围栏闭合回归锚
  test('SY-11 CRLF 回归锚：围栏正常闭合，围栏后 \\(\\) 行内数学渲染', async ({ page }) => {
    test.setTimeout(60_000);
    // 全 CRLF 行距（1b3f43d 前端对偶语义：入口 \r\n?→\n 归一化，闭围栏不被 \r 卡死）
    const content = [
      '# CRLF 回归',
      '',
      '\\[ E = h\\nu \\]',
      '',
      '```rust',
      'fn main() {}',
      '```',
      '',
      '围栏后 \\(\\alpha\\) 行内数学。',
      ''
    ].join('\r\n');
    await openMd(page, 'crlf-math.md', content);
    const md = page.locator('.vv-markdown');
    // 修复前症状：闭围栏带 \r 不匹配 → fence 吞掉后半文档，围栏后数学不渲染
    await expect(md.locator('.katex')).toHaveCount(2, { timeout: 20_000 });
    await expect(md.locator('.katex-display .katex')).toHaveCount(1);
    // fence 恰当闭合：rust 徽标在、代码文本不含围栏后行，首行标题不受影响
    await expect(md.locator('.md-code-lang')).toHaveText('rust');
    await expect(md.locator('pre code')).toContainText('fn main() {}');
    await expect(md.locator('pre code')).not.toContainText('alpha');
    await expect(md.locator('h1')).toContainText('CRLF 回归');
  });
});
