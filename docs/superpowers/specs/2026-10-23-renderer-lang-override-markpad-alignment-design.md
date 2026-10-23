# 渲染器/语言手动指定 + markpad 对齐收口 设计

- 日期：2026-10-23
- 状态：待用户审阅
- 来源：六大需求满足度审计（dwfrun-9b31ce56）遗留项 1a/1c、交接文档 `.temp/handoff-2026-10-23-renderer-metapanel-1a-1c.md`、用户追加需求（语言手动指定、属性面板常驻、kroki 类型扩容、worker kroki 转发、graphviz 多渲染器、mermaid theme）。
- 上游 spec：`2026-10-19-markdown-markpad-alignment-design.md`（§2 图表、§4.2 代码徽标——本文重开其中两处拍板）、`2026-10-11-format-coverage-open-with-design.md`（候选集定义——本文扩容）。

## 0. 全局拍板记录（本轮用户决策，实施不得回退）

1. **1a 四类图表对齐走 CDN 直链**（否决本地打包方案）。
2. **候选集口径：markdown 进恒兜底**（所有文件可切 markdown 渲染）。
3. **徽标即复制，右下角复制钮退役**（对齐 markpad 单入口）。
4. **语言入口：属性面板主入口 + 状态栏/Tab 右键轻入口**（不展开全列表）。
5. **worker 端支持 kroki 转发**（转发不算计算，不挂 native 门控）。
6. **graphviz 多渲染器、kroki 全类型扩容、mermaid theme 设置：全做**（推翻前轮「知情放弃」）。
7. **CDN 类资产一律不进 dist**；唯一本地打包例外是 svgbob wasm（无 npm 对齐包，自建 wrapper）。

## 1. 背景与目标

六大审计 25 要点中 5 项部分偏差，其中两项（1a 图表离线、1c 徽标复制）属 markpad 对齐缺口；属性面板「打开方式」下拉被 meta 实例门控、候选集不含 markdown，无法满足「.txt 强制 markdown 渲染」「扩展名与内容语言不匹配时手动改语言」两类场景。本 spec 一次收口：交互补全（A/B/C）+ 图表通道大扩容（D/E/F/G/H）。

**markpad 基准事实**（探索核实，防旧口径复用）：

- markpad 的 `.txt` 在 markdown 白名单内默认即渲（`src/lib/utils/markdownLinks.ts:18`），**没有**手动语言覆盖功能——语言手动指定是 vviewer 超出 markpad 的能力。
- 徽标即复制按钮（`src/lib/pipeline/copyCode.ts:15-62`：点击→Copied! 1.5s），无右下角复制钮。
- 图表类型注册表 18 类与 vviewer 完全全等（逐类对照 2026-10-23）；差距仅在 excalidraw/bpmn/vega/vegalite 四类的通道（markpad local 默认 vs vviewer kroki-only）。
- markpad graphviz 有渲染器双级选择（viz-js/hpcc-wasm/rust 三渲染器可切，`src/lib/diagrams.ts:121-126`）。

## 2. 全局不变量（改动必须维持）

- **渲染器三入口单机制**：候选集/顺序/存在性守卫全部由 `openWithOf`（`apps/web/src/lib/openWith.ts:15-34`）算出；状态栏浮层（`ViewerPane.svelte:467-483`）、Tab 右键子菜单（`TabBar.svelte:85-93` 经 `RendererPickerMenu.ts`）、MetaPanel 下拉三处同源同集同序。本 spec 的候选集扩容只动 `openWithOf` 一处。
- **持久化链**：`Tab.overrideRenderer` 快照写（`openFlow.svelte.ts:90`）/读回（`:414`）/复制继承（`:356`）/session 类型（`stores/session.ts:15-16`）；新增 `overrideLang`/图表设置字段全部同款链路。
- **e2e 锚**：OWX-01..09、TAX-12/13 现有断言按本 spec 更新口径后零翻转（候选集 +markdown 属预期翻转，逐锚更新并注记）。
- **4MB 图表预算门禁**（`tools/diagram-budget.mjs`，口径=diagram-engines-* chunk）：现占用 1.36MB，本 spec 后 2.2MB，门禁值不动。CDN 类资产不入该口径。
- **sanitize 面**：服务端/CDN 图表 SVG 的 `<style>` 放行走 `[data-vv-diagram=server]` 上下文豁免 + `url(#...)` 同文档引用放行正则（既有，`2026-10-19-md-diagrams-server.md` C1 口径）；CDN 引擎输出 SVG 复用同款豁免面（容器打 `data-vv-diagram` 标）。

