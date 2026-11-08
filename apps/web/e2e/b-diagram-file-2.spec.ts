import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-diagram-file-2 —— 图表文件渲染器（29 型 / 33 扩展名）e2e 扩面锚（DIA 域）。
 *
 * 域文档：docs/e2e/diagram-file-renderers.md（场景清单 / 验收行为 / 环境与数据）。
 * 实现锚：packages/vviewer-render-text/src/diagramFile.ts
 *   —— 注册面 DIAGRAM_FILE_EXTS:59-89（29 型 → 扩展名逐字映射）
 *   —— 大小门 DIAGRAM_MAX_BYTES:49（判据 `>` 严格大于）+ 降级卡:203-243
 *   —— 模式裁决 resolveEffectiveMode:132-149（source 档直接落源码，不建工具条）
 *   —— DOM 骨架与工具条:268-288（mode!=='source' 才建 toolbar）
 *   —— kroki 挂载链与失败文案分档:380-413（单跳 `kroki 渲染失败（图片加载错误）：<id>`
 *      / 两跳 `kroki 与官方服务器渲染失败…`）
 *   —— official→kroki 回落:415-437（officialImgError 链）
 *   —— 产出物消毒 sanitizeDiagramFragment:327（server 档）/:347（本地引擎档）
 * 注册表：packages/vviewer-render-diagram/src/markdown/diagrams.ts:39-74（各型
 *   local/defaultMode/krokiType/officialServer 旗标）
 * CDN 引擎：packages/vviewer-render-diagram/src/markdown/cdnEngines.ts（各型
 *   jsdelivr +esm 直链 URL 与调用面）
 * kroki / PlantUML 编码：diagrams.ts:106-114（官方：deflateRaw + 自定义字母表）、
 *   :120-128（kroki：deflate + base64url 无填充）
 *
 * 与既有锚的分工（不重复）：
 *   - b-diagram-file.spec.ts DIA-FILE-01~05：graphviz（抢注/双视图切换）、mermaid
 *     （本地引擎）、plantuml（kroki 成功 / kroki+官方双跳两跳文案）、>10MB 降级。
 *   - b-cdn-diagram-engines.spec.ts CDN-01~04 与 b-diagram-server-kroki.spec.ts
 *     DSV-04/06 走 **markdown 围栏管线**（.md-diagram-view 面，pipeline.ts）；
 *     本文件走 **图表文件渲染器**（.vv-html 面，diagramFile.ts 自有降级链）——
 *     两条链不同面，不互认覆盖。
 *
 * 拦截面纪律（域文档 §5）：第三方请求一律经 **context.route**（不是 page.route）——
 *   SW（vite-plugin-pwa autoUpdate + clientsClaim）接管后，page.route 拦不到经 SW
 *   发出的 jsdelivr 请求（探针 P-A：page.route 命中 0、请求真出网；P-B：改
 *   context.route 命中 1）。请求台账在 route 命中处记账——route 命中即请求确曾
 *   发出，计数不依赖 SW 是否把请求转发到页面网络栈（避免「计数恒 0」的假绿）。
 *   凡依赖外域的用例一律先挂拦截面：命中 mock（fulfill）或 abort，绝不裸依赖真网。
 *
 * 桌面专属：图表引擎渲染面与视口无关，mobile 375px 复跑只翻倍套件时长不增覆盖
 *   （同 b-diagram-file.spec.ts / b-save-as 既有写法）。
 */

/** 第三方主机判定（kroki.io / cdn.jsdelivr.net / plantuml.com）——拦截与计数只认这三家 */
const THIRD_PARTY_RE = /kroki\.io|cdn\.jsdelivr\.net|plantuml\.com/;

/**
 * 同源服务端代理面（`/api/compute/diagram` 与 `/api/kroki`）——server 档与
 * krokiVia=server 的唯一外呼通道（diagramFile.ts:317-330）。default 套件无服务端
 * 连接，该面本不该有请求；命中即记账并 abort（防真发 + 计数为硬证据）。
 */
const SERVER_API_RE = /\/api\/(compute|kroki)/;

/** kroki mock 应答（最小 svg；与 b-cdn-diagram-engines 的 SVG_BODY 同串） */
const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

/** plantuml 夹具（复用 b-diagram-file.spec.ts 同款 proc.puml） */
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/diagram-file', import.meta.url));
const PROC_PUML = readFileSync(join(FIXTURE_DIR, 'proc.puml'), 'utf-8');

