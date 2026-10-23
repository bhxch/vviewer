# 渲染器/语言手动指定 P3 服务端 kroki+图表扩容（阶段 F/G/H）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端单图渲染端点 + kroki 服务端代发（native+worker 双形态，F）、graphviz 多渲染器 + mermaid theme 设置（G）、kroki 类型扩容 30 类 + wavedrom/bytefield/dbml/d2 CDN 引擎（H）。

**Architecture:** kroki 转发不算计算——core 新增 kroki 域（`KrokiHttp` trait 接缝，storage HttpTransport 同款模式），native 装 reqwest、worker 装 Fetch binding，两形态共用 `/api/kroki`；SSRF 防线 host 只来自部署侧配置。单图端点 `/api/compute/diagram` 复用 `render_diagram_svg` 提 pub，仍挂 native×compute 双门。前端 settings.diagrams 五处落点（注册表类型/运行时白名单/导入白名单/DiagramsSection/viewer 注入）由 F→G→H 逐阶段扩。

**Tech Stack:** Rust（axum/reqwest/workers-rs 0.8.7/async-trait）、Svelte 5、jsdelivr +esm。

**Spec:** `docs/superpowers/specs/2026-10-23-renderer-lang-override-markpad-alignment-design.md` §8/§9/§10。

## Global Constraints

- 门禁跑法同 P1/P2；cargo 跑法在 `server/` 下（`cargo test --workspace`、`cargo clippy --workspace -- -D warnings` 基线 0）；worker 构建验证 `cargo build -p vviewer-worker --target wasm32-unknown-unknown`（server/ 下）。
- worker 形态 compute 仍整体缺失（现状不变）；`/api/kroki` 必须 native+worker 双形态可用（用户拍板：转发不算计算）。
- SSRF 防线：kroki 上游 host 只来自 `--kroki-host`（native）/`VV_KROKI_HOST`（worker），请求不带 host；lang 路径段白名单 `[a-z0-9-]`。
- 前端 sanitize：fetched SVG 内联走 `[data-vv-diagram=server]` 上下文豁免面 + `url(#...)` 放行正则（2026-10-19 md-diagrams-server C1/C2 口径，`rg -n 'uponSanitizeElement' packages/render-text/src/markdown/sanitize.ts` 复用既有钩子逻辑）。
- CDN 包名勘误：spec §9.1 的「@hpcc-js/wasm-graphograf」为笔误，正确包名 **`@hpcc-js/wasm-graphviz`**（本计划为准）。
- kroki API 调查佐证：`/var/tmp/kroki-research/`（2026-10-23 调查安装的五包 node_modules）可查 API 实测形态。

---

### Task 1: core kroki 域（trait + 纯逻辑）+ capabilities 宣告

**Files:**
- Create: `server/core/src/kroki.rs`、`server/core/src/kroki.rs` 测试（同文件 `#[cfg(test)]`）
- Modify: `server/core/src/lib.rs`（`pub mod kroki;`，**不挂 native cfg**）
- Modify: `server/core/src/health.rs:79-84`（capabilities push）

**Interfaces:**
- Produces: `kroki::KrokiHttp`（`async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError>`）、`kroki::KrokiState { host: String, http: Arc<dyn KrokiHttp> }`、`kroki::render(state: &KrokiState, lang: &str, source: &[u8]) -> Result<Vec<u8>, CoreError>`；health capabilities 增 `"kroki-proxy"`（native+worker 恒宣告）。

- [ ] **Step 1: RED 测试**（mock transport）：

```rust
struct MockHttp { body: Vec<u8>, status_ok: bool }
#[async_trait::async_trait]
impl KrokiHttp for MockHttp {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        assert_eq!(url, "https://kroki.io/svgbob/svg"); // host 仅来自 state.host
        assert_eq!(body, b"+-->+".to_vec());
        if self.status_ok { Ok(self.body.clone()) } else { Err(CoreError::upstream("kroki 400")) }
    }
}

#[tokio::test]
async fn render_拼接_host 白名单_lang_透传_raw_body() {
    let st = KrokiState { host: "https://kroki.io/".into(), http: Arc::new(MockHttp { body: b"<svg/>".into(), status_ok: true }) };
    assert_eq!(kroki::render(&st, "svgbob", b"+-->+").await.unwrap(), b"<svg/>");
}
#[tokio::test]
async fn lang_白名单_拒绝路径注入() {
    let st = KrokiState { host: "https://kroki.io".into(), http: Arc::new(MockHttp { body: vec![], status_ok: true }) };
    for bad in ["../etc", "graphviz?x=1", "", "PlantUml"] {
        assert!(kroki::render(&st, bad, b"src").await.is_err());
    }
}
```

