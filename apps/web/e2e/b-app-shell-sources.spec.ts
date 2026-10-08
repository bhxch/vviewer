import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * app-shell-sources 域回归（docs/e2e/app-shell-sources.md）：缺陷修复用例，
 * 补既有 m1-m7 套件未覆盖的验收行为。通道同 m1/m2：页面内 new File +
 * defineProperty 写 webkitRelativePath 经调试钩子 __vvOpenDirImpl 注入。
 *
 * 覆盖：
 * - SHELL-11 / BUG-03：j/k 逐行滚、gg 顶、G 底、Ctrl+P 快速打开（修复前全零响应）
 * - SHELL-12 / BUG-04：状态栏「语言/编码/大小/行」段 + 右栏属性面板（修复前全占位）
 * - SHELL-09/13 / BUG-05：设置面板（⚙/Ctrl+,）排除规则预设生效、自动刷新开关落盘（修复前无 UI 入口）
 * - SHELL-03/05 / BUG-07：无扩展名文件可预览（shebang→python、Makefile），.xyz 兜底不回退
 * - SHELL-01/08 / BUG-19/25：打开文件夹两通道均有可见反馈（取消提示），回退通道可达
 */

const LINE = 'const vv = 1; // c\n';

/** 301 行 long-code.js（域文档 4.2：G 键跳底基准 scrollTop≈5567 的同规格载体） */
const LONG_CODE = LINE.repeat(301);

/** UTF-16LE 带 BOM 文本（域文档 4.2 编码 5 件同规格） */
const UTF16LE_BYTES = (() => {
  const body = '统一码文本验证\n'.repeat(8);
  const bytes = new Uint8Array(2 + body.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe; // UTF-16LE BOM
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return Buffer.from(bytes);
})();

/** gb18030 文本：中文四字「中文测试」的 GB2312/gb18030 编码字节 + ASCII（无 BOM → 非 UTF-8 → 判 gb18030） */
const GB18030_BYTES = Buffer.concat([
  Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]),
  Buffer.from(' gb18030 text\n')
]);

/** b04 属性面板/状态栏测试组（二进制载荷以 base64 携带） */
const B04_FILES = [
  { name: 'code-301.js', type: 'text/javascript', content: LONG_CODE },
  { name: 'utf16le.txt', type: 'text/plain', b64: UTF16LE_BYTES.toString('base64') },
  { name: 'gb18030.txt', type: 'text/plain', b64: GB18030_BYTES.toString('base64') }
];

interface Payload {
  name: string;
  type: string;
  content?: string;
  b64?: string;
}

/** 同 m1/m2 的 openDir 通道（内容在页内构造 File，避免 6MB 级 base64 往返） */
async function openDir(page: Page, payloads: Payload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content, b64 }) => {
      const f = new File(
        [content !== undefined ? content : Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))],
        name,
        { type }
      );
      // webkitRelativePath 是原型上仅 getter 的访问器，defineProperty 写自有属性遮蔽（与真实 input 一致）
      Object.defineProperty(f, 'webkitRelativePath', { value: `bshell/${name}` });
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

/** ≤600px 断点右栏（MetaPanel）收进抽屉：AppShell.svelte 的 @media (max-width: 600px) */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

test('BUG-03/SHELL-11：j/k 逐行滚动、gg 跳顶、G 跳底（代码区点击焦点态）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'long-code.js', type: 'text/javascript', content: LONG_CODE }]);
  await openFile(page, 'long-code.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();

  // 焦点态①：点击代码区（修复前三种焦点态 trusted keydown 全到达但 scrollTop 恒 0）
  await page.locator('.vv-code-pre').click({ position: { x: 40, y: 40 } });

  const pre = page.locator('.vv-code-pre');
  // j = +20px（AppShell CODE_LINE_HEIGHT，与 render-text code.ts 行高同源）
  await page.keyboard.press('j');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(20);
  // j×43（场景步骤）：累计 +860
  for (let i = 0; i < 42; i++) await page.keyboard.press('j');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(860);
  // k = -20px
  await page.keyboard.press('k');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(840);

  // gg（500ms 内两击）跳顶
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(0);

  // G 跳底：301 行 × 20px 行高 ≈ 6020 scrollHeight，G 后贴近底部（报告基准 ≈5567）
  await page.keyboard.press('G');
  await expect
    .poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(5000);

  // 焦点态②（修复验收「三种焦点状态」）：gg 回顶后 focus 容器，j 单步仍生效
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(0);
  await pre.focus();
  await page.keyboard.press('j');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(20);

  // 焦点态③：blur 到 body（点壳层空白处），G 跳底仍生效
  await page.locator('.vv-shell').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('G');
  await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(5000);
});

