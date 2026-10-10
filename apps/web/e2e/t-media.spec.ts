import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * t- 前缀：media-office-viewer 域缺口补齐（2026-10 缺口分析第二轮）。
 * 场景来源：docs/e2e/media-office-viewer.md（MEDIA-01~11）与 docs/e2e/README.md §3.2
 * 编号约定。既有覆盖不重写：b-media-office-viewer.spec.ts 已覆盖 MEDIA-01/02/03/05/
 * 06/07/11，m4.spec.ts 已覆盖 office 三件套行为；本文件只补缺口分析指出的弱断言与
 * 无编号用例（每条对应一个场景编号，标题以编号开头）：
 * - MEDIA-01 逐次断言 1.1×/0.9× 步进倍率（b- 仅断收敛终态 scale(10/0.1/1)，任何
 *   ≥1.1 的乘法步进都能通过；步进实现见 packages/render-media/src/image.ts:39），
 *   并补「初始倍率 1×」记录与限位/复位复核；
 * - MEDIA-03 断言 readyState=4 与「video 元素出现耗时」（b- 仅断 err=0 + 推进或
 *   ended；m4 放宽为 loadedmetadata 或无 error；135ms 为报告域内实测参考值，
 *   CI 机器波动大，断言取 2s 宽松上限并打印实测值）；
 * - MEDIA-08 docx 正文 p 与源 document.xml 的 4 个 w:t 一一对照（m4 仅断 p=4 +
 *   首段文本；w:t 文本经 unzip -p samples/m4/sample.docx word/document.xml 实提）；
 * - MEDIA-09 多 sheet 页签切换逐格核对各 sheet 内容 + 250 行恰渲染前 200 行与精确
 *   截断提示（补编号化用例；源内容经 SheetJS 读 samples/m4/sample*.xlsx 实提，
 *   单元格文本 = cell.w ?? String(v)，见 packages/render-doc/src/xlsx.ts:40）；
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
  // sample.bin 本体即 PNG（IHDR 32×8，m4.spec 同源口径），改名为 .png 走图片渲染器
  await page.goto('/');
  await openDir(page, [{ name: 't-zoom.png', type: 'image/png', bytes: sampleOf('sample.bin') }]);
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
  // 恰 4 个 w:t，每个独立成段；mammoth 一段一 <p>（packages/render-doc/src/docx.ts:37-43）
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
  // 的 <a:p> 段落；extractSlideLines 一段一行（packages/render-doc/src/pptxText.ts:35-45），
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

// ── 媒体与 Office 域探索复核确认缺陷回归占位（2026-10-10 轮）──────────────────────────
// README §3.2.4 第 4 条：修复合入前以 test.fixme 落占位并在标题/注释标注缺陷号，缺陷修复
// PR 中转为正式断言。标题以缺陷库编号开头、[探索] 标注来源（缺陷由探索/复核会话独立复现
// 确认）；各用例注释给出最小复现步骤、证据路径与源码定位。分诊：三条均发现于媒体与 Office
// 域探索、根因均属本域（packages/render-media 渲染链路：av.ts 音频分支 / image.ts 图片 /
// av.ts 错误文案取值链），不外迁；BUG-54 虽牵涉 ArtPlayer 重连时序，但缺陷面与修复点在本域
// av.ts:476-478。转正时三条均可用本文件既有页内 File 注入装置构造截断/垃圾字节载体
// （音频/视频/图片渲染分支对本地 store 无 source 限制，av.ts:357-384、image.ts:57-72），
// 无需服务端实例。