（`CoreError` 变体按 `rg -n 'pub enum CoreError' server/core/src` 实际构造函数对齐；无 upstream 变体则用既有最近似变体+消息。）

- [ ] **Step 2: 实现 kroki.rs**：

```rust
//! kroki 转发域（spec 2026-10-23 §8.2）：转发不算计算——native/worker 双形态编译进。
//! SSRF 防线：上游 host 只来自部署侧配置（native --kroki-host / worker VV_KROKI_HOST），
//! 请求体仅 raw 源码。上游协议 POST {host}/{lang}/svg（text/plain）→ 200 SVG bytes。

use std::sync::Arc;
use crate::CoreError;

#[async_trait::async_trait]
pub trait KrokiHttp: Send + Sync {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError>;
}

pub struct KrokiState {
    pub host: String,
    pub http: Arc<dyn KrokiHttp>,
}

fn valid_lang(lang: &str) -> bool {
    !lang.is_empty()
        && lang.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub async fn render(state: &KrokiState, lang: &str, source: &[u8]) -> Result<Vec<u8>, CoreError> {
    if !valid_lang(lang) {
        return Err(CoreError::bad_request("invalid diagram language"));
    }
    let url = format!("{}/{}/svg", state.host.trim_end_matches('/'), lang);
    state.http.post_text(url, source.to_vec()).await
}
```

health.rs `:79-84` capabilities 段加 `capabilities.push("kroki-proxy");`（native/worker 共用此函数则一处；若 worker 侧独立构造 capabilities（`rg -n 'capabilities' server/worker/src/lib.rs`），两处都加）。

- [ ] **Step 3: GREEN** — `cd server && cargo test -p vviewer-core kroki`；Commit：

```bash
git commit -am "feat(core): kroki 转发域与 KrokiHttp 接缝——native/worker 双形态共用，health 宣告 kroki-proxy（spec §8.2）"
```

---

### Task 2: native 端点 /api/kroki + --kroki-host

**Files:**
- Modify: `server/src/config.rs`（kroki_host 字段 + CLI）、`server/src/state.rs` 或 AppState 声明（`rg -n 'pub struct AppState' server/src`）
- Create: `server/src/routes/kroki.rs`（handler + reqwest KrokiHttp 实现）
- Modify: `server/src/routes/mod.rs:88-93`（protected 组挂 `/kroki`）

**Interfaces:**
- Consumes: Task 1 `kroki::render/KrokiState/KrokiHttp`。
- Produces: `POST /api/kroki {"lang":"svgbob","source":"..."} → {"svg":"..."}`；非 2xx/网络错 → 502（透传 kroki 消息体前 200 字节）；`--kroki-host <url>`（默认 `https://kroki.io`）。

- [ ] **Step 1: config + 装配**——config.rs 加 `kroki_host: String`（default `https://kroki.io`，TOML 节 `[kroki] host` 与 CLI `--kroki-host` 双通道，优先级 CLI>文件，镜像既有参数模式 `rg -n 'compute' server/src/config.rs`）；AppState 加 `kroki: kroki::KrokiState`（装配点 `http: Arc::new(ReqwestKrokiHttp::new())`）。

`ReqwestKrokiHttp`：

