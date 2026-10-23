# 渲染器/语言手动指定 P2 图表引擎（阶段 E/D）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** svgbob 前端 wasm 引擎本地打包（E，唯一 dist 增量）+ excalidraw/bpmn/vega/vegalite 四类 CDN 直链本地引擎（D，dist 零增量）。

**Architecture:** E 走 grammar 先例——自建 `svgbob-wasm` wrapper crate 构建期生成（产物不入库，gitignore），glue 落 `packages/render-text/src/markdown/svgbob-wasm-gen/`（d.ts 入库锁类型、js/wasm 构建期生成），预算脚本扩展把 wasm 资产计入 diagram-engines 口径。D 走 jsdelivr `+esm` 动态 import 新模块 `cdnEngines.ts`（loader 可注入供单测 mock），四类注册表翻转 local，失败沿既有回退链 kroki→source。

**Tech Stack:** Rust+wasm-bindgen 0.2.129、wasm-opt（binaryen，grammar 工具链缓存先例）、Vite 动态 import（@vite-ignore）、workbox runtimeCaching。

**Spec:** `docs/superpowers/specs/2026-10-23-renderer-lang-override-markpad-alignment-design.md` §6/§7/§12。

## Global Constraints

- 门禁跑法同 P1（svelte-check 在 apps/web 下、vitest 仓库根、重建 build:e2e）。
- **svgbob 版本锁**：wrapper `svgbob = "=0.7.6"` 与 server 端 Cargo.lock 同版（防前后端渲染漂移）；wasm-bindgen CLI 版本与 crate 侧依赖精确一致（构建脚本校验）。
- **4MB 预算门禁值不动**（`tools/diagram-budget.mjs`），口径扩展（Task 3）。
- CDN 类资产不进 dist：D 全部动态 import，不新增任何 npm 依赖（`@excalidraw/utils`/`bpmn-js`/`vega-embed` 均不装包）。
- 可行性已实证（2026-10-23 probe）：svgbob 0.7.6 wasm32 一次编译通过、bindgen 后 820KB、Node 渲染与 native byte 级一致；probe 产物在 `/tmp/svgbob-wasm-probe/` 可参考。

---

### Task 1: svgbob-wasm wrapper crate + 构建脚本

**Files:**
- Create: `tools/svgbob-wasm/Cargo.toml`、`tools/svgbob-wasm/src/lib.rs`、`tools/svgbob-wasm/examples/render_fixture.rs`
- Create: `tools/build-svgbob-wasm.mjs`
- Create: `packages/render-text/src/markdown/svgbob-wasm-gen/svgbob_wasm.d.ts`（**入库**，仅类型声明）
- Modify: `.gitignore`（`packages/render-text/src/markdown/svgbob-wasm-gen/` 下 js/wasm）、根 `package.json` scripts、`.github/workflows/ci.yml`（`rg -n 'gen:grammars' .github/workflows/ci.yml package.json` 镜像其接线点）

**Interfaces:**
- Produces: `packages/render-text/src/markdown/svgbob-wasm-gen/svgbob_wasm.js` + `svgbob_wasm_bg.wasm`（构建期生成）；d.ts 声明 `export default function init(): Promise<void>; export function render(source: string): string;`；根脚本 `pnpm gen:svgbob-wasm`。

- [ ] **Step 1: wrapper crate**

`tools/svgbob-wasm/Cargo.toml`（独立 crate，不入 server workspace）：

```toml
[package]
name = "svgbob-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
svgbob = "=0.7.6"
wasm-bindgen = "0.2.129"

[profile.release]
opt-level = "s"
lto = true
```

`src/lib.rs`：

```rust
//! svgbob wasm wrapper（spec 2026-10-23 §7）：与服务端 native 同 API to_svg，
//! 版本锁 "=0.7.6" 保证前后端渲染 byte 级一致（probe 已实证）。
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub fn render(source: String) -> String {
    svgbob::to_svg(&source)
}
```

`examples/render_fixture.rs`（native 锚 fixture 生成器）：

```rust
fn main() {
    let out = std::env::args().nth(1).expect("usage: render_fixture <out.svg>");
    std::fs::write(out, svgbob::to_svg("+-->+\n| a |\n+<--+\n")).expect("write fixture");
}
```

- [ ] **Step 2: 构建脚本 `tools/build-svgbob-wasm.mjs`**