/**
 * 假 dbml 引擎模块（ESM 源，jsdelivr +esm 直链的替身）——调用面镜像
 * cdnEngines.ts:129-134（`mod.run(src, 'svg')` 同步直出字符串）。产物故意带
 * 脏 payload：`<script>`（副作用）与 `onclick`（事件属性）——本地引擎档是唯一
 * 可离线注入脏 HTML 的入口（server 档需 release 二进制、kroki 档走 img 不产 HTML）。
 * 矩形铺满整块 svg：点击落点必然命中 rect（text 只占左侧一角），onclick 若存活
 * 必被触发——「副作用不发生」这条断言才不是恒真。
 */
const FAKE_DBML_MODULE = `export function run(src, fmt) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60">'
    + '<script>window.__vvDiaPwned = 1;</script>'
    + '<rect x="0" y="0" width="200" height="60" fill="#eeeeee" onclick="window.__vvDiaPwned = 2"/>'
    + '<text x="12" y="36">hello</text>'
    + '</svg>';
}
`;

/** 第三方拦截动作：abort（断链）/ kroki-svg（kroki 命中 mock）/ es-module（CDN 命中假 ESM） */
type ThirdPartyAction = 'abort' | 'kroki-svg' | 'es-module';

/**
 * 第三方拦截面（context.route）+ 请求台账。
 * 命中即记账（URL 原样入账）——「零请求」与「命中 mock」两态断言都以此为凭据。
 */
async function mockThirdParty(
  context: BrowserContext,
  decide: (url: string) => ThirdPartyAction
): Promise<string[]> {
  const urls: string[] = [];
  await context.route(THIRD_PARTY_RE, async (route) => {
    const url = route.request().url();
    urls.push(url);
    const action = decide(url);
    if (action === 'kroki-svg') {
      await route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY });
      return;
    }
    if (action === 'es-module') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        headers: { 'access-control-allow-origin': '*' },
        body: FAKE_DBML_MODULE
      });
      return;
    }
    await route.abort();
  });
  return urls;
}

/**
 * 服务端代理请求台账（/api/compute 与 /api/kroki）——命中即记账（请求确曾发出的
 * 凭据），并 abort 兜底（default 套件无服务端，不该有此类请求）。
 */
async function countServerApi(context: BrowserContext): Promise<string[]> {
  const urls: string[] = [];
  await context.route(SERVER_API_RE, async (route) => {
    urls.push(route.request().url());
    await route.abort();
  });
  return urls;
}

/**
 * settings 预注入（loadSettings 白名单直读；须先于 goto 注册，b-cdn-diagram-engines
 * / b-diagram-server-kroki 同款）。modes 的键取注册表 id、值取五枚举之一
 * （stores/settings.ts:170-175 白名单）。
 */
function injectSettings(page: Page, settings: Record<string, unknown>): void {
  void page.addInitScript((s) => {
    localStorage.setItem('vviewer:settings', JSON.stringify(s));
  }, settings);
}

/** 注入单个图表文件并打开（type 显式 text/plain 防默认语义混淆），等渲染宿主挂载 */
async function openDiagramFile(page: Page, name: string, content: string): Promise<Locator> {
  await injectDir(page, [{ name, content, type: 'text/plain' }]);
  await openTreeFile(page, name);
  const pane = page.locator('.vv-html');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  return pane;
}

/**
 * 合成指定字节数的文本夹具：每行 80 字符 + 换行 = 81 字节，末行补齐到精确字节数。
 * 多行短行而非单行巨串——虚拟滚动只渲染可视区行，单行 10MB 巨串会把布局面压垮
 * （生成型合成思路；原 2.2MB 静态 big.dot 夹具已随 10MB 门扩容删除）。
 */
function synthDiagramText(totalBytes: number): string {
  const line = 'a'.repeat(80) + '\n'; // 81 字节
  const full = Math.floor(totalBytes / 81);
  const rest = totalBytes - full * 81; // 0..80
  let out = line.repeat(full);
  if (rest > 0) out += 'a'.repeat(rest - 1) + '\n';
  return out;
}