```rust
pub struct ReqwestKrokiHttp { client: reqwest::Client }
impl ReqwestKrokiHttp { pub fn new() -> Self { Self { client: reqwest::Client::new() } } }
#[async_trait::async_trait]
impl vviewer_core::kroki::KrokiHttp for ReqwestKrokiHttp {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        let resp = self.client.post(url).header(CONTENT_TYPE, "text/plain").body(body)
            .timeout(Duration::from_secs(30)).send().await
            .map_err(|e| CoreError::upstream(format!("kroki 请求失败: {e}")))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(|e| CoreError::upstream(format!("kroki 读响应失败: {e}")))?;
        if !status.is_success() {
            let msg = String::from_utf8_lossy(&bytes);
            return Err(CoreError::upstream(format!("kroki {}: {}", status.as_u16(), &msg[..msg.len().min(200)])));
        }
        Ok(bytes.to_vec())
    }
}
```

- [ ] **Step 2: handler + 路由**——routes/kroki.rs：

```rust
#[derive(Deserialize)]
pub struct KrokiRequest { pub lang: String, pub source: String }
#[derive(Serialize)]
pub struct KrokiResponse { pub svg: String }

pub async fn proxy(State(state): State<AppState>, Json(req): Json<KrokiRequest>) -> Result<Json<KrokiResponse>, AppError> {
    let bytes = vviewer_core::kroki::render(&state.kroki, &req.lang, req.source.as_bytes()).await?;
    let svg = String::from_utf8(bytes).map_err(|_| AppError::upstream("kroki 响应非 UTF-8"))?;
    Ok(Json(KrokiResponse { svg }))
}
```

mod.rs protected 组（`:88` 前的链式段）加 `.route("/kroki", post(kroki::proxy).layer(DefaultBodyLimit::max(KROKI_BODY_LIMIT)))`（KROKI_BODY_LIMIT=1MB，常量与 COMPUTE_BODY_LIMIT 同处声明）——**放 compute 门控之外**（`#[cfg(feature = "native")] if state.compute` 块外、auth_mw 之内）。

- [ ] **Step 3: 集成测试**（镜像既有 handler 集成测试装置 `rg -l 'auth_mw\|AppState' server/src/routes --glob '*.rs'` 的 test 模块）：AppState 用 mock KrokiHttp 注入——成功 200 `{svg}`；lang 非法 400；有 token 无 Bearer 401；body 超 1MB 413。worker 侧 AppError/状态码形态与 mounts 集成测试对齐。

- [ ] **Step 4: GREEN + clippy** — `cd server && cargo test --workspace && cargo clippy --workspace -- -D warnings`；Commit：

```bash
git commit -am "feat(server): /api/kroki 服务端代发端点与 --kroki-host 配置——SSRF 防线 host 部署侧收口（spec §8.2）"
```

---

### Task 3: worker 端 /api/kroki + VV_KROKI_HOST

**Files:**
- Modify: `server/worker/src/dispatch.rs:61-88`（match 表加 arm）
- Create: `server/worker/src/kroki.rs`（Fetch binding KrokiHttp impl）
- Modify: `server/worker/src/lib.rs`（init 读 env；能力矩阵表 `/api/compute/*` 行下加 `/api/kroki | 挂载（转发不算计算）`）
- Test: `server/worker/src/kroki.rs` 单测（url 拼接/白名单复用 core 用例）+ dispatch 集成锚

**Interfaces:**
- Consumes: Task 1 core kroki 域；worker 既有 Fetch transport（`server/worker/src/transport.rs`）。
- Produces: worker 形态 `POST /api/kroki` 可用；`VV_KROKI_HOST` env（缺省 `https://kroki.io`，空白串封死=装配失败 fail-closed，I-1 先例）。

- [ ] **Step 1: Fetch impl**（镜像 transport.rs 的 binding fetch 调用形态——worker fetch 需绝对 URL，URL 拼接已在 core 完成）：

```rust
pub struct FetchKrokiHttp;
#[async_trait::async_trait]
impl vviewer_core::kroki::KrokiHttp for FetchKrokiHttp {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        // binding fetch（transport.rs 同款 Request/Headers 构造），text/plain，30s 由 workerd 侧超时语义兜底
        let res = fetch_post_text(url, body).await?;
        if !res.ok() { return Err(CoreError::upstream(format!("kroki {}", res.status_code()))); }
        Ok(res.bytes().await?)
    }
}
```