要点（全脚本无第三方依赖，风格镜像 tools/diagram-budget.mjs）：①校验 `wasm-bindgen --version` 输出与 Cargo.toml 依赖版本一致，不一致 exit 1；②`cargo build --target wasm32-unknown-unknown --release`（cwd=tools/svgbob-wasm）；③有 wasm-opt 则先 `-Oz`（PATH 或 `~/.cache/tree-sitter/binaryen/bin/wasm-opt`，缺则跳过并 warn）；④`wasm-bindgen --target web --out-dir ../../packages/render-text/src/markdown/svgbob-wasm-gen`（target wasm32-unknown-unknown/release/svgbob_wasm.wasm）；⑤打印产物体积。gen 目录 js/wasm 若已存在先清空再写（防陈旧混排）。

- [ ] **Step 3: 跑通 + fixture 入库**

```bash
rustup target list --installed | grep wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
pnpm gen:svgbob-wasm
cd tools/svgbob-wasm && cargo run --example render_fixture ../../packages/render-text/src/markdown/__fixtures__/svgbob-sample.svg
```

Expected: gen 目录出现 svgbob_wasm.js/_bg.wasm/.d.ts；fixture 与 probe 实测形态一致（含 `<svg`/`<style`）。d.ts 手写入库：

```ts
export default function init(): Promise<void>;
export function render(source: string): string;
```

- [ ] **Step 4: gitignore + CI 接线**——.gitignore 加：

```
packages/render-text/src/markdown/svgbob-wasm-gen/*.js
packages/render-text/src/markdown/svgbob-wasm-gen/*.wasm
```

`package.json` scripts 加 `"gen:svgbob-wasm": "node tools/build-svgbob-wasm.mjs"`；ci.yml e2e/构建 job 在 web build 前插 `pnpm gen:svgbob-wasm`（镜像 gen:grammars 步骤的安装与缓存形态；rust target 沿 grammar job 已装工具链）。

- [ ] **Step 5: Commit**

```bash
git add tools/svgbob-wasm tools/build-svgbob-wasm.mjs packages/render-text/src/markdown/svgbob-wasm-gen/svgbob_wasm.d.ts packages/render-text/src/markdown/__fixtures__/svgbob-sample.svg .gitignore package.json .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(tools): svgbob-wasm wrapper crate 与构建脚本——前端 wasm 引擎产物构建期生成（spec §7）"
```

---

### Task 2: diagramEngines 接入 svgbob 引擎 + 注册表翻转

**Files:**
- Modify: `packages/render-text/src/markdown/diagramEngines.ts`（engine 联合类型 + renderSvgbob + switch case）
- Modify: `packages/render-text/src/markdown/diagrams.ts:32`（svgbob 行翻转）
- Test: `packages/render-text/src/markdown/diagrams.test.ts`（`rg -l 'resolveDiagramType' packages/render-text/src/markdown --glob '*.test.ts'` 定位）

**Interfaces:**
- Produces: `renderDiagramEngine('svgbob', source)` → SVG 字符串；注册表 `svgbob: local:true, defaultMode:'local', engine:'svgbob'`。

- [ ] **Step 1: RED**——注册表测试加：

```ts
it('svgbob 注册表翻转 local 默认（spec §7）', () => {
  const t = resolveDiagramType('svgbob')!;
  expect(t.local).toBe(true);
  expect(t.engine).toBe('svgbob');
  expect(t.defaultMode).toBe('local');
});
```

引擎测试（skipIf 防未构建环境假红；放 diagramEngines 同目录新测试或既有引擎测试文件）：

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const hasGen = existsSync(fileURLToPath(new URL('./svgbob-wasm-gen/svgbob_wasm.js', import.meta.url)));
describe.skipIf(!hasGen)('svgbob wasm 引擎', () => {
  it('渲染 fixture 输入与 native 锚一致', async () => {
    const html = await renderDiagramEngine('svgbob', '+-->+\n| a |\n+<--+\n');
    const fixture = readFileSync(fileURLToPath(new URL('./__fixtures__/svgbob-sample.svg', import.meta.url)), 'utf8');
    expect(html).toContain('<svg');
    expect(html).toContain(fixture.slice(fixture.indexOf('<style'), fixture.indexOf('<style') + 80)); // style 块头部锚
  });
});
```

- [ ] **Step 2: 实现**——diagramEngines.ts：

```ts
export type DiagramEngineId = 'mermaid' | 'graphviz' | 'nomnoml' | 'math' | 'svgbob';