## 3. 阶段 A：候选集 markdown 恒兜底 + 属性面板下拉常驻

### 3.1 候选集扩容

`openWithOf` 恒兜底序列 `push('code'); push('hex')`（`openWith.ts:28-33`）扩为 `code, markdown, hex`。语义：任何文件都值得试以 markdown 打开（与 hex 对 .md 出现的先例一致；markdown 渲染器对二进制 buffer 强解 UTF-8 渲染乱码，无害）。OWX 系候选集断言逐锚更新。

### 3.2 MetaPanel 下拉常驻

去掉 `{#if fileMeta.openWith}` 门控（`MetaPanel.svelte:149`），改用 `rendererCandidatesOfTab`（`RendererPickerMenu.ts:48-63`，TabBar 同款：`lastRendererId`/`lastDetExt` 回退 `extOfName`）从激活 tab 状态直接计算——meta 实例缺失的渲染路径（store.read 失败卡片、清理后空态）下拉不再消失。选择仍走 `onOpenWith` → `setRendererOverride`（`openFlow.svelte.ts:495-509`），持久化链零改动。metaStore 的 `fileMeta.openWith` 上行通道保留给「打开方式（手动）」徽标显示。

## 4. 阶段 B：高亮语言手动指定

### 4.1 状态与消费链

- `Tab.overrideLang?: string` 新字段，与 `overrideRenderer` 正交；快照写/读回/duplicate 继承全同款（`session.ts`、`openFlow.svelte.ts` 三处）。值=语言检测表 canonical 名（rust/javascript/...）。
- 消费：dispatch 到 code 渲染器时 `opts.lang = overrideLang ?? meta.lang ?? det.lang`——注入口现成（`code.ts:698`，有值即跳过 `detectLanguage`；组装点 `code.ts:2585`）。非 code 渲染器 override 保留不消费，切回再生效。
- 引擎链自兜底：tree-sitter 三层资产链找不到 → hljs 别名桥 → plain。**不做输入校验**（宽松透传）。
- 已知既有不一致保持现状：highlightAuto 内容嗅探结果不回写面板语言行（本 spec 不动，注记）。

### 4.2 UI

- **属性面板（主入口）**：「语言」行（`MetaPanel.svelte:173-175`，现纯展示 `fileMeta.lang`）升级为 `<input list>` + datalist 可搜索建议，值集=languages.json 检测表 canonical 名（~342 项）；空值=自动。override 生效时显「（手动）」徽标（与打开方式同款）。
- **状态栏轻入口**：浮层菜单（`.vv-status-picker`）底部加「语言：自动（检测 rust）／rust（手动）」项，点击打开属性面板（移动端开抽屉）并聚焦语言输入框。
- **Tab 右键轻入口**：「打开方式」子菜单旁加单项「语言：…（在属性面板中修改）」，同款跳转。

## 5. 阶段 C：徽标点击复制（1c 对齐，重开 2026-10-19 spec §4.2 拍板）

- 语言徽标（`pipeline.ts` data-md-lang，`:465-470` 拍板注释同步更新）升级为复制按钮：点击复制整块代码 + 「已复制」反馈 1.5s（复用现右下角钮逻辑 `:471-511`），交互对齐 markpad `copyCode.ts`。
- **右下角复制钮退役**——复制入口收敛为徽标一个。
- **无语言块**：徽标恒渲染，无语言时显示复制图标（markpad 同款），复制入口不消失。
- 导出 HTML（`collectExportHtml`）：徽标保留语言标识、转纯 span 去交互。MD 域复制钮 e2e 用例改徽标锚。

## 6. 阶段 D：四类图表 CDN 直链本地引擎（1a 对齐）

