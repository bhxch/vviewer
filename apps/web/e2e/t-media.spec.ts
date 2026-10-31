import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { goodPng } from './png-fixture';

/**
 * t- 前缀：media-office-viewer 域缺口补齐（2026-10 缺口分析第二轮）。
 * 场景来源：docs/e2e/media-office-viewer.md（MEDIA-01~11）与 docs/e2e/README.md §3.2
 * 编号约定。既有覆盖不重写：b-media-office-viewer.spec.ts 已覆盖 MEDIA-01/02/03/05/
 * 06/07/11，m4.spec.ts 已覆盖 office 三件套行为；本文件只补缺口分析指出的弱断言与
 * 无编号用例（每条对应一个场景编号，标题以编号开头）：
 * - MEDIA-01 逐次断言 1.1×/0.9× 步进倍率（b- 仅断收敛终态 scale(10/0.1/1)，任何
 *   ≥1.1 的乘法步进都能通过；步进实现见 packages/vviewer-render-media/src/image.ts:39），
 *   并补「初始倍率 1×」记录与限位/复位复核；
 * - MEDIA-03 断言 readyState=4 与「video 元素出现耗时」（b- 仅断 err=0 + 推进或
 *   ended；m4 放宽为 loadedmetadata 或无 error；135ms 为报告域内实测参考值，
 *   CI 机器波动大，断言取 2s 宽松上限并打印实测值）；
 * - MEDIA-08 docx 正文 p 与源 document.xml 的 4 个 w:t 一一对照（m4 仅断 p=4 +
 *   首段文本；w:t 文本经 unzip -p samples/m4/sample.docx word/document.xml 实提）；
 * - MEDIA-09 多 sheet 页签切换逐格核对各 sheet 内容 + 250 行恰渲染前 200 行与精确
 *   截断提示（补编号化用例；源内容经 SheetJS 读 samples/m4/sample*.xlsx 实提，
 *   单元格文本 = cell.w ?? String(v)，见 packages/vviewer-render-doc/src/xlsx.ts:40）；
 * - MEDIA-10 提纲卡片页码齐全（.vv-pptx-slide-no「第 N 页」，pptx.ts:46-47）且各卡
 *   文本与源 slide XML 的 a:p 段落一一对照（m4 仅抽样断 2 卡片与两处文本）。
 * 通道同 m4/b-：页面内构造 File 经 __vvOpenDirImpl 注入（纯前端本地 store）；
 * 树行点击经 drawer.ts 适配 mobile project（375px 抽屉断点）。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
/** 样例与 m4 套件同源（samples/m4，tools/gen-samples.mjs 生成） */
const sampleOf = (name: string): Uint8Array => new Uint8Array(readFileSync(`${repoRoot}/samples/m4/${name}`));

interface SpecFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

async function openDir(page: Page, files: SpecFile[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `tmedia/${name}` });
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

/** 表格当前网格文本（行 × 单元格），供 xlsx 逐格对照 */
async function readGrid(page: Page): Promise<string[][]> {
  return page
    .locator('.vv-xlsx-sheet:not([hidden]) table tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')));
}

