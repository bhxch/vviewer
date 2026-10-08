import { expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-markdown-html-docs 组共享 helper（markdown-html-docs 域补缺用例专用，本组自建）。
 * 注入通道与既有 m3/fix-pwa 相同：页面内构造 File + webkitRelativePath 经
 * __vvOpenDirImpl 注入，与真实 webkitdirectory input change 走同一
 * openDirectoryViaInput 通道（纯前端本地 store，auto 策略落本地管线）。
 */

/** 1×1 png（与 e2e-server/fixtures.mjs 同源 base64），data:image 内嵌图片素材 */
export const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface TextFileSpec {
  name: string;
  content: string;
  type?: string;
}

/** 文本内容 → 注入 payload（base64 规避结构化克隆对字符串数组的多余拷贝，同 m3 写法） */
function textPayloads(
  files: TextFileSpec[]
): Array<{ name: string; type: string; b64: string }> {
  return files.map((f) => ({
    name: f.name,
    type: f.type ?? (f.name.endsWith('.md') ? 'text/markdown' : 'text/html'),
    b64: Buffer.from(f.content, 'utf-8').toString('base64')
  }));
}

/** 首页加载后注入目录（固定虚拟根 bmd/） */
export async function injectDir(page: Page, files: TextFileSpec[]): Promise<void> {
  const payloads = textPayloads(files);
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((ps) => {
    const list = ps.map(({ name, type, b64 }) => {
      const f = new File([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], name, { type });
      // webkitRelativePath 是原型上仅 getter 的访问器，defineProperty 写自有属性遮蔽（与真实 input 一致）
      Object.defineProperty(f, 'webkitRelativePath', { value: `bmd/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(list);
  }, payloads);
}

/** 树行点击打开文件（窄视口经抽屉开合，drawer.ts），等待 tab 激活 */
export async function openTreeFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}
