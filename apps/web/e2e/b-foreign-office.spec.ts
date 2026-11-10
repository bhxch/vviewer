import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-foreign-office —— file-viewer 第一波桥接渲染器（SAVE-FOREIGN 域）e2e 锚
 * （spec 2026-11-04-file-viewer-integration §6.3，plan3 Task 5）。
 *
 * 被测面：viewer.ts 装配的 10 组桥接渲染器（id foreign-<group>，diagram 块后、
 * codeRenderer 前——装配序颠倒时下列扩展名被 generated 补空位认领，渲染锚即红）。
 * 首开形态：@file-viewer/* 全动态 import（core+renderer chunk 懒加载），有资产组
 * （word/presentation/spreadsheet/iwork/hangul/chm/wordperfect）另需按 VV_FOREIGN_ASSETS
 * 三层链拉取 worker/wasm（缺省 jsdelivr CDN）——首屏锚时限统一放宽至 45s（懒加载
 * chunk + CDN 资产 + wasm 编译），email/epub/ofd 组渲染器随 dist 打包无资产外呼。
 *
 * 语料：tools/fetch-e2e-corpus.mjs 增源 file-viewer-fixtures（github flyfish-dev/
 * file-viewer 钉 v3.3.3 tag → commit 760038d8，Apache-2.0）——其自带上游夹具按
 * maxPerExtension=1 每扩展名取首个小体量文件，落 e2e/fixtures/corpus/file-viewer-
 * fixtures/（gitignore，本地/CI 由脚本先行拉取）。本 spec 静态声明所需夹具路径，
 * 逐用例 existsSync 守卫：语料未拉取时 skip（b-md-corpus-multisource 缺源容错同款），
 * 语料落地后自动生效。
 *
 * 用例组织（FO 系十锚：FO-00 一致性 + FO-01…FO-09 渲染/切换/错误面/转移/缩放锚）：
 * - FO-00 语料一致性：FIXTURES 表 ⊆ manifest.files（终审 M2——上游 bump 后确定性
 *   选取漂移时各渲染用例会静默 skip，此锚显式红）；
 * - FO-01 Word 组三格式渲染：doc（msdoc 引擎）/ odt（odf 引擎）——presence 锚引擎
 *   容器类（file-viewer 渲染器 dist 的挂载根类名，逐包 dist 实查，见各断言处注）；
 * - FO-02 邮件/电子书组：eml / epub / fb2（epub 组双扩展）；
 * - FO-03 版式/帮助/表格组：ofd / chm（wasm 资产组）/ dbf（xlsx worker 资产组）；
 * - FO-04 iWork/Hangul/WordPerfect 组：pages / hwp / wpd（三组均 wasm/worker 资产组）；
 * - FO-05 open-as 双向切换（rtf）：桥默认渲染 → 状态栏打开方式浮层切 code（rtf 源
 *   文本）→ 切回 Word 文档（foreign 复渲染）——override 双向生效锚；
 * - FO-06 错误文件错误卡：非 CFB 字节命名 .msg → email 渲染器 CFB 签名校验 reject
 *   （msgCfb 'missing CFB signature'）→ dispatcher 错误卡片上位（无渲染器内错误面）；
 * - FO-07 tsv 转移锚：tsv 自 code 内置清单转移至 spreadsheet 桥（T2 同 commit 原子
 *   转移）——打开 tsv 落电子表格桥渲染，code 源码面零出现（装配序回退/code 清单
 *   漏删任一即红）；
 * - FO-08 csv 转移锚：csv 2026-11-10 自 code 内置清单转移至 spreadsheet 桥（默认
 *   电子表格网格面，code 纯文本降 altExtensions 候选）——判据同 FO-07；
 * - FO-09 ctrl+滚轮缩放锚：宿主桥接层（foreignZoom.ts）消费渲染器 zoom provider
 *   ——真实输入链驱动 provider scale 步进/钳界 + preventDefault 拦浏览器整页缩放。
 *
 * 断言口径：presence-based（引擎容器类可见 + code 源码面否定断言），不做引擎内部
 * 深断言——file-viewer 渲染内部结构非本仓契约面。全部经 .vv-viewer-host 作用域
 * （b-save-as 同款宿主锚）。
 *
 * 桌面专属（仅 chromium project，b-save-as/b-diagram-file beforeEach 跳过同款）：
 * 状态栏打开方式浮层与多 tab 交互均为桌面交互面，mobile 375px 复跑无增量覆盖。
 *
 * 注入通道：injectDir + openTreeFile（b-md-corpus-multisource 同款 openFlow
 * openDirectoryViaInput 注入；二进制夹具 readFileSync → b64 直通）。
 */

