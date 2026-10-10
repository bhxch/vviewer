import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * binary-hex-archive 域覆盖缺口补强（t- 前缀：本轮新增，不改既有文件）。
 * 场景来源：docs/e2e/binary-hex-archive.md 第 3 节验收判据，补既有覆盖的弱断言：
 * - BIN-01 验收③：sample.bin(4129B) 末偏移与文件实际大小吻合（0x1020；首行三列/PNG
 *   签名 m4.spec.ts 已断言，不重复）
 * - BIN-02 期望③④：3MB 口径末行 0x2ffff0 + 回滚再滚动行内容稳定无白屏（1MB 口径与
 *   虚拟化结构证据 fix-pwa.spec.ts:159 已断言；BUG-16 性能预算按域档 §4.3.7 不自动化）
 * - BIN-03 验收②：IHDR height=8（width=32 m4.spec.ts 已断言；samples/m4/sample.bin
 *   即 IHDR width=32/height=8 的 PNG 改名件，xxd 实测偏移 0x10 处 00000020 00000008）
 * - BIN-05：zip 条目树与 unzip -l 逐项一致（sample.zip 共 7 条目，既有断言缺
 *   nested/inner.zip）
 * 通道同 m4/b-：页面内构造 File 经 __vvOpenDirImpl 注入（偏差 #7 压缩包前端本地解包）。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function openDir(page: Page, files: Array<{ name: string; type: string; bytes: Uint8Array }>): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `tbin/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 展开压缩包树内目录（details summary 首次展开懒加载子项），同 m4 惯例 */
async function expandArchiveDir(page: Page, dir: string): Promise<void> {
  await page.locator('.vv-archive summary.vv-tree-row', { hasText: dir }).click();
}

/** hex 虚拟滚动容器滚到顶/底（.vv-hex-dump 自身滚动，hex.ts:63-70） */
async function scrollHexDump(page: Page, to: 'top' | 'bottom'): Promise<void> {
  await page.locator('.vv-hex-dump').evaluate((el, dir) => {
    el.scrollTop = dir === 'bottom' ? el.scrollHeight : 0;
  }, to);
}

/** 末行行首偏移（16 字节/行，8 位十六进制），同 fix-pwa 口径 */
async function lastHexRowOffset(page: Page): Promise<string> {
  return page.locator('.vv-hex-dump').evaluate((el) => {
    const rows = el.querySelectorAll('.vv-hex-row');
    return rows.length > 0 ? (rows[rows.length - 1] as HTMLElement).textContent!.slice(0, 8) : '';
  });
}

test('BIN-01：sample.bin hex 三列视图滚动到底，末偏移与 4129 字节吻合(0x1020)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const bytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.bin`));
  expect(bytes.length).toBe(4129);
  await openDir(page, [{ name: 'sample.bin', type: 'application/octet-stream', bytes }]);
  await openFile(page, 'sample.bin');

  // 首行在位（三列逐字节断言见 m4.spec.ts），滚到底：末行行首 = floor(4128/16)*16 = 0x1020
  await expect(page.locator('.vv-hex-dump .vv-hex-row').first()).toBeVisible();
  await scrollHexDump(page, 'bottom');
  await expect.poll(() => lastHexRowOffset(page), { timeout: 10_000, message: '等待滚动到底后的末行渲染' })
    .toBe('00001020');
});

test('BIN-02：3MB .bin 滚动到底即达末尾(0x2ffff0)，回滚再滚动行内容稳定无白屏', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const bytes = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xff;
  await openDir(page, [{ name: 'random-3mb.bin', type: 'application/octet-stream', bytes }]);
  await openFile(page, 'random-3mb.bin');
  const dump = page.locator('.vv-hex-dump');

  // ① 滚动到底即达数据末尾（无续读步骤）：196,608 行整，末行起始 0x2ffff0、行内覆盖至末字节
  await expect(dump.locator('.vv-hex-row').first()).toBeVisible();
  await scrollHexDump(page, 'bottom');
  await expect.poll(() => lastHexRowOffset(page), { timeout: 10_000, message: '等待首次滚动到底的末行' })
    .toBe('002ffff0');
  const lastRowText = await dump.locator('.vv-hex-row').last().textContent();

  // ② 回滚到顶：首行偏移 00000000（无白屏——行内容即时重渲染）
  await scrollHexDump(page, 'top');
  await expect
    .poll(
      async () =>
        dump.evaluate((el) => {
          const rows = el.querySelectorAll('.vv-hex-row');
          return rows.length > 0 ? (rows[0] as HTMLElement).textContent!.slice(0, 8) : '';
        }),
      { timeout: 10_000, message: '等待回滚到顶后的首行渲染' }
    )
    .toBe('00000000');

  // ③ 再滚到底：末行偏移与行内容与首次一致（滚动续读行稳定）
  await scrollHexDump(page, 'bottom');
  await expect.poll(() => lastHexRowOffset(page), { timeout: 10_000, message: '等待再次滚动到底的末行' })
    .toBe('002ffff0');
  expect(await dump.locator('.vv-hex-row').last().textContent()).toBe(lastRowText);
});

