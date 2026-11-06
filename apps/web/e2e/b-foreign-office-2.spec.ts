import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-foreign-office-2 —— file-viewer 第二波桥接渲染器（SAVE-FOREIGN-2 域）e2e 锚
 * （spec 2026-11-04-fv-plan4-foreign-wave2 §6.3 序 12-21，plan4 Task 4；编写 only，
 * 实跑移交统一验证——计划纪律）。
 *
 * 被测面：viewer.ts 装配的第二波 10 组桥接渲染器（foreign-data/design/image/geo/
 * typst/dicom/signature/eda/drawing/midi，装配序仍在 codeRenderer 前——回退时下列
 * 扩展名被 generated/hex/av 认领，渲染锚即红）。首开形态同 FO 系：@file-viewer/*
 * 全动态 import，data/design/typst/drawing 四组另需按 FOREIGN_GROUP_ASSET_PACKAGE
 * 拉 CDN 资产（sql wasm 669KB / photoshop worker / typst 编译器 wasm 27MB〔超 20MB
 * 备案项〕/ drawio viewer-static 3.9MB）；image/geo/dicom/signature/eda/midi 组自
 * 包含零资产外呼。
 *
 * 语料：tools/fetch-e2e-corpus.mjs 增源 file-viewer-fixtures-2（同仓同 commit
 * 760038d8 = v3.3.3 tag，Apache-2.0）——第二波绑定面上游有小体量夹具的 19 扩展名
 * 按 maxPerExtension=1 圈定，实测 18 文件 ~243KB，落 e2e/fixtures/corpus/
 * file-viewer-fixtures-2/（gitignore，本地/CI 由脚本先行拉取）。本 spec 静态声明
 * 所需夹具路径，逐用例 existsSync 守卫：语料未拉取时 skip（b-foreign-office 同款）。
 * 上游误名文件排除注记：pic.tif/pic.tiff 实为 PNG 字节（走 <img> 原生解码，Chromium
 * 无 TIFF 支持恒错误卡）——tif 锚取 multipage-ccitt-g4.tif（G4 压缩经 utif decodeG4
 * 本地实核解码通过）。
 *
 * 用例组织（FO2 系十三锚 + FO2-00 一致性）：
 * - FO2-00 语料一致性：FIXTURES 表 ⊆ manifest.files（FO-00 同款终审 M2 锚）；
 * - FO2-01 data 组渲染：sqlite（sql.js WASM）/ wasm（WebAssembly.Module 纯 JS）——
 *   挂载根 .data-viewer（renderer-data dist data.js 实查，全 data-asset 类型共用）；
 * - FO2-02 wasm 转移锚（双向）：wasm 自 hex 清单移除（plan4 T2 同 commit 原子转移）
 *   → 默认落 foreign-data 桥（.vv-hex 否定）→ open-as 切 hex（.vv-hex）→ 切回桥
 *   复渲染——byExtension 单 owner + hex open-as 兜底双向锚（FO-05 同款浮层流程）；
 * - FO2-03 字体查看锚：ttf 落 data 桥 FontFace 预览面（.font-preview）且 fonts
 *   store 零写入（style#vv-font 无桥接 family 前缀——T2「桥接源零 fontsStore 引用」
 *   单元锚的 e2e 面）；
 * - FO2-04 design 组渲染：psd 落 photoshop 引擎 .psd-viewer（renderer-design dist
 *   photoshop.js 实查；psd 经 T3 wireDesignOrDataSeam 走 renderFileViewerDesign
 *   高保真而非 data 基础视图——缝回退即红）；
 * - FO2-05 image 组渲染：tif 落 tiff 引擎 .image-viewer.tiff-viewer（renderer-image
 *   dist tiff.js 实查；UTIF G4 多页解码）；
 * - FO2-06 geo 组转移锚：geojson/kml/gpx 自 code 兜底转移至 geo 桥（T2 同 commit
 *   原子转移）——.geo-viewer（renderer-geo dist 实查）+ code 源码面否定 + 桥 label；
 * - FO2-07 typst 组渲染：typ 落 typst 引擎 .typst-viewer（renderer-typst dist 实查；
 *   assets-typst 编译器 wasm 27MB 超限备案项——实跑耗时以此锚为最）；
 * - FO2-08 dicom 组渲染：dcm 落 dicom 引擎 .dicom-viewer（renderer-dicom dist 实查）；
 * - FO2-09 signature 组渲染：p7m 落签名检查面 .signature-shell（renderer-signature
 *   dist 实查；CMS/ASN1 纯 JS 路径，零 worker 依赖）；
 * - FO2-10 signature 失败面锚：非 ASN1 字节命名 .p7s → 渲染器 shell 内错误面
 *   .signature-error（dist 实核：renderInspection 顶层 catch 就地渲染——T2 报告
 *   「失败形态 = 错误卡」假定修正为 in-renderer 错误面；dispatcher 错误卡仅容器
 *   超限等 handler reject 面可达）——不白屏/不悬挂语义锚；
 * - FO2-11 eda 组渲染：gds（GDSII 流）/ olb（OrCAD CFB）双解析路径落 .eda-viewer
 *   （renderer-eda dist 实查）；
 * - FO2-12 eda 失败面锚：非 CFB 字节命名 .olb → parseEdaFile 恒 binary fallback
 *   不 reject（dist 实核）→ .eda-viewer 容错面挂载（不白屏/不悬挂语义锚）；
 * - FO2-13 drawing 组渲染：drawio 落 .drawing-viewer（renderer-drawing dist 实查；
 *   装配启用 capability-drawio-official——官方运行时 iframe.drawing-mxgraph 为预期
 *   内部面，CDN 资产超时回退内置 SVG 时壳不变，锚以壳为口径不绑 iframe）；
 * - FO2-14 midi 组转移锚：mid 自 av 清单转移至 midi 面（capability-midi →
 *   renderer-media audio handler midi 路径）——.fv-midi-viewer（renderer-media dist
 *   audio.js 实查）+ av 否定 + 桥 label。
 *
 * 降级记录（无上游小体量夹具 → 无渲染锚，plan4 task-4 报告清单）：data 组
 * parquet/avro/webarchive、image 组 heic/heif、geo 组 shp、signature 组其余 16
 * 扩展名、drawing 组 dio——渲染面由各自 dist 同构路径（data-asset 单壳/heic2any/
 * togeojson/CMS/官方运行时）覆盖代理。
 *
 * 断言口径：presence-based（引擎容器类可见 + code/hex/av 否定断言），不做引擎内部
 * 深断言——file-viewer 渲染内部结构非本仓契约面。全部经 .vv-viewer-host 作用域
 * （b-save-as/FO 系同款宿主锚）。
 *
 * 桌面专属（仅 chromium project，b-foreign-office 同款）：状态栏打开方式浮层与多
 * tab 交互均为桌面交互面，mobile 375px 复跑无增量覆盖。
 *
 * 注入通道：injectDir + openTreeFile（b-foreign-office 同款；二进制夹具
 * readFileSync → b64 直通）。
 */