const CORPUS_ROOT = fileURLToPath(new URL('./fixtures/corpus', import.meta.url));
const SOURCE_ID = 'file-viewer-fixtures';

/** 语料夹具（tools/fetch-e2e-corpus.mjs SOURCES 表 file-viewer-fixtures 源的确定性
 * 选取结果——manifest 同名源逐字核对，2026-11-06 实跑 16 文件；仓内相对路径） */
const FIXTURES = {
  doc: 'apps/viewer-demo/public/example/test.doc',
  odt: 'apps/viewer-demo/public/example/document.odt',
  rtf: 'apps/viewer-demo/public/example/sample.rtf',
  eml: 'apps/viewer-demo/public/example/sample.eml',
  epub: 'apps/viewer-demo/public/example/book.epub',
  fb2: 'apps/viewer-demo/public/example/format-matrix.fb2',
  chm: 'packages/renderers/chm/rust/tests/fixtures/complete.chm',
  ofd: 'apps/viewer-demo/public/example/ofd-resource-paths.ofd',
  dbf: 'apps/viewer-demo/public/example/format-matrix.dbf',
  pages: 'apps/viewer-demo/public/example/apple-pages-09-experimental.pages',
  hwp: 'apps/viewer-demo/public/example/hwplib-image.hwp',
  wpd: 'apps/viewer-demo/public/example/wordperfect-wp6.wpd'
} as const;

/** 夹具注入 MIME（Detection 无 mime 维度——路由纯按扩展名，此处仅语义精确化） */
const MIME: Record<keyof typeof FIXTURES, string> = {
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  eml: 'message/rfc822',
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml',
  chm: 'application/vnd.ms-htmlhelp',
  ofd: 'application/octet-stream',
  dbf: 'application/octet-stream',
  pages: 'application/octet-stream',
  hwp: 'application/octet-stream',
  wpd: 'application/octet-stream'
};

/** 语料在盘判定（目录 gitignore，本地/CI 由 fetch-e2e-corpus.mjs 先行拉取）；
 * 用法 test.skip(!requireFixture(rel), ...) —— b-md-corpus-markpad 容错惯例同款 */
function requireFixture(rel: string): boolean {
  return existsSync(join(CORPUS_ROOT, SOURCE_ID, rel));
}

/** 语料字节 → 注入规格（readFileSync 原始字节 → base64 直通，multisource 同款） */
function fixtureSpec(key: keyof typeof FIXTURES): TextFileSpec {
  const rel = FIXTURES[key];
  const name = rel.split('/').pop()!;
  return {
    name,
    content: '',
    type: MIME[key],
    b64: readFileSync(join(CORPUS_ROOT, SOURCE_ID, rel)).toString('base64')
  };
}

/** 首屏渲染锚时限（懒加载 chunk + CDN 资产 + wasm 编译，见文件头注） */
const FIRST_RENDER_TIMEOUT = 45_000;

/** 一次性注入本用例全部语料夹具（单批单目录——injectDir 内含 page.goto('/')，
 * 逐文件多次注入会反复重载应用），返回各树名（basename，本 spec 夹具名互异）；
 * 打开经 openTreeFile 逐个进行（树行点击 → tab 激活） */
async function injectFixtures(page: Page, keys: Array<keyof typeof FIXTURES>): Promise<string[]> {
  const specs = keys.map(fixtureSpec);
  await injectDir(page, specs);
  return specs.map((s) => s.name);
}