- 引擎：`@excalidraw/utils`（exportToSvg）、`bpmn-js`（NavigatedViewer importXML→提取 SVG）、`vega-embed`（内联 vega+vega-lite，render→svg）。版本取 markpad 现用（@excalidraw/utils 0.1.5 / bpmn-js 18.31.0 / vega-embed 7.3.0），渲染逻辑移植 markpad `src/lib/localRenderers.ts`。
- 通道：jsdelivr `+esm` 精确版本动态 `import(/* @vite-ignore */)`，**dist 零增量**。新增 cdnEngines 模块（`diagramEngines.ts` 扩展），四类注册表（`packages/render-text/src/markdown/diagrams.ts:33,35-37`）`local:false→true`、`defaultMode:'kroki'→'local'`、engine 标 CDN 载体。
- 回退链：CDN 加载失败（离线/被墙/版本失效）→ kroki → source，沿用 `pipeline.ts:135-143` 现链。
- SW：runtimeCaching 加 `cdn.jsdelivr.net/npm/` 图表引擎请求 CacheFirst（版本化 URL 恒定，grammar wasm 先例同款）；缓存后二次访问近似离线。
- 设置：`settings.diagrams.modes` 四类白名单补 `'local'`（`stores/settings.ts:106`、`settingsDraft.ts:53/156`）。
- **前置 spike（实施首步）**：浏览器实测四包 `+esm` 动态 import 可用性（bpmn-js 内部 dynamic import、vega-embed 产物体积与加载时长、CSS 需求）——不过则回用户重拍板。
- 已知差异（知情）：markpad local 失败不回退 kroki，vviewer 回退链更优；mermaid kroki 端为 ELK 布局（kroki v0.33），本地为 mermaid 默认 dagre，布局细节差异知情。

## 7. 阶段 E：svgbob 前端 wasm 引擎

- **可行性已实证**（2026-10-23 试编译）：svgbob 0.7.6 一次编译过 wasm32-unknown-unknown 零 workaround（sauron 依赖未启用 with-dom）；bindgen 后 820KB、gzip ~156KB；Node 渲染与 native byte 级一致；API `to_svg(&str) -> String` 无 DOM 序列化问题。npm 现成包内核停 0.6.6（带已修 styles 泄漏 bug），不可用。
- **wrapper crate**：自建 `svgbob-wasm`（wasm-bindgen 导出 `render(source: String) -> String`，内部 `svgbob::to_svg`），依赖 `svgbob = "=0.7.6"` 与 server 端 Cargo.lock 锁死同版（防前后端渲染漂移）。
- **构建链**：仿 grammar 先例——tools 构建脚本构建期生成，**产物不入库**；CI 装 wasm32 target + wasm-bindgen-cli（CLI 版本与 crate 侧 wasm-bindgen 精确一致，钉死）。
- **交付：本地打包进 dist（唯一 dist 增量）**——bindgen 产物 820KB raw 入 diagram-engines 口径（1.36→~2.2MB < 4MB 门禁不动）；SW runtimeCaching 补 svgbob wasm CacheFirst。
- 注册表：svgbob `local:false→true`、`defaultMode:'kroki'→'local'`、`engine:'svgbob'`；回退链自动接管（服务端 compute 路径的 rust svgbob 不受影响，两通道并存：文档走服务端整篇渲时由 rust 渲，本地管线按 mode 走 wasm）。
- 输出 SVG 含 `<style>`（0.7.x 已 `class="svgbob"` 作用域限定），sanitize 走 §2 豁免面。

## 8. 阶段 F：图表级「服务端」模式 + kroki 服务端代发（native + worker）

### 8.1 服务端单图渲染端点

`POST /api/compute/diagram {lang, source} → {svg}`——`render_diagram_svg`（`server/core/src/compute/diagrams.rs:16`，私有）提 pub 复用，仅 NATIVE 子集（graphviz/svgbob，`diagrams.rs:14`），非 NATIVE 4xx。挂 compute 组（`routes/mod.rs:72-87` 同款：Bearer 鉴权 + CompressionLayer + body limit）。**这是「前端打开的文件也能用服务端渲染」的载体**：单图端点不经整篇 markdown 路由（`routeMarkdown` 的 `src.path` 判据不再拦路），本地来源文档只要会话连过服务器（`loadLastServer` + `vv:capabilities` 会话缓存）即可用，无需 per-doc 探活，fetch 失败走回退链兜底。

### 8.2 kroki 代发（worker 参与）