/** kroki-only 15 型（注册表 krokiType=id；umlet→.uxf / structurizr→.dsl 为造名扩展名） */
const KROKI_ONLY_TYPES: ReadonlyArray<{ id: string; ext: string; krokiType: string }> = [
  { id: 'pikchr', ext: 'pikchr', krokiType: 'pikchr' },
  { id: 'ditaa', ext: 'ditaa', krokiType: 'ditaa' },
  { id: 'blockdiag', ext: 'blockdiag', krokiType: 'blockdiag' },
  { id: 'nwdiag', ext: 'nwdiag', krokiType: 'nwdiag' },
  { id: 'actdiag', ext: 'actdiag', krokiType: 'actdiag' },
  { id: 'seqdiag', ext: 'seqdiag', krokiType: 'seqdiag' },
  { id: 'erd', ext: 'erd', krokiType: 'erd' },
  { id: 'structurizr', ext: 'dsl', krokiType: 'structurizr' },
  { id: 'tikz', ext: 'tikz', krokiType: 'tikz' },
  { id: 'umlet', ext: 'uxf', krokiType: 'umlet' },
  { id: 'goat', ext: 'goat', krokiType: 'goat' },
  { id: 'wireviz', ext: 'wireviz', krokiType: 'wireviz' },
  { id: 'packetdiag', ext: 'packetdiag', krokiType: 'packetdiag' },
  { id: 'rackdiag', ext: 'rackdiag', krokiType: 'rackdiag' },
  { id: 'symbolator', ext: 'symbolator', krokiType: 'symbolator' }
];

/**
 * CDN 本地引擎 8 型：注册表 local=true + engine=<CDN 直链引擎>（diagrams.ts:52-70）。
 * token = 该型自己的 jsdelivr 包名（cdnEngines.ts 各实现行的 URL 片段）——因果锚：
 * 证「曾试的是本型引擎包」而非别的型的包。krokiType = 注册表 krokiType（回退段）。
 */
const CDN_ENGINE_TYPES: ReadonlyArray<{
  id: string;
  ext: string;
  token: string;
  krokiType: string;
  content: string;
}> = [
  {
    id: 'excalidraw',
    ext: 'excalidraw',
    token: '@excalidraw/utils',
    krokiType: 'excalidraw',
    content: '{"type":"excalidraw","elements":[],"appState":{},"files":{}}'
  },
  {
    id: 'bpmn',
    ext: 'bpmn',
    token: 'bpmn-js',
    krokiType: 'bpmn',
    content: '<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>\n'
  },
  {
    id: 'vega',
    ext: 'vega',
    token: 'vega-embed',
    krokiType: 'vega',
    content: '{"$schema":"https://vega.github.io/schema/vega-lite/v5.json","data":{"values":[]}}'
  },
  {
    id: 'vegalite',
    ext: 'vl',
    token: 'vega-embed',
    krokiType: 'vegalite',
    content: '{"$schema":"https://vega.github.io/schema/vega-lite/v5.json","data":{"values":[]}}'
  },
  {
    id: 'wavedrom',
    ext: 'wavedrom',
    token: 'wavedrom',
    krokiType: 'wavedrom',
    content: '{ "signal": [ { "name": "clk", "wave": "p.....", "data": "0" } ] }'
  },
  {
    id: 'bytefield',
    ext: 'bytefield',
    token: 'bytefield-svg',
    krokiType: 'bytefield',
    content: '(draw-box "A" 4)\n'
  },
  {
    id: 'dbml',
    ext: 'dbml',
    token: 'dbml-renderer',
    krokiType: 'dbml',
    content: 'Table users {\n  id int\n}\n'
  },
  {
    id: 'd2',
    ext: 'd2',
    token: '@d2lang/d2',
    krokiType: 'd2',
    content: 'x -> y\n'
  }
];