/** svgbob wasm 引擎（spec §7）：glue 构建期生成（gen:svgbob-wasm），init 幂等缓存。 */
let svgbobInit: Promise<{ render: (s: string) => string }> | null = null;
async function renderSvgbob(source: string): Promise<string> {
  svgbobInit ??= import('./svgbob-wasm-gen/svgbob_wasm.js').then(async (m) => {
    await m.default();
    return m;
  }).catch((e: unknown) => { svgbobInit = null; throw e; });
  const mod = await svgbobInit;
  return mod.render(source);
}
```

switch 加 `case 'svgbob': return renderSvgbob(source);`（函数签名 engine 参数类型同步扩）。diagrams.ts `:32` 行改 `{ id: 'svgbob', aliases: [], local: true, defaultMode: 'local', krokiType: 'svgbob', highlightLang: '', engine: 'svgbob' }`，`engine?:` 联合类型（`:17`）加 `'svgbob'`。

- [ ] **Step 3: GREEN + 门禁**——`pnpm gen:svgbob-wasm && pnpm vitest run packages/render-text && pnpm --filter web typecheck`；Commit：

```bash
git commit -am "feat(render-text): svgbob 前端 wasm 引擎接入与注册表翻转——回退链 kroki→source 自动接管（spec §7）"
```

---

### Task 3: 预算脚本口径扩展 + SW 缓存规则

**Files:**
- Modify: `tools/diagram-budget.mjs`
- Modify: `apps/web/vite.config.ts:313-365`（runtimeCaching 追加一条）

**Interfaces:**
- Produces: 预算口径 = `diagram-engines-*` JS chunk + `*_svgbob*_bg*.wasm` 资产（预期 ~1.36MB + ~0.8MB ≈ 2.2MB，门禁 4MB 不动）；SW 对 svgbob wasm CacheFirst。

- [ ] **Step 1: 预算脚本**——entries 统计后追加 wasm 资产扫描（头部注释同步口径说明）：

```js
const assetsDir = 'apps/web/build/_app/immutable/assets';
try {
  for (const f of readdirSync(assetsDir).filter((f) => /svgbob.*\.wasm$/.test(f))) {
    entries.push({ file: `assets/${f}`, size: statSync(join(assetsDir, f)).size });
  }
} catch { /* assets 目录缺失与 chunk 缺失同判：构建产物不存在错误出口 */ }
```

- [ ] **Step 2: SW 规则**——runtimeCaching 数组（`:365` 前）追加（形态镜像 grammars 规则 `:314-326`）：

```ts
{
  // svgbob 前端 wasm 引擎（diagram-engines 动态 import 的同包资产，~0.8MB）：
  // 内容随构建指纹恒定，CacheFirst + 修订号缓存名（跨版本陈旧由 cacheName 兜底）
  urlPattern: /svgbob_wasm_bg[\w.-]*\.wasm$/,
  handler: 'CacheFirst',
  options: {
    cacheName: `vv-diagram-svgbob-${BUILD_REVISION}`,
    expiration: { maxEntries: 2, purgeOnQuotaError: true },
    cacheableResponse: { statuses: [200] }
  }
},
```

- [ ] **Step 3: 验证**——`pnpm build:e2e && node tools/diagram-budget.mjs`（预期 2.0-2.3MB 区间通过）；Commit：

```bash
git commit -am "feat(web): svgbob wasm 计入图表预算口径与 SW CacheFirst——唯一 dist 增量收口（spec §7/§12）"
```

---

### Task 4: cdnEngines 模块 + 四类注册表翻转

**Files:**
- Create: `packages/render-text/src/markdown/cdnEngines.ts`
- Modify: `packages/render-text/src/markdown/diagrams.ts:33,35-37`（excalidraw/bpmn/vega/vegalite 翻转）+ `engine?` 联合类型扩 `'excalidraw' | 'bpmn' | 'vega' | 'vegalite'`
- Modify: `packages/render-text/src/markdown/diagramEngines.ts`（switch 委派 cdnEngines）
- Modify: `apps/web/src/lib/settings/DiagramsSection.svelte:59-62`（hint 文案更新）
- Test: `packages/render-text/src/markdown/cdnEngines.test.ts`（新建）

**Interfaces:**
- Consumes: pipeline `renderDiagramEngine(engine, source, opts)`（`pipeline.ts:315` 不变）。
- Produces: `renderDiagramEngine('excalidraw'|'bpmn'|'vega'|'vegalite', source)` → SVG 字符串；`cdnEngines.__setCdnLoaderForTest(fn | null)`（单测注入口）；SW jsdelivr 引擎缓存规则。

- [ ] **Step 0: 前置 spike（spec §6 拍板门）**——真实浏览器/Node 实测四包 +esm 可用性，任何一项失败即停手回用户重拍板：

```bash
for u in '@excalidraw/utils@0.1.5' 'bpmn-js@18.31.0/lib/NavigatedViewer.js' 'vega-embed@7.3.0'; do
  curl -sSI -o /dev/null -w "%{http_code} $u\n" "https://cdn.jsdelivr.net/npm/$u/+esm"