test.fixme('BUG-52 [探索]：损坏音频解码失败后完全静默——audio 分支无 error 监听，无错误卡片与重试/降级（对照视频分支正常弹卡）', async () => {
  // 现象：损坏/截断音频（mp3/wav）解码失败后 UI 完全静默，audio.error 已触发
  //   （code=4 DEMUXER_ERROR_COULD_NOT_OPEN）但 main 区域无 .vv-error-card、无任何动作
  //   按钮，仅呈现空 0:00/0:00 原生控件。影响全部音频扩展名（mp3/wav/flac/m4a/aac/oga/
  //   opus 均走该分支，av.ts:354）。严重度 medium：正常音频可播；损坏音频即便有卡片也
  //   无法播放，缺的是错误呈现与重试/降级恢复路径，属健壮性/错误处理一致性缺陷。
  // 根因（已核对源码）：packages/render-media/src/av.ts:367-384 音频分支只创建
  //   audio.vv-av + blob src，无任何 error 监听；对照视频分支同文件 av.ts:476-479 有
  //   art.on('error')→showMediaError→showErrorCard（av.ts:436-473，错误卡片带重试/降级
  //   查看按钮；类名见 packages/core/src/dispatch/errorRenderer.ts:16,29）——BUG-14 错误
  //   卡片升级链本身工作，唯独原生音频分支漏接。上报会话 rg 全仓
  //   addEventListener('error')/onerror 仅命中 SSE/XHR/IndexedDB，无 audio 元素错误兜底。
  // 最小复现（服务端档，上报口径）：
  //   1) head -c 300 .temp/explore/media/data/normal.mp3 > /tmp/x.mp3（或直接用已生成的
  //      broken.mp3）；
  //   2) server/target/release/vviewer serve --root .temp/explore/media/data --web-dist
  //      apps/web/build --port 8431；
  //   3) 连接服务器 → 文件树点击 broken.mp3；
  //   4) 页内 eval：document.querySelector('audio.vv-av').error → {code:4,...}，
  //      document.querySelector('main .vv-error-card') → null。
  //   探测脚本：cd apps/web && node .temp/explore-media/p1c-one.mjs broken.mp3 audio。
  // 证据（上报会话亲手复现）：broken.mp3 → {"audio":true,"audioErr":{"code":4,"msg":
  //   "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed"},
  //   "errorCard":false,"actions":[]}；broken.wav 同结果（code=4、errorCard:false）。
  //   对照：同浏览器点 broken.mp4（截断 mp4，视频分支）→ {"card":true,"detail":
  //   "无法播放此媒体：未知错误","actions":["重试","降级查看"]}——证明 BUG-14 错误卡片
  //   升级链本身工作，唯独音频分支漏接。截图对比 /tmp/cand-media-e1/broken-mp3-8442.png
  //   （空 0:00/0:00 原生控件无卡片）vs /tmp/cand-media-e1/broken-mp4-card.png（统一错误
  //   卡片+两按钮）。覆盖缺口：现有 e2e 仅 apps/web/e2e/t-pwa.spec.ts:483（PWA-09/2 正常
  //   音频可起播），无损坏音频错误呈现用例。
  // 转正提示：修复 = 音频分支挂 el.addEventListener('error') → showErrorCard（带重试/降级，
  //   对齐视频分支）；断言 = 注入截断 mp3 字节后 .vv-error-card 可见且含重试/降级查看按钮。
});

test.fixme('BUG-53 [探索]：损坏图片解码失败无任何兜底——img error 已触发但无错误卡片，仅裂图+alt 文件名（与 BUG-14 修复后的 av 渲染器不一致）', async () => {
  // 现象：损坏图片（jpg/webp）解码失败，img error 事件已触发（window capture 级监听捕获
  //   {tag:"img",src:"blob:..."}）、naturalWidth=0、complete=true，但 main 区域无
  //   .vv-error-card、无重试/降级按钮，UI 仅裂图图标+alt 文件名。严重度 medium：正常图片
  //   渲染不受影响（对照 good.png naturalWidth=8 渲染成功），损坏文件属性面板仍可读，
  //   属错误呈现缺失，与原 BUG-14 同级。
  // 根因（已核对源码）：packages/render-media/src/image.ts:68-69 `img.src = url` 赋值后
  //   无 error 事件监听，render() 亦不校验解码结果；对照 BUG-14 修复范围
  //   docs/report/e2e/e2e-fix-report-2026-10-08.md:35（单测 av.test.ts、场景截断 mp4/PDF，
  //   不含 image）。
  // 最小复现（服务端档，上报口径）：
  //   1) 自起实例（测试件自制并经 file(1) 验证 magic：broken.jpg 'JPEG image data, JFIF
  //      standard 1.01'、broken.webp 'RIFF…Web/P image'，magic 头+垃圾数据）：
  //      server/target/release/vviewer serve --root <fixture> --web-dist apps/web/build
  //      --port 8442；
  //   2) 连接服务器 → 点击 broken.jpg；
  //   3) 页内 eval：document.querySelector('.vv-image img').naturalWidth → 0，
  //      document.querySelector('main .vv-error-card') → null。
  //   探测脚本：cd apps/web && node .temp/explore-media/p1c-one.mjs broken.jpg img
  //   （复核复刻版 /tmp/reverify-media-e2/verify.mjs 同口径）。
  // 证据（复核三次运行）：broken.jpg → {"mediaErrs":[{"tag":"img","src":"blob:…"}],
  //   "final":{"hasCard":false,"retryBtn":false,"naturalWidth":0,"complete":true}}；
  //   broken.webp 同构（mediaErrs 含 img error、hasCard:false、naturalWidth:0）；对照
  //   good.png 无 error 事件、naturalWidth=8 正常渲染（排除渲染器整体失效）；对照
  //   broken.mp4（ffmpeg libopenh264 生成 2s 后 head -c 3000 截断，file(1) 验证
  //   'ISO Media, MP4'）→ {"mediaErrs":[{"tag":"video","errCode":4}],"final":{"hasCard":
  //   true,"cardText":"无法播放此媒体：未知错误","retryBtn":true}}，与
  //   apps/web/e2e/b-media-office-viewer.spec.ts:416-422 断言的修复后行为一致（broken.mp4
  //   → .vv-error-card 可见 + detail 含「无法播放此媒体」+ 重试/降级查看两按钮）。
  //   截图 /tmp/reverify-media-e2/shot-broken.jpg.png（裂图图标+alt 文本，无卡片）。
  // 转正提示：修复 = img.addEventListener('error') → showErrorCard（或 render 后校验解码
  //   结果）；断言 = 注入垃圾字节 .jpg 后 .vv-error-card 可见、.vv-image 不残留裂图 img。
});

