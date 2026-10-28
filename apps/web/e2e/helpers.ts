import { expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 新 spec 共用 e2e 装置（终审 M-4 抽取）：b-open-with-more / b-file-detect-signature /
 * b-encoding-detect 三份复制的注入与定位装置收敛单点。装置血统：waitAppMounted/
 * tabNamed/openFile 自 t-tab-actions、openRightIfNarrow 自 t-open-with——既有 spec
 * 内的副本不动（收敛另行立项）。断点口径：≤900px 文件树、≤600px 右栏（MetaPanel）
 * 各收进抽屉（drawer.ts 适配）。
 */

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 等应用挂载：__vvOpenDirImpl 注入钩子就绪 + TopBar 可见 */
export async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/**
 * 目录注入通道（__vvOpenDirImpl；只建目录 store tab——文件 tab 须树行点击打开，
 * 配合 openFile）。group = webkitRelativePath 首段（目录组显示名）；文本载荷走
 * text/plain，二进制载荷走 application/octet-stream（字节经数组桥接，与既有
 * evaluate 传参形态一致）。
 */
export async function openDirText(page: Page, group: string, name: string, text: string): Promise<void> {
  await page.evaluate(
    ({ g, n, t }) => {
      const f = new File([t], n, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `${g}/${n}` });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    },
    { g: group, n: name, t: text }
  );
}

/** 目录注入通道的二进制载荷变体（openDirText 同构，openDirText 头注同语义） */
export async function openDirBytes(page: Page, group: string, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate(
    ({ g, n, b }) => {
      const f = new File([new Uint8Array(b)], n, { type: 'application/octet-stream' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `${g}/${n}` });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    },
    { g: group, n: name, b: Array.from(bytes) }
  );
}

/** 精确名 tab 定位（.vv-tab-name 子元素锚定——tab 根级 textContent 含关闭钮「×」，
 * getByRole('tab') 不可用） */
export function tabNamed(page: Page, name: string): Locator {
  return page
    .locator('.vv-tab')
    .filter({
      has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) })
    });
}

/** 树行点击打开文件 tab（≤900px 抽屉断点适配；20s 超时与套件负载口径一致） */
export async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible({ timeout: 20_000 });
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉；宽视口 no-op（返回 false） */
export async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}