test('MEDIA-01：图片滚轮缩放逐次 1.1×/0.9× 步进倍率、上限 10×/下限 0.1×、双击复位 1×', async ({
  page
}) => {
  test.setTimeout(60_000);
  // 载体真 PNG（goodPng() 现地构造）：原 sample.bin 为 PNG 头+伪随机体（无 IDAT/IEND），
  // BUG-53 解码校验合入后被「图片解码失败」卡正确拒绝，不再可作正常图片载体
  await page.goto('/');
  await openDir(page, [{ name: 't-zoom.png', type: 'image/png', bytes: goodPng() }]);
  await openFile(page, 't-zoom.png');

  const img = page.locator('.vv-image img');
  await expect(img).toBeVisible();
  // attachZoom 把倍率写进 img.style.transform（image.ts:40）；未写时即初始 1×
  const readScale = (): Promise<number> =>
    img.evaluate((el) => {
      const m = /scale\(([\d.eE+-]+)\)/.exec(el.style.transform);
      return m ? Number(m[1]) : 1;
    });
  await expect.poll(readScale, { timeout: 5_000 }).toBe(1); // ① 初始倍率 1×

  // ② 逐次向上：每步严格 ×1.1（模板串十进制往返精确，容差仅防格式化边缘）
  let prev = await readScale();
  for (let i = 0; i < 3; i++) {
    await page.locator('.vv-image').dispatchEvent('wheel', { deltaY: -100 });
    const cur = await readScale();
    expect(Math.abs(cur - prev * 1.1)).toBeLessThan(Math.max(prev * 1.1 * 1e-9, 1e-12));
    prev = cur;
  }
  // 持续向上收敛到上限 10×（1.331×1.1^30 远超 10，Math.min 收口）
  for (let i = 0; i < 30; i++) {
    await page.locator('.vv-image').dispatchEvent('wheel', { deltaY: -100 });
  }
  await expect.poll(readScale, { timeout: 5_000 }).toBe(10);

  // ③ 逐次向下：每步严格 ×0.9（10 → 9 → 8.1 → 7.29）
  prev = await readScale();
  for (let i = 0; i < 3; i++) {
    await page.locator('.vv-image').dispatchEvent('wheel', { deltaY: 100 });
    const cur = await readScale();
    expect(Math.abs(cur - prev * 0.9)).toBeLessThan(Math.max(prev * 1e-9, 1e-12));
    prev = cur;
  }
  // 持续向下收敛到下限 0.1×（7.29×0.9^50 ≈ 0.038，Math.max 收口）
  for (let i = 0; i < 50; i++) {
    await page.locator('.vv-image').dispatchEvent('wheel', { deltaY: 100 });
  }
  await expect.poll(readScale, { timeout: 5_000 }).toBe(0.1);

  // ④ 双击复位 1×（偏差 #4：移动端捏合缩放未实现属裁决维持，不做捏合断言）
  await page.locator('.vv-image').dispatchEvent('dblclick');
  await expect.poll(readScale, { timeout: 5_000 }).toBe(1);
});

test('MEDIA-03：mp4 ArtPlayer 挂载、video readyState=4、播放推进', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 't-sample.mp4', type: 'video/mp4', bytes: sampleOf('sample.mp4') }]);
  const t0 = Date.now();
  await openFile(page, 't-sample.mp4');
  const video = page.locator('.vv-artplayer video');
  await video.waitFor({ state: 'attached', timeout: 20_000 });
  // 起播耗时：报告域内实测 ~135ms，为参考值非判据；CI 共享机波动大，断言 2s 宽松上限并记录实测
  const mountMs = Date.now() - t0;
  console.log(`[t-media] MEDIA-03 video 元素出现耗时 ${mountMs}ms（报告域内实测 ~135ms）`);
  expect(mountMs).toBeLessThan(2_000);
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });

  // 静音起播（无头无用户手势环境下的合规自动播放）
  await video.evaluate(async (el) => {
    const m = el as HTMLMediaElement;
    m.muted = true;
    await m.play();
  });
  // readyState=4（HAVE_ENOUGH_DATA）：blob 小文件全量缓冲（0.16s 样例）
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLMediaElement).readyState), {
      timeout: 15_000,
      message: '等待 video readyState=4'
    })
    .toBe(4);
  // 播放推进：0.16s 样例 currentTime > 0 或已播完（ended）均为推进证据
  await expect
    .poll(
      async () => {
        const s = await video.evaluate((el) => {
          const m = el as HTMLMediaElement;
          return { t: m.currentTime, ended: m.ended, err: m.error?.code ?? 0 };
        });
        return s.err === 0 && (s.t > 0 || s.ended);
      },
      { timeout: 15_000, intervals: [100, 250, 500] }
    )
    .toBe(true);
});

test('MEDIA-08：docx 正文 p 与源 document.xml 的 w:t 一一对应（数量/顺序/文本）', async ({ page }) => {
  test.setTimeout(60_000);
  // 源基准（2026-10-10 实提）：unzip -p samples/m4/sample.docx word/document.xml | grep -o '<w:t[^>]*>[^<]*</w:t>'
  // 恰 4 个 w:t，每个独立成段；mammoth 一段一 <p>（packages/vviewer-render-doc/src/docx.ts:37-43）
  const W_T_TEXTS = [
    'vviewer docx 样例',
    '此文件由 tools/gen-samples.mjs 手工构造为最小 OOXML 包（无 Word 依赖），供 E2E 与人工预览。',
    '列表项一',
    '列表项二'
  ];
  await page.goto('/');
  await openDir(page, [
    {
      name: 't-sample.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: sampleOf('sample.docx')
    }
  ]);
  await openFile(page, 't-sample.docx');

  const docx = page.locator('.vv-docx');
  await expect(docx).toBeVisible({ timeout: 20_000 });
  const ps = docx.locator('.vv-docx-content p');
  await expect(ps).toHaveCount(W_T_TEXTS.length, { timeout: 20_000 });
  const texts = await ps.evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
  expect(texts).toEqual(W_T_TEXTS); // 与源 w:t 顺序、文本完全一致
});

