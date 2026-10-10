import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * t- 前缀：media-office-viewer 域 · 服务端模式缺口补齐（2026-10 缺口分析第二轮）。
 * 场景来源：docs/e2e/media-office-viewer.md §3 BUG-01「修复后应有行为」第 1 条：
 * video-hls.m3u8 经 hls.js 起播后「readyState≥3、currentTime 推进、**可播完**」——
 * 既有 e2e-server/b-media-office-viewer.spec.ts:100 已断言就绪与推进（currentTime>1），
 * 未断言「播完」（ended）；本文件补该子项（标题按 README §3.2 携带编号后缀）。
 * HLS 要求 remote store 直连（packages/render-media/src/av.ts:120-128 resolveHlsDirect
 * 仅对服务端 base 生效），故必须跑 playwright.server.config.ts（4174）。
 * 夹具：beforeAll 以 ffmpeg（libopenh264）生成 2s HLS（2×~1s 分片，总时长取最小
 * 以缩短播完等待），文件名 t-hls-done.m3u8 / t-seg%d.ts 与 b-media 夹具
 * （video-hls.m3u8/seg%d.ts/missing-seg.m3u8/video.ts/video.flv）及基础夹具不重叠；
 * 服务端套件单 worker（playwright.server.config.ts），无并发 fs 竞争。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');

test.beforeAll(() => {
  if (!existsSync(join(repoRoot, 'server/target/release/vviewer'))) {
    throw new Error('release 二进制不存在：先执行 cargo build --release --manifest-path server/Cargo.toml');
  }
  mkdirSync(FIXTURE, { recursive: true });
  execSync(
    `ffmpeg -hide_banner -loglevel error -y ` +
      `-f lavfi -i testsrc=duration=2:size=320x240:rate=15 ` +
      `-f lavfi -i sine=frequency=440:duration=2 ` +
      `-c:v libopenh264 -pix_fmt yuv420p -c:a aac -b:a 32k ` +
      `-force_key_frames 'expr:gte(t,n_forced*1)' ` +
      `-f hls -hls_time 1 -hls_list_size 0 -hls_segment_filename '${FIXTURE}/t-seg%d.ts' ` +
      `${FIXTURE}/t-hls-done.m3u8`,
    { stdio: 'inherit' }
  );
});

/** 展开 TopBar 连接表单并提交（服务器无 token 配置，令牌留空；同 b-media 口径） */
async function connect(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree')).toBeVisible({ timeout: 15_000 });
}

async function openTreeFile(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

test('MEDIA-04/播完：video-hls.m3u8 起播后播放至 ended，不落错误卡片', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await connect(page);

  // 服务端契约对照（报告 curl 口径：清单 200 / 分片 200，本夹具自生成）
  const manifest = await page.request.get(`${BASE}/api/file?path=t-hls-done.m3u8`);
  expect(manifest.status()).toBe(200);
  expect(await manifest.text()).toContain('#EXTM3U');
  const seg = await page.request.get(`${BASE}/api/file?path=t-seg0.ts`);
  expect(seg.status()).toBe(200);

  await openTreeFile(page, 't-hls-done.m3u8');
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });
  // 静音起播（无头无用户手势环境下的合规自动播放）；play() 延迟 resolve 由下方轮询兜底
  await page.locator('.vv-artplayer video').evaluate(async (el) => {
    const m = el as HTMLMediaElement;
    m.muted = true;
    await m.play().catch(() => undefined);
  });
  // readyState≥3（HAVE_FUTURE_DATA）或 error 先到；落点必须无 error
  await expect
    .poll(
      async () =>
        page.locator('.vv-artplayer video').evaluate((el) => {
          const m = el as HTMLMediaElement;
          return m.readyState >= 3 || (m.error?.code ?? 0) > 0 ? 'settled' : 'pending';
        }),
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe('settled');
  expect(
    await page.locator('.vv-artplayer video').evaluate((el) => (el as HTMLMediaElement).error?.code ?? 0)
  ).toBe(0);
  // 播完：2s 流自然播至 ended（BUG-01 验收第 1 条「可播完」），且全程无错误卡片
  await expect
    .poll(() => page.locator('.vv-artplayer video').evaluate((el) => (el as HTMLMediaElement).ended), {
      timeout: 30_000,
      intervals: [500, 1_000]
    })
    .toBe(true);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});