- [ ] **Step 2: 装配 + 路由**——lib.rs init：`let kroki_host = std::env::var("VV_KROKI_HOST").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "https://kroki.io".into());`（`VV_MOUNTS` 先例）；CoreState/WorkerState 带 `KrokiState { host, http: Arc::new(FetchKrokiHttp) }`；dispatch.rs match 加：

```rust
        m if m == Method::Post && path == "/api/kroki" => kroki_proxy(req, state).await,
```

（kroki_proxy：读 body JSON {lang, source} → core kroki::render → JSON {svg}；错误出口复用 `json_error` 形态。）

- [ ] **Step 3: 构建验证 + 测试** — `cd server && cargo test -p vviewer-worker && cargo build -p vviewer-worker --target wasm32-unknown-unknown`；worker 侧集成锚（dispatch 层 mock transport 不现实——以 core 单测 + wasm 构建通过 + 冒烟清单注记为准）；Commit：

```bash
git commit -am "feat(worker): /api/kroki 转发端点与 VV_KROKI_HOST——Fetch 接缝双形态补全（spec §8.2）"
```

---

### Task 4: 服务端单图渲染端点 /api/compute/diagram

**Files:**
- Modify: `server/core/src/compute/diagrams.rs:16`（`fn render_diagram_svg` → `pub fn`，新增 `pub fn canonical_of(lang: &str) -> Option<&'static str>` 走 NATIVE 表）+ `server/core/src/compute/mod.rs`（如需 re-export）
- Modify: `server/src/routes/compute.rs`（handler）+ `server/src/routes/mod.rs:72-87`（compute 块挂路由）

**Interfaces:**
- Consumes: 既有 `render_diagram_svg(canon, source) -> Option<String>`（graphviz 零节点判空 + catch_unwind 兜底已在函数内）。
- Produces: `POST /api/compute/diagram {"lang":"graphviz","source":"..."} → {"svg":"..."}`；非 NATIVE 400、渲染失败 400；挂 compute 组（Bearer + CompressionLayer + body limit）。

- [ ] **Step 1: handler**（compute.rs，镜像 markdown handler 薄适配形态）：

```rust
#[derive(Deserialize)]
pub struct DiagramRequest { pub lang: String, pub source: String }
#[derive(Serialize)]
pub struct DiagramResponse { pub svg: String }

pub async fn diagram(State(_state): State<AppState>, Json(req): Json<DiagramRequest>) -> Result<Json<DiagramResponse>, AppError> {
    let canon = vviewer_core::compute::diagrams::canonical_of(&req.lang)
        .ok_or_else(|| AppError::bad_request("非服务端原生图表语言"))?;
    let svg = vviewer_core::compute::diagrams::render_diagram_svg(canon, &req.source)
        .ok_or_else(|| AppError::bad_request("图表渲染失败"))?;
    Ok(Json(DiagramResponse { svg }))
}
```

mod.rs compute 块（`:79-83` 旁）加 `.route("/compute/diagram", post(compute::diagram).layer(DefaultBodyLimit::max(COMPUTE_BODY_LIMIT)))`。

- [ ] **Step 2: cargo 测试**——成功（graphviz 最小 dot → svg 含 `<svg`）；`digraph{}` 零节点 400；`lang="mermaid"` 400；token 401 面（镜像 compute/markdown 既有测试）。core 侧 canonical_of 单测（graphviz/dot→graphviz、svgbob、大小写不敏感、未知 None）。

- [ ] **Step 3: GREEN + Commit** — `cd server && cargo test --workspace`；

```bash
git commit -am "feat(server): /api/compute/diagram 单图渲染端点——本地来源文档图表服务端渲染载体（spec §8.1）"
```

---

### Task 5: 前端 DiagramMode 'server' + krokiVia + capabilities 消费