const CORPUS_ROOT = fileURLToPath(new URL('./fixtures/corpus', import.meta.url));
const SOURCE_ID = 'file-viewer-fixtures-2';

/** 语料夹具（tools/fetch-e2e-corpus.mjs SOURCES 表 file-viewer-fixtures-2 源的确定性
 * 选取结果——manifest 同名源逐字核对，2026-11-06 实跑 18 文件；仓内相对路径）。
 * oas/oasis/dra 落语料但渲染锚未用（与 gds 同解析族，报告降级注记）——FO2-00 仅
 * 断言本表子集。 */
const FIXTURES = {
  psd: 'apps/viewer-demo/public/example/design.psd',
  sqlite: 'apps/viewer-demo/public/example/sample.sqlite',
  wasm: 'apps/viewer-demo/public/example/module.wasm',
  ttf: 'apps/viewer-demo/public/vendor/drawio/styles/fonts/ArchitectsDaughter-Regular.ttf',
  geojson: 'apps/viewer-demo/public/example/en/map.geojson',
  kml: 'apps/viewer-demo/public/example/route.kml',
  gpx: 'apps/viewer-demo/public/example/track.gpx',
  typ: 'apps/viewer-demo/public/example/report.typ',
  dcm: 'apps/viewer-demo/public/example/ct-small.dcm',
  drawio: 'apps/viewer-demo/public/example/process.drawio',
  mid: 'apps/viewer-demo/public/example/melody.mid',
  olb: 'apps/viewer-demo/public/example/sample.olb',
  gds: 'apps/viewer-demo/public/example/layout.gds',
  p7m: 'apps/viewer-demo/public/example/signature-invoice-cades-bes.pdf.p7m',
  tif: 'apps/viewer-demo/public/example/multipage-ccitt-g4.tif'
} as const;