- 端点 `POST /api/kroki {lang, source} → {svg}`：放 protected 组，**不进 compute 组、不挂 native 门控**（用户拍板：转发不算计算）。服务端构造 kroki 请求用 **POST raw body**（`POST {host}/{type}/svg`，无 URL 长度限制）。
- **SSRF 防线：请求不带 host**。转发目标完全由部署侧配置：native 新 CLI 项 `--kroki-host`（默认 `https://kroki.io`），worker env `VV_KROKI_HOST`（`VV_MOUNTS` 先例）。
- **transport 接缝**：core 加 kroki 代理模块 + 出站 HTTP trait（storage `HttpTransport` 同款模式）——native 装配 reqwest，**worker 装配 Fetch binding**（`server/worker/src/transport.rs` 先例），两形态都编译进去。
- capabilities 加 `"kroki-proxy"`，两形态恒宣告（编译期即存在）。worker 的 `/api/compute/*` 仍不挂载（现状），`/api/kroki` 挂上。

### 8.3 前端设置与消费

- `DiagramMode` 加 `'server'`（`diagrams.ts:5`）——仅 graphviz/svgbob 两类 UI 出现该选项（服务端 native 子集）；不可用降级 `server→local→kroki→source`（`effectiveModeOf`，`pipeline.ts:135-143`——恰好两类都有前端本地引擎，降级链全通）。
- `krokiVia: 'client' | 'server'` 新字段：client=img 直发现状零改动（`pipeline.ts:292-306`）；server=fetch `/api/kroki` 内联 svg，sanitize 走 §2 豁免面（容器打 `data-vv-diagram="kroki-proxy"` 标）。
- capabilities 消费：前端开始读 health `diagrams` 子集（决定「服务端」选项显隐）与 `kroki-proxy`（决定 krokiVia=server 显隐）——`health.rs:79-84` 宣告已有，前端新增读取。
- 设置面落点五处：注册表类型（`diagrams.ts`）、运行时白名单（`settings.ts:99-109`）、导入白名单两处（`settingsDraft.ts:53/144-157/413`）、DiagramsSection 控件、viewer.ts 注入（`viewer.ts:167-175` → `DiagramRenderOptions`，`markdownRenderer.ts:130-135`）。

## 9. 阶段 G：graphviz 多渲染器 + mermaid theme 设置

### 9.1 graphviz 双渲染器

- 引入 `@hpcc-js/wasm-graphograf` 1.30.0（实证：wasm 内嵌单文件，jsdelivr +esm 可用，820KB/gzip 636KB，维护活跃）——CDN 直链（阶段 D 基建复用）。
- `settings.diagrams.renderers: Record<string, string>` 新字段（graphviz: `'viz-js'` 默认 | `'hpcc'`）；渲染器 id 白名单同 §8.3 五处落点。
- DiagramsSection 网格每类型第二列 select，仅多渲染器类型显示。
- 引擎分发：`renderDiagramEngine('graphviz', src, { renderer })`——viz-js `renderString` / hpcc `layout`（后者顺带 circo/neato/fdp 等 engine 子集，engine 参数透传）。默认 `viz-js` 不变，默认渲染结果零变化。

### 9.2 mermaid theme

- `MermaidTheme` 类型扩全集（`diagramEngines.ts:4`，现 `'default'|'dark'` → +neutral/forest/base）。
- `settings.diagrams.mermaidTheme: 'auto' | MermaidTheme` 新字段（`auto`=跟随外观亮暗，即现状语义，`theme.ts:296-298` `resolveMermaidTheme`）。
- 注入（`viewer.ts:171-174`）改「设置优先、auto 回退 `resolveMermaidTheme(mode)`」；重画通道现成（`renderMermaidInto`，`diagramEngines.ts:52-60`，每次重画重新 initialize）。
- **即时生效**：settings 保存路径派发新事件 `vv:diagram-settings-applied`，markdownRenderer 复用 onAppearance 同构监听（`markdownRenderer.ts:532-556`）重画本实例 `[data-mermaid]`。DiagramsSection「设置变更不回溯已开文档」设计注记同步（仅本字段开口）。

## 10. 阶段 H：kroki 类型扩容 + wavedrom/bytefield/dbml 本地引擎

对齐 kroki v0.33.0 官方注册表（31 端点=30 类型+dot 别名，2026-10-23 调查），vviewer 18 → 30 类：