test('MEDIA-09：xlsx 多 sheet 页签切换逐格核对 + 250 行仅渲染前 200 行与截断提示', async ({ page }) => {
  test.setTimeout(90_000);
  // 源基准（2026-10-10 实提，SheetJS 读 samples/m4/sample*.xlsx）：
  // sample.xlsx 两 sheet——清单 A1:C3、汇总 A1:B3；sample-large.xlsx 单 sheet 大表 A1:C250
  // （表头 序号/名称/数量，数据行 n → [n, 项目 n, 2n]）。
  // 渲染：每 sheet 手动 <table>，单元格 textContent = cell.w ?? String(v)（xlsx.ts:40,63）；
  // 行截断 MAX_ROWS_PER_SHEET=200（xlsx.ts:13,57），提示条 xlsx.ts:69-81。
  await page.goto('/');
  await openDir(page, [
    {
      name: 't-sample.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: sampleOf('sample.xlsx')
    },
    {
      name: 't-large.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: sampleOf('sample-large.xlsx')
    }
  ]);

  // ① 多 sheet：页签名与顺序 + 切换后逐格核对各 sheet 内容（两 sheet 的 table 常驻
  // DOM、hidden 切换，可见 sheet 经 :not([hidden]) 取——同 m4.spec.ts 口径）
  await openFile(page, 't-sample.xlsx');
  const activeSheet = page.locator('.vv-xlsx-sheet:not([hidden])');
  await expect(activeSheet.locator('table')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-xlsx-tab')).toHaveCount(2);
  await expect(page.locator('.vv-xlsx-tab')).toHaveText(['清单', '汇总']);
  await expect.poll(() => readGrid(page), { timeout: 10_000 }).toEqual([
    ['名称', '数量', '单价'],
    ['苹果', '3', '5.2'],
    ['香蕉', '12', '2.8']
  ]);
  await page.locator('.vv-xlsx-tab', { hasText: '汇总' }).click();
  await expect.poll(() => readGrid(page), { timeout: 10_000 }).toEqual([
    ['季度', '营收'],
    ['Q1', '1024'],
    ['Q2', '2048']
  ]);

  // ② 250 行 > 200：精确截断提示 + 恰 200 行 + 截断边界两行内容（首数据行/末渲染行）
  await openFile(page, 't-large.xlsx');
  await expect(page.locator('.vv-xlsx-truncated')).toHaveText(
    '内容较长：共 250 行，仅显示前 200 行',
    { timeout: 20_000 }
  );
  await expect(activeSheet.locator('table tr')).toHaveCount(200);
  const largeGrid = await readGrid(page);
  expect(largeGrid[0]).toEqual(['序号', '名称', '数量']);
  expect(largeGrid[1]).toEqual(['1', '项目 1', '2']);
  expect(largeGrid[199]).toEqual(['199', '项目 199', '398']); // 源第 200 行 = 截断边界
});

test('MEDIA-10：pptx 提纲卡片页码齐全且文本与源 slide XML 一致', async ({ page }) => {
  test.setTimeout(60_000);
  // 源基准（2026-10-10 实提）：unzip -p samples/m4/sample.pptx ppt/slides/slide{1,2}.xml
  // 的 <a:p> 段落；extractSlideLines 一段一行（packages/vviewer-render-doc/src/pptxText.ts:35-45），
  // 卡片页码 head.textContent = `第 ${idx + 1} 页`（pptx.ts:46-47）。
  const SLIDE_LINES = [
    ['vviewer pptx 样例', '第一张幻灯片要点'],
    ['第二张', '要点 A', '要点 B']
  ];
  await page.goto('/');
  await openDir(page, [
    {
      name: 't-sample.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: sampleOf('sample.pptx')
    }
  ]);
  await openFile(page, 't-sample.pptx');

  const pptx = page.locator('.vv-pptx');
  await expect(pptx).toBeVisible({ timeout: 20_000 });
  const cards = pptx.locator('.vv-pptx-slide');
  await expect(cards).toHaveCount(SLIDE_LINES.length, { timeout: 20_000 });
  // 页码齐全：每张卡片带「第 N 页」
  for (const [i, lines] of SLIDE_LINES.entries()) {
    await expect(cards.nth(i).locator('.vv-pptx-slide-no')).toHaveText(`第 ${i + 1} 页`);
    const cardLines = await cards
      .nth(i)
      .locator('p')
      .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
    expect(cardLines).toEqual(lines); // 与源 slide XML 段落顺序、文本一致
  }
});

// ── 媒体与 Office 域探索复核确认缺陷回归（2026-10-10 轮）——已全部转正 ─────────────────
// README §3.2.4 第 4 条：修复合入前以 test.fixme 落占位，缺陷修复 PR 中转为正式断言。
// BUG-52（音频分支无 error 监听）/ BUG-53（图片解码失败无兜底）/ BUG-54（ArtPlayer 重连
// 清空 video.error 致文案映射不可达）三条根因均在本域 packages/vviewer-render-media 渲染链路，
// 产品修复已先后合入（音频 error 兜底、图片同步解码校验 throw、video:error 同步点缓存
// code），占位用例已转为正式断言（截断 mp3 / 垃圾 jpg / 截断 mp4 载体，经本文件页内
// File 注入装置构造，无需服务端实例）。原始现象/复现步骤/证据路径见缺陷库 BUG-52/53/54。

test('BUG-52：损坏音频解码失败 → 统一错误卡片（重试按钮）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  // 2026-10-10 探索复核缺陷回归：音频分支原只建 audio.vv-av 无 error 监听，audio.error
  // （code=4 demux 失败）后 UI 完全静默；修复 = 对齐视频分支挂 error → showErrorCard。
  // 载体：真 ID3 头（0x49 0x44 0x33）+ 垃圾字节，浏览器 demux 直接失败。
  await openDir(page, [
    { name: 'broken.mp3', type: 'audio/mpeg', bytes: new Uint8Array(300).map((_, i) => (i === 0 ? 0x49 : i === 1 ? 0x44 : i === 2 ? 0x33 : 0xba)) }
  ]);
  await openFile(page, 'broken.mp3');
  const card = page.locator('.vv-error-card');
  await expect(card, '音频解码失败出统一错误卡片（BUG-52 修复面）').toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.vv-error-detail')).toContainText('无法播放此媒体');
  await expect(card.locator('.vv-error-action', { hasText: '重试' })).toBeVisible();
});