done
node -e "import('https://cdn.jsdelivr.net/npm/vega-embed@7.3.0/+esm').then(m=>console.log('vega-embed ok', typeof m.default))"
```

（网络不可达环境改用浏览器 e2e CDN-01 充当 spike；重点风险=bpmn-js 子路径 +esm 打包完整性、vega-embed 加载时长。）

- [ ] **Step 1: cdnEngines.ts**（版本钉死与 markpad 对齐，2026-10-23 调查实证 +esm 全 200、Node 直出 SVG 无 DOM 依赖）：

```ts
// cdnEngines.ts — CDN 直链图表引擎（spec §6）：jsdelivr +esm 精确版本，dist 零增量；
// 加载失败抛错由 renderDiagramBlock 回退链降级 kroki→source。负结果不缓存（可重试）。
const CDN = 'https://cdn.jsdelivr.net/npm';
type CdnLoader = (url: string) => Promise<unknown>;
let loader: CdnLoader = (url) => import(/* @vite-ignore */ url);
/** 单测注入口（生产路径不调用） */
export function __setCdnLoaderForTest(fn: CdnLoader | null): void { loader = fn ?? ((u) => import(/* @vite-ignore */ u)); }

export async function renderExcalidrawCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@excalidraw/utils@0.1.5/+esm`)) as {
    exportToSvg: (opts: { data: unknown }) => Promise<SVGSVGElement>;
  };
  const svg = await mod.exportToSvg({ data: JSON.parse(source) });
  return svg.outerHTML;
}

export async function renderBpmnCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/bpmn-js@18.31.0/lib/NavigatedViewer.js/+esm`)) as {
    default: new () => { importXML: (xml: string) => Promise<unknown>; saveSVG: () => Promise<{ svg: string }>; destroy: () => void };
  };
  const viewer = new mod.default();
  try {
    await viewer.importXML(source);
    const { svg } = await viewer.saveSVG();
    return svg;
  } finally { viewer.destroy(); }
}

export async function renderVegaCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/vega-embed@7.3.0/+esm`)) as {
    default: (el: HTMLElement, spec: unknown, opts?: { renderer: string }) => Promise<unknown>;
  };
  const el = document.createElement('div');
  await mod.default(el, JSON.parse(source), { renderer: 'svg' });
  const svg = el.querySelector('svg');
  if (!svg) throw new Error('vega 渲染失败');
  return svg.outerHTML;
}
```

（API 依据：markpad `src/lib/localRenderers.ts:95-215`——bpmn importXML+saveSVG、excalidraw exportToSvg、vega-embed svg renderer；实施时若 +esm 实测签名有出入以 markpad 原案为准修正。）

- [ ] **Step 2: RED 测试**（mock loader）：

```ts
it('四类 CDN 引擎经 loader 渲染并走精确版本 URL', async () => {
  const seen: string[] = [];
  __setCdnLoaderForTest(async (url) => {
    seen.push(url);
    return {
      exportToSvg: async () => ({ outerHTML: '<svg>exc</svg>' }),
      default: () => ({ importXML: async () => {}, saveSVG: async () => ({ svg: '<svg>bpmn</svg>' }), destroy() {} }),
    };
  });
  expect(await renderExcalidrawCdn('{}')).toBe('<svg>exc</svg>');
  expect(seen[0]).toBe('https://cdn.jsdelivr.net/npm/@excalidraw/utils@0.1.5/+esm');
  __setCdnLoaderForTest(null);
});
```