**Files:**
- Modify: `packages/render-text/src/markdown/diagrams.ts:5`（DiagramMode 加 `'server'`）+ DiagramType 加 `server?: boolean`（graphviz/svgbob 两行标 true）
- Modify: `packages/render-text/src/markdown/pipeline.ts:134-143`（effectiveModeOf）+ `:292-321`（renderDiagramBlock server 分支 + krokiVia=server 分支）+ 新 helper `sanitizeDiagramFragment`
- Modify: `packages/render-text/src/markdown/sanitize.ts`（fetched-SVG 豁免导出，`rg -n 'uponSanitizeElement' packages/render-text/src/markdown/sanitize.ts`）
- Modify: `packages/render-text/src/markdown/markdownRenderer.ts:130-135`（DiagramRenderOptions）
- Modify: `apps/web/src/lib/viewer.ts:167-175`（注入）+ `apps/web/src/lib/stores/settings.ts`（类型/默认/白名单）+ `apps/web/src/lib/settingsDraft.ts:53,144-157,413`（DIAGRAM_MODES/'server'、diagrams 字段清单加 'krokiVia'）+ `DiagramsSection.svelte`（krokiVia select + server option）

**Interfaces:**
- Produces: `DiagramRenderOptions` 扩 `krokiVia: 'client' | 'server'`、`serverDiagramOf: (lang: string) => boolean`、`krokiProxy: boolean`；pipeline `renderServerDiagram(lang, source)`（fetch `/api/compute/diagram`）、`renderKrokiViaServer(lang, source)`（fetch `/api/kroki`）——两者均经 `computeRouter.remoteCall(path)` 取 `{url, headers}`（`viewer.ts:97-116` remoteMarkdown 同款）+ `sanitizeDiagramFragment` 后 innerHTML。

- [ ] **Step 1: RED（pipeline）**：

```ts
it('modes=server 且 serverDiagramOf 命中→走服务端 fetch 并 sanitize', async () => {
  /* mock fetch 返回 {svg:'<svg><style>...</style></svg>'} → wrapper view 含 svg 且 style 保留（豁免面）；lang=dot→serverDiagramOf('dot') 命中（别名归一） */
});
it('modes=server 未命中能力→降级 local→kroki→source', async () => { /* serverDiagramOf=false 且 type 有 engine → 断言 local 渲染被调用 */ });
it('krokiVia=server→POST /api/kroki 内联 svg（非 img src）', async () => { /* 断言 view 无 img、含 svg；krokiProxy=false 时回落 client img 路径 */ });
```

- [ ] **Step 2: 实现 pipeline**——effectiveModeOf：

```ts
  if (requested === 'server') {
    if (ctx.diagram?.serverDiagramOf?.(type.id)) return 'server';
    if (type.local && type.engine) return 'local';
    return type.krokiType ? 'kroki' : 'source';
  }
```

renderDiagramBlock 加 server 分支（kroki 分支前；fetch 失败 catch → 降级链递归/复用 kroki 逻辑——按「fetch 抛错转 Kroki 回退」实现：server 失败 `mode = type.local && type.engine ? 'local' : 'kroki'` 重走分支）。sanitize.ts 抽 `sanitizeDiagramFragment(root: Document, html: string): string`——服务端上下文钩子逻辑复用（style/`url(#` 规则同 `wrapServerDiagrams` 承接面）。kroki 分支头部按 `ctx.diagram?.krokiVia === 'server' && ctx.diagram?.krokiProxy` 分叉内联路径。

- [ ] **Step 3: 注入与设置五处**——viewer.ts 注入闭包加（capabilities 读 `loadCapabilities()`，`openFlow.svelte.ts:798-806`）：

```ts
const caps = loadCapabilities();
const capDiagrams = /* health diagrams 子集：rg -n 'diagrams' apps/web/src/lib/openFlow.svelte.ts —
  若未缓存则补 loadDiagramCapabilities()（sessionStorage 'vv:diagram-capabilities'，镜像 compute-languages） */;
setDiagramOptions(() => {
  const s = loadSettings();
  return {
    krokiHost: s.diagrams.krokiHost || DEFAULT_KROKI_HOST,
    mermaidTheme: resolveMermaidTheme(mode),
    krokiVia: s.diagrams.krokiVia,
    serverDiagramOf: (lang) => capDiagrams.includes(resolveDiagramType(lang)?.id ?? lang),
    krokiProxy: caps.includes('kroki-proxy'),
    modeOf: (lang) => s.diagrams.modes[lang] ?? resolveDiagramType(lang)?.defaultMode ?? 'local',
  };
});
```