test('FO-00 语料一致性：FIXTURES 表 ⊆ manifest.files（终审 M2，防上游 bump 静默 skip）', () => {
  // fetch-e2e-corpus.mjs 的确定性选取随上游 bump 漂移：文件从 manifest 消失后各渲染
  // 用例的 existsSync 守卫静默 skip（覆盖面空心化无告警）。此锚在 manifest 加载面
  // 显式断言 FIXTURES 每条路径仍被选中——上游漂移即红，倒逼同步 FIXTURES/SOURCES。
  // 不依赖 page（纯文件面断言）；语料未拉取时对容错 skip。
  const manifestPath = join(CORPUS_ROOT, 'manifest.json');
  test.skip(!existsSync(manifestPath), '语料未拉取（fetch-e2e-corpus.mjs 未运行），对语料容错');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sources: Array<{ id: string; files: Array<{ path: string }> }>;
  };
  const source = manifest.sources.find((s) => s.id === SOURCE_ID);
  expect(source, `manifest 缺 ${SOURCE_ID} 源（fetch-e2e-corpus.mjs SOURCES 表漂移）`).toBeDefined();
  const paths = new Set(source!.files.map((f) => f.path));
  for (const [key, rel] of Object.entries(FIXTURES)) {
    expect(
      paths.has(rel),
      `FIXTURES.${key} = ${rel} 不在 manifest.files（上游 bump 后确定性选取漂移——更新 FIXTURES 或调 SOURCES 约束）`
    ).toBe(true);
  }
});

