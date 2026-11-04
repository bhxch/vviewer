import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-diagram-file —— 图表文件渲染器 e2e 锚（DIA-FILE 域五锚，spec
 * 2026-11-04-file-viewer-integration §5.2/§5.3，plan1 Task 6）。Task 5 装配终态：
 * 29 型图表文件渲染器（id diagram-<type>）先于 codeRenderer 安装（generated 补空位
 * 铁律），.dot/.mermaid/.puml 等扩展名不再落代码高亮而走图形渲染。
 *
 * - DIA-FILE-01 .dot 打开即图形渲染：viz-js 本地引擎出 svg、无源码面（抢注锚——
 *   装配序颠倒时 .dot 被 code generated 补空位认领，此锚即红）；
 * - DIA-FILE-02 图/源码切换（html.ts 双视图机制同构移植，类名复用 vv-html-*）：
 *   源码视图含 dot 源文本（renderCode 行视图，无 <pre> 元素——断言 .vv-code 行文本），
 *   切回渲染复现 svg；
 * - DIA-FILE-03 .mermaid 打开：mermaid 本地引擎（npm 依赖）渲染 svg，零网络；
 * - DIA-FILE-04 .puml（defaultMode kroki）双变体：
 *   (a) page.route fulfill kroki img 请求 → img src 指向 kroki host 且命中 mock
 *       （命中计数双保险，b-md-diagrams kroki mock 同款手法）；
 *   (b) kroki.io 与 www.plantuml.com 双 route.abort → kroki img error → M1 官方重试
 *       一跳也败 → 终态源码视图 + 失败提示卡（两跳文案「kroki 与官方服务器渲染失败」，
 *       Task 5 officialTried 文案锚的 e2e 面）；
 * - DIA-FILE-05 big.dot（>2MB 夹具，48000 边链）打开：大小门先行直落源码视图 +
 *   降级卡（标题/阈值明细/文件名 meta），无引擎外呼（kroki/官方零请求）、无工具条
 *   （大小门早于 DOM 骨架创建返回）。
 *
 * 桌面专属（仅 chromium project，b-layout-zen beforeEach 跳过同款）：图表引擎渲染面
 * 视口无关，mobile 375px 复跑同断言只翻倍套件时长无增量覆盖（重引擎 viz-js/mermaid
 * 首渲秒级），不做 mobile 变体。
 *
 * 装置：injectDir + openTreeFile 注入通道（b-md-diagrams/b-diagram-server-kroki 同款，
 * type 显式 text/plain 防默认 text/html 语义混淆）；夹具落 e2e/fixtures/diagram-file/
 * （b-corpus 的 fileURLToPath 解析同款），big.dot 为生成型文本夹具（重复行拼量，
 * 语法可恢复的有效 digraph）。
 */
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/diagram-file', import.meta.url));
const SAMPLE_DOT = readFileSync(join(FIXTURE_DIR, 'sample.dot'), 'utf-8');
const FLOW_MERMAID = readFileSync(join(FIXTURE_DIR, 'flow.mermaid'), 'utf-8');
const PROC_PUML = readFileSync(join(FIXTURE_DIR, 'proc.puml'), 'utf-8');
const BIG_DOT = readFileSync(join(FIXTURE_DIR, 'big.dot'), 'utf-8');

/** kroki/官方双 host abort（环境无关面：真网可达与否不影响回退断言，b-md-diagrams 同款） */
async function abortDiagramRemotes(page: Page): Promise<void> {
  await page.route('**kroki.io/**', (route) => route.abort());
  await page.route('**plantuml.com/**', (route) => route.abort());
}

/** kroki/官方请求收集器（DIA-FILE-05 零外呼锚；先于注入挂载） */
function collectDiagramRemoteRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (/kroki\.io|plantuml\.com/.test(r.url())) hits.push(r.url());
  });
  return hits;
}

/** 注入图表文件并打开，等渲染宿主（.vv-html 类面由 diagramFile 渲染器同步打上）挂载 */
async function openDiagramFile(page: Page, name: string, content: string, waitMs = 20_000): Promise<Locator> {
  await injectDir(page, [{ name, content, type: 'text/plain' }]);
  await openTreeFile(page, name);
  const pane = page.locator('.vv-html');
  await expect(pane).toBeVisible({ timeout: waitMs });
  return pane;
}