test('BUG-53：损坏图片解码失败 → dispatcher 错误卡片（hex 排前），无残留裂图', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  // 2026-10-10 探索复核缺陷回归：image.ts 原 img.src 赋值后无 error 监听，解码失败仅裂图
  // +alt 文件名无卡片；修复 = render 后同步解码校验 throw 落 dispatcher 错误卡片。
  // 载体：JPEG 头 + NUL 填充——解码必败；含 NUL 判非文本（magic.ts:32，git 同口径），
  // open-as 排序落 hex 在前分支（纯 0xba 垃圾 suspicious=0 会被误判文本，不可用）。
  await openDir(page, [
    {
      name: 'broken.jpg',
      type: 'image/jpeg',
      bytes: new Uint8Array(512).map((_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : i === 2 ? 0xff : 0x00))
    }
  ]);
  await openFile(page, 'broken.jpg');
  const card = page.locator('.vv-error-card');
  await expect(card, '解码失败 throw → dispatcher 卡片').toBeVisible({ timeout: 30_000 });
  const labels = card.locator('.vv-error-action');
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(0), 'dispatcher 约定：重试恒首（排序只作用于 open-as 组内）').toHaveText('重试');
  await expect(labels.nth(1), '判非文本 → 「以 hex 打开」排「以纯文本打开」前（排序锚）').toHaveText('以 hex 打开');
  await expect(labels.nth(2)).toHaveText('以纯文本打开');
  await expect(page.locator('.vv-image'), '无残留裂图 img').toHaveCount(0);
});

test('BUG-54：video 运行期错误文案命中映射表（code=4 → MEDIA_ERR_SRC_NOT_SUPPORTED）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  // 2026-10-10 探索复核缺陷回归：ArtPlayer video:error 先 sleep 重连并重设源（清空
  //   video.error），av 回调读 art.video?.error 恒空 → 文案恒「未知错误」、映射表不可达；
  //   修复 = video:error 同步点缓存 code 供重连后的 emit(error) 取用。
  // 载体：真 mp4 截断 300B（moov 损坏，video error code=4），沿 b- 套件截断口径。
  const sample = sampleOf('sample.mp4');
  await openDir(page, [{ name: 'broken.mp4', type: 'video/mp4', bytes: sample.slice(0, 300) }]);
  await openFile(page, 'broken.mp4');
  const card = page.locator('.vv-error-card');
  // ArtPlayer video:error → 1s sleep 重连 → emit error：文案在卡片出现即查缓存表
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.vv-error-detail')).toContainText('MEDIA_ERR_SRC_NOT_SUPPORTED', { timeout: 30_000 });
});
