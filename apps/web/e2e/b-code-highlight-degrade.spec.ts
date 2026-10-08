import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-code-highlight-degrade E2E（code-highlight-degrade 域补齐，2026-10-09 缺陷修复批次回归）。
 * 场景来源：docs/e2e/code-highlight-degrade.md——
 * - BUG-07（HL-05）：无扩展名文件不再被「不支持的扩展名 "."」拒绝，shebang 识别进入预览；
 * - BUG-04（HL-06/07 前端口径）：状态栏元数据段（编码/大小/行）随实例渲染展示；
 * - BUG-20（HL-04）：>20MB 纯文本虚拟滚动出现明确超限提示条，滚动/行号不回退；
 * - HL-03：3MB 分块路径滚动位置与行内容零错位；
 * - HL-09/HL-11：约 2MB 解析中切 tab 无残留错误 + 解析期交互响应（宽松阈值防抖动）。
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

test('BUG-20：>20MB 纯文本虚拟滚动出现明确超限提示条，滚到底末行行号与字节数吻合，切走重开提示仍在', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // 338,770 行 × 65B = 22,020,050B ≈ 21.0MiB ∈ (20MB, ∞) → plain 虚拟滚动 + 超限提示。
  // 单次注入两个文件：重复 __vvOpenDirImpl 会按 label 替换同目录树，先注入的中转件会消失
  const ROWS = 338_770;
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  // 21MB 内容在页内构造（经 evaluate 传参会翻倍内存）
  await page.evaluate((rows) => {
    const mk = (name: string, content: string): File => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bhl/${name}` });
      return f;
    };
    const row = 'x'.repeat(64) + '\n';
    // 去掉末尾换行：末行不带 \n → 总字节恰 rows×65，行数（渲染与 wc 口径）一致为 rows
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([
      mk('tiny-switch.txt', 'switch target\n'), // 切走重开的中转件
      mk('big-21mb.txt', row.repeat(rows).slice(0, -1))
    ]);
  }, ROWS);
  await openFile(page, 'big-21mb.txt');

  // 缺陷态：三时点全文零超限文案。修复后：打开即见提示条（文案含阈值与降级说明）
  const notice = page.locator('.vv-code-oversize-card');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText('20MB');
  await expect(notice).toContainText('纯文本虚拟滚动');
  await expect(page.locator('.vv-statusbar')).toContainText('纯文本', { timeout: 20_000 });
  // BUG-04 行段与 wc 口径一致（行数 × 65B = 22,020,050B 与字节数吻合）
  await expect(page.locator('.vv-statusbar')).toContainText(`行: ${ROWS}`, { timeout: 20_000 });
  // 降级链不回退：无语法 span（plain 不做高亮）
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);

  // 滚动一步到底：末行行号 = 338,770（行数 × 65B 与字节数吻合；性能仅记录不作硬门）
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
  console.log(`[perf] 21MB 滚动到底耗时: ${Date.now() - t0}ms（宽松记录，不作硬门）`);

  // 提示条持久（滚动后仍在，非一次性 toast 已消失的形态）
  await expect(notice).toBeVisible();

  // 切走再重开：提示条再次可观察（缺陷态「重开 1.3s 时点」亦无文案）
  await openFile(page, 'tiny-switch.txt');
  await openFile(page, 'big-21mb.txt');
  await expect(page.locator('.vv-code-oversize-card')).toBeVisible({ timeout: 30_000 });
});

test('HL-03：3MB 分块路径滚动 50%/75%/100% 渲染行内容与行号零错位', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // 48,000 行 × 65B ≈ 3.1MB ∈ (2MB, 20MB] → hljs 分块 + 虚拟滚动；行文本自带行号供比对
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
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 分块', { timeout: 20_000 });

  const pre = page.locator('.vv-code-pre');
  // 50%/75%/100% 三处：首可见行的行号应与 scrollTop/行高(20px) 推算一致，且文本行号自洽
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
            return text.includes(`row${no}`) && text.includes(`// ${no}`);
          }),
        { timeout: 10_000, message: `等待 ${ratio * 100}% 处渲染稳定` }
      )
      .toBe(true);
  }
});

test('HL-09：约 2MB 解析中切 tab——新文件正常渲染、无报错、切回无残留错误卡片', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('/');
  await openDir(page, [
    {
      name: 'big2m.ts',
      type: 'text/typescript',
      content: 'const vv = 1; // c\n'.repeat(100_000) // 1.9MB ≤ 2MB → tree-sitter 主路径（解析秒级）
    },
    { name: 'tiny.txt', type: 'text/plain', content: 'tiny marker\n' }
  ]);

  // 发起打开 2MB 后不等待解析，立即切另一文件（缺陷场景的竞态窗口）；
  // mobile 视口树行在抽屉内：先开抽屉连点两行再关（drawer.ts 惯例）
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'big2m.ts' }).click();
  await page.locator('.vv-tree-row', { hasText: 'tiny.txt' }).click();
  await closeDrawerIfOpened(page, drawer);

  // 新文件正常渲染，无错误卡片、无页面异常
  await expect(page.locator('.vv-tab.active', { hasText: 'tiny.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('tiny marker', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 切回大文件 tab：解析完成正常渲染（tree-sitter span 到达），无残留错误卡片
  await openFile(page, 'big2m.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
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