settings.ts：`DiagramsSettings` 加 `krokiVia: 'client' | 'server'`；默认 `:52` 加 `krokiVia: 'client'`；白名单 `:101-109` 重建式对象加 `krokiVia: d.krokiVia === 'server' ? 'server' : 'client'`。settingsDraft.ts：DIAGRAM_MODES 加 `'server'`；`:413` diagrams 字段清单加 `'krokiVia'`；`:144-157` 值校验同步。DiagramsSection：mode select 加 `{#if t.server}<option value="server">服务端</option>{/if}`；krokiVia select（client=「前端直连」/server=「服务端代发」）+ hint 注明服务端代发需部署侧 kroki 支持。

- [ ] **Step 4: GREEN + 门禁 + Commit** — `pnpm vitest run packages/render-text apps/web && pnpm --filter web typecheck`；

```bash
git commit -am "feat(web/render-text): 图表 server 模式与 krokiVia 设置——capabilities 协商消费（spec §8.3）"
```

---

### Task 6: graphviz 双渲染器（hpcc CDN）

**Files:**
- Modify: `packages/render-text/src/markdown/cdnEngines.ts`（renderGraphvizHpcc）
- Modify: `packages/render-text/src/markdown/diagrams.ts`（DiagramType 加 `renderers?: readonly string[]`；graphviz 行 `renderers: ['viz-js', 'hpcc']`）
- Modify: `packages/render-text/src/markdown/diagramEngines.ts`（renderGraphviz 分流）+ `renderDiagramEngine` opts 加 `renderer?: string`
- Modify: `apps/web/src/lib/stores/settings.ts` + `settingsDraft.ts:413`（`renderers: Record<string, string>` + 白名单字段 'renderers'）+ `DiagramsSection.svelte`（第二列 select，仅 `t.renderers?.length` 时显示）
- Modify: `apps/web/src/lib/viewer.ts:167-175`（注入 `rendererOf`）

**Interfaces:**
- Produces: `renderDiagramEngine('graphviz', src, { renderer: 'viz-js' | 'hpcc' })`；`DiagramRenderOptions.rendererOf?: (lang: string) => string | undefined`；pipeline `:315` 调用透传 `renderer: ctx.diagram?.rendererOf?.(type.id)`。

- [ ] **Step 1: cdnEngines renderGraphvizHpcc**：