| 组 | 类型 | 通道 | defaultMode |
|---|---|---|---|
| 新本地引擎 | wavedrom 3.7.0（+esm 75KB）、bytefield-svg 1.11.0（843KB 单文件自包含）、dbml-renderer 1.0.31（入口 36KB，内嵌 viz.js sync 变体 ~2MB） | CDN local / kroki / source | local |
| 特殊 | d2（`@d2lang/d2` 0.1.34 官方 wasm，11.5MB 内嵌 42MB wasm，play.d2lang.com 同款） | CDN local / kroki / source | **kroki**（11.5MB 太重不做默认） |
| kroki-only 注册 | packetdiag、rackdiag、goat、wireviz、structurizr（DSL 解析仅 Java）、symbolator、tikz、umlet | kroki / source | kroki |

- 不注册：diagramsnet（kroki 自标实验性）、lini（kroki Unreleased 未随版本发布）、protobuf（kroki 现版无此类型）。
- 三个新本地引擎全部 **CDN 动态加载，不进 dist**（与 §6 同策略；实证 +esm 全 200、Node 实测直出 SVG 无 DOM 依赖）。d2 的 local 通道同 CDN 按需。
- 注册表逐类补齐，aliases 无新增（kroki 无额外官方别名）；krokiType 端点名=上表 id；highlightLang（源码模式高亮）：wavedrom→`json`（wavejson）、bytefield→`clojure`（DSL 系）、dbml→`sql`（近似）、tikz→`latex`、wireviz→`yaml`、structurizr→`groovy`（DSL 近似）、d2→`''`（无 hljs 支持）、goat/symbolator/umlet/packetdiag/rackdiag→`''`。
- 已知取舍：bytefield 1.x 语法 `draw-box` 宽度须属性表 `{:span 4}`（kroki 同款）；dbml 依赖的 viz.js fork 2022 年停更（锁 3.4.0）——kroki 服务端同样如此，非 vviewer 独有风险。

## 11. 阶段顺序与依赖

A → B → C → E(svgbob wasm) → D(四类 CDN) → F(服务端+kroki 代发) → G(多渲染器+mermaid theme) → H(类型扩容)。

- E 先于 D：构建链类似 grammar 先例、风险更低。
- D 的 CDN 引擎基建（动态 import + 回退链 + SW 规则）被 G/H 复用。
- 各阶段独立可交付、可单独评审；实施期可拆多份 plan。

## 12. 资产策略矩阵

| 通道 | 资产 | dist 影响 |
|---|---|---|
| CDN 直链（jsdelivr +esm，版本钉死） | @excalidraw/utils、bpmn-js、vega-embed、@hpcc-js/wasm-graphograf、wavedrom、bytefield-svg、dbml-renderer、@d2lang/d2 | 零增量 |
| 本地打包（自建 wrapper，产物不入库） | svgbob-wasm（820KB raw） | +820KB |
| 服务端编译 | graphviz/svgbob（rust，现状）、kroki 转发（无资产） | 不涉 dist |

## 13. 测试与门禁

- **单测**：svgbob wrapper native 对照（byte 级一致锁死）；CDN 引擎 mock import（八个包）；overrideLang 消费链/快照/duplicate；候选集扩容；modes=server 降级链；krokiVia 分支；mermaid theme 注入与事件重画；renderers 分发。
- **cargo**：`/api/compute/diagram`（成功/非 NATIVE 4xx/鉴权/body limit）；`/api/kroki` native reqwest mock server + worker Fetch 形态；`--kroki-host`/`VV_KROKI_HOST` 配置；health `kroki-proxy` 宣告。
- **e2e**：OWX 候选集锚更新（+markdown）、overrideLang 全链（设置→重渲染→快照恢复→duplicate）、MD 域徽标复制改锚、svgbob local 出图、新类型 kroki 出图（真实网）、wavejson 本地出图、modes=server（server 套件）、krokiVia=server（mock kroki）、mermaid theme 切换重画。
- **门禁全套**：typecheck+svelte-check（apps/web 下）、vitest（仓库根）、cargo（server/ 下 workspace）、playwright 双通道、`tools/diagram-budget.mjs` 实跑确认 2.2MB 口径。

## 14. 非目标

- 文档级「强制服务端渲染」按钮（图表级 server 模式已覆盖用户诉求粒度）。
- per-块级图表通道选择（类型级已够）。
- 服务端渲染新语言（graphviz/svgbob 之外；lini 等 Rust 候选待 kroki 发版后另评估）。
- kroki 转发的多 host 负载/缓存。
- 语言 datalist 的输入强校验（宽松透传，引擎链自兜底）。
