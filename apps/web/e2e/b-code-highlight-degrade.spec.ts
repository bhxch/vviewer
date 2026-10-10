import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-code-highlight-degrade E2E（code-highlight-degrade 域补齐，2026-10-09 缺陷修复批次回归；
 * 阶段 4 统一懒高亮改写——>2MB 一律可视区懒高亮 chunk，不再有 hljs-block 分块路径）。
 * 场景来源：docs/e2e/code-highlight-degrade.md——
 * - BUG-07（HL-05）：无扩展名文件不再被「不支持的扩展名 "."」拒绝，shebang 识别进入预览；
 * - BUG-04（HL-06/07 前端口径）：状态栏元数据段（编码/大小/行）随实例渲染展示；
 * - BUG-20（HL-04，阶段 4 反转）：>20MB 文件不再纯文本降级——可视区懒高亮提示条出现
 *   且不阻断，滚动出现 tree-sitter chunk 着色，行号不回退；
 * - HL-03：3MB lazy chunk 路径滚动位置/行内容/语法着色零错位；
 * - HL-09：>2MB lazy chunk 解析中切 tab 取消（cancelAll 只逐出在-flight，不落 hljs 兜底）；
 * - HL-11：约 2MB（≤2MB 整文件 tree-sitter 路径）解析期交互响应（宽松阈值防抖动）；
 * - PERF-LAZY：25MB 懒高亮性能锚点（首屏纯文本 <1s、滚动后 2s 内 chunk 着色、滚动无长任务）。
 * BUG-06 主路径护栏已由 fix-pwa.spec.ts 覆盖，此处不重复。
 * 通道同 m1-m3：页面内 File + webkitRelativePath 经 __vvOpenDirImpl 注入（本地 store）。
 */

interface FilePayload {
  name: string;
  type: string;
  content: string | Uint8Array;
}

/** HL-05 载体：无扩展名 shebang-py（首行 #!/usr/bin/env python3）与同内容 .py 对照副本 */
const SHEBANG_PY = '#!/usr/bin/env python3\ndef greet(name):\n    return f"hello {name}"\n\nprint(greet("vviewer"))\n';

/** HL-05 附带：无扩展名非 shebang 文件（文本性探测路径，同 BUG-07 回退链） */
const MAKEFILE = 'all: build\n\nbuild:\n\techo done\n';

/** HL-06 载体：「中文内容」的 GB18030 字节（与 GBK 双字节区兼容，硬编码避免依赖 ICU Buffer） */
const GB18030_BYTES = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd]);

/** HL-07 载体：UTF-16LE BOM + 「《中文》\n」——BOM 消费后首字符码点 12298（域文档实测口径） */
const UTF16LE_BYTES = (() => {
  const text = '\u300A\u4E2D\u6587\u300B\n';
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return bytes;
})();

async function openDir(page: Page, payloads: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const data =
        typeof content === 'string' ? content : new Uint8Array(content);
      const f = new File([data], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bhl/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  // 精确匹配（caret span 使行 textContent 带前导空白；shebang-py 与 shebang-py-verify.py
  // 存在前缀包含关系，子串 hasText 会撞 strict mode）
  await page
    .locator('.vv-tree-row')
    .filter({ hasText: new RegExp(`^\\s*${name.replace(/\./g, '\\.')}\\s*$`) })
    .click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

test('BUG-07：无扩展名 shebang-py 进入代码预览并识别为 python（不再报「不支持的扩展名」），Makefile 同链可预览', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'shebang-py', type: 'application/octet-stream', content: SHEBANG_PY },
    { name: 'shebang-py-verify.py', type: 'text/x-python', content: SHEBANG_PY },
    { name: 'Makefile', type: 'application/octet-stream', content: MAKEFILE }
  ]);

  // 缺陷态：直接渲染错误页「无法预览此文件 / 不支持的扩展名 "."」，语言识别未发生
  await openFile(page, 'shebang-py');
  const code = page.locator('.vv-code-pre');
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-main')).not.toContainText('不支持的扩展名');
  // shebang 检测发生且被 code 渲染器消费（det.lang → getMeta.lang → 状态栏语言段）
  await expect(page.locator('.vv-statusbar')).toContainText('语言: python', { timeout: 20_000 });
  // 代码内容真实渲染（预览而非空壳），并获语法着色（tree-sitter 或 hljs 任一引擎）
  await expect(code).toContainText('greet');
  await expect(code.locator('span[class^="ts-"], span[class^="hljs-"]').first()).toBeVisible({
    timeout: 20_000
  });

  // 对照组：同内容 .py 副本正常渲染（缺陷态亦通过，回归不得引入回退）
  await openFile(page, 'shebang-py-verify.py');
  await expect(page.locator('.vv-code-pre').last()).toContainText('greet', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 同根因通用表现（app-shell-sources SHELL-03）：Makefile 等无扩展名文件同样不再被扩展名派发拦截
  await openFile(page, 'Makefile');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-main')).not.toContainText('不支持的扩展名');
});

