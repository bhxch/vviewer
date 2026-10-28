import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 编码探测升级 e2e（议题三，ENC-01~02）：Task 7（d5915e2）UTF-32 BOM 识别 +
 * Task 8（4e70590）chardet 精判分层的端到端实证：
 * - ENC-01 Shift-JIS 文本（无 BOM、非 UTF-8 → 初始判 gb18030）→ 精判翻转
 *   shift_jis，编码行显示 + 解码无乱码；
 * - ENC-02 UTF-32LE BOM（FF FE 00 00 为 FF FE 的前缀包含，Task 7 前置判）→
 *   编码行 utf-32le + 定长解码内容正确。
 *
 * 校准事实（简报锚的实测修正，2026-10-28，Task 8 probe 佐证）：
 * ① ENC-01 fixture 换真 cp932 样本——简报原样本（ASCII 头 + あ×40 的 0x82 0x60）
 *   高度重复字节上 chardet 2.2.0 analyse[0] 实为 windows-1252:98（sbcs Latin
 *   ngram 误报，置信度 0–100 量纲），mbcs Shift_JIS 弱匹配仅 10 分垫底——精判
 *   不会采纳，该 fixture 下断言 shift_jis 必败。改用「日本語のテキスト。
 *   // comment\n」×3 的 cp932 字节（87B，与 packages/core/test/encodingRefine.test.ts
 *   sjisBytes 同源），实测 analyse[0] = Shift_JIS:100 居首（次位 windows-1252:60），
 *   ≥ CONFIDENCE_MIN(90) 且在白名单 → det.encoding 翻转 shift_jis。
 * ② 断言锚：编码行走 .meta-panel 宽锚 toContainText（MetaPanel.svelte 编码行
 *   `<div class="meta-row"><dt>编码</dt><dd>{fileMeta.encoding}</dd></div>`，
 *   fileMeta 由渲染实例 getMeta 上行，dispatcher 在 render 前完成精判——
 *   dispatcher.ts:316 初始精判 + redetectWithFull 同源，无需更窄锚）；内容锚
 *   .vv-code-pre 为 code 域既有用法（t-md/t-hl/b-code-highlight-degrade 同款）。
 *   精判就位后 renderCode 以 shift_jis/utf-32le 解码（decodeText 单源，Task 7），
 *   编码行与内容同帧转绿，两锚无时序分叉。
 * ③ ENC-02 的 utf-32le 精判无关（refineEncoding 门控仅 gb18030）：BOM 直判即定案，
 *   decodeText 剥 BOM 后按 4 字节码元定长解码，非法码点才落 U+FFFD——'AB' 正常。
 *
 * 通道：目录注入经 __vvOpenDirImpl 只建目录 tab（Task 4 经验）——文件 tab 须补树
 * 行点击打开（b-file-detect-signature / b-open-with-more 同款装置）；≤900px 文件
 * 树、≤600px 右栏（MetaPanel）各收进抽屉，经 drawer.ts / openRightIfNarrow 适配；
 * default 套件 chromium+mobile 双 project 全跑。
 */

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 「日本語のテキスト。// comment\n」×3 的 Shift-JIS（cp932）字节（87B）——与
 * encodingRefine.test.ts sjisBytes 同源；Task 8 probe 实测 analyse[0] =
 * [{confidence:100, name:'Shift_JIS', lang:'ja'}, …]。 */
function sjisBytes(): Uint8Array {
  return new Uint8Array([
    0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67,
    0x81, 0x42, 0x2f, 0x2f, 0x20, 0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x0a, 0x93, 0xfa, 0x96,
    0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, 0x81, 0x42, 0x2f,
    0x2f, 0x20, 0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x0a, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea,
    0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, 0x81, 0x42, 0x2f, 0x2f, 0x20, 0x63,
    0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x0a
  ]);
}

/** 等应用挂载（__vvOpenDirImpl 注入钩子 + TopBar 就绪；b-file-detect-signature 同款） */
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
      Object.defineProperty(f, 'webkitRelativePath', { value: `enc/${n}` });
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

/** 树行点击打开文件 tab（≤900px 抽屉断点适配，b-file-detect-signature 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible({ timeout: 20_000 });
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（b-file-detect-signature 同款） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

/** 注入 → 开文件 tab → 断言编码行与解码内容（20s 与套件负载口径一致） */
async function openAndAssert(page: Page, name: string, bytes: Uint8Array, encoding: string, content: string): Promise<void> {
  await waitAppMounted(page);
  await openDir(page, name, bytes);
  await openFile(page, name);
  await openRightIfNarrow(page);
  await expect(page.locator('.meta-panel')).toContainText(encoding, { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toContainText(content, { timeout: 20_000 });
}

test.describe('编码探测升级（ENC）', () => {
  test('ENC-01 Shift-JIS 文本：精判 shift_jis + 无乱码', async ({ page }) => {
    test.setTimeout(60_000);
    // 无 BOM、严格 UTF-8 校验失败 → 初始 gb18030 → chardet 精判 Shift_JIS:100
    // 翻转（校准①）；正确解码必现「日本語のテキスト」，误判解码则为 mojibake
    await openAndAssert(page, 'sjis.txt', sjisBytes(), 'shift_jis', '日本語のテキスト');
  });

  test('ENC-02 UTF-32LE BOM 文件：编码行 utf-32le + 定长解码内容正确', async ({ page }) => {
    test.setTimeout(60_000);
    // BOM（FF FE 00 00）+ 'AB'（41 00 00 00 42 00 00 00）：Task 7 前置判 +
    // decodeText 定长解码（校准③，精判门控不涉 utf-32le）
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0, 0x42, 0, 0, 0]);
    await openAndAssert(page, 'u32.txt', b, 'utf-32le', 'AB');
  });
});
