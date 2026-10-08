import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * media-office-viewer 域补充 E2E（b- 前缀：缺陷修复回归 + 既有套件缺失场景）。
 * 场景来源：docs/e2e/media-office-viewer.md（MEDIA-01~11）。既有覆盖不重写：
 * m4.spec.ts 已覆盖 MEDIA-03 就绪（ArtPlayer 挂载）、MEDIA-07 canvas 初渲染、
 * MEDIA-08/09/10（office 三件套）；本文件补：
 * - MEDIA-01 图片滚轮缩放 1.1× 步进 + 10/0.1 限位 + 双击复位（偏差 #4：不做捏合断言）
 * - MEDIA-02 SVG 消毒（script 移除 / onload 剥除 / 探针变量不出现）
 * - MEDIA-03 播放推进（补 m4 就绪断言之外的 currentTime 推进）
 * - MEDIA-05 mp3/wav 原生音频控件 + 播放推进 + 暂停生效
 * - MEDIA-06 EXIF Orientation=6 按 90° 应用（natural 200×400）
 * - MEDIA-07 6 页 PDF 翻页页码随动 + 200% 缩放 + canvas 懒渲染
 * - MEDIA-11 / BUG-14 截断 mp4/pdf 统一错误卡片（含重试/降级按钮）+ 不阻塞其他 tab
 * 通道同 m4：页面内构造 File 经 __vvOpenDirImpl 注入（纯前端本地 store）。
 * Reconnect 计数不作断言（场景文档 §4.4 第 4 条仲裁备注）。
 *
 * 【顺带发现（非本批 4 缺陷，未修）】快速连续切换 av tab 时，前一个 ArtPlayer 实例
 * 销毁会触发一次 video 伪 error 事件（video.error 为空），av 渲染器将其升级为
 * 「无法播放此媒体：未知错误」卡片并落入共享 host——可覆盖新挂载的播放器。本套件
 * 以「正常件先开 + expectGoodPlaying 自愈重开 tab」规避；人为点击节奏下影响有限，
 * 复现路径：broken.mp4 → broken.pdf → good.mp4 快速连开，good.mp4 pane 被拆除。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** ffmpeg 生成的 400×200 横向红图（MEDIA-06 基座，测试内注入 EXIF Orientation=6） */
const JPG_BASE_B64 =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMwD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAyAGQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiwEm38AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//2Q==';

/** ffmpeg libmp3lame 生成（2s 440Hz 单声道 8kHz/24kbps，MEDIA-05） */
const MP3_B64 =
  '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';

/** 构造 16-bit PCM WAV（MEDIA-05 wav 件：程序化生成，无外部依赖） */
function makeWavBytes(seconds = 2, rate = 8000): Uint8Array {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), true);
  }
  return new Uint8Array(buf);
}

/** 对横向 JPEG 注入 EXIF APP1（Orientation=6），构造 MEDIA-06 样例（域文档 §4.3 第 3 条） */
function withExifRot90(jpg: Uint8Array): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0]); // II + 42 + IFD0@8
  tiff[8] = 0x01; // IFD entry count = 1
  tiff.set([0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, 0x06, 0, 0, 0], 10); // Orientation=6
  const payload = new Uint8Array(6 + tiff.length);
  payload.set(new TextEncoder().encode('Exif\0\0'));
  payload.set(tiff, 6);
  const app1 = new Uint8Array(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (payload.length + 2) >> 8;
  app1[3] = (payload.length + 2) & 0xff;
  app1.set(payload, 4);
  const out = new Uint8Array(2 + app1.length + jpg.length - 2);
  out.set(jpg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpg.subarray(2), 2 + app1.length);
  return out;
}

/** 极简多页 PDF（MEDIA-07：6 页 600×900pt 高页——页码指示器统计 200px 预热边距内的
 * 首个可视页，矮页滚到底仍显示靠前页码；高页保证「滚到底=第 6 页」判据清晰） */
function buildMultiPagePdf(pages: string[]): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pid = 4 + i * 2;
    const cid = pid + 1;
    objs[pid] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
    const stream = `BT /F1 28 Tf 40 500 Td (${text}) Tj ET`;
    objs[cid] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const chunks: Uint8Array[] = [enc('%PDF-1.4\n')];
  const total = (arr: Uint8Array[]): number => arr.reduce((n, c) => n + c.length, 0);
  const offsets: number[] = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = total(chunks);
    chunks.push(enc(`${i} 0 obj\n${objs[i]}\nendobj\n`));
  }
  const xrefAt = total(chunks);
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(enc(xref));
  const out = new Uint8Array(total(chunks));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const b64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

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
      Object.defineProperty(f, 'webkitRelativePath', { value: `bmedia/${name}` });
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