test('BUG-03/SHELL-11：Ctrl+P 快速打开面板，过滤 + Enter 打开，Esc 关闭', async ({ page }) => {
  await page.goto('/');
  await openDir(page, [
    { name: 'alpha.js', type: 'text/javascript', content: 'const a = 1;\n' },
    { name: 'beta.md', type: 'text/markdown', content: '# beta\n' },
    { name: 'keep.txt', type: 'text/plain', content: 'keep\n' }
  ]);
  await expect(page.locator('.vv-tree-row', { hasText: 'keep.txt' })).toBeVisible();

  await page.keyboard.press('Control+p');
  const panel = page.locator('.vv-quickopen');
  await expect(panel).toBeVisible();
  await expect(page.locator('.vv-quickopen-input')).toBeFocused();

  // 全量列表 → 输入过滤（文件名命中）
  await expect(page.locator('.vv-quickopen-row')).toHaveCount(3);
  await page.locator('.vv-quickopen-input').fill('keep');
  await expect(page.locator('.vv-quickopen-row')).toHaveCount(1);
  await expect(page.locator('.vv-quickopen-row', { hasText: 'keep.txt' })).toBeVisible();

  // Enter 打开首条选中项
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-tab.active', { hasText: 'keep.txt' })).toBeVisible();
  await expect(panel).toHaveCount(0);

  // 再开再关：Esc 关闭（面板内 Esc）
  await page.keyboard.press('Control+p');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // 回归不破坏（BUG-03 验收 4）：'/' 文件内搜索仍正常
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('BUG-04/SHELL-12：状态栏「语言/编码/大小/行」段 + 属性面板字段（代码/编码件/图片）', async ({
  page
}) => {
  await page.goto('/');
  await openDir(page, B04_FILES);
  await expect(page.locator('.vv-tree-row', { hasText: 'code-301.js' })).toBeVisible();

  // 代码文件：语言 + 编码 + 大小 + 行（修复前 outerHTML 四字段均为 Svelte 占位 <!---->）
  await openFile(page, 'code-301.js');
  const sb = page.locator('.vv-statusbar');
  await expect(sb).toContainText('语言: javascript');
  await expect(sb).toContainText('编码: utf-8');
  await expect(sb).toContainText(/大小: \d+/);
  await expect(sb).toContainText('行: 301');
  // 既有正确行为不退化：高亮引擎与执行位置段仍在
  await expect(sb).toContainText(/高亮: (tree-sitter|hljs)/);

  // 属性面板（右栏）：名称/大小/编码/语言/行数字段实渲染
  await openRightIfNarrow(page);
  await expect(page.locator('.meta-name')).toHaveText('code-301.js');
  await expect(page.locator('.meta-row', { hasText: '编码' })).toContainText('utf-8');
  await expect(page.locator('.meta-row', { hasText: '语言' })).toContainText('javascript');
  await expect(page.locator('.meta-row', { hasText: '行数' })).toContainText('301');
  await expect(page.locator('.meta-row', { hasText: '大小' })).toContainText(/字节/);
  if (await page.evaluate(() => window.innerWidth <= 600)) {
    await page.locator('.vv-right-toggle').click(); // 关右抽屉还内容区
  }

  // UTF-16LE 带 BOM：编码段 utf-16le（修复前无任何编码显示）
  await openFile(page, 'utf16le.txt');
  await expect(page.locator('.vv-statusbar')).toContainText('编码: utf-16le');

  // gb18030（无 BOM 非 UTF-8）：编码段 gb18030
  await openFile(page, 'gb18030.txt');
  await expect(page.locator('.vv-statusbar')).toContainText('编码: gb18030');
});

test('BUG-04：媒体/图片状态栏按通用字段口径呈现（大小段，不再仅有「自动刷新不可用」）', async ({
  page
}) => {
  const png = await page.request.get('/manifest.webmanifest'); // 仅为确立 page 上下文；图片经本地 File 注入
  expect(png.status()).toBe(200);
  await page.goto('/');
  // 1x1 PNG（与 samples/m1/generate.mjs 同源 base64）
  await openDir(page, [
    {
      name: 'pixel.png',
      type: 'image/png',
      b64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    }
  ]);
  await openFile(page, 'pixel.png');
  await expect(page.locator('.vv-image img')).toBeVisible();
  await expect(page.locator('.vv-statusbar')).toContainText(/大小: \d+/);
  await openRightIfNarrow(page);
  await expect(page.locator('.meta-name')).toHaveText('pixel.png');
  await expect(page.locator('.meta-row', { hasText: '大小' })).toContainText(/字节/);
});

test('BUG-05/SHELL-09/13：设置面板排除规则预设生效，设置与开关持久化', async ({ page }) => {
  await page.goto('/');
  await openDir(page, [
    { name: '.git/HEALTH.txt', type: 'text/plain', content: 'x\n' },
    { name: 'node_modules/left-pad/index.js', type: 'text/javascript', content: 'x\n' },
    { name: 'src/keep.txt', type: 'text/plain', content: 'keep\n' }
  ]);
  await expect(page.locator('.vv-tree-row', { hasText: '.git' })).toBeVisible();
  await expect(page.locator('.vv-tree-row', { hasText: 'node_modules' })).toBeVisible();

  // 入口①：⚙ 按钮（修复前全量按钮穷举无一相关）
  await page.locator('button[aria-label="设置"]').click();
  const panel = page.locator('.vv-settings');
  await expect(panel).toBeVisible();

  // 预设一键加入 → 树即时重建（onSettingsChanged 订阅 + {#key} 通道）
  await panel.locator('button[aria-label="加入预设排除规则 .git"]').click();
  await panel.locator('button[aria-label="加入预设排除规则 node_modules"]').click();
  await expect(page.locator('.vv-tree-row', { hasText: '.git' })).toHaveCount(0);
  await expect(page.locator('.vv-tree-row', { hasText: 'node_modules' })).toHaveCount(0);
  // 树懒加载：展开 src 后确认保留文件仍在（移动端树在抽屉内，经 drawer 适配点击）
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'src' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tree-row', { hasText: 'keep.txt' })).toBeVisible();

  // 单键对象 vviewer:settings 落盘（域文档 4.3 边界 3 口径）
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}')
  );
  expect(saved.excludedPatterns).toEqual(expect.arrayContaining(['.git', 'node_modules']));

  // 自动刷新开关：关闭 → autoRefresh:false 落盘；重开面板状态回显
  await panel.locator('.vv-settings-toggle input[type="checkbox"]').uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}').autoRefresh)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.locator('button[aria-label="设置"]').click();
  await expect(panel.locator('.vv-settings-toggle input[type="checkbox"]')).not.toBeChecked();
  await page.keyboard.press('Escape');

  // 手动刷新按钮入口存在（BUG-05 验收 4 的 UI 前提；行为级验证在服务端模式 spec）
  await expect(page.locator('button[aria-label="刷新当前文件"]')).toBeVisible();

  // 持久化：刷新后设置面板仍带排除规则与关闭的开关（本地 File 会话不跨刷新，树级验证走服务端模式 spec）
  await page.reload();
  await page.locator('button[aria-label="设置"]').click();
  await expect(page.locator('.vv-settings-pattern', { hasText: '.git' })).toBeVisible();
  await expect(page.locator('.vv-settings-toggle input[type="checkbox"]')).not.toBeChecked();

  // 入口②：Ctrl+comma 开合（面板打开即聚焦其输入框——inField 守卫下需先 blur 才能再次接管）
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+,');
  await expect(page.locator('.vv-settings')).toBeVisible();
  await page.locator('.vv-shell').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('Control+,');
  await expect(page.locator('.vv-settings')).toHaveCount(0);
});