/** 夹具注入 MIME（Detection 无 mime 维度——路由纯按扩展名，此处仅语义精确化） */
const MIME: Record<keyof typeof FIXTURES, string> = {
  psd: 'image/vnd.adobe.photoshop',
  sqlite: 'application/vnd.sqlite3',
  wasm: 'application/wasm',
  ttf: 'font/ttf',
  geojson: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
  gpx: 'application/gpx+xml',
  typ: 'text/x-typst',
  dcm: 'application/dicom',
  drawio: 'application/xml',
  mid: 'audio/midi',
  olb: 'application/octet-stream',
  gds: 'application/octet-stream',
  p7m: 'application/pkcs7-mime',
  tif: 'image/tiff'
};

/** 语料在盘判定（目录 gitignore，本地/CI 由 fetch-e2e-corpus.mjs 先行拉取）；
 * 用法 test.skip(!requireFixture(rel), ...) —— b-foreign-office 容错惯例同款 */
function requireFixture(rel: string): boolean {
  return existsSync(join(CORPUS_ROOT, SOURCE_ID, rel));
}

/** 语料字节 → 注入规格（readFileSync 原始字节 → base64 直通，FO 系同款） */
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

test('FO2-00 语料一致性：FIXTURES 表 ⊆ manifest.files（终审 M2，防上游 bump 静默 skip）', () => {
  // FO-00 同款：fetch-e2e-corpus.mjs 的确定性选取随上游 bump 漂移——文件从 manifest
  // 消失后各渲染用例的 existsSync 守卫静默 skip（覆盖面空心化无告警），此锚显式红。
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

test.describe('b-foreign-office-2 file-viewer 第二波桥接渲染（SAVE-FOREIGN-2 域）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('FO2-01 data 组渲染：sqlite 落 sql.js WASM 面、wasm 落模块结构面（无 code 源码面）', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!requireFixture(FIXTURES.sqlite) || !requireFixture(FIXTURES.wasm), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['sqlite', 'wasm']);

    // .sqlite：renderSqlite → sql.js（assets-data CDN sql-wasm.wasm）→ 挂载根
    // .data-viewer（renderer-data dist data.js renderPreviewDom 实查）
    await openTreeFile(page, 'sample.sqlite');
    await expect(host.locator('.data-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .wasm：renderWasm → WebAssembly.Module imports/exports 解析（纯 JS 零资产）
    // → 同挂载根 .data-viewer；hex 已自默认清单移除（plan4 T2 原子转移）——
    // .vv-hex 否定面（正向转移锚在 FO2-02）
    await openTreeFile(page, 'module.wasm');
    await expect(host.locator('.data-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-hex')).toHaveCount(0);
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-02 wasm 转移锚（双向）：默认落 data 桥 → open-as 切 hex → 切回桥复渲染', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(!requireFixture(FIXTURES.wasm), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['wasm']);
    await openTreeFile(page, 'module.wasm');

    // 默认（自动 = 按扩展名）：foreign-data 桥上位（wasm 自 hex 清单移除——hex 不再
    // 默认认领，.vv-hex 否定面）
    await expect(host.locator('.data-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-hex')).toHaveCount(0);
    const openwith = page.locator('.vv-status-openwith');
    await expect(openwith).toContainText('数据与字体'); // 指示器跟随自动选路的桥 label

    // 状态栏浮层（.vv-status-openwith → .vv-status-picker[role=menu]，FO-05 同款）：
    // 切 hex —— override 即时重渲染出 hex 面（hex 保留 open-as 兜底，用户拍板项）
    await openwith.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('menuitem', { name: '✓ 自动（按扩展名）' })).toBeVisible(); // 桥默认为自动
    await picker.getByRole('menuitem', { name: '二进制' }).click();
    await expect(picker).toHaveCount(0);
    await expect(host.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('.data-viewer')).toHaveCount(0);
    await expect(openwith).toContainText('二进制');

    // 切回：wasm 的扩展名候选 数据与字体 恒在受限浮层（openWithOf ext 候选语义）——
    // 显式选回 foreign-data 桥，override 双向生效
    await openwith.click();
    await expect(picker).toBeVisible();
    await picker.getByRole('menuitem', { name: '数据与字体' }).click();
    await expect(picker).toHaveCount(0);
    await expect(host.locator('.data-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('.vv-hex')).toHaveCount(0);
    await expect(openwith).toContainText('数据与字体');
  });

  test('FO2-03 字体查看锚：ttf 落 data 桥 FontFace 预览面且 fonts store 零写入', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(!requireFixture(FIXTURES.ttf), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['ttf']);
    await openTreeFile(page, 'ArchitectsDaughter-Regular.ttf');

    // .ttf：renderFont → FontFace API 就地加载 → .data-viewer 壳 + .font-preview
    // 样张面（renderer-data dist data.js 实查）——桥接查看面（fonts store 加载职责
    // 不动，spec §6.3 序 12）
    await expect(host.locator('.data-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.data-viewer .font-preview')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // fonts store 零写入：桥接 family（FlyfishPreviewFont-* 前缀）只进 document.fonts
    // （FontFace 预览），不得出现在 fonts store 应用面 style#vv-font（b-fonts
    // textContent 口径）——双向断言（正：预览 face 就位；负：store 面无泄漏）
    const faceLoaded = await page.evaluate(() => {
      let found = false;
      document.fonts.forEach((face) => {
        if (face.family.startsWith('FlyfishPreviewFont-')) found = true;
      });
      return found;
    });
    expect(faceLoaded, '桥接字体未经 FontFace API 预览（.font-preview 已渲染却无 face）').toBe(true);
    const vvFontText = await page.evaluate(() => document.getElementById('vv-font')?.textContent ?? '');
    expect(vvFontText).not.toContain('FlyfishPreviewFont');
  });

  test('FO2-04 design 组渲染：psd 落 photoshop 引擎高保真面（designOrData 缝正面）', async ({ page }) => {
    test.setTimeout(240_000); // assets-design CDN（photoshop worker 等）+ wasm 编译
    test.skip(!requireFixture(FIXTURES.psd), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['psd']);
    await openTreeFile(page, 'design.psd');

    // .psd：foreign-design 组经 wireDesignOrDataSeam（plan4 T3）把 data-asset handler
    // 换成 renderFileViewerDesignOrData——psd 命中 renderFileViewerDesign 高保真
    // （photoshop.js）→ 挂载根 .psd-viewer；缝回退（裸 renderFileViewerData 基础
    // 视图）时落 .data-viewer，此锚即红
    await expect(host.locator('.psd-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.data-viewer')).toHaveCount(0);
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-05 image 组渲染：tif 落 tiff 引擎多页面（UTIF G4 解码）', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!requireFixture(FIXTURES.tif), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['tif']);
    await openTreeFile(page, 'multipage-ccitt-g4.tif');

    // .tif：hasTiffSignature → renderTiff（UTIF）→ 挂载根 .image-viewer.tiff-viewer
    // + .tiff-stage 多页舞台（renderer-image dist tiff.js 实查；本地 node 侧 utif
    // decodeG4 实核 2 页 2480x3507 解码通过）
    await expect(host.locator('.image-viewer.tiff-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.tiff-stage')).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-06 geo 组转移锚：geojson/kml/gpx 落 geo 桥而非 code（扩展名转移原子性）', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(
      !requireFixture(FIXTURES.geojson) || !requireFixture(FIXTURES.kml) || !requireFixture(FIXTURES.gpx),
      '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错'
    );
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['geojson', 'kml', 'gpx']);

    // .geojson：自 code 兜底转移至 geo 桥（T2 同 commit 原子转移）→ 挂载根
    // .geo-viewer（renderer-geo dist geo.js 实查）+ code 源码面否定 + 桥 label
    await openTreeFile(page, 'map.geojson');
    await expect(host.locator('.geo-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0); // code 未抢注（转移锚否定面）
    await expect(page.locator('.vv-status-openwith')).toContainText('地理数据');

    // .kml / .gpx：@tmcw/togeojson 同壳渲染（geo 组其余绑定扩展同构路径）
    await openTreeFile(page, 'route.kml');
    await expect(host.locator('.geo-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await openTreeFile(page, 'track.gpx');
    await expect(host.locator('.geo-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-07 typst 组渲染：typ 落 typst 引擎排版面（assets-typst 27MB 备案项）', async ({ page }) => {
    test.setTimeout(300_000); // assets-typst 编译器 wasm 27MB（jsdelivr）+ 渲染器 wasm + 字体
    test.skip(!requireFixture(FIXTURES.typ), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['typ']);
    await openTreeFile(page, 'report.typ');

    // .typ：renderFileViewerTypst（typst_ts_web_compiler_bg.wasm 27MB 超限备案 +
    // typst_ts_renderer_bg.wasm）→ 挂载根 .typst-viewer（renderer-typst dist 实查）
    await expect(host.locator('.typst-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-08 dicom 组渲染：dcm 落 dicom 影像面', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!requireFixture(FIXTURES.dcm), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['dcm']);
    await openTreeFile(page, 'ct-small.dcm');

    // .dcm：renderFileViewerDicom（dicom-parser + decode-worker 随 dist）→ 挂载根
    // .dicom-viewer（renderer-dicom dist dicom.js 实查）
    await expect(host.locator('.dicom-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-09 signature 组渲染：p7m 落签名检查面（CMS/ASN1 纯 JS 路径）', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(!requireFixture(FIXTURES.p7m), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['p7m']);
    await openTreeFile(page, 'signature-invoice-cades-bes.pdf.p7m');

    // .p7m：inspectSignatureContainer（ASN1 纯 JS，零 worker）→ 挂载根
    // .signature-shell（renderer-signature dist signature.js 实查）
    await expect(host.locator('.signature-shell')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-10 signature 失败面锚：非 ASN1 字节命名 .p7s → shell 内 .signature-error（不白屏）', async ({ page }) => {
    test.setTimeout(60_000);
    // 纯文本字节伪装 .p7s（FO-06 注入同款）：inspectSignatureContainer ASN1 解析
    // throw（本地 node 实核 'ASN.1 length extends beyond its parent.'）→
    // renderInspection 顶层 catch 就地渲染 .signature-error（dist 实核：T2 报告
    // 「失败形态 = 错误卡」假定修正为 in-renderer 错误面）——失败不白屏/不悬挂
    await injectDir(page, [
      { name: 'broken.p7s', content: 'this is definitely not a PKCS#7 signature structure', type: 'application/pkcs7-mime' }
    ]);
    await openTreeFile(page, 'broken.p7s');

    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.signature-shell')).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('.signature-shell .signature-error')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('.vv-error-card')).toHaveCount(0); // shell 挂载后 handler 不 reject
  });

  test('FO2-11 eda 组渲染：gds/olb 双解析路径落 eda 面', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!requireFixture(FIXTURES.gds) || !requireFixture(FIXTURES.olb), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');

    await injectFixtures(page, ['gds', 'olb']);

    // .gds：GDSII 流解析路径 → 挂载根 .eda-viewer（renderer-eda dist eda.js 实查）
    await openTreeFile(page, 'layout.gds');
    await expect(host.locator('.eda-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);

    // .olb：OrCAD CFB 容器解析路径（eda-orcad）→ 同挂载根 .eda-viewer
    await openTreeFile(page, 'sample.olb');
    await expect(host.locator('.eda-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-12 eda 失败面锚：非 CFB 字节命名 .olb → binary fallback 容错面（不白屏）', async ({ page }) => {
    test.setTimeout(60_000);
    // parseEdaFile 恒不 reject（dist 实核：isOrcadCompoundFile 不命中直接
    // parseBinaryFallback；CFB 命中但解析失败也回退 fallback）→ dispatcher 错误卡
    // 对 eda 不可达——失败语义 = 容错壳面照常挂载（不白屏/不悬挂）
    await injectDir(page, [
      { name: 'broken.olb', content: 'this is definitely not an OrCAD compound file', type: 'application/octet-stream' }
    ]);
    await openTreeFile(page, 'broken.olb');

    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.eda-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('.vv-error-card')).toHaveCount(0); // fallback 面而非错误卡
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-13 drawing 组渲染：drawio 落 drawing 图表面（官方运行时首选）', async ({ page }) => {
    test.setTimeout(240_000); // assets-drawing CDN（viewer-static.min.js 3.9MB + 离线资产）
    test.skip(!requireFixture(FIXTURES.drawio), '语料文件缺失（fetch-e2e-corpus.mjs 未拉取），对语料容错');
    const host = page.locator('.vv-viewer-host');
    await injectFixtures(page, ['drawio']);
    await openTreeFile(page, 'process.drawio');

    // .drawio：renderFileViewerDrawing → 挂载根 .drawing-viewer（renderer-drawing
    // dist drawing.js 实查）。装配启用 capability-drawio-official → 官方运行时
    // iframe.drawing-mxgraph 为预期内部面；CDN 资产超时回退内置 SVG 时壳不变
    // （DRAWIO_OFFICIAL_TIMEOUT → renderDrawioFallback）——锚以壳为口径不绑 iframe
    await expect(host.locator('.drawing-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('FO2-14 midi 组转移锚：mid 落 midi 面而非 av（扩展名转移原子性）', async ({ page }) => {
    test.setTimeout(90_000);
    // mid/midi 自 av 清单移除与 capability-midi 注册同 commit（T2 原子转移）：
    // 任一侧回退（av 抢注 / foreign-midi 漏装）→ 此锚红。capability-midi →
    // renderer-media audio handler midi 路径 → .fv-midi-viewer（renderer-media
    // dist audio.js 实查）；av 无 mid/midi（T2 单元锚）的 e2e 面 = 无音频播放器面
    await injectFixtures(page, ['mid']);
    await openTreeFile(page, 'melody.mid');

    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.fv-midi-viewer')).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT });
    await expect(host.locator('audio.vv-av')).toHaveCount(0); // av 未抢注（转移锚否定面，av.ts 音频面类）
    await expect(host.locator('.vv-code-pre')).toHaveCount(0);
    await expect(page.locator('.vv-status-openwith')).toContainText('MIDI 音乐'); // 桥 label 上位
  });
});