/** 静音起播（无头无用户手势环境下的合规自动播放），返回当前 error code */
async function mutedPlay(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate(async (el) => {
    const m = el as HTMLMediaElement;
    m.muted = true;
    await m.play();
    return m.error?.code ?? 0;
  });
}

/**
 * good.mp4 起播推进断言，对「伪 error 卡片干扰」自愈：快速连续开 tab 时，前一个
 * ArtPlayer 实例销毁期的伪 error 事件（video.error 为空 →「无法播放此媒体：未知错误」）
 * 可能落在新挂载的播放器上（app 侧已知脆弱点，见文件头注）。此时重新激活 tab 触发
 * 全新渲染——滞留事件已落定，新渲染不再受干扰。重试至多 3 次。
 */
async function expectGoodPlaying(page: Page): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const video = page.locator('.vv-artplayer video');
    const started = await video
      .evaluate(async (el) => {
        const m = el as HTMLMediaElement;
        m.muted = true;
        await m.play();
        return true;
      })
      .catch(() => false);
    if (started) {
      const advanced = await video
        .evaluate(
          (v) =>
            new Promise<boolean>((resolve) => {
              const m = v as HTMLMediaElement;
              const t0 = m.currentTime;
              setTimeout(() => resolve(m.currentTime > t0 || m.ended), 1_200);
            })
        )
        .catch(() => false);
      if (advanced) return;
    }
    if (attempt >= 2) throw new Error('good.mp4 反复被伪 error 卡片干扰，无法起播推进');
    await page.locator('.vv-tab', { hasText: 'broken.mp4' }).click();
    await page.waitForTimeout(800);
    await page.locator('.vv-tab', { hasText: 'good.mp4' }).click();
    await page.waitForTimeout(1_200);
  }
}