test.describe('b-diagram-file-2 图表文件渲染器 29 型扩面（DIA 域）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（图表引擎渲染面与视口无关）');
  });

  // ---------- DIA-LOCAL-01：本地引擎档（npm / wasm）零锚型 ----------

  test('DIA-LOCAL-01/nomnoml: nomnoml（本地 npm 引擎档）打开即出本地 svg，零三方外呼', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const third = await mockThirdParty(page.context(), () => 'abort');
    const pane = await openDiagramFile(page, 'n.nomnoml', '[A]->[B]\n');

    // 本地 npm 引擎直出 svg（diagramFile.ts:331-340 localEngineHtml → mountHtml）
    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });
    // 产物内容锚：'[A]->[B]' 渲染出两个文本节点 A / B（引擎出空图或错图即红——
    // 只断言 svg 存在的话，引擎返回空 svg 也能过）
    await expect(pane.locator('.vv-html-content text')).toHaveText(['A', 'B']);
    // 未落源码面、未回落 kroki img、无失败卡
    await expect(pane.locator('.vv-code')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    // 非 source 档建工具条，且渲染钮 active（view 初值 = rendered）
    await expect(pane.locator('.vv-html-toolbar')).toHaveCount(1);
    await expect(pane.locator('.vv-html-btn-rendered')).toHaveClass(/active/);
    // 本地档不发任何三方请求（kroki.io / cdn.jsdelivr.net / plantuml.com 零命中）
    expect(third, '本地 npm 引擎档零三方外呼').toHaveLength(0);
  });

  test('DIA-LOCAL-01/svgbob: svgbob（本地 wasm 档）打开即出本地 svg，零三方外呼', async ({ page }) => {
    test.setTimeout(120_000);
    const third = await mockThirdParty(page.context(), () => 'abort');
    const pane = await openDiagramFile(page, 's.svgbob', '+-->+\n| a |\n+<--+\n');

    // 本地 wasm 引擎（构建期 gen:svgbob-wasm 产物）直出 svg
    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });
    // 产物内容锚：盒图标签 'a' 渲染成文本节点（引擎出空图或错图即红）
    await expect(pane.locator('.vv-html-content text')).toHaveText(['a']);
    await expect(pane.locator('.vv-code')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    await expect(pane.locator('.vv-html-toolbar')).toHaveCount(1);
    await expect(pane.locator('.vv-html-btn-rendered')).toHaveClass(/active/);
    expect(third, '本地 wasm 引擎档零三方外呼').toHaveLength(0);
  });

  // ---------- DIA-KROKI-01：kroki-only 15 型各自直发 kroki.io ----------

  for (const t of KROKI_ONLY_TYPES) {
    test(`DIA-KROKI-01/${t.id}: ${t.id} 直发 kroki.io 且请求 URL 型段随型而变`, async ({ page }) => {
      test.setTimeout(60_000);
      const third = await mockThirdParty(page.context(), (url) =>
        url.includes('kroki.io') ? 'kroki-svg' : 'abort'
      );
      const pane = await openDiagramFile(page, `f.${t.ext}`, `x ${t.id}\n`);

      // kroki img 可见（命中 mock 的最小 svg）
      const img = pane.locator('.vv-html-content img');
      await expect(img).toBeVisible({ timeout: 20_000 });
      // URL 形态：https://kroki.io/<krokiType>/svg/<base64url 无填充>（diagrams.ts:120-128）
      await expect(img).toHaveAttribute(
        'src',
        new RegExp(`^https://kroki\\.io/${t.krokiType}/svg/[A-Za-z0-9_-]+$`)
      );
      // 台账：本型至少一次命中，且每次命中的型段都是本型（不串型）
      const krokiHits = third.filter((u) => u.includes('kroki.io'));
      expect(krokiHits.length, 'kroki 直发请求在案').toBeGreaterThanOrEqual(1);
      expect(
        krokiHits.filter((u) => !u.startsWith(`https://kroki.io/${t.krokiType}/svg/`)),
        '不得出现别型 URL 段（不串型）'
      ).toEqual([]);
      // 成功路径：无失败卡、无源码面
      await expect(pane.locator('.vv-error-card')).toHaveCount(0);
      await expect(pane.locator('.vv-code')).toHaveCount(0);
    });
  }

  // ---------- DIA-KROKI-02：kroki-only 型失败终态为单跳文案 ----------

  for (const t of [{ id: 'pikchr', ext: 'pikchr' }, { id: 'ditaa', ext: 'ditaa' }]) {
    test(`DIA-KROKI-02/${t.id}: ${t.id} 失败终态为单跳文案（不得出现「与官方服务器」两跳形态）`, async ({
      page
    }) => {
      test.setTimeout(60_000);
      // kroki 与 plantuml 双 abort：kroki 断链触发 img error；plantuml 仅作零请求台账
      const third = await mockThirdParty(page.context(), () => 'abort');
      const pane = await openDiagramFile(page, `f.${t.ext}`, `x ${t.id}\n`);

      // 失败提示卡（diagramFile.ts:396-412 单跳文案分支）
      const card = pane.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.locator('.vv-error-title')).toHaveText('图表渲染失败，已回退源码视图');
      await expect(card.locator('.vv-error-detail')).toContainText(
        `kroki 渲染失败（图片加载错误）：${t.id}`
      );
      // 缺席断言：kroki-only 型不是 officialServer 型，不得出现两跳文案
      await expect(card.locator('.vv-error-detail')).not.toContainText('官方服务器');
      // 缺席断言：官方服务器零请求（非 officialServer 型不得触发官方重试一跳）
      expect(
        third.filter((u) => u.includes('plantuml.com')),
        'kroki-only 型不得触发官方服务器重试'
      ).toHaveLength(0);
      // 终态：源码视图承接，图形面清空，源码钮 active
      await expect(pane.locator('.vv-html-content .vv-code')).toBeVisible();
      await expect(pane.locator('svg')).toHaveCount(0);
      await expect(pane.locator('img')).toHaveCount(0);
      await expect(pane.locator('.vv-html-btn-source')).toHaveClass(/active/);
    });
  }

  // ---------- DIA-C4-01：c4plantuml（kroki 段 + 官方重试一跳） ----------

  test('DIA-C4-01/kroki: c4plantuml 默认 kroki 档直发 kroki.io 且型段为 c4plantuml', async ({ page }) => {
    test.setTimeout(60_000);
    const third = await mockThirdParty(page.context(), (url) =>
      url.includes('kroki.io') ? 'kroki-svg' : 'abort'
    );
    const pane = await openDiagramFile(page, 'c.c4plantuml', '@startuml\nC4 -> Context: c4\n@enduml\n');

    // kroki img 可见（命中 mock 的最小 svg）；型段 = 注册表 krokiType=c4plantuml
    // （diagrams.ts:43：krokiType 'c4plantuml'，与 plantuml 同族但不同端点名）
    const img = pane.locator('.vv-html-content img');
    await expect(img).toBeVisible({ timeout: 20_000 });
    await expect(img).toHaveAttribute('src', /^https:\/\/kroki\.io\/c4plantuml\/svg\/[A-Za-z0-9_-]+$/);
    // 台账：kroki 请求在案且型段恒为本型（不串型到 plantuml）
    const krokiHits = third.filter((u) => u.includes('kroki.io'));
    expect(krokiHits.length, 'kroki 直发请求在案').toBeGreaterThanOrEqual(1);
    expect(
      krokiHits.filter((u) => !u.startsWith('https://kroki.io/c4plantuml/svg/')),
      '不得出现别型 URL 段'
    ).toEqual([]);
    // 成功路径：无失败卡、无源码面
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    await expect(pane.locator('.vv-code')).toHaveCount(0);
  });

  test('DIA-C4-01/official-retry: c4plantuml kroki 失败触发官方服务器重试一跳，终态为两跳文案', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // kroki 与 plantuml 双 abort：kroki img error → officialServer 型（diagrams.ts:43）
    // 且 krokiHost 为公共默认 kroki.io → 触发官方重试一跳（diagramFile.ts:405-412）
    const third = await mockThirdParty(page.context(), () => 'abort');
    const pane = await openDiagramFile(page, 'c.c4plantuml', '@startuml\nC4 -> Context: c4\n@enduml\n');

    // 失败卡：两跳文案（officialTried 分支）+ 本型 id
    const card = pane.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.vv-error-title')).toHaveText('图表渲染失败，已回退源码视图');
    await expect(card.locator('.vv-error-detail')).toContainText(
      'kroki 与官方服务器渲染失败（图片加载错误）：c4plantuml'
    );
    // 官方重试确曾发生（URL 形态 …）：officialServer 旗标的行为证据——既有
    // DIA-FILE-04b 只断言两跳文案，未证官方那一跳真的发出过
    const officialHits = third.filter((u) => u.includes('plantuml.com'));
    expect(officialHits.length, '官方服务器重试请求在案').toBe(1);
    expect(officialHits[0]).toMatch(/^https:\/\/www\.plantuml\.com\/plantuml\/svg\/[0-9A-Za-z_-]+$/);
    // kroki 段也确曾发生，且型段为本型
    const krokiHits = third.filter((u) => u.includes('kroki.io'));
    expect(krokiHits.length, 'kroki 直发请求在案').toBeGreaterThanOrEqual(1);
    expect(
      krokiHits.filter((u) => !u.startsWith('https://kroki.io/c4plantuml/svg/')),
      '不得出现别型 URL 段'
    ).toEqual([]);
    // 终态：源码视图承接，图形面清空
    await expect(pane.locator('.vv-html-content .vv-code')).toBeVisible();
    await expect(pane.locator('svg')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
  });

  // ---------- DIA-CDN-01：CDN 本地引擎档失败回退 kroki 第一跳 ----------

  for (const t of CDN_ENGINE_TYPES) {
    test(`DIA-CDN-01/${t.id}: ${t.id} CDN 引擎加载失败回退 kroki img（曾试本型引擎包）`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      // d2 注册表 defaultMode=kroki（diagrams.ts:64），须显式 local 才走 CDN 档
      if (t.id === 'd2') injectSettings(page, { diagrams: { modes: { d2: 'local' } } });
      const third = await mockThirdParty(page.context(), (url) =>
        url.includes('cdn.jsdelivr.net') ? 'abort' : url.includes('kroki.io') ? 'kroki-svg' : 'abort'
      );
      const pane = await openDiagramFile(page, `c.${t.ext}`, t.content);

      // 回退第一跳接管：kroki img 可见，且型段与本型 krokiType 一致
      // （img 可见 ⇒ 本地引擎 import 已失败 ⇒ CDN 请求必已发生并落账）
      const img = pane.locator('.vv-html-content img');
      await expect(img).toBeVisible({ timeout: 20_000 });
      await expect(img).toHaveAttribute(
        'src',
        new RegExp(`^https://kroki\\.io/${t.krokiType}/svg/[A-Za-z0-9_-]+$`)
      );
      // 第一跳即终态成功：无失败卡、无本地 svg 残留
      await expect(pane.locator('.vv-error-card')).toHaveCount(0);
      await expect(pane.locator('svg')).toHaveCount(0);
      // 因果锚取于终态断言之后（链路收敛后一次性取计数）：本型自己的 jsdelivr
      // 引擎包请求在案且恰 1 次（cdnEngines.ts 各实现行），无别型包名。
      // 计数必须在终态之后取——只增计数器上的 expect.poll 会在计数首次为 1 的
      // 瞬间放行，迟到的第二次请求不可见，「>1 次 = 重复加载」打不红。
      const cdnHits = third.filter((u) => u.includes('cdn.jsdelivr.net'));
      expect(
        cdnHits.filter((u) => u.includes(t.token)).length,
        `${t.id} 的 CDN 引擎包请求恰 1 次（实际 ${JSON.stringify(cdnHits)}）`
      ).toBe(1);
      expect(
        cdnHits.filter((u) => !u.includes(t.token)),
        '不得加载别型的引擎包'
      ).toEqual([]);
    });
  }

  // ---------- DIA-SERVER-01：server 档未连接服务端时回落 local ----------

  test('DIA-SERVER-01: server 档在未连接服务端时回落 local（出本地 svg、零 /api/compute 请求）', async ({
    page
  }) => {
    test.setTimeout(90_000);
    // 显式 server 档；default 套件无服务端连接 → serverDiagramOf 恒 false
    // （viewer.ts:288 loadDiagramCapabilities 为空 → resolveEffectiveMode 回落 local）
    injectSettings(page, { diagrams: { modes: { graphviz: 'server' } } });
    const third = await mockThirdParty(page.context(), () => 'abort');
    const api = await countServerApi(page.context());
    const pane = await openDiagramFile(page, 'g.dot', 'digraph { server_mode -> local_engine }\n');

    // 回落 local：viz-js 本地引擎直出 svg（server→local→kroki→source 链的第一跳）
    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });
    // 零服务端代理请求：未走 server 链（/api/compute/diagram 与 /api/kroki 均未发）
    expect(api, '未连接服务端时不得发 /api/compute 或 /api/kroki').toHaveLength(0);
    // 零三方外呼（回落的是本地引擎档）
    expect(third, '回落 local 后零三方外呼').toHaveLength(0);
    // 成功路径：无失败卡、无 kroki img、渲染钮 active
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('.vv-code')).toHaveCount(0);
    await expect(pane.locator('.vv-html-btn-rendered')).toHaveClass(/active/);
  });

  // ---------- DIA-SIZE-01：大小门等界（=10MiB 与 +1 字节） ----------

  test('DIA-SIZE-01/exact: 恰好 10MiB 的图表文件不触发大小门，走正常路径无降级卡', async ({ page }) => {
    test.setTimeout(120_000);
    // 大小门先于模式裁决（diagramFile.ts:203 vs :245）——判据与模式无关，
    // 固定 source 档只为让「正常路径」的落点唯一（源码视图，无网络面）
    injectSettings(page, { diagrams: { modes: { pikchr: 'source' } } });
    const third = await mockThirdParty(page.context(), () => 'abort');
    const content = synthDiagramText(10 * 1024 * 1024);
    expect(
      new TextEncoder().encode(content).byteLength,
      '夹具字节数自证（恰 10MiB）'
    ).toBe(10 * 1024 * 1024);
    const pane = await openDiagramFile(page, 'exact.pikchr', content);

    // 正常路径（source 档）承接源码视图——降级路径无 .vv-html-content 骨架，
    // 故此断言本身就是「未走大小门」的判据
    await expect(pane.locator('.vv-html-content .vv-code')).toBeVisible();
    // 大小门判据是严格大于（DIAGRAM_MAX_BYTES:49 + `>` 比较）：等界不降级
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    await expect(pane).not.toHaveClass(/vv-degraded/);
    expect(third, '正常路径零三方外呼').toHaveLength(0);
  });

  test('DIA-SIZE-01/over: 10MiB+1 字节即触发大小门（直落源码视图 + 超限降级卡，零引擎外呼）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    // 刻意不注入 source 档：pikchr 留注册表默认 kroki 档（diagrams.ts:50 defaultMode
    // kroki）——如此「零三方外呼」才真正证明大小门早于引擎链：若大小门被挪到模式
    // 裁决之后，pikchr 会走 kroki 档发出 kroki.io 请求，计数即非零。
    // （旧写法注入 source 档时零外呼由模式决定、与大小门次序无关——恒真。）
    const third = await mockThirdParty(page.context(), () => 'abort');
    const content = synthDiagramText(10 * 1024 * 1024 + 1);
    expect(
      new TextEncoder().encode(content).byteLength,
      '夹具字节数自证（10MiB+1）'
    ).toBe(10 * 1024 * 1024 + 1);
    const pane = await openDiagramFile(page, 'over.pikchr', content);

    // 降级卡三件套：标题 / 阈值明细（10MB）/ 文件名 meta
    const card = pane.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.vv-error-title')).toHaveText('图表文件过大，已降级显示');
    await expect(card.locator('.vv-error-detail')).toContainText('10MB');
    await expect(card.locator('.vv-error-meta')).toHaveText('over.pikchr');
    // 降级标记（diagramFile.ts:204 target.classList.add('vv-html','vv-degraded')）
    await expect(pane).toHaveClass(/vv-degraded/);
    // 大小门先于一切引擎/kroki 路径：零三方外呼（pikchr 默认 kroki 档——次序证据）
    expect(third, '大小门先于引擎链（pikchr 默认 kroki 档下仍零外呼）').toHaveLength(0);
    // 降级路径不建渲染骨架（正常路径才有 .vv-html-content）——与降级卡互为对照
    await expect(pane.locator('.vv-html-content')).toHaveCount(0);
    // 源码视图承接（降级 holder 即 .vv-code 根）
    await expect(pane.locator('.vv-degraded-content.vv-code')).toBeVisible();
  });

  // ---------- DIA-SRC-01：source 档无工具条、零渲染请求 ----------

  test('DIA-SRC-01: 显式 source 模式下图表文件只出源码视图（不建工具条、不发渲染请求）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    injectSettings(page, { diagrams: { modes: { pikchr: 'source' } } });
    const third = await mockThirdParty(page.context(), () => 'abort');
    const pane = await openDiagramFile(page, 'src.pikchr', 'hello source\n');

    // 缺席三连：source 档无渲染视图可切 → 不建 toolbar（diagramFile.ts:273-288）
    await expect(pane.locator('.vv-html-toolbar')).toHaveCount(0);
    await expect(pane.locator('.vv-html-btn-rendered')).toHaveCount(0);
    await expect(pane.locator('.vv-html-btn-source')).toHaveCount(0);
    // 源码视图承接
    await expect(pane.locator('.vv-html-content .vv-code')).toBeVisible();
    await expect(pane.locator('.vv-code-line').first()).toContainText('hello source');
    // 无图形面、无失败卡
    await expect(pane.locator('svg')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    // source 档零渲染请求（不调引擎、不发 kroki/official）
    expect(third, 'source 档零三方外呼').toHaveLength(0);
  });

  // ---------- DIA-SAN-01：产出物过消毒链 ----------

  test('DIA-SAN-01: 本地引擎产出物过消毒链（script 与事件属性被剥离，副作用不发生）', async ({
    page
  }) => {
    test.setTimeout(90_000);
    // jsdelivr 命中假 dbml ESM 模块（dbml 注册表 defaultMode=local，走 CDN 档）
    const third = await mockThirdParty(page.context(), (url) =>
      url.includes('cdn.jsdelivr.net') ? 'es-module' : 'abort'
    );
    const pane = await openDiagramFile(page, 'z.dbml', 'Table users {\n  id int\n}\n');

    // mock 模块确实被加载并渲染（假引擎调用面与真 dbml 同：mod.run(src,'svg')）
    await expect(pane.locator('.vv-html-content svg')).toBeVisible({ timeout: 30_000 });
    expect(
      third.filter((u) => u.includes('cdn.jsdelivr.net')).length,
      'dbml 引擎模块请求在案'
    ).toBeGreaterThanOrEqual(1);
    // script 元素整体剥离
    await expect(pane.locator('.vv-html-content script')).toHaveCount(0);
    // 事件属性剥离：脏 rect 的 onclick 不在
    const rect = pane.locator('.vv-html-content rect');
    await expect(rect).toHaveCount(1);
    await expect(rect).not.toHaveAttribute('onclick');
    // 全域扫描：产出物内不得残留任何 on* 内联事件属性
    const inlineHandlers = await pane.locator('.vv-html-content').evaluate((el) =>
      Array.from(el.querySelectorAll('*')).flatMap((node) =>
        Array.from(node.attributes)
          .filter((a) => a.name.toLowerCase().startsWith('on'))
          .map((a) => `${node.tagName}@${a.name}`)
      )
    );
    expect(inlineHandlers, '产出物不得残留 on* 事件属性').toEqual([]);
    // 文本内容保留（证明产物真被渲染，不是空壳）
    await expect(pane.locator('.vv-html-content text')).toHaveText('hello');
    // 副作用不发生：点脏 rect（onclick 若存活必被触发 → 标记置位）
    // rect 铺满整块 svg（text 只占左侧一角）→ 点击落点必然命中 rect 自身；
    // 注：<script> 元素经 innerHTML 注入本就不执行（浏览器语义），故脚本侧由上面的
    // 「script 元素计数 0」负责；本条只证**事件属性**侧——onclick 存活则点击必置位，
    // 标记恒 undefined 即证事件属性已被剥离。
    await rect.click({ timeout: 15_000 });
    const pwned = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__vvDiaPwned
    );
    expect(pwned, 'onclick 副作用不得发生').toBeUndefined();
    // 净化 ≠ 渲染失败
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
  });

  // ---------- DIA-OFFICIAL-01：official 档直连官方服务器 + 回落 kroki ----------

  test('DIA-OFFICIAL-01: 显式 official 档直连 PlantUML 官方服务器，官方图失败时回落 kroki img', async ({
    page
  }) => {
    test.setTimeout(90_000);
    injectSettings(page, { diagrams: { modes: { plantuml: 'official' } } });
    // plantuml.com → abort（官方图失败触发回落）；kroki.io → fulfill（回落接管）
    const third = await mockThirdParty(page.context(), (url) =>
      url.includes('kroki.io') ? 'kroki-svg' : 'abort'
    );
    const pane = await openDiagramFile(page, 'proc.puml', PROC_PUML);

    // official→kroki 回落接管（diagramFile.ts:415-437）：须等 kroki 前缀的 img——
    // 加载失败的官方 img 仍有布局盒，按 .vv-html-content img 断言会假通过；
    // kroki img 出现 ⇒ 官方请求已发生且已失败（官方 img error 才触发回落链）
    const img = pane.locator('.vv-html-content img[src^="https://kroki.io/plantuml/svg/"]');
    await expect(img).toBeVisible({ timeout: 30_000 });
    // 回落成功即终态：无失败卡
    await expect(pane.locator('.vv-error-card')).toHaveCount(0);
    // kroki 回落确曾发生
    expect(
      third.filter((u) => u.includes('kroki.io')).length,
      'kroki 回落请求在案'
    ).toBeGreaterThanOrEqual(1);
    // 官方服务器请求计数取于终态断言之后（链路收敛后一次性取计数）：
    // URL 形态 https://www.plantuml.com/plantuml/svg/<官方编码>
    // （diagrams.ts:106-114：deflateRaw + 自定义字母表、无填充）。
    // 只增计数器上的 expect.poll 会在计数首次为 1 的瞬间放行——kroki 再失败触发的
    // 官方第二跳（diagramFile.ts:405-409）发生在断言之后就不可见。
    const officialHits = third.filter((u) => u.includes('plantuml.com'));
    expect(
      officialHits.length,
      `官方服务器请求恰 1（实际 ${JSON.stringify(officialHits)}）`
    ).toBe(1);
    expect(officialHits[0]).toMatch(/^https:\/\/www\.plantuml\.com\/plantuml\/svg\/[0-9A-Za-z_-]+$/);
  });
});