test('BIN-03：PNG 改名 .bin 按内容 magic 识别结构树——IHDR width=32、height=8', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  // samples/m4/sample.bin 即「IHDR width=32、height=8 的 PNG 改名 .bin」样例
  // （xxd -l 32 实测：PNG 签名 + IHDR 数据 00000020 00000008）
  const bytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.bin`));
  await openDir(page, [{ name: 'png-as-bin.bin', type: 'application/octet-stream', bytes }]);
  await openFile(page, 'png-as-bin.bin');

  // 状态行按内容识别为 PNG（.bin 扩展名路由 hex 渲染器，识别发生在渲染器内 struct 解析）
  await expect(page.locator('.vv-hex-status')).toContainText('PNG');
  await page.locator('.vv-hex-struct > summary').click();
  await page.locator('.vv-hex-struct summary', { hasText: 'PNG' }).click();
  await page.locator('.vv-hex-struct summary', { hasText: 'IHDR' }).click();
  // 验收②：width/height 与结构解析一致（十进制，struct.ts:157-158）
  await expect(page.locator('.vv-hex-struct')).toContainText('width = 32');
  await expect(page.locator('.vv-hex-struct')).toContainText('height = 8');
});

test('BIN-05：zip 条目树与 unzip -l 逐项一致（7 条目含目录层级）', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  // unzip -l samples/m4/sample.zip：hello.txt / notes.md / nested/ / nested/inner.txt /
  // nested/inner.zip / nested/deep/ / nested/deep/n1.zip（本轮实跑核对）
  const bytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.zip`));
  await openDir(page, [{ name: 'sample.zip', type: 'application/zip', bytes }]);
  await openFile(page, 'sample.zip');
  const pane = page.locator('.vv-archive');

  // 根级 3 项：2 文件 + 1 目录
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible();
  await expect(pane.locator('.vv-tree-row', { hasText: 'notes.md' })).toBeVisible();
  await expect(pane.locator('summary.vv-tree-row', { hasText: 'nested' })).toBeVisible();

  // nested/ 下 3 项：2 文件 + 1 目录（inner.zip 为既有覆盖缺口项）
  await expandArchiveDir(page, 'nested');
  await expect(pane.locator('.vv-tree-row', { hasText: 'inner.txt' })).toBeVisible();
  await expect(pane.locator('.vv-tree-row', { hasText: 'inner.zip' })).toBeVisible();
  await expect(pane.locator('summary.vv-tree-row', { hasText: 'deep' })).toBeVisible();

  // nested/deep/ 下 1 项
  await expandArchiveDir(page, 'deep');
  await expect(pane.locator('.vv-tree-row', { hasText: 'n1.zip' })).toBeVisible();
});