test('BUG-07/SHELL-03/05：无扩展名文件可预览（shebang→python、Makefile），.xyz 兜底不回退', async ({
  page
}) => {
  test.setTimeout(60_000);
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto('/');
  const py = '#!/usr/bin/env python3\nvalue = 42\nprint(f"v={value}")\n';
  await openDir(page, [
    { name: 'shebang-py', type: 'text/plain', content: py },
    { name: 'control.py', type: 'text/plain', content: py },
    { name: 'Makefile', type: 'text/plain', content: 'all:\n\techo hi\n\n.PHONY: all\n' },
    { name: 'unknown.xyz', type: 'text/plain', content: 'data\n' }
  ]);

  // 无扩展名 + shebang：不再被「不支持的扩展名 "."」拒绝，识别 python（同内容 .py 对照一致）
  await openFile(page, 'shebang-py');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-statusbar')).toContainText('语言: python');
  // python grammar 在 gen:grammars lite 集内 → tree-sitter 主路径（hljs 兜底同类名亦可辨引擎）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({ timeout: 20_000 });

  await openFile(page, 'control.py');
  await expect(page.locator('.vv-statusbar')).toContainText('语言: python');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 无扩展名无 shebang（Makefile）：文本性探测 → code 视图，非错误卡片
  await openFile(page, 'Makefile');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre')).toContainText('echo hi');
  await expect(page.locator('.vv-statusbar')).toContainText('编码: utf-8');

  // 回归不破坏（BUG-07 验收 4 / SHELL-05 已 pass 项）：真未知类型 .xyz 兜底不变
  await openFile(page, 'unknown.xyz');
  await expect(page.locator('.vv-error-card')).toBeVisible();
  await expect(page.locator('.vv-error-card')).toContainText('不支持的扩展名 ".xyz"');
  expect(errors).toEqual([]);
});