test.describe('b-foreign-office file-viewer 桥接渲染（SAVE-FOREIGN 域）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('FO-01 Word 组渲染：doc 落 msdoc 引擎、odt 落 odf 引擎（无 code 源码面）', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!requireFixture(FIXTURES.doc) || !requireFixture(FIXTURES.odt), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['doc', 'odt']);

    // .doc：legacy 二进制 Word → wordDoc 引擎挂载根 .msdoc-stage（renderer-word
    // dist wordDoc.js 实查）
    await openTreeFile(page, 'test.doc');
    await expect(host.locator('.msdoc-stage')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .odt：OpenDocument → openDocument 引擎挂载根 .odf-shell（openDocumentStyle 实查）
    await openTreeFile(page, 'document.odt');
    await expect(host.locator('.odf-shell')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO-02 邮件/电子书组渲染：eml 落 email 面、epub/fb2 落电子书面（零资产外呼组）', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(
      !requireFixture(FIXTURES.eml) || !requireFixture(FIXTURES.epub) || !requireFixture(FIXTURES.fb2),
      '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错'
    );
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['eml', 'epub', 'fb2']);

    // .eml：email 引擎挂载根 .email-viewer（renderer-email dist emailStyle 实查）
    await openTreeFile(page, 'sample.eml');
    await expect(host.locator('.email-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .epub：epubjs 面挂载根 .epub-viewer（renderer-epub dist 实查）
    await openTreeFile(page, 'book.epub');
    await expect(host.locator('.epub-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .fb2：同组第二扩展名 → fb2 面挂载根 .fb2-viewer
    await openTreeFile(page, 'format-matrix.fb2');
    await expect(host.locator('.fb2-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO-03 版式/帮助/表格组渲染：ofd 落版式面、chm 落帮助面、dbf 落表格面', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(
      !requireFixture(FIXTURES.ofd) || !requireFixture(FIXTURES.chm) || !requireFixture(FIXTURES.dbf),
      '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错'
    );
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['ofd', 'chm', 'dbf']);

    // .ofd：ofd 引擎挂载根 .ofd-stage（renderer-ofd dist ofdStyle 实查）
    await openTreeFile(page, 'ofd-resource-paths.ofd');
    await expect(host.locator('.ofd-stage')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .chm：wasm 资产组（assets-chm）→ chm 面挂载根 .chm-body（renderer-chm dist 实查）
    await openTreeFile(page, 'complete.chm');
    await expect(host.locator('.chm-body')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .dbf：spreadsheet 桥（assets-standard xlsx worker）→ 挂载根 .excel-wrapper
    await openTreeFile(page, 'format-matrix.dbf');
    await expect(host.locator('.excel-wrapper')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO-04 iWork/Hangul/WordPerfect 组渲染：pages/hwp/wpd 各落专有引擎面', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(
      !requireFixture(FIXTURES.pages) || !requireFixture(FIXTURES.hwp) || !requireFixture(FIXTURES.wpd),
      '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错'
    );
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['pages', 'hwp', 'wpd']);

    // .pages：iWork wasm/worker 资产组（assets-iwork）→ 挂载根 .iwork-viewer
    await openTreeFile(page, 'apple-pages-09-experimental.pages');
    await expect(host.locator('.iwork-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .hwp：Hangul wasm 资产组（assets-hangul）→ 挂载根 .hangul-viewer
    await openTreeFile(page, 'hwplib-image.hwp');
    await expect(host.locator('.hangul-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .wpd：WordPerfect wasm 资产组（assets-wordperfect）→ 挂载根 .wpd-viewer
    await openTreeFile(page, 'wordperfect-wp6.wpd');
    await expect(host.locator('.wpd-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO-05 open-as 双向切换（rtf）：桥默认 → code 源码面 → 切回桥复渲染', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!requireFixture(FIXTURES.rtf), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['rtf']);
    await openTreeFile(page, 'sample.rtf');

    // 默认（自动 = 按扩展名）：foreign-word 桥上位（rtf 由 capability-rtf 经 rtf.js
    // 渲染，挂载根 .flyfish-rtf-viewer——renderer-word dist openDocumentStyle 实查）
    await expect(host.locator('.flyfish-rtf-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    const openwith = page.locator('.vv-status-openwith');
    await expect(openwith).toContainText('Word 文档'); // 指示器跟随自动选路的桥 label

    // 状态栏浮层（.vv-status-openwith → .vv-status-picker[role=menu]，OWM-02 同款）：
    // 切 code —— override 即时重渲染出 rtf 源文本（code 面挂载）
    await openwith.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('menuitem', { name: '✓ 自动（按扩展名）' })).toBeVisible(); // 桥默认为自动
    await picker.getByRole('menuitem', { name: '代码/文本' }).click();
    await expect(picker).toHaveCount(0);
    await expect(host.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('.flyfish-rtf-viewer')).toHaveCount(0);
    await expect(openwith).toContainText('代码/文本');

    // 切回：rtf 的扩展名候选 Word 文档 恒在受限浮层（openWithOf ext 候选语义）——
    // 显式选回 foreign 渲染器，override 双向生效
    await openwith.click();
    await expect(picker).toBeVisible();
    await picker.getByRole('menuitem', { name: 'Word 文档' }).click();
    await expect(picker).toHaveCount(0);
    await expect(host.locator('.flyfish-rtf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
    await expect(openwith).toContainText('Word 文档');
  });

  test('FO-06 错误文件错误卡：非 CFB 字节命名 .msg → dispatcher 错误卡片上位', async ({ page }) => {
    test.setTimeout(90_000);
    // 纯文本字节伪装 .msg：email 渲染器 msg 路径经 msgCfb CFB 签名校验 reject
    // （'Invalid Outlook MSG: missing CFB signature'）→ 桥 render 抛出 → 错误卡片
    // （email 组无资产外呼，失败路径快且确定性）
    await injectDir(page, [
      { name: 'broken.msg', content: 'this is definitely not an Outlook MSG compound file', type: 'application/octet-stream' }
    ]);
    await openTreeFile(page, 'broken.msg');

    const card = page.locator('.vv-viewer-host .vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.vv-error-title')).toHaveText('无法预览此文件');
    await expect(card.locator('.vv-error-meta')).toContainText('broken.msg');
    await expect(page.locator('.vv-viewer-host .email-viewer')).toHaveCount(0);
  });

  test('FO-07 tsv 转移锚：tsv 落 spreadsheet 桥而非 code（扩展名转移原子性）', async ({ page }) => {
    test.setTimeout(120_000);
    // tsv 自 code 内置清单移除与 spreadsheet 桥接注册同一 commit（T2 原子转移）：
    // 任一侧回退（装配序颠倒被 generated 抢注 / code 清单漏删双注册冲突）→ 此锚红。
    // 首开需 assets-standard xlsx worker（CDN 资产组），时限按首屏口径放宽
    await injectDir(page, [
      {
        name: 'sample.tsv',
        content: 'name\tage\tcity\nAlice\t30\tBeijing\nBob\t25\tShanghai\n',
        type: 'text/tab-separated-values'
      }
    ]);
    await openTreeFile(page, 'sample.tsv');

    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.excel-wrapper')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0); // code 未抢注（转移锚否定面）
    await expect(page.locator('.vv-status-openwith')).toContainText('电子表格'); // 桥 label 上位
  });

  test('FO-08 csv 转移锚：csv 落 spreadsheet 桥而非 code（2026-11-10 扩展名转移原子性）', async ({ page }) => {
    test.setTimeout(120_000);
    // csv 自 code 内置清单移除与 spreadsheet 桥接注册同一 commit（原子转移，tsv FO-07
    // 同款判据）：任一侧回退（装配序颠倒被 generated 抢注 / code 清单漏删双注册冲突）
    // → 此锚红。上游 renderer 三面实证支持 csv（definitions extensions / worker
    // TEXT_SPREADSHEET_EXTENSIONS / GRID_FORMATS 网格面）。首开需 xlsx worker 资产
    await injectDir(page, [
      {
        name: 'sample.csv',
        content: 'name,age,city\nAlice,30,Beijing\nBob,25,Shanghai\n',
        type: 'text/csv'
      }
    ]);
    await openTreeFile(page, 'sample.csv');

    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.excel-wrapper')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0); // code 降候选未抢注（转移锚否定面）
    await expect(page.locator('.vv-status-openwith')).toContainText('电子表格'); // 桥 label 上位
  });

  test('FO-09 ctrl+滚轮缩放：zoom provider 被宿主接线驱动（放大步进/缩小+钳界/整页缩放拦截）', async ({ page }) => {
    test.setTimeout(120_000);
    // 渲染器把缩放能力注册为 zoom provider（[data-viewer-zoom-provider] 的
    // __flyfishViewerZoomProvider）但不接任何事件——宿主桥接层（foreignZoom.ts）
    // 挂 ctrl+wheel → setZoom 驱动。此前零消费 ⇒ ctrl+滚轮落浏览器默认整页缩放
    // （支持不佳的根因）。锚：真实输入链（键盘 Control + mouse.wheel，CDP 合成
    // 事件带修饰键实况）驱动 provider scale 变化 + 边界钳制 + preventDefault。
    await injectDir(page, [
      { name: 'zoom.csv', content: 'name,age\nAlice,30\nBob,25\nCarol,41\n', type: 'text/csv' }
    ]);
    await openTreeFile(page, 'zoom.csv');

    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.excel-wrapper')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });

    // provider 读取锚（zoom 状态只有 provider 面，无 DOM 可见标签——chrome 不渲染
    // 缩放百分比，renderChrome 实读）
    const readScale = (): Promise<number | null> =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement & { __flyfishViewerZoomProvider?: { getState(): { scale: number } } }>(
          '.vv-viewer-host [data-viewer-zoom-provider]'
        );
        return el?.__flyfishViewerZoomProvider?.getState().scale ?? null;
      });
    await expect.poll(readScale, { timeout: 20_000 }).not.toBeNull();
    const initial = (await readScale()) as number;
    expect(initial).toBeGreaterThan(0);

    // 放大：ctrl+滚轮（真实输入链，事件落点在表格上冒泡至宿主 target 监听）
    await host.locator('.excel-wrapper').hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect.poll(readScale, { timeout: 20_000 }).toBeGreaterThan(initial); // 乘性步进生效

    // 缩小越界：连续下滚钳到 minScale（spreadsheet 0.25），不放行浏览器整页缩放
    await page.keyboard.down('Control');
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, 240);
    await page.keyboard.up('Control');
    await expect
      .poll(readScale, { timeout: 20_000 })
      .toBeLessThan(initial); // 已离开放大态
    expect((await readScale()) as number).toBeGreaterThanOrEqual(0.25); // 钳界（renderer clampZoom）

    // preventDefault 锚：合成 ctrl+wheel 经接线监听被拦截（默认动作=浏览器整页缩放）
    const prevented = await page.evaluate(() => {
      const el = document.querySelector('.vv-viewer-host [data-viewer-zoom-provider]');
      if (!el) return false;
      const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ctrlKey: true, deltaY: -120 });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });
});