```ts
export async function renderGraphvizHpcc(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@hpcc-js/wasm-graphviz@1.30.0/+esm`)) as {
    Graphviz: { load: () => Promise<{ layout: (src: string, fmt?: string, engine?: string) => Promise<string>; dispose: () => void }> };
  };
  const g = await mod.Graphviz.load();
  try { return await g.layout(source, 'svg', 'dot'); } finally { g.dispose(); }
}
```

diagramEngines renderGraphviz(source, renderer)：`renderer === 'hpcc'` → cdnEngines.renderGraphvizHpcc；否则既有 viz 路径（默认零变化）。默认 settings.diagrams.renderers 为空 → rendererOf 返回 undefined → viz-js。

- [ ] **Step 2: RED 单测**——cdnEngines mock loader 断言 hpcc URL 与 layout 调用；settings 白名单用例（renderers 非对象值归位默认空）；DiagramsSection 渲染锚（graphviz 行出现渲染器 select、mermaid 行无）。

- [ ] **Step 3: UI 五处 + GREEN**——settingsDraft validateSettings 对 renderers 值校验（仅白名单 id：'viz-js'/'hpcc'，非法归默认）；viewer.ts 注入 `rendererOf: (lang) => s.diagrams.renderers[resolveDiagramType(lang)?.id ?? lang]`。`pnpm vitest run packages/render-text apps/web/src/lib && pnpm --filter web typecheck`；Commit：

```bash
git commit -am "feat(render-text/web): graphviz 双渲染器 viz-js/hpcc——hpcc 经 CDN 直链按需加载（spec §9.1）"
```

---

### Task 7: mermaid theme 设置 + 即时生效事件

**Files:**
- Modify: `packages/render-text/src/markdown/diagramEngines.ts:4`（`MermaidTheme = 'default' | 'neutral' | 'dark' | 'forest' | 'base'`）
- Modify: `packages/render-text/src/markdown/markdownRenderer.ts:532-556`（onAppearance 旁加 onDiagramSettings 同构监听）+ DiagramRenderOptions.mermaidTheme 类型同步
- Modify: `apps/web/src/lib/stores/settings.ts`（`mermaidTheme: 'auto' | MermaidTheme`，默认 'auto'）+ `settingsDraft.ts`（:413 diagrams 清单加 'mermaidTheme'，值校验五枚举+'auto'）
- Modify: `apps/web/src/lib/viewer.ts:167-175`（`mermaidTheme: s.diagrams.mermaidTheme === 'auto' ? resolveMermaidTheme(mode) : s.diagrams.mermaidTheme`）
- Modify: `apps/web/src/lib/AppShell.svelte`（onSettingsChanged 内派发 `vv:diagram-settings-applied`，`rg -n 'onSettingsChanged' apps/web/src/lib/AppShell.svelte` 定位——d53defd 补打标同点）+ `apps/web/src/lib/theme.ts:313-323`（外观事件 detail.mermaidTheme 类型扩五枚举）
- Modify: `DiagramsSection.svelte`（mermaid theme select：自动/默认/中性/暗色/森林/基础）

**Interfaces:**
- Produces: `vv:diagram-settings-applied` CustomEvent（detail `{ mermaidTheme: MermaidTheme }`，与 appearance 事件同构）。

- [ ] **Step 1: RED**——markdownRenderer 测试（`rg -l 'vv:appearance-applied' packages/render-text --glob '*.test.ts'` 既有装置）：

```ts
it('vv:diagram-settings-applied 触发 [data-mermaid] 重画为设置主题', async () => {
  /* 渲染含 mermaid fence 文档 → 派发事件 detail.mermaidTheme='forest' → renderMermaidInto 被以 forest 调（mock 引擎断言） */
});
```

- [ ] **Step 2: 实现**——markdownRenderer 监听段镜像 `:534-540`（第二个具名 listener + destroy removeEventListener）；theme 设置链按 Global Interfaces 所列五处；DiagramsSection select options 六项。

- [ ] **Step 3: GREEN + 门禁 + Commit** — `pnpm vitest run packages/render-text apps/web && pnpm --filter web typecheck`；

```bash
git commit -am "feat(web/render-text): mermaid theme 用户设置与即时重画事件——auto 跟随外观语义保留（spec §9.2）"
```

---

### Task 8: kroki 类型扩容 30 类 + 四个新 CDN 引擎

**Files:**
- Modify: `packages/render-text/src/markdown/diagrams.ts`（注册表 18→30 行 + aliases 无新增）
- Modify: `packages/render-text/src/markdown/cdnEngines.ts`（wavedrom/bytefield/dbml/d2 四渲染器）
- Modify: `packages/render-text/src/markdown/diagramEngines.ts`（switch 四 case）
- Modify: `DiagramsSection.svelte` hint 文案（30 类口径）

**Interfaces:**
- Produces: 注册表新行（spec §10 表格逐行）；`renderDiagramEngine('wavedrom'|'bytefield'|'dbml'|'d2', source)`。

- [ ] **Step 1: 注册表**——按 spec §10 表逐行加（krokiType=id、highlightLang 按 spec §10 补齐值、defaultMode：wavedrom/bytefield/dbml='local'，d2 与 8 个 kroki-only='kroki'；engine 仅四个 local 类标）：

```ts
  { id: 'wavedrom', aliases: [], local: true, defaultMode: 'local', krokiType: 'wavedrom', highlightLang: 'json', engine: 'wavedrom' },
  { id: 'bytefield', aliases: [], local: true, defaultMode: 'local', krokiType: 'bytefield', highlightLang: 'clojure', engine: 'bytefield' },
  { id: 'dbml', aliases: [], local: true, defaultMode: 'local', krokiType: 'dbml', highlightLang: 'sql', engine: 'dbml' },
  { id: 'd2', aliases: [], local: true, defaultMode: 'kroki', krokiType: 'd2', highlightLang: '', engine: 'd2' },
  // kroki-only 八行：packetdiag/rackdiag/goat/wireviz/structurizr/symbolator/tikz/umlet
  // highlightLang：tikz→'latex'、wireviz→'yaml'、structurizr→'groovy'，余 ''