test.fixme('BUG-54 [探索]：video 运行期错误卡片文案恒为「无法播放此媒体：未知错误」——ArtPlayer 重连重设源清空 video.error，videoErrorMessage 映射表不可达', async () => {
  // 现象：av 渲染器 video 运行期错误卡片文案恒为「无法播放此媒体：未知错误」，无论底层
  //   MediaError 是 code=3（解码失败）还是 code=4（格式不支持）——av.ts:270-278 的
  //   videoErrorMessage 映射表实际不可达（永远落 default「未知错误」，av.ts:276）。影响
  //   限于错误详情文案的诊断信息量：错误卡片本身、重试/降级按钮、播放器摘除、不阻塞其他
  //   tab 均正常；BUG-14 验收「含明确错误信息」的达成度被削弱，现有 e2e
  //   （apps/web/e2e/b-media-office-viewer.spec.ts:419）只断「无法播放此媒体」前缀，不红。
  // 根因（已核对源码）：av.ts:476-478 art.on('error') 回调签名 ()、忽略事件参数，读
  //   art.video?.error；而 ArtPlayer 5.4.0 的 video:error handler（node_modules/.pnpm/
  //   artplayer@5.4.0/node_modules/artplayer/dist/artplayer.mjs:2495-2501）在
  //   art.emit("error", error2, reconnectTime) 之前先 await sleep(1s) 并
  //   art.url = option.url 重设源（重设 src 按 media load 算法清空 video.error），故回调
  //   读到的恒为 null/undefined → videoErrorMessage(undefined) 落 default；
  //   RECONNECT_TIME_MAX=5、RECONNECT_SLEEP_TIME=1e3（artplayer.mjs:4976-4977）。
  // 最小复现（服务端档，上报口径）：
  //   1) 8391 实例（.temp/e2e-data root，--compute）连接服务器，打开
  //      domain-media-office-viewer/broken-video.mp4（截断 mp4，video error code=4）；
  //   2) 等错误卡片出现（约 2~5s，ArtPlayer 重连 sleep 后），读卡片文案；
  //   3) code=3 对照：自起 8440 实例打开 hollow.mp4（sample-video.mp4 mdat 挖空 88633
  //      字节构造，video error code=3），同文案。
  // 证据（复核实跑 /tmp/vv-review-e3/repro.mjs：document 捕获级 error 监听记录真实
  //   MediaError + 读卡片文案）：broken-video.mp4 → {"detail":"无法播放此媒体：未知错误",
  //   "buttons":["重试","降级查看"],"videoErrors":[{"code":4,"message":
  //   "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed"}],
  //   "artCountAfterCard":0}，截图 /tmp/vv-review-e3/broken-mp4-8391.png；hollow.mp4 →
  //   {"detail":"无法播放此媒体：未知错误","videoErrors":[{"code":3,"message":
  //   "PipelineStatus::PIPELINE_ERROR_DECODE: …"}]}，截图 /tmp/vv-review-e3/hollow-8440.png。
  //   按 av.ts:274-275 两场景本应分别显示「解码失败：文件损坏或编码不支持
  //   （MEDIA_ERR_DECODE）」「媒体源不可达或格式不支持（MEDIA_ERR_SRC_NOT_SUPPORTED）」。
  // 转正提示：修复 = error 回调改接事件参数携带的 MediaError（art.emit("error", error2, …)
  //   第一参即原始 error；或在重设 url 前缓存 video.error）；断言 = code=4 卡片文案含
  //   MEDIA_ERR_SRC_NOT_SUPPORTED、code=3 含 MEDIA_ERR_DECODE（载体可用本文件装置注入
  //   截断/挖空 mp4 字节）。
});
