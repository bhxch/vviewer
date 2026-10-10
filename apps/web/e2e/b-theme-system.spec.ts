import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * theme-system 域回归（docs/e2e/theme-system.md）。既有覆盖不重写：
 * 三态循环+持久（mobile.spec.ts 主题项）、tree-sitter 路径切主题零重解析（m2.spec.ts）、
 * hljs 级联暗色 --hljs-keyword（m7.spec.ts）。本文件补：
 * - THEME-02：system 模式 prefers-color-scheme 双向跟随（壳层 --ui-bg + 代码主题槽位）
 * - THEME-03：长 .rs 滚动 100000 后连切主题——类名哈希不变、scrollTop 不丢（chromium project：
 *   规模口径按域文档桌面基准；零重解析契约与视口无关）
 * - THEME-04：亮暗双槽位独立记忆、互不串扰、刷新恢复
 * - THEME-05：markdown rust 围栏与独立 .rs 同主题同色、切主题同步更新
 * - THEME-06：hljs 整文件兜底路径（perl/prolog 不在内嵌 grammar 集）9 个 --hljs-* 变量
 *   全量跟随 + 视口 span 计算色一致（chromium project；域文档 4.4：主题断言只用页内 evaluate）
 * - THEME-07：切主题仅 style#vv-code-theme 变化（head 结构签名 + span 哈希不变）+ 落 DOM 耗时
 *   宽松断言（报告口径 0.5~0.8ms，阈值放宽到 50ms 防环境抖动）
 */

const RUST_SNIPPET = 'fn main() {\n    let x = 42;\n    println!("hello {}", x);\n} // c\n';

/** THEME-06 载体：perl 源码。prolog/perl 均不在内嵌 grammar 集（apps/web/static/grammars
 * 为 lite 子集）→ hljs 整文件兜底——阶段 4 后视口 hljs-* span 的唯一真实消费路径 */
const PERL_SNIPPET = `# THEME-06 载体：perl 脚本（hljs 兜底）
use strict;
use warnings;

my %counts;
open my $fh, '<', $ARGV[0] or die "cannot open $ARGV[0]: $!";
while (my $line = <$fh>) {
    for my $word (split /\\s+/, lc $line) {
        $counts{$word}++;
    }
}
close $fh;

for my $word (sort { $counts{$b} <=> $counts{$a} } keys %counts) {
    printf "%-20s %d\\n", $word, $counts{$word};
}
`;

interface Payload {
  name: string;
  type: string;
  content?: string;
}