// （docs/e2e/README.md §3.2.4 第 4 条：修复合入前以 test.fixme 落占位并标注缺陷号，
// 修复 PR 中转正式断言。以下为本轮探索在 bin 域确认的新缺陷回归占位，仅追加。）
test.fixme(
  'BUG-55 [探索]: hex 虚拟滚动 spacer 单元素定高超 Chromium 元素高度上限——≈28.44MiB 以上 .bin 尾部不可达且滚到底停在错误偏移',
  async () => {
    // 现象（severity high）：hex 渲染器虚拟滚动以单元素 spacer 表达总行高
    // （packages/core/src/virtualScroller.ts:25 `spacer.style.height = rowCount*lineHeight px`；
    // rowCount=ceil(len/16)：packages/render-binary/src/hex.ts:76；行高 18px：hex.ts:12）。
    // 文件超过 ≈29,826,144B（33,554,428px÷18≈1,864,134 行×16B≈28.44MiB）后 spacer 声明
    // 高度超出 Chromium 单元素上限 33,554,428px 被钳制：滚动区间缩短，尾部数据任何滚动
    // 方式（程序化置底/滚轮循环到底均实测）不可达；且滚到底时视口末行停在中间偏移
    // （40MB 实测 0x01c71d10~0x01c71d20，真实末行应为 0x027ffff0），状态栏仅「40.0 MB ·
    // 未知二进制」无任何末偏移或截断提示，用户会误认为已到文件末尾——属「错误结果」+
    // 大文件尾部经唯一查看器彻底不可查看（40MB 尾部 12,116,704B≈28.9% 不可达；hex.ts 无
    // 偏移跳转输入，ViewerPane 的跳转仅文本搜索命中行、binary 域不适用，无替代通道）。
    // <28.44MiB 不受影响：28MB 对照组末行 0x01bffff0 与期望精确吻合、尾部 0 字节不可达。
    // 服务端数据完好（Range 请求末 16B 返回 206/16B），纯前端 UI 滚动域缺陷。违反
    // docs/e2e/binary-hex-archive.md:23 BIN-02 期望③「末行偏移与总大小吻合」与 :99 §4.3
    // 第 3 条「滚动到底即达数据末尾」（hex.ts:5 注释自述该语义）。
    //
    // 最小复现：
    //   1) .temp/explore/bin/data/ 备 big-40mb.bin（41,943,040B 确定性伪随机，生成器
    //      apps/web/.temp/explore-bin/make-data.mjs）；
    //   2) 起实例（server/target/release/vviewer serve --root .temp/explore/bin/data
    //      --web-dist apps/web/build --port 8441）并页内「连接服务器」接入；
    //   3) 点击 big-40mb.bin 打开 hex 视图；
    //   4) 滚到底（程序化 scrollTop=scrollHeight 或滚轮循环到底均可）→ 可视末行偏移停在
    //      0x01c71d10~0x01c71d20，而真实末行应为 0x027ffff0；
    //   5) 对照 28MB 文件同步骤末行 0x01bffff0 正确吻合。
    //
    // 证据（探索复核自起实例复现，复核完实例已关闭；独立脚本 /tmp/cand-bin-e1/verify.mjs，
    // Playwright chromium 1440×900、页内「连接服务器」接入）：
    //   - 根因坐实：空白页设 div height:47185920px（=2,621,440 行×18px）实测
    //     offsetHeight=33554428（Chromium 单元素上限钳制）；40MB 页面内 spacer style 属性
    //     实测 'height: 4.71859e+07px;'（CSSOM 科学计数法序列化）、offsetHeight 同为
    //     33554428；
    //   - big-28mb.bin（29,360,128B）{spacerOffsetH:33030144, clamped:false, 末行
    //     0x01bffff0=期望, unreachableTailBytes:0}；big-30mb.bin {spacerOffsetH:33554428,
    //     clamped:true, 末行 0x01c71d10、期望 0x1dffff0, unreachable:1,630,944}；
    //     big-40mb.bin 程序化置底 {scrollTop:33553652, scrollHeight:33554432, 末行
    //     0x01c71d10、期望 0x27ffff0, unreachable:12,116,704}；
    //   - 用户交互通道复验：mouse.wheel 循环到底至 scrollTop 不再变化（33553656=
    //     maxScrollTop），末行 0x01c71d20≠0x27ffff0，tailUnreachableBytes:12,116,688；
    //   - 数据完整性对照：curl -H 'Range: bytes=41943024-41943039'
    //     '/api/file?path=big-40mb.bin' → 206、16 字节，服务端尾部完好，纯属 UI 滚动域问题；
    //   - 阈值复核：33,554,428/18≈1,864,134 行×16B≈29,826,144B，与报告的 ≈28.44MiB 边界
    //     吻合；28MB（29,360,128B）未触发、30MB 触发，实测与推算一致。
    //
    // 转正提示：修复 PR 中转正式断言，口径沿 BIN-02 期望③——构造 >28.44MiB 的 .bin
    // （如 40MB）打开后滚到底，可视末行偏移须等于真实末行（floor((size-1)/16)*16 的 8 位
    // 十六进制，40MB 时 '027ffff0'，同本文件 lastHexRowOffset 口径）；或 spacer 改分块/
    // 上限保护后按等效口径断言「滚动到底即达数据末尾」。护栏：<28.44MiB 行为不回归
    // （本文件 BIN-01/BIN-02 已覆盖 4KB/3MB 口径）。
  }
);