```

- [ ] **Step 2: 四渲染器**（cdnEngines；API 以 /var/tmp/kroki-research 实测为准）：

```ts
export async function renderWavedromCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/wavedrom@3.7.0/+esm`)) as {
    renderWaveForm: (index: number, source: unknown, el: HTMLElement) => void;
  };
  const el = document.createElement('div');
  mod.renderWaveForm(0, JSON.parse(source), el); // JSON5 语法容错：parse 失败抛错走回退链
  const svg = el.querySelector('svg');
  if (!svg) throw new Error('wavedrom 渲染失败');
  return svg.outerHTML;
}
export async function renderBytefieldCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/bytefield-svg@1.11.0/+esm`)) as { default: (src: string, opts?: { embedded?: boolean }) => string };
  return mod.default(source, { embedded: true });
}
export async function renderDbmlCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@softwaretechnik/dbml-renderer@1.0.31/+esm`)) as { run: (src: string, format: string) => string };
  return mod.run(source, 'svg');
}
export async function renderD2Cdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@d2lang/d2@0.1.34/+esm`)) as { D2: new () => { compile: (s: string) => Promise<unknown>; render: () => Promise<string>; dispose: () => Promise<void> } };
  const d2 = new mod.D2();
  try { await d2.compile(source); return await d2.render(); } finally { await d2.dispose(); }
}
```

（wavedrom DOM 路径为兜底案；若 /var/tmp/kroki-research 实测 renderAny+onml 无 DOM 路径可用则优先采用——实施首步验证并择一，另一案留注释。）

- [ ] **Step 3: 单测**（mock loader 四类 URL+产物断言）+ 注册表用例（30 类、d2 defaultMode kroki、别名 dot/vega-lite/latex 不变）。

- [ ] **Step 4: GREEN + Commit** — `pnpm vitest run packages/render-text && pnpm --filter web typecheck`；

```bash
git commit -am "feat(render-text): kroki 类型扩容 30 类与 wavedrom/bytefield/dbml/d2 CDN 引擎（spec §10）"
```

---

### Task 9: e2e 与全量门禁收口

**Files:**
- Create: `apps/web/e2e/b-diagram-server-kroki.spec.ts`
- Modify: `docs/e2e/`（server-kroki 域文档或并入既有）

- [ ] **Step 1: e2e**（server 通道用例跑 playwright.server.config，mock kroki 用 page.route）：

```ts
test('DSV-01 modes=server（graphviz）经 /api/compute/diagram 出图', async ({ page }) => {
  /* server 套件：settings.diagrams.modes.graphviz='server' → 打开 md → 拦截断言请求 path=/api/compute/diagram → svg 出图 */
});
test('DSV-02 krokiVia=server 经 /api/kroki 内联（mock kroki 上游 200）', async ({ page }) => {
  /* page.route('**/api/kroki', fulfill {svg}) —— 或 server 侧 --kroki-host 指 mock 上游；view 无 img 有 svg */
});
test('DSV-03 无 kroki-proxy 能力（无服务端会话）→ krokiVia 选项隐藏/回落 client', async ({ page }) => { /* 本地模式打开 → 设置中心 krokiVia select 仅 client 或隐藏 */ });
test('DSV-04 wavedrom 本地 CDN 出图（真实网络，skipIf offline）', async ({ page }) => { /* ```wavedrom wavejson → svg */ });
```

- [ ] **Step 2: 全量门禁**

```bash
pnpm --filter web typecheck
pnpm vitest run
cd server && cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo build -p vviewer-worker --target wasm32-unknown-unknown
pnpm build:e2e && node tools/diagram-budget.mjs
pnpm --filter web exec playwright test（默认 + server 双通道）
```

Expected: 全绿；预算 ≤4MB（CDN 类零增量）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e docs/e2e
git commit -m "test(e2e): 服务端图表/kroki 代发/新类型 CDN 用例与 P3 门禁收口（spec §8/§10）"
```