test('BUG-04：状态栏元数据段展示编码/大小/行——gb18030 与 UTF-16LE(BOM) 解码正确且编码值如实', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'gb18030.txt', type: 'text/plain', content: GB18030_BYTES },
    { name: 'utf16le-cn.txt', type: 'text/plain', content: UTF16LE_BYTES }
  ]);

  // HL-06：GB18030 中文解码渲染正常，状态栏编码段如实（前端口径；服务端 x-vv-encoding 对照在 e2e-server）
  await openFile(page, 'gb18030.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('中文内容', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('编码: gb18030', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('大小: 8'); // 缺陷态四字段全为条件占位不渲染
  await expect(page.locator('.vv-statusbar')).toContainText('行: 1');

  // HL-07：UTF-16LE BOM 消费正确（首渲染字符码点 12298《），正文无 BOM 乱码，状态栏编码 utf-16le
  await openFile(page, 'utf16le-cn.txt');
  await expect(page.locator('.vv-statusbar')).toContainText('编码: utf-16le', { timeout: 20_000 });
  const firstCharCode = await page.evaluate(() => {
    const body = document.querySelector('.vv-code-pre .vv-code-line .vv-code-body');
    return body?.textContent ? body.textContent.codePointAt(0) : null;
  });
  expect(firstCharCode).toBe(12298); // 0x300A 《——BOM 已消费（缺陷态同值，回归不回退）
  await expect(page.locator('.vv-code-pre')).toContainText('中文');
});