async function openDir(page: Page, payloads: Payload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const f = new File([content ?? ''], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `btheme/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** style#vv-code-theme 注释头含当前主题名与亮暗（theme.ts applyCodeTheme 写入） */
function themeComment(page: Page): Promise<string> {
  return page.evaluate(
    () => document.getElementById('vv-code-theme')?.textContent?.slice(0, 80) ?? ''
  );
}

/** 视口内 ts-* 与 hljs-* span 的 {类名 → 计算色} 映射（THEME-05 同色比对的页内实现） */
async function spanColors(page: Page, scope: string): Promise<Record<string, string>> {
  return page.evaluate((scope) => {
    const out: Record<string, string> = {};
    for (const el of document.querySelectorAll(`${scope} span[class^="ts-"]`)) {
      const cls = el.className;
      if (!(cls in out)) out[cls] = getComputedStyle(el).color;
    }
    return out;
  }, scope);
}

test('THEME-02：system 模式 prefers-color-scheme 双向跟随（壳层配色 + 代码主题槽位）', async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  const themeBtn = page.getByRole('button', { name: /主题：/ });
  await expect(themeBtn).toHaveText('主题：跟随系统');
  // vite8 起默认 CSS 压缩器由 esbuild 换为 Lightning CSS：#ffffff 被等价缩短为 #fff
  // （产物实测 --ui-bg:#fff）。自定义属性 getPropertyValue 取的是原始声明值（浏览器
  // 不做颜色归一化），断言前先把 3 位 hex 展开为 6 位再比较——断言语义不变，且不
  // 绑定压缩器输出格式；暗色 #0d1117 无 3 位等价形式，不受影响
  const uiBg = () =>
    page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--ui-bg').trim();
      const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
      return m && m[1] && m[2] && m[3]
        ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase()
        : v;
    });
  await expect.poll(uiBg).toBe('#ffffff'); // 亮色壳层
  await expect.poll(() => themeComment(page)).toContain('onelight');

  // 系统→暗：壳层变暗 + 暗槽位代码主题（无需手动干预，主题态保持「跟随系统」）
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(uiBg, { timeout: 10_000 }).toBe('#0d1117');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  await expect.poll(() => themeComment(page), { timeout: 10_000 }).toContain('serika-dark');

  // 系统→亮：双向第二轮
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(uiBg, { timeout: 10_000 }).toBe('#ffffff');
  await expect.poll(() => themeComment(page), { timeout: 10_000 }).toContain('onelight');
});

test('THEME-04：亮暗双槽位独立记忆、来回切换互不串扰、刷新恢复', async ({ page }) => {
  await page.goto('/');
  const themeBtn = page.getByRole('button', { name: /主题：/ });
  const themeSelect = page.getByLabel('代码主题');

  // 亮态选 A
  await themeBtn.click(); // system → light（headless prefers light）
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await themeSelect.selectOption('github_light');
  await expect.poll(() => themeComment(page)).toContain('github_light');

  // 暗态选 B（域文档口径：暗槽位 gruvbox）
  await themeBtn.click(); // light → dark
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await themeSelect.selectOption('gruvbox');
  await expect.poll(() => themeComment(page)).toContain('gruvbox');

  // 双键独立存储
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}'));
  expect(saved.codeThemeLight).toBe('github_light');
  expect(saved.codeThemeDark).toBe('gruvbox');

  // 来回切换互不串扰（dark → system → light）：亮恒回 A、暗恒回 B
  await themeBtn.click(); // dark → system（headless 解析为亮）
  await expect.poll(() => themeComment(page)).toContain('github_light');
  await expect(themeSelect).toHaveValue('github_light');
  await themeBtn.click(); // system → light
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await expect(themeSelect).toHaveValue('github_light');
  await themeBtn.click(); // light → dark
  await expect(themeSelect).toHaveValue('gruvbox');
  await expect.poll(() => themeComment(page)).toContain('gruvbox');

  // 刷新后双槽位记忆保持并正确应用（themeMode=dark 持久）
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect.poll(() => themeComment(page)).toContain('gruvbox');
  await expect(page.getByLabel('代码主题')).toHaveValue('gruvbox');
  await page.getByRole('button', { name: /主题：/ }).click(); // dark → system（亮）
  await expect(page.getByLabel('代码主题')).toHaveValue('github_light');
});

test('THEME-05：markdown rust 围栏与独立 .rs 同主题同色，切主题同步更新', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const md = ['```rust', RUST_SNIPPET, '```', '', '# 围栏联动', '', '正文段落。', ''].join('\n');
  await openDir(page, [
    { name: 'fence.md', type: 'text/markdown', content: md },
    { name: 'sample.rs', type: 'text/plain', content: RUST_SNIPPET.repeat(8) }
  ]);

  // markdown 围栏：tree-sitter 围栏高亮（fenceToHtml 同 HighlightClient，类名 ts-*）
  await openFile(page, 'fence.md');
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-markdown span[class^="ts-"]').first()).toBeVisible({
    timeout: 20_000
  });
  // 独立 .rs：tree-sitter 主路径
  await openFile(page, 'sample.rs');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 20_000
  });

  // 回到 markdown tab：同亮暗态同代码主题下，两视图共享捕获类的计算色一致。
  // tab 切换会整体重渲染（ViewerPane effect 重建实例），取色前必须等高亮 span 再现
  const capture = async (scope: string): Promise<Record<string, string>> => {
    await expect(page.locator(`${scope} span[class^="ts-"]`).first()).toBeVisible({
      timeout: 20_000
    });
    return spanColors(page, scope);
  };
  await page.locator('.vv-tab', { hasText: 'fence.md' }).click();
  const mdColors = await capture('.vv-markdown');
  await page.locator('.vv-tab', { hasText: 'sample.rs' }).click();
  const rsColors = await capture('.vv-code-pre');
  const shared = Object.keys(mdColors).filter((k) => k in rsColors);
  expect(shared.length).toBeGreaterThan(0); // 有可比的同类 token
  for (const cls of shared) expect(mdColors[cls], `围栏 vs .rs 的 ${cls}`).toBe(rsColors[cls]);

  // 切代码主题：两视图同步更新且仍一致（围栏着色联动，零重解析只换变量）
  await page.getByLabel('代码主题').selectOption('catppuccin_mocha');
  await expect.poll(() => themeComment(page), { timeout: 10_000 }).toContain('catppuccin_mocha');
  await page.locator('.vv-tab', { hasText: 'fence.md' }).click();
  const mdColors2 = await capture('.vv-markdown');
  await page.locator('.vv-tab', { hasText: 'sample.rs' }).click();
  const rsColors2 = await capture('.vv-code-pre');
  const changed = shared.filter((k) => mdColors2[k] !== mdColors[k]);
  expect(changed.length).toBeGreaterThan(0); // 至少一类 token 实际换色
  for (const cls of shared) expect(mdColors2[cls]).toBe(rsColors2[cls]);
});

// ── 以下三个重头场景规模口径按域文档桌面基准，仅在 chromium project 跑 ──

test('THEME-03：长 .rs 滚动 100000 后连切两主题——类名哈希不变、scrollTop 不丢', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '规模口径按域文档桌面基准（chromium project）');
  test.setTimeout(120_000);
  await page.goto('/');
  // 16000 行 rust（≈540KB）：scrollHeight≈320000px，100000 滚动位成立
  await openDir(page, [
    { name: 'long.rs', type: 'text/plain', content: RUST_SNIPPET.repeat(16000) }
  ]);
  await openFile(page, 'long.rs');
  const pre = page.locator('.vv-code-pre');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 60_000
  });
  await pre.evaluate((el) => {
    el.scrollTop = 100000;
  });
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBe(100000);

  /** 渲染区全部 span 类名的稳定指纹（数量 + 类名序列）；滚动触发的虚拟填充异步落定后才采信 */
  const fingerprint = () =>
    page.evaluate(() => {
      const spans = [...document.querySelectorAll('.vv-code-pre span[class^="ts-"]')];
      return { count: spans.length, classes: spans.map((s) => s.className).join('|') };
    });
  const stableFingerprint = async (): Promise<{ count: number; classes: string }> => {
    let prev = await fingerprint();
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(100);
      const cur = await fingerprint();
      if (cur.count === prev.count && cur.classes === prev.classes) return cur;
      prev = cur;
    }
    return prev;
  };
  const base = await stableFingerprint();
  expect(base.count).toBeGreaterThan(0);

  // 连切两个主题（含域文档点名的 catppuccin_mocha）：指纹逐字一致 + 滚动位不丢
  for (const theme of ['catppuccin_mocha', 'tokyonight']) {
    const before = await stableFingerprint();
    await page.getByLabel('代码主题').selectOption(theme);
    await expect.poll(() => themeComment(page), { timeout: 10_000 }).toContain(theme);
    const after = await stableFingerprint();
    expect(after.count).toBe(before.count);
    expect(after.classes).toBe(before.classes);
    const st = await pre.evaluate((el) => el.scrollTop);
    expect(Math.abs(st - 100000), `${theme} 切换后 scrollTop`).toBeLessThanOrEqual(2);
  }
  expect(base.count).toBeGreaterThan(0);
});

test('THEME-06：hljs 整文件兜底路径 9 个 --hljs-* 变量全量跟随 + 视口 span 计算色一致', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '与 THEME-03/07 同批桌面基准（域文档 4.4）');
  test.setTimeout(120_000);
  await page.goto('/');
  // 阶段 4 改写：hljs-block 分块路径已退役，>2MB 走 lazy chunk（tree-sitter 质量）。
  // 视口 hljs-* span 的消费路径收窄为「≤2MB 且无内嵌 grammar」的整文件兜底——
  // .pl 载体（detectLanguage('pl')→prolog，不在内嵌集）正是 m2 sample.pl 同款降级链
  await openDir(page, [{ name: 'theme06.pl', type: 'text/plain', content: PERL_SNIPPET }]);
  await openFile(page, 'theme06.pl');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]').first()).toBeVisible({
    timeout: 30_000
  });

  /** style#vv-code-theme 内 9 个 --hljs-* 变量值（theme.ts HLJS_CAPTURE_TO_VAR 全集） */
  const hljsVars = () =>
    page.evaluate(() => {
      const text = document.getElementById('vv-code-theme')?.textContent ?? '';
      const names = [
        '--hljs-keyword',
        '--hljs-string',
        '--hljs-comment',
        '--hljs-number',
        '--hljs-title',
        '--hljs-type',
        '--hljs-variable',
        '--hljs-tag',
        '--hljs-attr'
      ];
      return Object.fromEntries(
        names.map((n) => {
          const m = new RegExp(`${n}:\\s*([^;]+);`).exec(text);
          return [n, m ? m[1]!.trim() : ''];
        })
      );
    });

  const before = await hljsVars();
  // 换 tokyonight：9 个变量全量写入新色板（无默认残留）
  await page.getByLabel('代码主题').selectOption('tokyonight');
  await expect.poll(() => themeComment(page), { timeout: 10_000 }).toContain('tokyonight');
  const after = await hljsVars();
  for (const name of Object.keys(after)) {
    expect(after[name], `${name} 已写入 tokyonight 取色`).not.toBe('');
  }
  expect(after['--hljs-keyword']).not.toBe(before['--hljs-keyword']);
  expect(after['--hljs-comment']).not.toBe(before['--hljs-comment']);

  // 视口内 hljs span 的计算色与变量一致（探针元素直用同一 var 表达式，避免 hex→rgb 换算）
  const mismatches = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    document.body.append(probe);
    const bad: string[] = [];
    for (const cls of ['hljs-keyword', 'hljs-comment', 'hljs-string', 'hljs-number']) {
      const span = document.querySelector(`.vv-code-pre span.${cls}`);
      if (!span) continue;
      const varName = `--hljs-${cls.slice('hljs-'.length)}`;
      probe.style.color = `var(${varName})`;
      if (getComputedStyle(span).color !== getComputedStyle(probe).color) bad.push(cls);
    }
    probe.remove();
    return bad;
  });
  expect(mismatches).toEqual([]);
});

test('THEME-07：切主题仅 style#vv-code-theme 变化，落 DOM 亚毫秒级（宽松阈值 50ms）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '与 THEME-03/06 同批桌面基准');
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'small.ts', type: 'text/plain', content: 'const a: number = 1; // c\n'.repeat(50) }
  ]);
  await openFile(page, 'small.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 20_000
  });

  const signature = () =>
    page.evaluate(() => ({
      head: [...document.head.children].map((el) => `${el.tagName}#${el.id}`).join('|'),
      spans: [...document.querySelectorAll('.vv-code-pre span')]
        .map((s) => s.className)
        .join('|'),
      styleText: document.getElementById('vv-code-theme')?.textContent ?? ''
    }));
  const base = await signature();
  expect(base.spans.length).toBeGreaterThan(0);

  // 页内触发切换（改 select + change 事件，与用户切换同管线），
  // MutationObserver 记录 style#vv-code-theme textContent 替换落 DOM 耗时
  const durationMs = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const el = document.getElementById('vv-code-theme');
        const sel = document.querySelector<HTMLSelectElement>('select[aria-label="代码主题"]');
        if (!el || !sel) {
          reject(new Error('style#vv-code-theme 或代码主题下拉不存在'));
          return;
        }
        const t0 = performance.now();
        const mo = new MutationObserver(() => {
          mo.disconnect();
          resolve(performance.now() - t0);
        });
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        sel.value = 'github_dark';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => reject(new Error('5000ms 内未观察到主题样式落 DOM')), 5000);
      })
  );
  console.log(`[perf] 切主题落 DOM 耗时: ${durationMs.toFixed(2)}ms（报告口径 0.5~0.8ms）`);
  expect(durationMs).toBeLessThan(50); // 宽松阈值防环境抖动；远低于此即视为亚毫秒级契约成立

  const after = await signature();
  expect(after.head).toBe(base.head); // head 子节点结构签名不变
  expect(after.spans).toBe(base.spans); // span 类名序列逐字不变（零重解析）
  expect(after.styleText).not.toBe(base.styleText); // 变化的仅是 style#vv-code-theme 文本
  expect(after.styleText).toContain('github_dark');
});
