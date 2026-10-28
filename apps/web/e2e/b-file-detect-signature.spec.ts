import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 签名改派扩表 e2e（议题二，SIG-01~04）：Task 5（7c22ddf）13 个新 magic 签名的
 * 改派路由实证——无扩展名文件按内容直达真渲染器：
 * - SIG-01 无扩展名 mp4（ftyp isom 品牌）→ av
 * - SIG-02 无扩展名 webp（RIFF…WEBP）→ image
 * - SIG-03 无扩展名 gz（1f 8b 08）→ archive
 * - SIG-04 无扩展名 7z（37 7a bc af 27 1c）→ archive
 *
 * 断言锚（简报口径的实测校准，2026-10-28 核对源码）：
 * ① 简报锚 `.meta-openwith` select 的 value 实为 override 回显（openWithOf 返回
 *   current = overrideRenderer ?? ''，ViewerPane 上行与 MetaPanel 候选派生同源）——
 *   自动路由（含签名改派）恒显示「自动」（value ''），永不为 dispatch rendererId
 *   （同源先例：SUSP-09 断言 value ''；OWM-01 简报 toHaveValue('archive') 同病被
 *   Task 3 校准）。故改派实证锚校准为 select 的**候选面**：option[value=rendererId]
 *   出现。该锚同样由 dispatch 决定、与播放/解码成败无关，且软/硬失败两路殊途同归：
 *   - 改派软失败（av 内构错误卡片链，res.rendererId 真值）：push(rendererId) 直入候选；
 *   - render 抛错（dispatch catch 返回 rendererId 'error'）：'error' 被 openWithOf
 *     存在性守卫滤除，但签名路由已纠偏 det.ext（mp4/webp/gz/7z），该渲染器经扩展名
 *     候选同面出现——无时序分叉。
 * ② 判别力：无扩展名文件在扩表前 signature=null → 探测链兜底（SIG-01/03/04 载荷含
 *   NUL 落 hex；SIG-02 载荷全可打印 ASCII，looksTextual 判文本落 code）且 det.ext
 *   恒 ''（无扩展名候选）→ 候选面必无 av/image/archive option；本锚只在 Task 5 扩表
 *   后转绿。
 * ③ 载荷为垃圾字节：av/image/archive 的运行期错误卡片（无法播放/解码失败/无法识别
 *   压缩包）与本锚无关，可能异步出现，不断言（简报口径）。
 *
 * 通道：目录注入经 __vvOpenDirImpl 只建目录 tab（Task 4 经验）——文件 tab 须补树行
 * 点击打开（b-open-with-more openDir+openFile 同款装置）；≤900px 文件树、≤600px 右栏
 * （MetaPanel）各收进抽屉，经 drawer.ts / openRightIfNarrow 适配；default 套件
 * chromium+mobile 双 project 全跑。
 */

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 最小 ftyp-isom 头（垃圾负载，仅锚选路） */
function mp4ish(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0, 0, 0, 0x18], 0);
  b.set(new TextEncoder().encode('ftypisom'), 4);
  return b;
}

/** 等应用挂载（__vvOpenDirImpl 注入钩子 + TopBar 就绪；b-open-with-more 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 目录注入通道（__vvOpenDirImpl；webkitRelativePath 首段 = 组名，只建目录 tab） */
async function openDir(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate(
    ({ n, b }) => {
      const f = new File([new Uint8Array(b)], n, { type: 'application/octet-stream' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `sig/${n}` });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    },
    { n: name, b: Array.from(bytes) }
  );
}

/** 精确名 tab 定位（t-tab-actions tabNamed 同款：.vv-tab-name 子元素锚定） */
function tabNamed(page: Page, name: string): Locator {
  return page
    .locator('.vv-tab')
    .filter({
      has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) })
    });
}

/** 树行点击打开文件 tab（≤900px 抽屉断点适配，b-open-with-more 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible({ timeout: 20_000 });
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（b-open-with-more 同款） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

/** 注入 → 开文件 tab → 断言改派锚（头注校准①②：候选面 rendererId option + value 自动） */
async function openAndAssert(page: Page, name: string, bytes: Uint8Array, rendererId: string): Promise<void> {
  await waitAppMounted(page);
  await openDir(page, name, bytes);
  await openFile(page, name);
  await openRightIfNarrow(page);
  const sel = page.locator('.meta-openwith');
  await expect(sel).toBeVisible({ timeout: 20_000 });
  // 改派锚：候选面出现 dispatch rendererId（软失败 push(rendererId) / 硬失败 det.ext
  // 纠偏扩展名候选，两路同面；20s 与套件负载口径一致）
  await expect(sel.locator(`option[value="${rendererId}"]`)).toHaveCount(1, { timeout: 20_000 });
  // value = override 回显语义（校准①）：自动路由恒「自动」（''），与 SUSP-09 同锚
  await expect(sel).toHaveValue('');
}

test.describe('签名改派扩表（SIG）', () => {
  test('SIG-01 无扩展名 mp4（ftyp isom）→ av', async ({ page }) => {
    test.setTimeout(60_000);
    await openAndAssert(page, 'video', mp4ish(), 'av');
  });

  test('SIG-02 无扩展名 webp → image', async ({ page }) => {
    test.setTimeout(60_000);
    const b = new TextEncoder().encode('RIFF0000WEBPVP8 ') as unknown as Uint8Array;
    await openAndAssert(page, 'photo', b, 'image');
  });

  test('SIG-03 无扩展名 gz → archive', async ({ page }) => {
    test.setTimeout(60_000);
    const b = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff, 1, 2, 3]);
    await openAndAssert(page, 'bundle', b, 'archive');
  });

  test('SIG-04 无扩展名 7z → archive', async ({ page }) => {
    test.setTimeout(60_000);
    const b = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x40]);
    await openAndAssert(page, 'pack', b, 'archive');
  });
});