test('BUG-19/25/SHELL-01/08：打开文件夹两通道均有可见反馈（取消提示），回退通道可达', async ({
  page
}) => {
  test.setTimeout(60_000);
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );

  // 通道① FS Access（headless 立即 AbortError）：点击 → 弹出选择器调用 → 取消有提示（BUG-19 修复行为）
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const orig = (w.showDirectoryPicker as (o?: unknown) => Promise<FileSystemDirectoryHandle>).bind(w);
    w.__vvPickerCalls = 0;
    w.showDirectoryPicker = (o?: unknown) => {
      w.__vvPickerCalls = ((w.__vvPickerCalls as number) ?? 0) + 1;
      return orig(o);
    };
  });
  await page.getByRole('button', { name: '打开文件夹' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __vvPickerCalls?: number }).__vvPickerCalls))
    .toBe(1);
  await expect(page.locator('.vv-statusbar')).toContainText('已取消选择文件夹', { timeout: 10_000 });

  // 通道② 非 FS Access 回退（BUG-25 验收方法：hook createElement、延迟 ≥500ms 读后置属性）
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.showDirectoryPicker = undefined; // 模拟缺失（typeof 判定不再为 function）
    w.__vvFileInputs = [] as HTMLInputElement[];
    const orig = document.createElement.bind(document);
    document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
      const el = orig(tag, opts);
      if (tag.toLowerCase() === 'input') {
        (w.__vvFileInputs as HTMLInputElement[]).push(el as HTMLInputElement);
      }
      return el;
    }) as typeof document.createElement;
  });
  await page.getByRole('button', { name: '打开文件夹' }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              (window as unknown as { __vvFileInputs?: HTMLInputElement[] }).__vvFileInputs ?? []
            ).filter((i) => i.type === 'file').length
        ),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);
  // 属性后置设置：等待而非创建即读（BUG-25 复核教训）
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const inputs = (
            (window as unknown as { __vvFileInputs?: HTMLInputElement[] }).__vvFileInputs ?? []
          ).filter((i) => i.type === 'file');
          return inputs.length > 0 && inputs[inputs.length - 1].webkitdirectory === true;
        }),
      { timeout: 10_000 }
    )
    .toBe(true);
  // input.click() 被调用：headless 自动 cancel → 状态栏再次提示（无静默、无 JS 错误）
  await expect(page.locator('.vv-statusbar')).toContainText('已取消选择文件夹', { timeout: 10_000 });
  expect(errors).toEqual([]);
});