test.describe('b-diagram-file 图表文件渲染（DIA-FILE 域五锚）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('DIA-FILE-01 .dot 打开即图形渲染：viz-js 本地出 svg、无源码面（抢注锚）', async ({ page }) => {
    test.setTimeout(60_000);
    await abortDiagramRemotes(page); // 本地引擎环境无关；拦截兜底通道证零 kroki 依赖
    const pane = await openDiagramFile(page, 'sample.dot', SAMPLE_DOT);

    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });
    // 抢注锚：diagram-graphviz 认领 .dot——无 code 源码面、无 kroki img 兜底、渲染钮 active
    await expect(pane.locator('.vv-code')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('.vv-html-btn-rendered')).toHaveClass(/active/);
    await expect(pane.locator('.vv-html-btn-source')).toHaveText('源码');
  });

  test('DIA-FILE-02 图/源码切换：源码视图含 dot 源文本，切回渲染复现 svg', async ({ page }) => {
    test.setTimeout(60_000);
    await abortDiagramRemotes(page);
    const pane = await openDiagramFile(page, 'sample.dot', SAMPLE_DOT);
    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });

    // 切源码：renderCode 行视图（无 <pre>——虚拟滚动行结构），源文本可读。
    // .vv-code 类打在 holder 同一元素上（renderCode 首行 target.classList.add('vv-code')），
    // 非 .vv-degraded-content 的后代——复合选择器锚双类同体
    await pane.locator('.vv-html-btn-source').click();
    const sourceView = pane.locator('.vv-degraded-content.vv-code');
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toContainText('digraph');
    await expect(pane.locator('.vv-html-btn-source')).toHaveClass(/active/);
    await expect(pane.locator('.vv-html-content svg')).toHaveCount(0);

    // 切回渲染：复挂载闭包缓存（切换不重调引擎），svg 重现、源码面卸载
    await pane.locator('.vv-html-btn-rendered').click();
    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });
    await expect(pane.locator('.vv-code')).toHaveCount(0);
  });

  test('DIA-FILE-03 .mermaid 打开：mermaid 本地引擎渲染 svg（零网络）', async ({ page }) => {
    test.setTimeout(120_000);
    await abortDiagramRemotes(page); // mermaid npm 本地引擎，拦截外呼证零网络
    const pane = await openDiagramFile(page, 'flow.mermaid', FLOW_MERMAID);

    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 60_000 });
    await expect(pane.locator('.vv-code')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
  });

  test('DIA-FILE-04a .puml kroki 路径：img src 指向 kroki host 且命中 route mock', async ({ page }) => {
    test.setTimeout(60_000);
    // 拦截须在 goto（injectDir 内）前注册；fulfill 供 img 可见即证走 mock（plantuml
    // defaultMode=kroki，默认 host kroki.io 直发 img），命中计数双保险
    let krokiHits = 0;
    await page.route('**/plantuml/svg/*', (route) => {
      krokiHits += 1;
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
      });
    });
    const pane = await openDiagramFile(page, 'proc.puml', PROC_PUML);

    const img = pane.locator('.vv-html-content img[src^="https://kroki.io/plantuml/svg/"]');
    await expect(img).toBeVisible({ timeout: 30_000 });
    expect(krokiHits).toBeGreaterThanOrEqual(1);
    // 成功路径：无失败卡、无源码面
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    await expect(pane.locator('.vv-code')).toHaveCount(0);
  });

  test('DIA-FILE-04b .puml kroki+官方双 abort：源码回退 + 提示卡（M1 两跳文案回退锚）', async ({ page }) => {
    test.setTimeout(60_000);
    await abortDiagramRemotes(page);
    const pane = await openDiagramFile(page, 'proc.puml', PROC_PUML);

    // 链路：kroki img error → officialServer（plantuml）+ 默认 host → 官方重试一跳
    // 也败 → 终态源码视图 + 失败卡（detail 为两跳文案——单跳失败不含「与官方服务器」）
    const card = pane.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.vv-error-title')).toHaveText('图表渲染失败，已回退源码视图');
    await expect(card.locator('.vv-error-detail')).toContainText('kroki 与官方服务器渲染失败');
    await expect(pane.locator('.vv-html-content .vv-code')).toBeVisible();
    await expect(pane.locator('svg')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
  });

  test('DIA-FILE-05 big.dot（>2MB）打开：直落源码视图 + 降级卡，无引擎外呼', async ({ page }) => {
    test.setTimeout(120_000);
    const remoteHits = collectDiagramRemoteRequests(page);
    const pane = await openDiagramFile(page, 'big.dot', BIG_DOT);

    // 降级卡三件套：标题 / 阈值明细（2MB）/ 文件名 meta
    const card = pane.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.vv-error-title')).toHaveText('图表文件过大，已降级显示');
    await expect(card.locator('.vv-error-detail')).toContainText('2MB');
    await expect(card.locator('.vv-error-meta')).toHaveText('big.dot');
    // 大小门先行：源码视图直挂、渲染面（svg/img）与工具条均不存在（早于 DOM 骨架返回）。
    // 降级路径无 .vv-html-content 骨架（card + holder 直挂 target），holder 即 .vv-code 根
    await expect(pane.locator('.vv-degraded-content.vv-code')).toBeVisible();
    await expect(pane.locator('.vv-code-line').first()).toContainText('digraph');
    await expect(pane.locator('svg')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('.vv-html-toolbar')).toHaveCount(0);
    expect(remoteHits, '大小门先于一切引擎/kroki 路径').toHaveLength(0);
  });
});
