import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * media-office-viewer 域 · 服务端模式补充 E2E（b- 前缀）。
 * 场景来源：docs/e2e/media-office-viewer.md MEDIA-04 / BUG-01（high · verified）。
 * HLS（m3u8）播放要求 remote store 直连（render-media av.ts resolveHlsDirect 仅对
 * 服务端 base 生效，本地 store 明确报错），故本域唯一必须跑服务端模式的场景在此覆盖：
 * 1. video-hls.m3u8 经 hls.js 起播：清单/分片请求指向 /api/file 可达 URL（不再出现
 *    指向不存在资源的 blob: 伪 URL），readyState≥3、currentTime 推进（报告缺陷态为
 *    分片指向 blob:http://…/seg0.ts 伪 URL、readyState 恒 0、静默死循环重试）；
 * 2. video.ts 经 mpegts.js 起播（dispatcher 签名改派），不落入代码容器渲染乱码；
 * 3. 回归护栏：video.flv 照常起播；服务端 /api/file 对 m3u8/seg/缺失分片 200/200/404
 *    契约不变（报告 curl 对照口径，经 request API 断言）。
 * missing-seg.m3u8「分片不可达出错误卡片」一项目前未达（hls.js 对 404 分片不升级
 * fatal，静默重试依旧），以 test.fixme 记录预期行为，见文件末尾用例注释。
 * 夹具：beforeAll 以 ffmpeg（libopenh264）生成 HLS 切片组/flv/ts 写入 server fixture
 * 根（与基础夹具及其他域用例文件名不重叠），生成后经 TopBar
 * 连接服务器从真实目录树打开。服务端模式单 worker（playwright.server.config.ts），
 * 夹具文件名与 b-binary-hex-archive 服务端用例不相交，workers=2 下亦无竞争。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
// 夹具直接放 fixture 根：服务端文件树默认不展开子目录；文件名与基础夹具及其他域用例均不重叠
const MEDIA_DIR = FIXTURE;

