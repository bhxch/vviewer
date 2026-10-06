import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

const samples = fileURLToPath(new URL('../../../samples/m1', import.meta.url));

const PAYLOADS = [
  { name: 'hello.js', type: 'text/javascript' },
  { name: 'notes.md', type: 'text/markdown' },
  { name: 'pixel.png', type: 'image/png' }
].map((f) => ({ ...f, b64: readFileSync(`${samples}/${f.name}`).toString('base64') }));

/**
 * M1 E2E 通道：Playwright 的 setInputFiles 构造的 File 无 webkitRelativePath，
 * 无法走 webkitdirectory input。改为在页面内 new File + Object.defineProperty 注入相对路径，
 * 调用应用暴露的调试钩子 __vvOpenDirImpl（与真实 input change 同走 openDirectoryViaInput）。
 */
async function openSampleDir(page: Page): Promise<void> {
  // 钩子在 openFlow.svelte.ts 模块求值时挂载，SvelteKit 动态 import 路由组件，
  // 可能晚于 goto 的 load 事件，故先等钩子就绪
  await page.waitForFunction(() => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function');
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const f = new File([bytes], name, { type });
      // webkitRelativePath 是原型上仅 getter 的访问器，Object.assign 会报错；
      // 用 defineProperty 写入同名自有属性遮蔽原型 getter（与真实 input 行为一致）
      Object.defineProperty(f, 'webkitRelativePath', { value: `m1/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, PAYLOADS);
}

test('open folder, render code with hljs and image, restore session after reload', async ({ page }) => {
  await page.goto('/');

  // 打开目录 → 文件树渲染
  await openSampleDir(page);
  await expect(page.locator('.vv-tree')).toBeVisible();
  await expect(page.locator('.vv-tree-row', { hasText: 'hello.js' })).toBeVisible();
  await expect(page.locator('.vv-tree-row', { hasText: 'notes.md' })).toBeVisible();

  // 代码 tab：hljs 高亮 span 可见，tab 处于激活态。
  // 不断言具体 hljs-keyword：highlightAuto 对超短文本可能误判语言
  //（2 行 hello.js 被判为 arcade，产出 hljs-function/hljs-string 等），
  // 这里验证的是高亮管线本身（异步加载 hljs → 按行切分 → 虚拟滚动渲染）
  await page.locator('.vv-tree-row', { hasText: 'hello.js' }).click();
  await expect(page.locator('.vv-code-pre [class*="hljs-"]').first()).toBeVisible();
  await expect(page.locator('.vv-tab.active', { hasText: 'hello.js' })).toBeVisible();

  // 防回归：.vv-code-pre 必须有确定高度——宿主高度链断裂时它会解析为 0 高，
  // 内容被 overflow 裁剪成“视觉空白”（虚拟滚动仍渲染但不可见）
  const preBox = await page.locator('.vv-code-pre').boundingBox();
  expect(preBox).not.toBeNull();
  expect(preBox!.height).toBeGreaterThan(0);

  // 图片 tab
  await page.locator('.vv-tree-row', { hasText: 'pixel.png' }).click();
  await expect(page.locator('.vv-image img')).toBeVisible();
  await expect(page.locator('.vv-tab.active', { hasText: 'pixel.png' })).toBeVisible();

  // TabBar 关闭：点击 × 后 tab 消失
  await page.locator('.vv-tab', { hasText: 'hello.js' }).locator('.vv-tab-close').click();
  await expect(page.locator('.vv-tab', { hasText: 'hello.js' })).toHaveCount(0);

  // 确定性等待 IndexedDB 会话落盘：close 触发的持久化是异步写，轮询 'vviewer' 库
  // kv store 的 tabs 记录不含 hello.js 后再刷新（固定 sleep 是 flake 向量）
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('vviewer', 1);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('kv', 'readonly').objectStore('kv').get('tabs');
            get.onsuccess = () => {
              const tabs = get.result as { name: string }[] | undefined;
              resolve(Array.isArray(tabs) && !tabs.some((t) => t.name === 'hello.js'));
              db.close();
            };
            get.onerror = () => {
              resolve(false);
              db.close();
            };
          } catch {
            resolve(false);
            db.close();
          }
        };
        open.onerror = () => resolve(false);
      }),
    undefined,
    { polling: 50 }
  );

  // 会话恢复：webkitdirectory 通道为 rename-only，刷新后恢复为占位 tab → 错误卡/空态
  await page.reload();
  await expect(page.locator('.vv-error-card, .vv-empty').first()).toBeVisible();
  // 未关闭的 tab 以占位形式恢复，hello.js 已关闭不再出现
  await expect(page.locator('.vv-tab', { hasText: 'pixel.png' })).toBeVisible();
  await expect(page.locator('.vv-tab', { hasText: 'hello.js' })).toHaveCount(0);
});