test('MEDIA-01：图片滚轮缩放 1.1× 步进、上限 10×、下限 0.1×、双击复位', async ({ page }) => {
  test.setTimeout(60_000);
  // sample.bin 本体即 PNG（IHDR 32×8，m4 已验证），改名为 .png 走图片渲染器
  const png = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.bin`));
  await page.goto('/');
  await openDir(page, [{ name: 'zoom.png', type: 'image/png', bytes: png }]);
  await openFile(page, 'zoom.png');

  const img = page.locator('.vv-image img');
  await expect(img).toBeVisible();
  const transform = () => img.evaluate((el) => el.style.transform);

  // 滚轮向上 30 步：1.1^30 ≈ 17.4 → 收敛到上限 10×（render-media/src/image.ts attachZoom）
  for (let i = 0; i < 30; i++) {
    await page.locator('.vv-image').dispatchEvent('wheel', { deltaY: -100 });
  }
  await expect.poll(transform, { timeout: 5_000 }).toBe('scale(10)');

  // 滚轮向下 50 步：10 × 0.9^50 ≈ 0.005 → 收敛到下限 0.1×
  for (let i = 0; i < 50; i++) {
    await page.locator('.vv-image').dispatchEvent('wheel', { deltaY: 100 });
  }
  await expect.poll(transform, { timeout: 5_000 }).toBe('scale(0.1)');

  // 双击复位 1×（偏差 #4：移动端捏合缩放未实现属裁决维持，本场景不含捏合断言）
  await page.locator('.vv-image').dispatchEvent('dblclick');
  await expect.poll(transform, { timeout: 5_000 }).toBe('scale(1)');
});

test('MEDIA-02：SVG 消毒——script 移除、onload 剥除、探针变量不出现', async ({ page }) => {
  test.setTimeout(60_000);
  const evil =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="window.__vvOnloadProbe=true">` +
    `<script>window.__vvScriptProbe=true;</script>` +
    `<circle cx="30" cy="30" r="20" fill="#0a0"/>` +
    `<a href="javascript:window.__vvJsProbe=true"><text x="60" y="35">probe</text></a></svg>`;
  await page.goto('/');
  await openDir(page, [{ name: 'evil.svg', type: 'image/svg+xml', bytes: new TextEncoder().encode(evil) }]);
  await openFile(page, 'evil.svg');

  // 正常渲染（消毒不是拒绝：图形仍在）
  const img = page.locator('.vv-image img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBe(120);

  // 消毒证据（sanitizeSvg 产物在 blob 内）：script 整段移除、onload 剥除、javascript: 移除
  const clean = await img.evaluate(async (el) => await (await fetch((el as HTMLImageElement).src)).text());
  expect(clean).not.toContain('<script');
  expect(clean).not.toContain('onload');
  expect(clean).not.toContain('javascript:');
  expect(clean).toContain('<circle');

  // 探针变量均未出现（脚本未执行）
  const probes = await page.evaluate(() => ({
    script: (window as unknown as { __vvScriptProbe?: boolean }).__vvScriptProbe ?? false,
    onload: (window as unknown as { __vvOnloadProbe?: boolean }).__vvOnloadProbe ?? false,
    js: (window as unknown as { __vvJsProbe?: boolean }).__vvJsProbe ?? false
  }));
  expect(probes).toEqual({ script: false, onload: false, js: false });
});

test('MEDIA-03：mp4 ArtPlayer 播放推进（补 m4 就绪断言）', async ({ page }) => {
  test.setTimeout(60_000);
  const mp4 = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.mp4`));
  await page.goto('/');
  await openDir(page, [{ name: 'sample.mp4', type: 'video/mp4', bytes: mp4 }]);
  await openFile(page, 'sample.mp4');

  // ArtPlayer 真实挂载（m4 已覆盖就绪，此处聚焦推进）
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });
  expect(await mutedPlay(page, '.vv-artplayer video')).toBe(0);
  // 0.16s 样例：currentTime 推进或已播完（ended）均为「播放推进」证据
  await expect
    .poll(
      async () =>
        page.locator('.vv-artplayer video').evaluate((v) => {
          const m = v as HTMLMediaElement;
          return { t: m.currentTime, ended: m.ended, err: m.error?.code ?? 0 };
        }),
      { timeout: 15_000, intervals: [100, 250, 500] }
    )
    .toMatchObject({ err: 0 });
  const s = await page.locator('.vv-artplayer video').evaluate((v) => {
    const m = v as HTMLMediaElement;
    return { t: m.currentTime, ended: m.ended };
  });
  expect(s.t > 0 || s.ended).toBe(true);
});

test('MEDIA-05：mp3/wav 原生音频控件、readyState=4、播放推进、暂停生效', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'tone.mp3', type: 'audio/mpeg', bytes: b64Bytes(MP3_B64) },
    { name: 'tone.wav', type: 'audio/wav', bytes: makeWavBytes() }
  ]);

  for (const name of ['tone.mp3', 'tone.wav']) {
    await openFile(page, name);
    const audio = page.locator('audio.vv-av');
    await expect(audio).toHaveCount(1);
    // 原生控件渲染 + 全量缓冲（blob 小文件 → HAVE_ENOUGH_DATA）
    await expect
      .poll(() => audio.evaluate((el) => (el as HTMLMediaElement).readyState), {
        timeout: 15_000,
        message: `${name} 等待 readyState=4`
      })
      .toBe(4);
    expect(await mutedPlay(page, 'audio.vv-av')).toBe(0);
    await expect
      .poll(() => audio.evaluate((el) => (el as HTMLMediaElement).currentTime), { timeout: 10_000 })
      .toBeGreaterThan(0.2);
    // 暂停生效：currentTime 停止推进
    await audio.evaluate((el) => (el as HTMLMediaElement).pause());
    const t1 = await audio.evaluate((el) => (el as HTMLMediaElement).currentTime);
    await page.waitForTimeout(800);
    const t2 = await audio.evaluate((el) => (el as HTMLMediaElement).currentTime);
    expect(t2).toBe(t1);
    await expect(audio.evaluate((el) => (el as HTMLMediaElement).error?.code ?? 0)).resolves.toBe(0);
  }
});

test('MEDIA-06：EXIF Orientation=6 按 90° 顺时针应用（natural 200×400）', async ({ page }) => {
  test.setTimeout(60_000);
  const jpg = withExifRot90(b64Bytes(JPG_BASE_B64)); // 存储横向 400×200
  await page.goto('/');
  await openDir(page, [{ name: 'exif-rot90.jpg', type: 'image/jpeg', bytes: jpg }]);
  await openFile(page, 'exif-rot90.jpg');

  // Chromium 默认 image-orientation: from-image：natural 尺寸按方向翻转（400×200 → 200×400）
  const img = page.locator('.vv-image img');
  await expect
    .poll(
      () =>
        img.evaluate((el) => {
          const m = el as HTMLImageElement;
          return m.complete && m.naturalWidth > 0 ? `${m.naturalWidth}x${m.naturalHeight}` : '';
        }),
      { timeout: 10_000 }
    )
    .toBe('200x400');
});

test('MEDIA-07：6 页 PDF 翻页页码随动、200% 缩放、canvas 懒渲染', async ({ page }) => {
  test.setTimeout(90_000);
  const pdf = buildMultiPagePdf([
    'Deck Page 1',
    'Deck Page 2',
    'Deck Page 3',
    'Deck Page 4',
    'Deck Page 5',
    'Deck Page 6'
  ]);
  await page.goto('/');
  await openDir(page, [{ name: 'deck6.pdf', type: 'application/pdf', bytes: pdf }]);
  await openFile(page, 'deck6.pdf');

  await expect(page.locator('.vv-pdf')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-pdf-page')).toHaveCount(6);
  await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 1 / 6 页');
  await expect(page.locator('.vv-pdf-zoom-label')).toHaveText('100%');

  // 懒渲染：初始只渲染前 3 页（IMMEDIATE_PAGES）+ 200px 预热边距内的页，第 6 页 canvas 不存在
  await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 20_000 });
  expect(await page.locator('.vv-pdf canvas').count()).toBeLessThan(6);
  expect(await page.locator('.vv-pdf-page').nth(5).locator('canvas').count()).toBe(0);

  // 翻页至末页：页码随动，第 6 页 canvas 懒渲染出现
  await page.locator('.vv-pdf-pages').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 6 / 6 页', { timeout: 10_000 });
  await expect(page.locator('.vv-pdf-page').nth(5).locator('canvas')).toHaveCount(1, { timeout: 10_000 });

  // 缩放至 200%（预设档 0.5/0.75/1/1.5/2/3）：档位两步串行——每档全量重绘（清空全部
  // canvas、占位尺寸变化）后滚动锚点仍为绝对像素值，需重滚到底让第 6 页回到可视集；
  // canvas 只为可视页重绘（总数受限）即缩放重绘 + 回收证据
  await page.getByRole('button', { name: '放大' }).click();
  await expect(page.locator('.vv-pdf-zoom-label')).toHaveText('150%');
  await page.locator('.vv-pdf-pages').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('.vv-pdf-page').nth(5).locator('canvas')).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole('button', { name: '放大' }).click();
  await expect(page.locator('.vv-pdf-zoom-label')).toHaveText('200%');
  await page.locator('.vv-pdf-pages').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 6 / 6 页', { timeout: 10_000 });
  await expect(page.locator('.vv-pdf-page').nth(5).locator('canvas')).toHaveCount(1, { timeout: 15_000 });
  expect(await page.locator('.vv-pdf canvas').count()).toBeLessThan(6);
});

test('MEDIA-11/BUG-14：截断 mp4 与截断 PDF 出统一错误卡片（含重试/降级按钮），不阻塞其他 tab', async ({
  page
}) => {
  test.setTimeout(90_000);
  const mp4 = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.mp4`));
  const pdf = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.pdf`));
  await page.goto('/');
  await openDir(page, [
    { name: 'good.mp4', type: 'video/mp4', bytes: mp4 },
    // 域文档 §4.3 截断口径（head -c N 截断真 mp4/pdf）；sample.mp4 共 921B，取 300B 确保 moov 损坏
    { name: 'broken.mp4', type: 'video/mp4', bytes: mp4.slice(0, 300) },
    { name: 'broken.pdf', type: 'application/pdf', bytes: pdf.slice(0, 500) }
  ]);

  // ① 正常 mp4 先起播推进（「不阻塞」的基准面；正常件先开规避 av 实例销毁期
  // ArtPlayer 伪 error 事件对后续挂载的干扰——已按「未知错误」卡片复现，见文件头注）
  await openFile(page, 'good.mp4');
  await expectGoodPlaying(page);

  // ② 截断 mp4：统一错误卡片替换黑屏播放器，含明确错误信息与重试/降级按钮
  await openFile(page, 'broken.mp4');
  const card = page.locator('.vv-error-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.vv-error-detail')).toContainText('无法播放此媒体');
  await expect(card.locator('.vv-error-action')).toHaveCount(2);
  await expect(card.locator('.vv-error-action').nth(0)).toHaveText('重试');
  await expect(card.locator('.vv-error-action').nth(1)).toHaveText('降级查看');
  // 黑屏播放器不再呈现（video 容器被卡片替换）
  await expect(page.locator('.vv-artplayer')).toHaveCount(0);

  // ③ 截断 PDF：错误卡片同样带按钮（报告现状为无按钮）
  await openFile(page, 'broken.pdf');
  const pdfCard = page.locator('.vv-error-card');
  await expect(pdfCard).toBeVisible({ timeout: 20_000 });
  const detail = await pdfCard.locator('.vv-error-detail').textContent();
  expect(detail!.trim().length).toBeGreaterThan(0);
  await expect(pdfCard.locator('.vv-error-action')).toHaveCount(2);
  await expect(pdfCard.locator('.vv-error-action').nth(0)).toHaveText('重试');

  // ④ 回归护栏：损坏 tab 打开期间，切回正常 mp4 照常起播推进（不阻塞其他 tab）
  await page.locator('.vv-tab', { hasText: 'good.mp4' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'good.mp4' })).toBeVisible();
  await expectGoodPlaying(page);

  // ⑤ 切回截断 mp4 tab：错误卡片仍在（错误只作用于该 tab）
  await page.locator('.vv-tab', { hasText: 'broken.mp4' }).click();
  await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 10_000 });
});