（vega 单测需 document——jsdom 环境直接可用；bpmn/excalidraw 分拆各断言 URL 与产物。）

- [ ] **Step 3: 注册表翻转 + 分发委派 + SW jsdelivr 规则**——diagrams.ts 四行改 `local: true, defaultMode: 'local'` + engine 字段（excalidraw/bpmn/vega/vegalite）；diagramEngines.ts switch 加：

```ts
    case 'excalidraw': return (await import('./cdnEngines')).renderExcalidrawCdn(source);
    case 'bpmn': return (await import('./cdnEngines')).renderBpmnCdn(source);
    case 'vega':
    case 'vegalite': return (await import('./cdnEngines')).renderVegaCdn(source);
```

（engine 参数联合类型同步扩四值。）vite.config.ts runtimeCaching 追加（G/H 的 CDN 引擎同吃此规则；jsdelivr 版本化 URL 恒定）：

```ts
{
  // CDN 图表引擎（jsdelivr +esm 精确版本，四类/新类型按需动态 import）：
  // CacheFirst 后二次访问近似离线；版本进 URL，跨版本陈旧天然免疫
  urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/.*/,
  handler: 'CacheFirst',
  options: {
    cacheName: `vv-cdn-engines-${BUILD_REVISION}`,
    expiration: { maxEntries: 24, purgeOnQuotaError: true },
    cacheableResponse: { statuses: [200] }
  }
},
```

DiagramsSection hint 文案改：「本地引擎支持 mermaid/graphviz/nomnoml/公式/svgbob 与 excalidraw/bpmn/vega/vegalite（CDN 按需加载），其余语言本地档自动回落 Kroki；…」。settings 白名单核验：`apps/web/src/lib/stores/settings.ts:106` 与 `settingsDraft.ts:53` 的 mode 枚举已含 'local'，无需改（验证即可）。

- [ ] **Step 4: GREEN + 门禁** — `pnpm vitest run packages/render-text && pnpm --filter web typecheck`；Commit：

```bash
git commit -am "feat(render-text): 四类图表 CDN 直链本地引擎——excalidraw/bpmn/vega/vegalite 注册表翻转（spec §6）"
```

---

### Task 5: e2e（CDN 成功/失败回退）+ 门禁收口

**Files:**
- Create: `apps/web/e2e/b-cdn-diagram-engines.spec.ts`
- Modify: `docs/e2e/` 域文档（就近并入 markdown 图表域文档或新建 cdn-diagram-engines.md）

- [ ] **Step 1: e2e 用例**（fixture：excalidraw 最小 JSON `{"type":"excalidraw","elements":[],"appState":{},"files":{}}`；wavejson 留 P3）：

```ts
test('CDN-01 可达网络下 excalidraw fence 本地出图', async ({ page }) => {
  /* 打开含 ```excalidraw 围栏的 md → wrapper 内 svg 存在（真实网络；CI 无外网时 test.skip） */
});
test('CDN-02 CDN 拦截→回退链 kroki→source', async ({ page }) => {
  await page.route('**cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**kroki.io/**', (r) => r.abort());
  /* 同 fence → wrapper 呈源码模式（错误/源码文案可见，66afead 教训：失败态不得 hidden） */
});
test('CDN-03 svgbob fence 本地 wasm 出图（不依赖外网）', async ({ page }) => {
  /* ```svgbob 围栏 → svg 出图；断言不发生 kroki 请求（page.on('request') 过滤 kroki.io 为空） */
});
```

- [ ] **Step 2: 重建 + 定向跑** — `pnpm build:e2e`（含 gen:svgbob-wasm 前置）→ 定向三用例 → playwright 默认通道全量。CDN-01 若执行环境无外网（GRF 域 VV_GRAMMAR_CDN 前科）标 `test.skip(!hasNet)`，探测用 `page.request.get('https://cdn.jsdelivr.net', {timeout: 3000})`。

- [ ] **Step 3: 收口门禁**——`pnpm --filter web typecheck && pnpm vitest run && node tools/diagram-budget.mjs`；Commit：

```bash
git add apps/web/e2e docs/e2e
git commit -m "test(e2e): CDN 引擎成功/回退/svgbob 本地三用例与 P2 门禁收口（spec §6/§7）"
```
