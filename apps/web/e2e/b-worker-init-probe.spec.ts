import { expect, test, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * worker init 挂起取证蹲守（spec 2026-10-16 卫生与 worker 健壮性 W2）：
 * 环境级 Parser.init 挂起（2026-10-09 立项）至今无 CI 证据通道——探针帧仅
 * console.debug 且此前无任何 e2e 带参导航，trace 又仅失败上传（且失败现场无探针帧
 * 可看）。本用例带 ?vvWorkerDebug=1 导航，console 收集器全程记录 [vviewer-worker]
 * 阶段帧，断言失败时 testInfo.attach 全量（不依赖 trace 对 debug 级 console 的
 * 收录）；挂起 → init ready 断言超时红 → artifact 留帧（停在 wasm-fetch 还是
 * parser-init 一目了然）。CI 绿满 10 轮后向用户提请「未复现关闭」裁决。
 */

interface SpecFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** 页内构造 File 经 __vvOpenDirImpl 注入（纯前端本地 store；t-media 同款装置） */
async function openDir(page: Page, files: SpecFile[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `probe/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

test('worker init 探针蹲守：debug 带参导航下 tree-sitter 初始化完成（挂起则 artifact 留阶段帧）', async ({
  page
}, testInfo) => {
  test.setTimeout(60_000);
  const frames: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[vviewer-worker]')) frames.push(`[${new Date().toISOString()}] ${text}`);
  });
  await page.goto('/?vvWorkerDebug=1');
  await openDir(page, [
    {
      name: 'probe-init.ts',
      type: 'text/plain',
      bytes: new TextEncoder().encode('export const answer = 42;\n')
    }
  ]);
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'probe-init.ts' }).click();
  await closeDrawerIfOpened(page, drawer);
  // 断言 init ready：状态栏出现「高亮: tree-sitter」；失败先留阶段帧再上抛
  try {
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 45_000 });
  } catch (err) {
    await testInfo.attach('worker-init-frames.txt', {
      body: frames.join('\n') || '(无探针帧——init 握手未达 worker 或 debug 帧通道失效)'
    });
    throw err;
  }
});