test('BUG-20（阶段 4 反转）：>20MB 文件可视区懒高亮——提示条出现不阻断、滚动 tree-sitter chunk 着色、末行行号吻合、切走重开提示仍在', async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  // 338,770 行 × 72B = 24,391,440B ≈ 23.3MiB ∈ (20MB, 200MB] → lazy + >20MB 提示条。
  // 行文本自带行号供比对；旧契约（>20MB 纯文本降级零高亮）已反转（spec §5.4）
  const ROWS = 338_770;
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  // 24MB 内容在页内构造（经 evaluate 传参会翻倍内存）
  await page.evaluate((rows) => {
    const mk = (name: string, content: string): File => {
      const f = new File([content], name, { type: 'text/javascript' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bhl/${name}` });
      return f;
    };
    const no6 = (n: number): string => String(n).padStart(6, '0');
    // 行长恒 72B（两处行号都定宽）：字节数恰 rows×72-1，稳超 HLJS_MAX_BYTES(20MiB)
    const row = (no: number): string => `const row${no6(no)} = '${'x'.repeat(40)}'; // ${no6(no)}\n`;
    // 去掉末尾换行：末行不带 \n → 行数（渲染与 wc 口径）一致为 rows，末行有内容可断言着色
    const content = Array.from({ length: rows }, (_, i) => row(i)).join('').slice(0, -1);
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([
      mk('tiny-switch.txt', 'switch target\n'), // 切走重开的中转件
      mk('big-24mb.js', content)
    ]);
  }, ROWS);
  await openFile(page, 'big-24mb.js');

  // 打开即见提示条（文案含阈值与懒高亮说明），且首屏纯文本先行渲染不被阻断
  const notice = page.locator('.vv-code-oversize-card');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText('20MB');
  await expect(notice).toContainText('懒高亮');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 10_000 });
  // BUG-04 行段与 wc 口径一致（末行带 \n，行数恰 ROWS）
  await expect(page.locator('.vv-statusbar')).toContainText(`行: ${ROWS}`, { timeout: 20_000 });
  // 阶段 4 反转：可视区 chunk tree-sitter 着色到达（不再是 plain 零高亮）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });

  // 滚动到底：末行行号 = 338,770（提示条不阻断滚动；性能仅记录不作硬门）
  const pre = page.locator('.vv-code-pre');
  const t0 = Date.now();
  await pre.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const lastGutter = pre.locator('.vv-code-line').last().locator('.vv-code-gutter');
  await expect
    .poll(async () => lastGutter.textContent(), {
      timeout: 30_000,
      message: '等待滚动到底后的末行渲染'
    })
    .toBe(String(ROWS));
  console.log(`[perf] 24MB 滚动到底耗时: ${Date.now() - t0}ms（宽松记录，不作硬门）`);
  // 末视口 chunk 同样着色到达（懒高亮对任意可视区生效）
  await expect(pre.locator('.vv-code-line').last().locator('span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });

  // 提示条持久（滚动后仍在，非一次性 toast 已消失的形态）
  await expect(notice).toBeVisible();

  // 切走再重开：提示条再次可观察（缺陷态「重开 1.3s 时点」亦无文案）
  await openFile(page, 'tiny-switch.txt');
  await openFile(page, 'big-24mb.js');
  await expect(page.locator('.vv-code-oversize-card')).toBeVisible({ timeout: 30_000 });
});

test('HL-03：3MB lazy chunk 路径滚动 50%/75%/100% 行号/行内容/语法着色零错位', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // 48,000 行 × 62B ≈ 3.0MB ∈ (2MB, 200MB] → 可视区懒高亮 chunk + 虚拟滚动；
  // 行文本自带行号供比对；行行含 const 关键字 → 着色到达后行行有 ts-* span
  const ROWS = 48_000;
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((rows) => {
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const no = String(i).padStart(6, '0');
      lines.push(`const row${no} = '${'x'.repeat(30)}'; // ${no}`);
    }
    const f = new File([lines.join('\n') + '\n'], 'scroll-3mb.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bhl/scroll-3mb.js' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, ROWS);
  await openFile(page, 'scroll-3mb.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();
  // 首视口 chunk 着色到达（lazy 管线先纯文本后增量着色）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 20_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });

  const pre = page.locator('.vv-code-pre');
  // 50%/75%/100% 三处：首可见行的行号应与 scrollTop/行高(20px) 推算一致，文本行号自洽，
  // 且该行语法着色同步到达（行 HTML 与 chunk 缓存零错位——着色缺失/错行都判负）
  for (const ratio of [0.5, 0.75, 1]) {
    await pre.evaluate(
      (el, { ratio, rows }) => {
        el.scrollTop = ratio === 1 ? el.scrollHeight : (rows - 1) * 20 * ratio;
      },
      { ratio, rows: ROWS }
    );
    await expect
      .poll(
        async () =>
          pre.evaluate(() => {
            const first = document.querySelector('.vv-code-pre .vv-code-line');
            if (!(first instanceof HTMLElement)) return false;
            // 行号与文本行号自洽（不重复不丢行）：首可见行 data-line 与内容中行号一致
            const line = Number(first.dataset.line);
            const no = String(line).padStart(6, '0');
            const text = first.textContent ?? '';
            return (
              text.includes(`row${no}`) &&
              text.includes(`// ${no}`) &&
              first.querySelector('span[class^="ts-"]') !== null
            );
          }),
        { timeout: 20_000, message: `等待 ${ratio * 100}% 处渲染稳定（含 chunk 着色到达）` }
      )
      .toBe(true);
  }
});

test('HL-09：>2MB lazy chunk 解析中切 tab——cancelAll 取消只逐出不落兜底，切回 chunk 重发正常着色', async ({
  page
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('/');
  await openDir(page, [
    {
      name: 'big3m.ts',
      type: 'text/typescript',
      content: 'const vv = 1; // c\n'.repeat(160_000) // ≈3.0MB > 2MiB → lazy chunk 路径
    },
    { name: 'tiny.txt', type: 'text/plain', content: 'tiny marker\n' }
  ]);

  // 发起打开 3MB（lazy chunk 请求在途）后不等待，立即切另一文件（缺陷场景的竞态窗口；
  // tab 切换 cancelHighlight → cancelAll，chunk 以 HighlightCanceledError 结束——
  // 只逐出在-flight、不写行级 hljs 兜底、无重试风暴）。mobile 视口树行在抽屉内：
  // 先开抽屉连点两行再关（drawer.ts 惯例）
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'big3m.ts' }).click();
  await page.locator('.vv-tree-row', { hasText: 'tiny.txt' }).click();
  await closeDrawerIfOpened(page, drawer);

  // 新文件正常渲染，无错误卡片、无页面异常
  await expect(page.locator('.vv-tab.active', { hasText: 'tiny.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('tiny marker', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 切回大文件 tab：chunk 重发正常着色（tree-sitter span 到达），无残留错误卡片，
  // 且零 hljs span——取消≠失败的硬约束（取消的 chunk 不得落 hljs 兜底遮蔽质量）
  await openFile(page, 'big3m.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('HL-11：约 2MB 解析期间 UI 交互保持毫秒级响应（宽松阈值 100ms 防环境抖动）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openDir(page, [
    {
      name: 'big2m-b.ts',
      type: 'text/typescript',
      content: 'const vv = 1; // c\n'.repeat(100_000)
    }
  ]);
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'big2m-b.ts' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-code-pre').first()).toBeVisible({ timeout: 20_000 });

  // 解析期（tree-sitter worker 高亮在途）：页内同步点击树行/查看区，测同步 handler 耗时。
  // 报告实测 1ms；共享机器存在外部负载，按域纪律放宽到 100ms，仅拦截「主线程被解析冻结」
  const cost = await page.evaluate(() => {
    const target = document.querySelector('.vv-tab.active');
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    return performance.now() - t0;
  });
  console.log(`[perf] 解析期 10 次交互 dispatch 总耗时: ${cost.toFixed(1)}ms`);
  expect(cost).toBeLessThan(100);

  // 解析正常完成（用例收尾即 HL-11 的「不冻结」最终证据）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 60_000
  });
});

test('PERF-LAZY：25MB 文件懒高亮性能锚点——首屏纯文本 <1s、跳滚后 2s 内 chunk 着色、滚动期无长任务', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '25MB 级性能锚点仅桌面基准跑（域文档 4.4，THEME-03/06 前例）');
  test.setTimeout(180_000);
  await page.goto('/');
  // 19B × 1,315,789 ≈ 25MB ∈ (20MB, 200MB] → lazy + >20MB 提示条；行行同构避免转义噪音
  const ROWS = 1_315_789;
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((rows) => {
    const f = new File(['const vv = 1; // c\n'.repeat(rows)], 'perf-25mb.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bhl/perf-25mb.js' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, ROWS);

  // 锚点 1：首屏纯文本首帧 < 1s（打开点击 → 首行渲染；解码+行索引 25MB 的同步成本在此内）
  const t0 = Date.now();
  await page.locator('.vv-tree-row', { hasText: 'perf-25mb.js' }).click();
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 20_000 });
  const firstFrame = Date.now() - t0;
  console.log(`[perf] 25MB 首屏纯文本首帧: ${firstFrame}ms（锚点 <1000ms，spec §5.4）`);
  expect(firstFrame, '25MB 首屏纯文本首帧（懒高亮不阻塞首帧的锚点）').toBeLessThan(1000);

  // 首视口 chunk 着色到达后装长任务观测（首帧前的解码/索引长任务不属滚动窗口）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await page.evaluate(() => {
    const w = window as unknown as { __vvLongTasks?: number };
    w.__vvLongTasks = 0;
    new PerformanceObserver((list) => {
      w.__vvLongTasks = (w.__vvLongTasks ?? 0) + list.getEntries().length;
    }).observe({ type: 'longtask' });
  });

  // 锚点 2：跳滚到未读区后 2s 内 tree-sitter chunk 着色出现（懒高亮追滚动预算）
  const pre = page.locator('.vv-code-pre');
  const TARGET = 1_100_000;
  const t1 = Date.now();
  await pre.evaluate((el, line) => {
    el.scrollTop = line * 20;
  }, TARGET);
  await expect(
    pre.locator(`[data-line="${TARGET}"] span[class^="ts-"]`).first()
  ).toBeVisible({ timeout: 2_000 });
  const chunkArrival = Date.now() - t1;
  console.log(`[perf] 25MB 跳滚 110 万行后 chunk 着色到达: ${chunkArrival}ms（锚点 <2000ms）`);
  expect(chunkArrival, '跳滚后 chunk 着色到达（懒高亮追滚动锚点）').toBeLessThan(2000);

  // 锚点 3：滚动连发期间主线程无长任务（chunk 解析在 worker、fillRows 毫秒级）
  for (const line of [200_000, 400_000, 600_000, 800_000, 1_000_000, 1_200_000]) {
    await pre.evaluate((el, l) => {
      el.scrollTop = l * 20;
    }, line);
    await page.waitForTimeout(120);
  }
  const longTasks = await page.evaluate(
    () => (window as unknown as { __vvLongTasks?: number }).__vvLongTasks ?? -1
  );
  console.log(`[perf] 25MB 滚动连发 longtask 数: ${longTasks}（锚点 0）`);
  expect(longTasks, '滚动期间主线程无 >50ms 长任务（解析不占主线程的锚点）').toBe(0);

  // 滚动全程提示条常驻不阻断（连发后仍可观察）
  await expect(page.locator('.vv-code-oversize-card')).toContainText('懒高亮');
});