test.beforeAll(() => {
  if (!existsSync(join(repoRoot, 'server/target/release/vviewer'))) {
    throw new Error('release 二进制不存在：先执行 cargo build --release --manifest-path server/Cargo.toml');
  }
  mkdirSync(MEDIA_DIR, { recursive: true });
  // 6s HLS（3×2s 分片，duration=6 与报告样例口径一致）
  execSync(
    `ffmpeg -hide_banner -loglevel error -y ` +
      `-f lavfi -i testsrc=duration=6:size=320x240:rate=15 ` +
      `-f lavfi -i sine=frequency=440:duration=6 ` +
      `-c:v libopenh264 -pix_fmt yuv420p -c:a aac -b:a 32k ` +
      `-force_key_frames 'expr:gte(t,n_forced*2)' ` +
      `-f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename '${MEDIA_DIR}/seg%d.ts' ` +
      `${MEDIA_DIR}/video-hls.m3u8`,
    { stdio: 'inherit' }
  );
  // 分片缺失清单：指向不存在的 seg_missing.ts（服务端应 404）
  writeFileSync(
    join(MEDIA_DIR, 'missing-seg.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg_missing.ts\n#EXT-X-ENDLIST\n'
  );
  const common =
    `-f lavfi -i testsrc=duration=3:size=320x240:rate=15 ` +
    `-f lavfi -i sine=frequency=440:duration=3 ` +
    `-c:v libopenh264 -pix_fmt yuv420p -c:a aac -b:a 32k `;
  execSync(`ffmpeg -hide_banner -loglevel error -y ${common}-f mpegts ${MEDIA_DIR}/video.ts`, {
    stdio: 'inherit'
  });
  execSync(
    `ffmpeg -hide_banner -loglevel error -y ${common}-force_key_frames 'expr:gte(t,n_forced*1)' -f flv ${MEDIA_DIR}/video.flv`,
    { stdio: 'inherit' }
  );
});

/** 展开 TopBar 连接表单并提交（服务器无 token 配置，令牌留空） */
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

/** 静音起播并轮询到流就绪（readyState≥3 = HAVE_FUTURE_DATA） */
async function playUntilReady(page: import('@playwright/test').Page, timeout = 30_000): Promise<void> {
  await page.locator('.vv-artplayer video').evaluate(async (el) => {
    const m = el as HTMLMediaElement;
    m.muted = true;
    await m.play().catch(() => undefined); // 个别环境 play() 可能延迟 resolve，靠下方轮询推进
  });
  await expect
    .poll(
      async () =>
        page.locator('.vv-artplayer video').evaluate((v) => {
          const m = v as HTMLMediaElement;
          return m.readyState >= 3 || (m.error?.code ?? 0) > 0 ? 'settled' : 'pending';
        }),
      { timeout, intervals: [250, 500, 1_000] }
    )
    .toBe('settled');
  const err = await page.locator('.vv-artplayer video').evaluate((v) => (v as HTMLMediaElement).error?.code ?? 0);
  expect(err).toBe(0);
}

test('MEDIA-04/BUG-01：HLS 起播可达分片、ts 走 mpegts、flv 回归、/api/file 契约', async ({ page }) => {
  test.setTimeout(180_000);
  const segmentUrls: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/seg\d*\.ts($|\?)/.test(u)) segmentUrls.push(u);
  });

  await page.goto('/');
  await connect(page);
  
  // ---- 服务端对照（报告口径：m3u8 200 / seg 200 / 缺失分片 404，契约不得因修复改变）----
  const manifest = await page.request.get(`${BASE}/api/file?path=video-hls.m3u8`);
  expect(manifest.status()).toBe(200);
  expect(await manifest.text()).toContain('#EXTM3U');
  const seg = await page.request.get(`${BASE}/api/file?path=seg0.ts`);
  expect(seg.status()).toBe(200);
  const missing = await page.request.get(`${BASE}/api/file?path=seg_missing.ts`);
  expect(missing.status()).toBe(404);

  // ---- ① video-hls.m3u8：hls.js 起播，分片直达 /api/file ----
  await openTreeFile(page, 'video-hls.m3u8');
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });
  await playUntilReady(page);
  // 分片请求指向服务端真实 URL（清单改写），不再出现 blob: 伪 URL
  expect(segmentUrls.length).toBeGreaterThan(0);
  for (const u of segmentUrls) {
    expect(u.startsWith('blob:')).toBe(false);
    expect(u).toContain('/api/file?path=');
  }
  // 播放推进（可播完：6s 流推进 1s 足证）
  await expect
    .poll(
      async () =>
        page.locator('.vv-artplayer video').evaluate((v) => {
          const m = v as HTMLMediaElement;
          return m.currentTime;
        }),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(1);

  // ---- ② video.ts：dispatcher 签名改派 → mpegts.js 起播，不落代码容器 ----
  await openTreeFile(page, 'video.ts');
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  await playUntilReady(page);
  await expect
    .poll(
      async () => page.locator('.vv-artplayer video').evaluate((v) => (v as HTMLMediaElement).currentTime),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0.5);

  // ---- ③ 回归护栏：video.flv 照常起播（报告现状已达，不得回退）----
  await openTreeFile(page, 'video.flv');
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });
  await playUntilReady(page);
  await expect
    .poll(
      async () => page.locator('.vv-artplayer video').evaluate((v) => (v as HTMLMediaElement).currentTime),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0.5);
});

/**
 * MEDIA-04/BUG-01 残留子项回归：missing-seg.m3u8「分片不可达给出错误提示、
 * 不静默挂起」（域文档 §3 BUG-01 验收第 3 条）。清单改写与 blob: 伪 URL 修复
 * 生效后分片正确请求 /api/file?path=seg_missing.ts 且服务端 404；hls.js 默认
 * 对 404 分片 6 次指数退避重试且不升级 fatal（静默挂起 ~1 次/秒）——av.ts
 * buildHlsConfig 已把清单/分片网络重试上限收紧为 2 次、短退避，404 分片在
 * 数秒内升级 fatal 走 hlsFatalDecision（一次 startLoad 重试后）出错误卡片。
 * 预期 .vv-error-card 含「HLS 流错误」与「重试」按钮、.vv-artplayer 被卡片替换。
 */
test('MEDIA-04/BUG-01：missing-seg.m3u8 分片不可达时出错误卡片（不静默挂起）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await connect(page);
  await openTreeFile(page, 'missing-seg.m3u8');
  await expect(page.locator('.vv-artplayer .art-video-player')).toBeVisible({ timeout: 20_000 });
  const card = page.locator('.vv-error-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText('HLS 流错误');
  await expect(card.locator('.vv-error-action', { hasText: '重试' })).toBeVisible();
  await expect(page.locator('.vv-artplayer')).toHaveCount(0);
});
