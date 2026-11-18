# VSCode 扩展（webview 只读渲染）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vviewer 的核心渲染器搬进 VSCode 扩展（spec H）：打开受支持文件即由 custom editor（viewType `vviewer.viewer`）在 webview 内直接渲染——markdown 全效果（管线/图表/katex/灯箱/导出 HTML）+ code（tree-sitter 离线高亮 + 大纲）+ 图片/音视频/PDF/HTML/JSONL/hex 基础渲染器；无目录树、无 tab 条、无状态栏；toc 面板默认收起、位置可选左右；设置走 `contributes.configuration` 且支持 VSCode 原生 per-language 覆盖；运行时**零外网 CDN 依赖**（grammar wasm/queries/tree-sitter runtime/pdf worker/katex 字体全部打进扩展本地资源，经 `asWebviewUri` 映射）；打包体积门 <100MB（lite grammar 集实测 46.4MiB）。

**Architecture:** 新增独立 workspace 包 `apps/vscode`（`@bhxch/vviewer-vscode`，非私有发布包）——extension host 侧（esbuild → CommonJS，外部 `vscode`）+ webview 侧（esbuild → ESM + code splitting）双 bundle，另出两个自包含 worker bundle（tree-sitter 高亮 worker / hex 解析 worker）；host↔webview 走 `postMessage` 协议（文件字节 / 设置 / 主题 / 相对文件读取 / 导出写盘）；webview 内装配方是 `apps/web/src/lib/viewer.ts`（357 行装配单点）的**无 app 依赖重写**——渲染器与注入缝直接消费 `packages/vviewer-*`（packages 零 `$app`/`import.meta.env`/IndexedDB/i18n 依赖，实查零命中），host 侧只做「读文件 + 发设置 + 收写盘请求」；**样式供给面显式建**（`MARKDOWN_CSS` 常量 + 扩展壳样式常量 → host 侧合成为一个 `<style nonce>` 内联进 webview HTML——`createMarkdownView` 自身不注入样式，markdownRenderer.ts:958-961 明写「CSS 由消费方引入」）；grammar/queries/runtime/pdf worker/katex 资产走构建期脚本从 `apps/web/static/grammars`（lite 集 34 语言）等源采集入 `dist/webview/assets/`，运行期经 `webview.asWebviewUri` 映射。

**Tech Stack:** TypeScript（ES2022 + bundler 解析）+ esbuild（host CJS / webview ESM splitting / worker IIFE）+ VSCode Extension API（`@types/vscode`）+ vitest（仓库根 jsdom，include 需扩 `apps/vscode/**`）+ Conventional Commits。**零 `.svelte`**：webview 壳为原生 TS DOM（裁量，见 Global Constraints）。

**Spec:** `docs/superpowers/specs/2026-11-12-vscode-extension-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 目标/非目标/反目标、§4 设计、§5 验收锚点、§6 留给 builder 的裁量、§7 builder check 订正与落定同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `9e4ef1c`（main；= `eed783c` + 本计划初版 docs commit `61d2e17` + 第一轮评审修订 `9e4ef1c`；工作树 clean，源码面等价）。spec A/B/C/D/E/F/G/I 已全部落地（7 个 spec 的 commit 均在 HEAD）；**spec H 此前零落地**——实查 `rg "vviewer-vscode" .`（排除 node_modules）零命中，`apps/` 下仅 `desktop/`（Tauri 薄壳）与 `web/`（SvelteKit）两个目录，无 `apps/vscode`。本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7，**严格串行**。理由：T1 的 workspace 包 + 构建链 + 资产脚本是 T2~T6 全部源码的宿主与门禁（无 `apps/vscode/tsconfig.json` 则后续任务无法 typecheck）；T2 的 custom editor 注册、文件字节通道与**扩展 i18n 目录/ESLint 纪律前置**是 T3 装配层的输入面（webview 拿不到字节即无渲染；首个用户可见文案即在 T2，故 i18n 纪律必须先于它落地）；T3 的注入缝、样式注入面与 CSP 是 T4 高亮链路与 T5 toc/导出的挂载点（缝一次性注入，重复注入即语义漂移）；T4 的 tree-sitter worker 与资产 URI 依赖 T1 的资产脚本产物；T5 的 toc/导出依赖 T3 的渲染实例面（`getToc`/`getOutline` 鸭子面）；T6 的设置面与实时生效依赖 T3/T4/T5 已有的消费面（配置项逐项对应既有消费点，不先有消费面则设置无处生效）；T7 收尾（发布 workflow + 全量门禁 + 台账）。
- **grammar 构建链条件核查（本计划与 C/I 两份计划相反——本计划**依赖** grammar 链）**：扩展要打包 lite grammar 集，wasm 产物**不入库**（`.gitignore`：`tools/grammar-builder/out/`、`apps/web/static/grammars/`、`*.wasm` 全局规则），来源链为 `pnpm gen:sources`（spec F 源头化：产 `languages.toml`/`build-list.json`/`packages/vviewer-highlight/assets/{languages.json,themes.json,queries}` 与 `packages/vviewer-core/src/registry/generated-extensions.ts`）→ `node tools/grammar-builder/build.mjs --fetch --lite` → `node tools/grammar-builder/build.mjs --self-build`（wasm 直写 `apps/web/static/grammars/` + `manifest.json`，runtime wasm 落 `apps/web/static/tree-sitter.wasm`，`build.mjs:40/:347-348`）。**故扩展构建前必须先跑该链**（CI 侧复用现成 composite action `.github/actions/setup-grammars`，默认 `languages: lite` 即 34 语言集）。**附带依赖**：`packages/vviewer-core/src/registry/generated-extensions.ts`（生成物、不入库）被扩展名清单生成消费——缺失即 fail-fast 并提示 `pnpm gen:sources`（`tools/e2e-list-guard.mjs:15` 同款纪律）。
- **不触及 server/（Rust）**：本计划零 `server/` 文件改动——扩展是纯 TS 前端产物，扩展内不做任何服务端依赖（spec §3 反目标：compute/watch/mounts 全部不适用）；`rg -i "vscode" server/` 仅命中 markdown 渲染语义比对注释，无相关实现面。（T7 的门禁会 `cargo build` 出 server 二进制供 server 档 e2e 用——那是**构建产物**，非源码改动。）
- **UI 文案/i18n/组件/a11y 触及面**：**有**——扩展自建 webview 壳（内容区 + toc 面板 + 顶部提示条 + 导出反馈）与中文/英文文案集（spec §4.4「i18n 文案内置中文/英文按 VSCode locale」）。开工前必读（Task 2/3/5 各自标注）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A 组/B 组）、`docs/design/semantic-components.md`（**核对面**：扩展 webview 是独立运行时，不复用 apps/web 组件库，该文档的浮层/菜单登记表**不覆盖**扩展面；但其 a11y 与「先登记后使用」的方法论沿用——扩展自建交互件逐条自检并在本计划登记）、`docs/design/ui-design-system.md`（令牌口径：扩展用 `--ui-*`/`--code-*`/`--vv-ts-*` 变量族，**不引入新 token**，缺省值沿 markdown.css 内既默认值）。
- **e2e 定向锚文件**：**无扩展专属 e2e**（spec §5 拍板「自动化裁量：MVP 以编译门+冒烟清单为主；e2e（@vscode/test-electron）列为增强非门禁」）。涉及 apps/web e2e 的有两处**包内 additive 缝**（默认值逐字节不变、apps/web 零改动 → 均为**回归锚**而非改动面）：**T3 的两处 worker-URL 注入缝**（`packages/vviewer-render-doc` / `packages/vviewer-render-binary`）→ `e2e/b-pdf-range.spec.ts`、`e2e/b-pdf-range-2.spec.ts`（pdf worker）、`e2e/b-binary-hex-archive.spec.ts`（hex worker）；**T5 的图表外联闸缝**（`packages/vviewer-markdown` 的 `DiagramRenderOptions.allowRemote`）→ `e2e/b-md-diagrams-deep.spec.ts`（DM-05 effectiveModeOf 回退链）、`e2e/b-cdn-diagram-engines.spec.ts`（CDN-02/03/04 降级链与 hpcc 渲染器）。

## Global Constraints

- **拍板项不得偏离**（spec §1/§3/§4/§7 落定）：
  - **MVP 范围**（spec §4.4 逐项）：markdown / code / image / av / pdf / html / text / jsonl / hex 九类渲染器 + archive **裁剪**（裁量落定，见下）。**foreign 20 组渲染器、Office 三件套（docx/xlsx/pptx）、目录树/多 tab/全局搜索/设置中心/另存为/挂载体系、移动端形态、webview 内编辑一律不做**（spec §3 非目标）。
  - **注册协议**：custom editor（`contributes.customEditors`，viewType `vviewer.viewer`，`priority: "default"`）——「打开文件时直接渲染」；用户可切回 VSCode 原生编辑器（custom editor 自带切换）。
  - **零外网 CDN 依赖**（约束②）：grammar wasm / queries / tree-sitter runtime / **pdfjs worker** / katex 字体**全部打进扩展本地资源**，运行期经 `webview.asWebviewUri` 映射；kroki/plantuml 等外联图表服务默认关闭（`vviewer.diagrams.allowRemoteServices` 默认 `false`）。
  - **打包体积 <100MB**（约束③）：门禁脚本断言 **`.vsix` 实包字节** <100MB（spec §5 口径：`vsce package` 产物）+ `dist/` 递归字节预检同门；lite grammar 集实测 46.4MiB（`du -sh apps/web/static/grammars` = 47M，34 个 wasm + manifest.json）；pdfjs worker 双分支各 ~1.3MB（合计 ~2.6MB，均有消费面——注入按能力选支，见「VSIX manifest 与 vsce 硬校验」条）。
  - **VSIX manifest 与 vsce 硬校验（新增硬约束——评审订正①，本轮）**：VSIX 侧 manifest = 构建产物 `dist/package.json`（**不是** workspace 源 manifest），vsce 4.1.1 在 `validateManifestForPackaging`（package.js:1001-1044，由 `readManifest(...).then(validateManifestForPackaging)` package.js:1120 进入）逐条硬校验：
    | 校验 | 源码锚 | 对本计划的约束 |
    |---|---|---|
    | `name` 必须匹配 `/^[a-z0-9][a-z0-9\-]*$/i` | validation.js:45 / :55-61 | **workspace 包名 `@bhxch/vviewer-vscode` 不合法**（首字符 `@`、含 `/`）→ 合并产物 `name` 重写为无 scope 的 `vviewer-vscode`；marketplace 标识 = `publisher.name` = `bhxch.vviewer-vscode` |
    | `version` 必填且合法 semver | validation.js:64-70 / package.js:1007 | 源 manifest 补 `version`（`0.1.0` 起，随发布递增） |
    | `engines.vscode` 与 `devDependencies['@types/vscode']` 按 major.minor 比大小 | package.js:1043-1044 / validation.js:100-137 | `engines.vscode: "^1.90.0"` ⇒ devDep 钉 `@types/vscode: "~1.90.0"`（不钉则取最新版 1.1xx → 抛「greater than engines.vscode 1.90.0」） |
    | `main`/`browser` 与激活事件 | package.js:1012-1041 | `engines.vscode ≥1.74` 且 `contributes.customEditors` 在场（隐式激活事件来源，package.js:1014-1021）→ `main` 必填即合法；**不得删 `contributes.customEditors`** |
    | `icon` | package.js:857 / :870-871 / :1046-1047 | **缺 `icon` 字段不报错**；**指定了 `icon` 而文件不在包内才报错**（`The specified icon '...' wasn't found in the extension.`）；SVG 图标被禁 → 若填 `icon` 必须把 PNG 复制进 VSIX 打包根 |
    | `.vscodeignore` 读取位置 | vsce 从**包根**读 | 包根 = `dist/` → **`.vscodeignore` 由构建脚本写进 `dist/`**，源侧 `apps/vscode/.vscodeignore` 不建（否则成死资产、排除规则不生效） |
  **源 manifest 与 VSIX manifest 解耦（名字与 scope 的分家）**：workspace 源 manifest 保留 `@bhxch/vviewer-vscode`（pnpm workspace 契约 + ask 硬要求）**且不得标 `private: true`**（Marketplace/OVSX 发布要求；仓内其余包皆 private 是 npm 侧纪律，扩展走 marketplace 通道不适用；`pnpm publish` 不涉及——发布面是 vsce/ovsx，`tools/pack-packages.mjs:53` 的 PACKAGES 显式清单不含扩展，零交叉）；**VSIX 侧 manifest 由构建脚本生成**（`dist/package.json`：`name: "vviewer-vscode"` + `version` + `publisher: "bhxch"` + `main: "./extension.js"` + `engines.vscode` + `contributes`），marketplace 标识 = `bhxch.vviewer-vscode`。**vsce 的三条硬校验只作用于 VSIX 侧**——workspace 名带 scope 不构成问题，但**不得**把 workspace 名原样写进 VSIX manifest。
  - **发布只落文件不实跑**（约束④）：`ovsx`/`vsce` 双渠道**上传**workflow 落文件即止——**无 secrets**（OVSX_PAT/VSCE_PAT 由用户在仓外配置），上传首跑实测属**仓外 deferred**（台账①）。**注意区分**：`vsce package`（本地打包 + 体积门）**在仓内实跑**（devDep 声明 + T1/T7 构建步），`vsce publish`（上传）不实跑。
  - **CSP**（约束⑤ + spec §7）：`script-src` 必须含 `'wasm-unsafe-eval'`（tree-sitter wasm 实例化必需）**且含 `${webview.cspSource}`**（webview 入口是外链 ESM 脚本、动态 chunk 亦为外链——nonce 只覆盖宿主 HTML 内的联脚本，覆盖不到 `import()` 的 chunk）；`font-src` 必须覆盖 `asWebviewUri` 源（katex 字体）；`media-src` 必须显式列（`default-src 'none'` 下回落即拦死 `<audio>`/`<video>`——av 渲染器的主功能面）；`worker-src`（webview 内 worker）+ `connect-src`（worker 内 fetch wasm，`default-src 'none'` 下回落即断）。
  - **设置面走 `contributes.configuration`**（约束⑥）：六项设置（toc.side / toc.defaultCollapsed / code.highlightEngine / markdown.diagramMode / diagrams.allowRemoteServices / markdown.externalImages）+ 外链图片白名单；per-language 覆盖用 VSCode 原生机制——host 侧 `workspace.getConfiguration('vviewer', { languageId })` 读取即天然支持，**声明 scope 必须是 `language-overridable`**（否则 VSCode 拒绝 per-language 覆盖——原生机制前提，非自研）。
  - **反目标**（spec §3）：把 AppShell 塞进 webview；扩展内任何服务端依赖；运行时外网 CDN 依赖；webview 内编辑（纯只读）。
- **spec §7 落定项承接**：①**相对链接导航在 MVP 接线**——webview 侧注入 workspace 版 `resolveRelativeLink`（`Uri.joinPath` + `workspace.fs.readFile` 探测）；②**相对图片一并解析**（sibling bytes → blob URL）——§4.3「相对图片 MVP 不解析」作废；数据通道相应加「按路径读文件」的 host 往返消息面；③**导出 HTML 保留在 MVP**——webview→host 写盘面（`showSaveDialog` + `fs.writeFile`），katex 字体内联走 `collectExportHtml` 既有形态；④**设置/主题变更实时生效**——`onDidChangeConfiguration`（vviewer 作用域过滤）+ `onDidChangeActiveColorTheme` → postMessage 推送已打开 webview → `applyTheme`/重渲染面应用，不要求重开文件；⑤**大文件上限 200MB**（对齐 web `PLAIN_MAX_BYTES` 口径，render-text/src/code/strategy.ts:92），超限 webview 显示引导占位（提示改用 VSCode 原生编辑器）。
- **样式供给面（新增硬约束——评审订正①）**：`createMarkdownView` **自身不注入任何样式**（markdownRenderer.ts:958-961 明写「CSS 由消费方引入 '@bhxch/vviewer-markdown/markdown.css'（或 MARKDOWN_CSS 常量注入 <style>）」；963-1050 的函数体无 style 注入）。apps/web 侧的供给面是 `apps/web/src/app.css:7` 的 `@import '@bhxch/vviewer-markdown/markdown.css'`。故扩展**必须自带两处样式供给**：
  1. **markdown 排版样式** = `MARKDOWN_CSS` 常量（`packages/vviewer-markdown/src/css.ts:216`，19.8KB TS 字符串；由 `packages/vviewer-markdown/src/index.ts:73` 导出；与 `markdown.css` 镜像文件逐字节等价由包内 `cssMirror.test.ts` 锁）→ **host 侧**合成为一个 `<style nonce>` 内联进 webview HTML（**不引 CSS 构建步骤**——常量形态本身即供给面；「零 CSS 构建」≠「零 CSS」）。
  2. **扩展壳样式**（内容区布局 / toc 左右停靠 / 折叠态 / 顶部提示条）= 扩展自持 `apps/vscode/src/webview/shellCss.ts` 的 `SHELL_CSS` 常量（与 markdown.css 同族纪律：全部 `var(--token, 默认值)`，**不定义 `:root` 令牌块**、零新 token）→ 同一个 `<style nonce>` 一并内联。
  **动态令牌**（`--vv-ts-*` 等随主题变的部分）走 webview 侧 `<style>` 元素更新面（主题变更时整体替换），不混进宿主内联块。
- **webview 必需选项（新增硬约束——评审订正④）**：`createWebviewPanel(..., { enableScripts: true }, ...)`（**不开则 webview 内脚本不执行 → 白屏**）；`localResourceRoots` 必须覆盖扩展的 `dist/` 目录（**资源不在 roots 内则 asWebviewUri 资源 404**——wasm/字体/grammar 全部依赖它）。二者叠加的失败面在无 console 回传的 webview 里近乎静默，与 RF 3「可见失败面」原则冲突，故单测硬断言。
- **包内 seam 纪律（新增硬约束——评审订正③）**：`packages/vviewer-render-doc`（pdf worker URL）与 `packages/vviewer-render-binary`（hex worker URL）需要注入缝（esbuild 不做 vite 的 `new URL(裸说明符, import.meta.url)` 资产化——pdf.ts:124-127 注释明说该能力是 vite 特有），**扩展必须自带对应 worker 文件**并经 `asWebviewUri` 注入：pdfjs worker（modern `pdfjs-dist/build/pdf.worker.min.mjs` + legacy `pdfjs-dist/legacy/build/pdf.worker.min.mjs`，各 ~1.3MB，随 T1 资产采集入 `dist/webview/pdf/`）+ hex worker（`packages/vviewer-render-binary/src/binary.worker.ts` 由 T1 单独打成 `dist/webview/binary-worker.js`）。
  **两个 provider 必须被接线（评审订正③·本轮）**：不注入即走默认路径——pdf 侧 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` 在 webview chunk URL 下 404 → pdfjs 无 workerSrc → **pdf 渲染死**；hex 侧 `new Worker(new URL('./binary.worker.ts', import.meta.url), {type:'module'})`（hex.ts:805）的 try/catch **只兜同步抛错**，404 是异步事件 → worker 永不应答 → **渲染挂死**。故 T3 装配层必须调用 `setPdfWorkerUrlProvider(...)` 与 `setHexWorkerUrlProvider(() => assets.binaryWorkerUrl)`；**pdf 双分支的消费面 = 按能力选支**（复用包内导出的 `preferModernBuild()`，render-doc/src/pdf.ts:96 → **webview 侧**从 `@bhxch/vviewer-render-doc` 根导入：`preferModernBuild() ? assets.pdfWorkerModernUrl : assets.pdfWorkerLegacyUrl`；host 侧只发两个 URL、不引 pdfjs）——两文件都有消费面，无死重，worker 与主模块构建分支必然一致。
- **svgbob glue 的构建前置（新增硬约束——评审订正②·本轮）**：`packages/vviewer-markdown/src/pipeline.ts:20` 静态 import `@bhxch/vviewer-render-diagram` 的 `renderDiagramEngine`，其实现 `packages/vviewer-render-diagram/src/markdown/diagramEngines.ts:63` 为 `import('./svgbob-wasm-gen/svgbob_wasm.js')`；该生成目录**不入库**（.gitignore:56-57 排除 `svgbob-wasm-gen/*.js` 与 `*.wasm`）→ esbuild 打包时须静态解析该 dynamic import，**新 checkout 上必然构建失败**（本仓因已有生成产物而侥幸通过，属假绿）。**落定**：T1 构建脚本对该路径做**条件桩**——文件存在 → 正常打包（完整 svgbob 能力）；**文件不存在 → esbuild 插件桩模块**（`default()` 抛错 → 管线 diagram 步的 local 分支 catch（pipeline.ts:536-549）：svgbob 的 `krokiType` 非空（diagrams.ts:51）→ **先降级 kroki 外联图**（`appendKrokiImg()`，pipeline.ts:425-447，外部请求）→ 该 img 加载失败才错误卡 + 源码同展（**非直接回落源码块**，订正）；**外联闸关时由 T5 的包内 `allowRemote` 缝直接落源码块**，不经 kroki）。故**扩展构建不强制 Rust 工具链**；CI 发布 workflow 仍跑 `pnpm gen:svgbob-wasm`（ci.yml:160 同款，需 wasm32 target + wasm-bindgen）取完整能力——「缺 glue 时 svgbob 围栏降级链含 kroki 外联一跳」记台账⑧。
- **图表外联闸的落点（新增硬约束——评审订正②·本轮）**：约束②「运行时零外网 CDN 依赖」与 README「离线（断网）全功能」冒烟项，**在自然实现下不成立**——三处外联路径必须逐条封堵：
  1. **`modeOf` 的逐语言映射**：`effectiveModeOf`（pipeline.ts:201-220）语义是 `requested==='local'` 时「`type.local && type.engine` → 'local'，否则 `type.krokiType ? 'kroki' : 'source'`」→ 对注册表中 **17 个 `local:false` 但有 `krokiType` 的类型**（plantuml/c4plantuml/ditaa/blockdiag/nwdiag/actdiag/seqdiag/erd/pikchr/packetdiag/rackdiag/goat/wireviz/structurizr/symbolator/tikz/umlet，diagrams.ts:42-50/:66-73）请求 'local' 仍会被**升格为 kroki 外联**。故扩展的 `modeOf` **不能只返回 'local'**——闸关时须**逐语言**判定：仅 `type.local && type.engine` 且 engine 属**离线引擎集**（mermaid/graphviz/nomnoml/math/svgbob）者给 'local'，其余（含 CDN 引擎族）一律给 **'source'**。
  2. **CDN 引擎族必须出 'local'**：`excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/dbml/d2` 虽 `local:true`，但 engine 是 CDN 直链（diagrams.ts:52-64）→ `renderDiagramEngine` → `cdnEngines.ts:5` 的 `CDN_DEFAULT='https://cdn.jsdelivr.net/npm'` **外联 jsdelivr**；`cdnEnginesHost` 只能换 host、不能禁用。故这 8 类在闸关时一律 'source'。同理 graphviz 的 `rendererOf` **不得选 'hpcc'**（`renderGraphviz` 的 `renderer==='hpcc'` 分支亦走 cdnEngines 外联）。
  3. **local 引擎失败的降级链含 kroki 外联一跳**：pipeline.ts:536-549 的 catch 是「`type.krokiType` → `appendKrokiImg()`（pipeline.ts:425-447，kroki URL 的 `<img src>`，外部请求）→ img 再失败才错误卡 + 源码」；kroki 模式分支（pipeline.ts:500-502）亦直接外联。**包内无任何 remote/offline 开关**（`DiagramRenderOptions`，markdownRenderer.ts:197-238，只有 krokiHost/mermaidTheme/modeOf/krokiVia?/rendererOf?/cdnEnginesHost?/serverDiagramOf?/krokiProxy?/remoteCall?）→ 故 **T5 必须在 `@bhxch/vviewer-markdown` 增一条 additive 缝 `allowRemote?: boolean`**：缺省 undefined = 现有行为逐字节不变（apps/web 零改动）；`false` 时 kroki 模式分支与 local 失败降级**直接落源码块**、不经 kroki。**设置枚举 'off' 必须映射为 'source'**（`DiagramMode` 无 'off'——diagrams.ts:7 = 'local'|'kroki'|'server'|'official'|'source'）。
- **扩展 i18n 纪律（前置硬约束——评审订正⑤）**：扩展文案**一律走自有目录**（`apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts`），**禁裸 CJK 字面量**。目录与 ESLint 覆盖块在 **T2 首批用户可见文案之前**落地（T2 的 200MB 超限提示是扩展第一句用户可见文案）：ESLint 覆盖块 `files: ['apps/vscode/src/**/*.{svelte,ts}']` + **`ignores: ['apps/vscode/src/i18n/**', 'apps/vscode/src/**/*.test.ts']`**（catalog 本体豁免——apps/web 同款纪律，eslint.config.js:243 块 A 的 ignores；测试豁免——目录值双锁断言直读是既定形态），rules 挂 `runesOptOut` + CJK 三形态 + `bareIntl` + 禁直读 catalogs。**T3/T5 的新增文案同样走目录**（不得先裸写后迁移）。
- **本仓纪律对扩展面的映射**：
  - **runes 纪律**：apps/vscode 零 `.svelte` 文件（裁量 2），无适用面；**若实施期引入 `.svelte` 则一律 runes 写法**（AGENTS.md 全局强制，不得逐组件退出）。
  - **i18n 机检现状（订正⑩·事实）**：CJK 三形态**只挂块 A**（`eslint.config.js:242` files `['apps/web/src/lib/**/*.{svelte,ts}']`，:243 ignores i18n 目录与 `*.test.ts`）；块 A2（:266 files `['apps/web/src/lib/i18n/**']`）**只挂 bareIntl**；块 B（:277 files `['apps/web/**/*.{svelte,ts}']`）**只挂 bareIntl + runesOptOut**。故 **CJK 三形态当前覆盖范围是 `apps/web/src/lib/**`，不是 `apps/web` 全域**——扩展面（`apps/vscode/**`）当前**零覆盖**，本计划新增覆盖块补齐。
  - **a11y 基线**：`frontend-conventions.md` §4 基线 + §6 A 组八条逐条自检（图标按钮有可读名称且 aria-label 含可见文本词形；异步反馈走 `role="status"`/`aria-live`；错误与输入关联；焦点可见；状态不只靠颜色）。扩展面**无 axe 扫描**（无 e2e），故 a11y 靠**评审必查 + 单测断言**兜（Task 3/5 的 DOM 单测锁关键 aria 属）。
  - **门禁口径**：vitest 一律在**仓库根**跑（`pnpm vitest run apps/vscode`——**须先扩 `vitest.config.ts` 的 include**，现 include 四项为 `packages/*/test/**`、`packages/*/src/**`、`tools/*/test/**`、`apps/web/src/**`，不含 `apps/vscode/**`）；typecheck 仓库根 `pnpm run typecheck`（**Task 1 扩根脚本纳入 `tsc -b apps/vscode/tsconfig.json`**）；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入——本计划零 apps/web 改动，仅 T3 回归时需要）。
  - **commit 纪律**：Conventional Commits（feat/fix/test/ci/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **裁量落定**（spec §6 六项，本计划逐项内联）：
  1. **打包器 = esbuild**（非 rolldown）：host bundle `format: 'cjs'` + `external: ['vscode']`；webview bundle `format: 'esm'` + `splitting: true`（mermaid/katex/pdfjs 动态 chunk 按需取——spec §4.4「动态 chunk（esbuild code splitting）」）；worker bundle `format: 'iife'` 自包含（blob worker 前提）。不用 vite：扩展构建无 PWA/HMR/SvelteKit 需求，vite 的 CSS 资产化与 worker 插件在此场景收益低于其配置面成本（**代价即「资产化要自己做」——故本计划显式建资产采集与注入两面**）。
  2. **webview 壳 = 原生 TS DOM（零 Svelte）**：扩展 webview 是独立运行时（CSP 独立、base URL 独立、无 SvelteKit），壳仅数件（内容区 / toc 面板 / 顶部提示条）；引 Svelte 需把 svelte 编译器接进 esbuild 链（插件 + 编译期），收益不抵成本。**副作用**：apps/vscode 零 `.svelte` 文件 → 仓库「全局强制 runes」纪律无适用面（AGENTS.md 约束的是 `.svelte`/`.svelte.ts` 写法）；a11y/i18n 纪律仍按 `frontend-conventions.md` 逐条自检。
  3. **archive 渲染器裁掉**（libarchive wasm + worker bundle 打包成本 vs 价值）：spec §4.4 授权「视依赖复杂度裁量裁剪」。裁剪后 hex 仍覆盖二进制查看面。
  4. **theme JSON 精确注入列为增强**（spec §4.2 拍板）：MVP 按 `activeColorTheme.kind` 注入 dark/light 缺省 UI 令牌；**代码 capture 着色**用打包进扩展的两条 helix 主题表（`onelight` / `serika-dark`，从 `packages/vviewer-highlight/assets/themes.json` 构建期裁剪，随资源入扩展）经 `themeToCssVars` 注入 `--vv-ts-*`——零外网、零 apps/web 依赖、无重复调色板（apps/web 的 `DEFAULT_CODE_THEME` 同这两条，语义同源）。读 VSCode 活动主题 JSON 精确注入 = 增强项（highlight 包已备 `validateVscodeTheme`/`tokenColorsToThemeTable`，实现成本低，**记台账②**）。
  5. **serializer / panel 复用**：MVP **不做** `WebviewPanelSerializer`（spec §4.2 明示「裁量可先不做 serializer」）；同文件复用 panel（`viewType` + 文档 URI 比对，命中即 reveal 既有 panel 而非新开）。
  6. **扩展名清单生成脚本形态**：构建期脚本用 esbuild 打包一个 TS 入口跑真实注册表（`createRegistry` + MVP 渲染器 install + `installFallbackExtensions('code', GENERATED_EXTENSIONS)`），输出**有效认领扩展名全集** → 写进生成的 `package.json` 的 `contributes.customEditors[].selector`（零重复维护、与渲染器安装序天然一致——**装序铁律只有一条：专有渲染器先于 generated 兜底安装**，`installFallbackExtensions` 遇已认领扩展名跳过；`md`/`markdown`/`html`/`htm` 由 code 渲染器显式不认领（render-text/src/code/index.ts 注 2），故归 markdown/html 渲染器）。
  7. **i18n 文案集**：扩展自有 `apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts`，key 三段 `{域}.{模块}.{语义}`（沿 `frontend-conventions.md` §3.1 纪律）；locale 由 `vscode.env.language` 选（`zh*` → zh-CN，其余 → en）。
  8. **发布 workflow 与 release.yml 编排**：**独立** `.github/workflows/publish-vscode.yml`（tag `v*` 触发 + workflow_dispatch），不并入 `release.yml`（后者四路产物 + npm 双发布面已密；并入会把无 secrets 的发布 job 挂进主发布链的成败判定）。
- **spec §4.2「无状态栏」保持不偏离（订正⑨·已消解）**：初版计划曾给 webview 壳设「状态行」承载降级指示——与 spec §4.2「无 FileTree/TabBar/状态栏」字面冲突。**落定改为**：可见反馈面 = **内容区顶部提示条（inline banner，`role="status"`）** + **toc 面板头部徽标**（高亮引擎态），**不引入状态栏**；spec §4.2 的「无状态栏」得以保持，同时满足 RF 3 的可见失败面要求（见 Errata ②）。
- **诚实边界**：①**上传**发布（ovsx/vsce publish）无 secrets → 台账 deferred（**本地 `vsce package` 体积门可实跑，见 T1/T7**）；②扩展真机行为（VSCode 内 custom editor 接管、webview CSP 生效、worker 起活、样式生效）**无法在本仓 CI 自动化**（无 @vscode/test-electron 基建，spec §5 定为非门禁）→ 以「编译门 + 包内单测 + README 冒烟清单」兑现，冒烟清单由用户在 VSCode 内手测（台账③）；③T7 全量 e2e 的**skip 计数不可作为零翻转证据**（见 T7 Step 2）。

## Review Focus

1. **包内 seam 的默认值不可漂移**（T3，最高风险）：`packages/vviewer-render-doc`（pdf worker URL）与 `packages/vviewer-render-binary`（hex worker URL）新增注入缝——**默认值必须与现实现逐字节等价**（pdf：`preferModernBuild() ? new URL('pdfjs-dist/build/pdf.worker.min.mjs', …) : new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', …)`（pdf.ts:128-132）；hex：`new Worker(new URL('./binary.worker.ts', import.meta.url), { type: 'module' })`（hex.ts:805））。apps/web 不注入 → 行为零变化；三处 e2e 回归锚（pdf×2 + hex）必须零翻转；单测锁「未注入 = 原表达式形态」「注入 = 返回注入值」。
2. **CSP 七 directive 缺一即功能面静默失效**（T3）：`default-src 'none'` 下——`script-src` 缺 `${webview.cspSource}` → **外链 ESM 入口与动态 chunk 全被拦（白屏）**，nonce 只覆盖宿主内联脚本、覆盖不到 `import()` 的 chunk；缺 `'wasm-unsafe-eval'` → wasm 实例化被拦；`connect-src` 缺 → worker 内 fetch grammar/runtime wasm 被拦 → tree-sitter 静默降级 hljs；`worker-src` 缺 → blob worker 起不来；`font-src` 缺 → katex 字体不加载；**`media-src` 缺 → `<audio>`/`<video>` 全被拦（av 渲染器主功能死）**。**每条 directive 都要有对应的可见失败面**（不能静默——见 RF 3），且单测须断言 `cspSource` 出现在 `script-src` 与 `media-src`（评审订正②的回归锚）。
3. **静默降级面必须可见**（T3/T4）：tree-sitter worker 起不来 / grammar wasm 404 / queries 缺失 → 落 hljs 或 plain，**但 webview 必须显示当前高亮引擎态**（顶部提示条 + toc 面板头部徽标，不设状态栏——见 Global Constraints「spec §4.2 保持不偏离」），否则与「装好了却没高亮」不可区分。webview 内零 console 出口（webview console 不回传 host）→ 提示条 + host 侧 `console.warn` 双通道。
4. **样式供给面不可省**（T1/T3，评审订正①）：`MARKDOWN_CSS`（19.8KB，含 `.vv-markdown` 排版 + `.ts-*` capture 着色映射 + 图表/灯箱/表格/alert 段）与 `SHELL_CSS`（壳布局）**必须内联进 webview HTML 的 `<style>`**；漏注入 → markdown 以「无排版裸 HTML」呈现（主功能缺失，且 markdown 包自身不注入、不会报错）。单测锁：注入块非空 + 含关键类名（`.vv-markdown`/`.ts-keyword`/`.md-lightbox` + 壳类名）。
5. **资产 URI 三段必须自洽**（T1/T4）：`grammarsBase`（`<assets>/grammars/`）、`queriesBase`（`<assets>/queries/`）、`runtimeDir`（`<assets>/`，`Parser.init` 经 `locateFile(joinPath(runtimeDir, 'tree-sitter.wasm'))` 取用——core-parse.ts:210）——三者同为 `asWebviewUri` 家族，**不得混用相对路径**（`Language.load(joinPath(entry.base ?? grammarsBase, entry.file))` core-parse.ts:417；queries 走 `fetch(`${dir}/${name}`)` core-parse.ts:484）。三条路径任一错 → 该语言静默无高亮。**pdf worker / hex worker 同理**（绝对 URL，注入 provider）。
6. **blob worker 的 base URL 陷阱**（T4）：blob worker 内 `import.meta.url` 为 `blob:` 域 → 一切相对资产 URL 失效 → wasm URL 必须**绝对**（`asWebviewUri` 绝对 URL）；worker bundle 必须**自包含 IIFE**（无 import），否则 blob worker 解析失败。起活失败必须走可见降级（RF 3），不得静默。
7. **katex CSS 双形态**（T1/T5）：包内 `pipeline.ts:643` 的 `import('katex/dist/katex.min.css')` 在 vite 下自动注入 <style>，**esbuild 下不会**（CSS 抽成独立产物，运行期不注入）→ 扩展必须**自备** katex CSS 注入面（构建期拷 `katex.min.css` + 20 个 woff2 → 字体 URL 改写为 asWebviewUri 绝对 URL）；漏做 → 公式出无排印 HTML（与 web 端 2026-10-19 前同款潜伏缺陷）。导出面另需**自包含** katex CSS（字体 data URI 内联）——两处 CSS 同源不同形态，不可混用。
8. **扩展名清单与渲染器认领面必须一致**（T1/T2）：custom editor 的 selector 集合 = 注册表**有效认领**扩展名全集（生成脚本实跑注册表得出）。认领面大于 selector → 用户双击某扩展名不接管（落到原生编辑器，体验断裂）；小于 selector → 接管后 dispatch 无渲染器 → 错误卡片。两面同源于生成脚本，单一来源。
9. **per-language 覆盖的真前提是 scope**（T6）：`contributes.configuration` 的 property `scope` 必须是 `language-overridable`（或 `resource`），否则 VSCode **静默忽略** `"[markdown]": {…}` 覆盖——用户以为配了却不生效。README 需给可复制示例 + 生效验证步骤。

---

### Task 1: 扩展工程骨架 + esbuild 构建链（含 svgbob 条件桩）+ 资产采集（grammar/queries/runtime/pdf worker/katex/icon）+ 样式常量 + VSIX manifest 生成 + 体积门 + 打包门

**Files:**
- Create: `apps/vscode/package.json`（**workspace 源 manifest**：`name: "@bhxch/vviewer-vscode"`；**非 private**；`version: "0.1.0"`（vsce 必填）；`publisher: "bhxch"`、`engines.vscode: "^1.90.0"`、`main: "./dist/extension.js"`、`contributes` 占位、`scripts.build`）
- Create: `apps/vscode/tsconfig.json`（`extends ../../tsconfig.base.json`，`include: ["src", "test"]`，`types: ["node"]`）
- Create: `apps/vscode/build.mjs`（esbuild 编排：host CJS / webview ESM+splitting / worker IIFE×2（tree-sitter worker、hex worker）；**svgbob glue 条件桩插件**；资产拷贝；**VSIX manifest 生成（name/main/version 重写）**；**`dist/.vscodeignore` 写出**；metafile 产出）
- Create: `apps/vscode/scripts/collect-assets.mjs`（grammar lite 集 + queries 过滤 + runtime wasm + **pdf worker（modern+legacy）** + 两条主题表 + katex css/fonts + **icon** 采集）
- Create: `apps/vscode/scripts/gen-manifest.mjs`（扩展名清单生成：esbuild 打包 TS 入口跑真实注册表 → 写 `contributes.customEditors[].selector`）
- Create: `apps/vscode/scripts/check-size.mjs`（体积门：`dist/` 递归字节 <100MB 预检 + `.vsix` 字节 <100MB 实包断言）
- Create: `apps/vscode/scripts/check-unresolved-imports.mjs`（**spec §5「esbuild 产物无未解析 import」检查**：metafile 扫描 `outputs[].imports`，断言无 `external: true` 残留（host bundle 的 `vscode` 为唯一豁免））
- Create: `apps/vscode/src/webview/shellCss.ts`（`SHELL_CSS` 常量——壳布局样式，`var(--token, 默认值)` 形态，零新 token）
- Create: `apps/vscode/README.md`（骨架：功能概述 + 构建/本地调试说明；冒烟清单与设置示例在 T6 补全）
- Create: `apps/vscode/LICENSE` + `apps/vscode/CHANGELOG.md`（Apache-2.0 副本 / vsce 要求项）
- Create: `apps/vscode/media/icon.png`（扩展图标 ≥128×128 PNG——**vsce 禁用 SVG**（package.js:1046-1047）；**缺 `icon` 字段不报错，但填了就必须在包内**（package.js:857/:870-871）→ 填 `icon` 即必须把 PNG 复制进 VSIX 打包根 `dist/media/icon.png`，manifest 的 `icon` 字段为 `"media/icon.png"`（相对包根））
- Modify: `package.json`（根）：`typecheck` 脚本纳入 `tsc -b apps/vscode/tsconfig.json`；新增 `build:vscode` 便捷脚本
- Modify: `vitest.config.ts`：include 增 `apps/vscode/src/**/*.test.ts` 与 `apps/vscode/test/**/*.test.ts`
- Modify: `.gitignore`：新增 `apps/vscode/dist/`、`apps/vscode/out/`（VSIX 产物）
- Modify: `pnpm-lock.yaml`（`pnpm install` 产物）
- **不建** `apps/vscode/.vscodeignore`：vsce 从**包根**（= `dist/`）读该文件——放源侧即死资产且排除规则不生效（评审订正⑥）；改由 `build.mjs` 写 `dist/.vscodeignore`（内容针对 dist 内容，如 `**/*.map`）。

**Interfaces:**
- **源 manifest（`apps/vscode/package.json`）关键字段**：`name: "@bhxch/vviewer-vscode"`（**workspace 名，带 scope——合法**；vsce 校验只作用于 VSIX 侧）、`version: "0.1.0"`、`displayName: "VViewer"`、`publisher: "bhxch"`、`engines.vscode: "^1.90.0"`、`main: "./dist/extension.js"`（源口径；**VSIX 侧重写为 `./extension.js`**）、`categories`、`icon: "media/icon.png"`（相对**打包根**——VSIX 侧同路径）、`contributes`（`customEditors` + `configuration` 的生成前占位；**`customEditors` 必留**——它是 vsce 判定的隐式激活事件来源，engines ≥1.74 下与 `main` 组合合法，package.js:1014-1041）、`scripts.build: "node build.mjs"`；devDeps：**`@types/vscode: "~1.90.0"`**（**必须钉版**——vsce 按 major.minor 校验其与 `engines.vscode` 的大小关系，package.js:1043-1044；不钉则取最新版 1.1xx → 抛「greater than engines.vscode 1.90.0」）、`esbuild`、`@types/node`、**`@vscode/vsce`**（本地打包体积门的 CLI）、**`ovsx`**（上传 CLI，发布 workflow 用）；deps：workspace 包 `@bhxch/vviewer-{core,detect,highlight,markdown,lightbox,render-text,render-media,render-doc,render-binary,render-diagram,sanitize}` + `katex`。
- **VSIX manifest（`apps/vscode/dist/package.json`，构建产物）**：`name: "vviewer-vscode"`（**无 scope**——vsce `nameRegex = /^[a-z0-9][a-z0-9\-]*$/i`（validation.js:45）拒绝 `@` 与 `/`，故 workspace 名 `@bhxch/vviewer-vscode` **不能**原样进 VSIX manifest）、`publisher: "bhxch"`（marketplace 标识 = `bhxch.vviewer-vscode`）、`version`（源 manifest 透传）、`main: "./extension.js"`、其余字段透传。
- 构建产物布局（`apps/vscode/dist/`——**同时是 VSIX 的打包根**）：
  ```
  dist/
  ├── package.json            # VSIX manifest（name 无 scope / main 重写 / version）
  ├── extension.js            # host bundle（CJS，external vscode）
  ├── README.md  LICENSE  CHANGELOG.md   # 复制进包根（vsce 要求项）
  ├── media/icon.png          # 复制进包根（manifest 的 icon 字段 = "media/icon.png"，相对包根）
  ├── .vscodeignore           # 构建脚本写出（vsce 从包根读）
  └── webview/
      ├── main.js             # webview bundle（ESM，splitting → chunk-*.js 同目录）
      ├── chunk-*.js          # 动态 import 产物（mermaid/katex/pdfjs 等按需取）
      ├── highlight-worker.js # tree-sitter worker（IIFE 自包含）
      ├── binary-worker.js    # hex 解析 worker（IIFE 自包含）
      ├── pdf/
      │   ├── pdf.worker.min.mjs        # pdfjs modern worker（1.3MB）
      │   └── pdf.worker.legacy.min.mjs # pdfjs legacy worker（1.3MB）
      ├── katex.min.css       # katex 排印样式（字体 URL 指向同目录 fonts/）
      ├── fonts/KaTeX_*.woff2 # 20 个 woff2
      └── assets/
          ├── grammars/{34 wasm + manifest.json}
          ├── queries/<lang>/{highlights,injections,tags}.scm}
          ├── tree-sitter.wasm
          └── themes.json     # 裁剪为 onelight + serika-dark 两条
  ```
- 资产采集契约（`collect-assets.mjs`）：grammar 源 = `apps/web/static/grammars`（lite 集，`manifest.json` 的 `grammars` 键集即语言集）；queries 源 = `packages/vviewer-highlight/assets/queries/<lang>/`（**仅** manifest 语言集命中项——canonical 语言名即查询目录名，alias 不另取：引擎按 canonical lang 取查询，core-parse.ts:484）；runtime 源 = `apps/web/static/tree-sitter.wasm`；**pdf worker 源 = `packages/vviewer-render-doc/node_modules/pdfjs-dist/build/pdf.worker.min.mjs` 与 `.../legacy/build/pdf.worker.min.mjs`**（评审订正③：esbuild 不做 vite 的裸说明符资产化，pdfjs 无 workerSrc 即 pdf 渲染死；**两支都有消费面**——注入按 `preferModernBuild()` 能力选支，见 Global Constraints「包内 seam 纪律」条）；主题源 = `packages/vviewer-highlight/assets/themes.json` 的 `onelight`/`serika-dark` 两键；katex 源 = `node_modules/katex/dist/katex.min.css` + `dist/fonts/*.woff2`（20 个 woff2，woff/ttf 不取——web 端同款取舍）；icon 源 = `apps/vscode/media/icon.png`（复制进打包根）。**任一源缺失即 fail-fast 并打印可执行修复命令**（`pnpm gen:sources` / `node tools/grammar-builder/build.mjs --fetch --lite` / `--self-build`）——不做静默降级（缺 grammar = 扩展无高亮，属构建期必须暴露的失败）。
- **svgbob glue 条件桩（构建期，评审订正②）**：`build.mjs` 挂 esbuild 插件拦截 `svgbob-wasm-gen/svgbob_wasm.js` 的解析（**路径逐字照抄真实 import**——`diagramEngines.ts:63`）——**文件存在** → 正常打包（完整 svgbob 围栏渲染）；**文件不存在**（新 checkout 的常态，.gitignore:56-57 出库）→ 返回**桩模块**（`export default async function init(){ throw new Error('svgbob glue 未生成：需 pnpm gen:svgbob-wasm'); }`）→ 运行期 `import()` 成功但 `default()` 抛错 → 管线 diagram 步的 local 分支 catch（pipeline.ts:536-549）：`type.krokiType` 非空（svgbob 的 krokiType='svgbob'，diagrams.ts:51）→ **先降级 kroki 外联图**（`appendKrokiImg()`，pipeline.ts:425-447，构造 kroki URL 的 `<img src>`，**外部请求**）→ 该 img 加载失败才落错误卡 + 源码同展（**不是直接回落源码块**——初版描述有误，订正）；**外联闸关时（`allowRemote=false`）由包内 allowRemote 缝直接落源码块，不经 kroki**（见 Global Constraints「图表外联闸的落点」条）。故扩展构建**不强制 Rust 工具链**；CI 发布 workflow 仍跑 `pnpm gen:svgbob-wasm`（ci.yml:160 同款）取完整能力。
- **spec §5 打包门双锚承接**：
  1. **「esbuild 产物无未解析 import」**：构建期 esbuild 默认对未解析 import 直接报错（**唯一 external 白名单 = host bundle 的 `vscode`**；svgbob 路径走上面的条件桩，不进 external 名单）；另落 `check-unresolved-imports.mjs` 扫 metafile `outputs[].imports`，断言无 `external: true` 残留（除 `vscode`）——把「构建期不炸」升级为「产物图可审计」。
  2. **「vsce package 体积 <100MB」**：`vsce package --no-dependencies` 以 `dist/` 为根产出 `.vsix`，断言 **`.vsix` 实包字节 <100MB**（spec 口径）；`dist/` 递归字节 <100MB 作快速预检（两者同门，前者是准）。**体积构成说明**：lite grammar 集 46.4MiB + pdfjs worker 双支 ~2.6MiB（均有消费面，非死重）+ queries ~1MiB + runtime 0.2MiB + 代码/图表引擎 ~10MiB 量级 → 远低于 100MB 门。
- **VSIX 组装步与打包根纪律**：`build.mjs` 产出的 `dist/` 是**独立可打包根**——`package.json` 的 `name` 重写为 `vviewer-vscode`、`main` 重写为 `./extension.js`（否则合并产物指向不存在的 `dist/dist/extension.js` → 404）、`version` 透传；README/LICENSE/CHANGELOG/**media/icon.png** 复制进 `dist/` 根；`dist/.vscodeignore` 由构建脚本写出。VSIX 组装步 = 在 `apps/vscode/dist/` 目录内执行 `vsce package --no-dependencies --out ../out`（cwd 即包根）。

- **验收锚 / e2e**：验收 = `apps/vscode/test/assets.test.ts` + `apps/vscode/test/shellCss.test.ts` 绿 + `pnpm run typecheck` 绿 + **构建步通过**（三 bundle 产出 + 资产齐备 + 无未解析 import + `.vsix` <100MB）；**所触 e2e 锚文件：无**（扩展面）。

- [ ] **Step 1: 骨架文件 + 根脚本纳入（vitest include / typecheck / gitignore）**
  建 `apps/vscode/{package.json,tsconfig.json,LICENSE,CHANGELOG.md,media/icon.png}`（**不建 `.vscodeignore`**——vsce 从包根 `dist/` 读该文件，由 `build.mjs` 写 `dist/.vscodeignore`；建在源侧即死资产且排除规则不生效——订正⑥）；`pnpm install`（新 workspace 包入锁 + devDep 装齐）；改根 `package.json` 的 `typecheck` 为 `tsc -b packages/*/tsconfig.json apps/vscode/tsconfig.json apps/web/tsconfig.e2e.json --noEmit && pnpm --filter web typecheck`；改 `vitest.config.ts` include；`.gitignore` 加 `apps/vscode/dist/`、`apps/vscode/out/`。Run: `pnpm run typecheck` → Expected: PASS（空工程零报错；证明 `tsc -b` 纳入新工程不破既有链）。

- [ ] **Step 2: 资产采集脚本 + 壳样式常量 + svgbob 条件桩（TDD 最小面）**
  先写 `apps/vscode/test/assets.test.ts`（纯函数：queries 语言过滤——按 manifest 语言集取目录、缺目录跳过；**pdf worker 采集清单——modern/legacy 两文件均需存在且非空**；katex 字体清单——20 个 woff2 名单与体积；主题裁剪——输出只含两键；icon 存在性；缺件时错误信息含修复命令）与 `shellCss.test.ts`（`SHELL_CSS` 非空；含壳类名；**全部颜色/尺寸走 `var(--token, 默认值)` 形态、不出现 `:root` 令牌定义**——与 markdown.css 的 token 契约同族）。再落 `collect-assets.mjs`/`build.mjs`/`check-size.mjs`/`check-unresolved-imports.mjs`，并落 **svgbob 条件桩插件**（文件在 → 正常打包；文件不在 → 桩模块抛错，运行期围栏回落源码块——评审订正②）。
  **前置**：`node tools/grammar-builder/gen-sources.mjs`（若 `apps/web/static/grammars/manifest.json` 缺失则先 `--fetch --lite` + `--self-build`）——资产脚本的源缺失路径必须 fail-fast（单测用临时目录构造缺件场景）。**svgbob glue 不列入前置**（条件桩兜住；CI 发布链另跑 `pnpm gen:svgbob-wasm` 取完整能力）。
  Run: `pnpm vitest run apps/vscode` → RED→GREEN。

- [ ] **Step 3: 扩展名清单生成脚本（真实注册表实跑）**
  `gen-manifest.mjs`：esbuild 打包 `apps/vscode/scripts/collect-extensions.ts`（import `@bhxch/vviewer-core` 的 `createRegistry` + MVP 渲染器 + `GENERATED_EXTENSIONS`）→ 在 Node 执行 → 得有效认领扩展名全集 → 写 `contributes.customEditors[0].selector`。单测：断言 markdown 类扩展名（md/markdown）由 markdown 认领（非 code）、generated 兜底扩展名在集内、集合非空且与渲染器 extensions 并集一致（RF 8）。

- [ ] **Step 4: 构建门 + 打包门 + 提交**
  Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿；`pnpm --filter @bhxch/vviewer-vscode build` → 断言：①四 bundle 产出（`dist/extension.js`、`dist/webview/main.js`、`dist/webview/highlight-worker.js`、`dist/webview/binary-worker.js`）；②**`dist/webview/pdf/pdf.worker.min.mjs` 与 `pdf.worker.legacy.min.mjs` 存在且非空**（评审订正③的构建断言）；③`dist/webview/katex.min.css` + `fonts/` 20 个 woff2 存在；④**`dist/package.json` 的 `name` === `vviewer-vscode`（无 scope）、`main` === `./extension.js`、`version` 存在且 semver**（vsce 三校验的预断言，评审订正①）；⑤**`dist/media/icon.png` 存在且 manifest 的 `icon`（`"media/icon.png"`）指向它**（填了 icon 就必须在包内，package.js:870-871）；⑥**`dist/.vscodeignore` 存在**（vsce 从包根读，评审订正⑥）；⑦`check-unresolved-imports` 零 external 残留；⑧`vsce package` 产 `.vsix` 且 **字节 <100MB**（**vsce 侧三条硬校验实跑即断言：name 合法 / version 合法 / `@types/vscode` 与 engines 兼容**）。
  ```bash
  git add apps/vscode package.json vitest.config.ts .gitignore pnpm-lock.yaml && git status --porcelain 自查后 commit -m "feat(vscode): 扩展工程骨架——@bhxch/vviewer-vscode workspace 包（源 manifest 带 scope/带 version/@types/vscode 钉版）+ esbuild 四产物构建链（host CJS/webview ESM splitting/worker IIFE×2）+ 资产采集（grammar lite 集/queries/runtime/pdfjs worker 双分支/katex 字体/两条主题表/icon）+ svgbob glue 条件桩 + 壳样式常量 + 扩展名清单实跑注册表生成 + VSIX manifest 生成（name 无 scope/main 重写/dist 侧 .vscodeignore）+ 打包门（无未解析 import + vsce .vsix <100MB）"
  ```

---

### Task 2: 扩展 host 侧——custom editor 注册 + webview 必需选项 + 文件字节通道 + 设置读取 + **扩展 i18n 目录与纪律前置**

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A/B 组）、`docs/design/semantic-components.md`（**核对面**：扩展 webview 独立运行时，该文档登记表不覆盖扩展面；本任务无新浮层/菜单/确认通道——「用编辑器打开」走 VSCode 原生命令而非自建菜单）、`docs/design/ui-design-system.md`（令牌口径：零新 token）。

**Files:**
- Create: `apps/vscode/src/extension.ts`（`activate`/`deactivate`；custom editor provider 注册；命令注册）
- Create: `apps/vscode/src/host/editorProvider.ts`（`CustomReadonlyEditorProvider` 实现）
- Create: `apps/vscode/src/host/webviewPanel.ts`（panel 创建/复用/reveal；**`enableScripts` + `localResourceRoots`**；`asWebviewUri` 资源映射；调用纯模板模块生成 HTML）
- Create: `apps/vscode/src/host/webviewHtml.ts`（**HTML 模板纯模块——零 `vscode` import**（`import * as vscode from 'vscode'` 在运行时不存在，vitest 直解析会红——评审订正⑧）：入参 = `{ cspSource, nonce, scriptUri, styleText }`，出参 = HTML 字符串；**CSP 七 directive** 与**样式内联**在此模块内成形 → 可被 `webviewHtml.test.ts` 直测）
- Create: `apps/vscode/src/host/fileChannel.ts`（读文件字节 + 大小上限）
- Create: `apps/vscode/src/host/protocol.ts`（host↔webview 消息类型——**纯 .ts，vitest 直测**）
- Create: `apps/vscode/src/host/settings.ts`（配置读取 + per-language 解析——**纯 .ts**，注入 `vscode` API 便于单测）
- Create: `apps/vscode/src/i18n/catalogs/zh-CN.ts`、`apps/vscode/src/i18n/catalogs/en.ts`（**扩展 i18n 目录前置到本任务**——T2 是首个用户可见文案落点）
- Create: `apps/vscode/src/i18n/core.ts`（纯层 `translate(key, params)`；locale 由 `vscode.env.language` 选）
- Modify: `eslint.config.js`（**新增** `apps/vscode/src/**` 覆盖块 + `ignores: ['apps/vscode/src/i18n/**', 'apps/vscode/src/**/*.test.ts']`——评审订正⑤）
- Test: `apps/vscode/test/protocol.test.ts`、`apps/vscode/test/settings.test.ts`、`apps/vscode/test/i18n.test.ts`、`apps/vscode/test/webviewHtml.test.ts`

**Interfaces:**
- 注册协议（spec §4.1）：`contributes.customEditors` = `[{ viewType: "vviewer.viewer", displayName: "VViewer", priority: "default", selector: [ …生成清单… ] }]`；host 侧 `window.registerCustomEditorProvider('vviewer.viewer', provider, { supportsMultipleEditorsPerDocument: false, webviewOptions: { enableFindWidget: true, retainContextWhenHidden: true } })`。
- **webview panel 必需选项（评审订正④）**：
  ```ts
  const panel = vscode.window.createWebviewPanel(
    'vviewer.viewer', docTitle,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,                                   // 不开 → webview 内脚本不执行 → 白屏
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],  // asWebviewUri 资源必须落在 roots 内，否则 404
    }
  );
  ```
  `localResourceRoots` 覆盖 `dist/`（`dist/webview/**` 的 wasm/字体/grammar/worker 全在其中）；单测断言二者（**评审订正④的回归锚**）。
- **CSP 七 directive（评审订正②，最终形态）**：
  ```
  default-src 'none';
  img-src ${webview.cspSource} data: blob: https:;
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';
  worker-src ${webview.cspSource} blob:;
  font-src ${webview.cspSource} data:;
  media-src ${webview.cspSource} blob: data:;
  connect-src ${webview.cspSource} data: blob: https:;
  ```
  逐条依据：`script-src` 的 **`${webview.cspSource}` 必需**——webview 入口 `main.js` 与动态 chunk `chunk-*.js` 都是外链脚本（ESM 入口 + code splitting），nonce 只覆盖宿主内联脚本、**覆盖不到 `import()` 的 chunk**；`'wasm-unsafe-eval'` 供 tree-sitter wasm 实例化；`media-src` 缺失则回落 `default-src 'none'` → `<audio>`/`<video>` 被拦（av 渲染器主功能死）；`connect-src` 缺失则 worker 内 fetch wasm 被拦；`font-src` 覆盖 asWebviewUri（katex 字体）；`style-src 'unsafe-inline'` 供包内导出/运行时样式（宿主内联块用 nonce）。
- **样式内联（评审订正①）**：webview HTML 头部内联**单一** `<style nonce="${nonce}">`，内容 = `MARKDOWN_CSS`（`@bhxch/vviewer-markdown` 导出，css.ts:216）+ `SHELL_CSS`（扩展壳样式常量，T1 Step 2 落）拼接——**markdown 排版/`.ts-*` 着色映射/图表/灯箱/表格/alert 段与壳布局一次到位**；动态令牌（`--vv-ts-*`）不进此块（主题变更时由 webview 侧 `<style>` 元素替换，见 T3/T6）。该拼接与 CSP 成形都在 **vscode-free 纯模块 `webviewHtml.ts`** 内完成（单测直测该模块，禁在测试里 import `vscode`）。单测断言：内联块非空且含 `.vv-markdown`、`.ts-keyword`、`.md-lightbox` 与壳类名。
- 消息协议（`protocol.ts`，host↔webview 双向）：
  ```ts
  export type HostToWebview =
    | { kind: 'init'; doc: { name: string; path: string; size: number; bytes: Uint8Array; languageId?: string };
        theme: { kind: 'dark' | 'light'; cssVars: Record<string, string> };
        settings: WebviewSettings;
        assets: AssetUris }
    | { kind: 'settings'; settings: WebviewSettings }
    | { kind: 'theme'; theme: { kind: 'dark' | 'light'; cssVars: Record<string, string> } }
    | { kind: 'file-bytes'; id: number; bytes: Uint8Array | null; error?: string }
    | { kind: 'export-result'; id: number; ok: boolean; path?: string; error?: string };
  export type WebviewToHost =
    | { kind: 'ready' }
    | { kind: 'read-file'; id: number; path: string }        // 相对链接/相对图片探测
    | { kind: 'export-html'; id: number; html: string; suggestedName: string }
    | { kind: 'open-external'; url: string }
    | { kind: 'report'; level: 'warn' | 'error'; message: string };  // webview 无 console 出口 → 走 host 通道
  ```
- `AssetUris`：`{ grammarsBase: string; queriesBase: string; runtimeDir: string; grammars: GrammarTable; binaryWorkerUrl: string; pdfWorkerModernUrl: string; pdfWorkerLegacyUrl: string; fontsBase: string; katexCssUrl: string; highlightWorkerSourceUrl: string }`（**无悬空 `workerUrl` 字段**——三个 worker 各有专名：`highlightWorkerSourceUrl`=tree-sitter worker（blob 源）、`binaryWorkerUrl`=hex worker、`pdfWorkerModernUrl`/`pdfWorkerLegacyUrl`=pdfjs worker 双支）——**全部为 `webview.asWebviewUri` 绝对 URL**（RF 5）；**pdfjs worker 两支都在其中**（选支在 webview 侧做，见下条——host 不引 pdfjs，避免把 pdfjs 打进 host bundle）。
- 大文件上限（spec §7 ⑤）：`MAX_BYTES = 200 * 1024 * 1024`（对齐 web `PLAIN_MAX_BYTES`，render-text/src/code/strategy.ts:92）；超限 → **不读文件**，webview 显示引导占位（**文案走扩展 i18n 目录**，如「文件超过 200MB，建议改用 VSCode 原生编辑器打开」）——host 侧 `fileChannel.ts` 读 `vscode.workspace.fs.stat` 拿 size 后判定（`fs.readFile` 前置判定，避免大文件全量入内存）。
- panel 复用（裁量 5）：`Map<documentUri.toString(), WebviewPanel>`；同文档再次打开 → `reveal()` 既有 panel（不重开）；文档关闭 → `onDidDispose` 清映射。
- 设置读取（`settings.ts`）：`workspace.getConfiguration('vviewer', { languageId })` → 归一为 `WebviewSettings`：
  ```ts
  export interface WebviewSettings {
    tocSide: 'left' | 'right';
    tocDefaultCollapsed: boolean;
    highlightEngine: 'tree-sitter' | 'hljs' | 'plain';
    diagramMode: 'local' | 'kroki' | 'off';
    allowRemoteServices: boolean;
    externalImages: 'blocked' | 'manual' | 'auto';
    externalImageAllowlist: string[];
  }
  ```
  归一纪律：枚举脏值回落缺省（`toc.side` 非 left/right → 'right'；`highlightEngine` 非三值 → 'tree-sitter'；`externalImages` 非三值 → 'blocked'——**对齐 `packages/vviewer-sanitize` 的 `EXTERNAL_IMAGE_POLICIES = ['blocked','manual','auto']`**）；白名单条目 trim + 去空 + 小写。
- **扩展 i18n 目录（本任务落地，后续任务一律走目录）**：`apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts`，key 三段 `{域}.{模块}.{语义}`（域：`shell`/`viewer`/`notice`/`errors`——扩展自有域集，不复用 apps/web 的 12 域全集）；`core.ts` 纯层 `translate(key, params)`，locale 由 `vscode.env.language` 选（`zh*` → zh-CN，其余 → en）；**T2 起任何用户可见文案一律 `t()` 取值，禁裸 CJK 字面量**（ESLint 覆盖块本任务落地即执法）。
- ESLint 覆盖块（评审订正⑤）：
  ```js
  {
    files: ['apps/vscode/src/**/*.{svelte,ts}'],
    ignores: ['apps/vscode/src/i18n/**', 'apps/vscode/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', runesOptOut, cjkLiteral, cjkTemplateElement, cjkSvelteText, cjkSvelteLiteral, bareIntl],
      'no-restricted-imports': [{ patterns: [{ group: ['**/i18n/catalogs', '**/i18n/catalogs/**'], message: '禁止直读 catalogs：消费方一律经 i18n/core 门面' }] }]
    }
  }
  ```
  （按仓库「后块整体覆盖前块」纪律，`runesOptOut` 一并展开；`apps/vscode` 无 `.svelte` 文件，选择器无匹配但纪律形状保持。）

- **验收锚 / e2e**：验收 = `apps/vscode/test/{protocol,settings,i18n,webviewHtml}.test.ts` 全绿（协议形状/脏值归一/per-language 覆盖解析/**CSP 七 directive + cspSource 出现在 script-src 与 media-src**/**`enableScripts: true` + `localResourceRoots` 含 dist**/**样式内联块含关键类名**/i18n zh==en 键集与占位符）+ `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（纯扩展面，apps/web 零改动）。

- [ ] **Step 1: i18n 目录 + ESLint 覆盖块 + 协议/设置纯逻辑（TDD RED）**
  先建 `apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts` 与 `core.ts`（含 T2 自己的文案键，如 `viewer.tooLarge`）；改 `eslint.config.js` 加覆盖块（**ignores 含 i18n 目录**）；`protocol.test.ts`（消息判别 `kind` 穷尽、`read-file`/`export-html` 的 id 单调性、`WebviewSettings` 归一）、`settings.test.ts`（`getConfiguration('vviewer', {languageId })` 桩 → 语言级覆盖 > 窗口级 > 缺省，RF 9）、`i18n.test.ts`（zh==en 键集、占位符集合相等、locale 选择）。Run: `pnpm vitest run apps/vscode` → Expected: RED（模块不存在）。**同任务内用 `pnpm exec eslint --stdin --stdin-filename apps/vscode/src/probe.ts` 验证 CJK 拦截生效（探针不入库）。**

- [ ] **Step 2: host 侧实现（provider / panel / 文件通道 / HTML 模板）**
  按 Interfaces 落地：`extension.ts` 激活注册 provider + 命令（`vviewer.openWithNative`（打开原生编辑器）/`vviewer.reload`（重渲染））；`webviewPanel.ts` 建 panel（**`enableScripts: true` + `localResourceRoots: [dist]`**）+ `asWebviewUri` 资源映射，HTML 交 `webviewHtml.ts` 纯模块生成（nonce + **CSP 七 directive** + **样式内联**）；`fileChannel.ts` 实现 200MB 判定与字节读。**所有用户可见文案走 i18n 目录**（`t()`）——禁裸 CJK 字面量。
- [ ] **Step 3: 门禁 + 提交**
  Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿。
  ```bash
  git add apps/vscode eslint.config.js && git commit -m "feat(vscode): host 侧——custom editor provider + webview 必需选项（enableScripts/localResourceRoots）+ CSP 七 directive（script-src 含 cspSource、media-src 显式列）+ MARKDOWN_CSS 与壳样式内联供给面 + 200MB 上限字节通道 + 设置读取（per-language）+ 扩展 i18n 目录与 ESLint 纪律前置"
  ```

---

### Task 3: webview 装配层——渲染器注册 + 十一处 setter 接线 + 动态令牌 + 包内 worker URL 缝新增

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A/B 组）、`docs/design/semantic-components.md`（**核对面**：本任务无新浮层/菜单/确认通道）、`docs/design/ui-design-system.md`（令牌口径：零新 token）。

**Files:**
- Create: `apps/vscode/src/webview/main.ts`（webview 入口：消息协议接线 + 装配 + 渲染调度）
- Create: `apps/vscode/src/webview/assemble.ts`（**纯 TS 装配层**——`apps/web/src/lib/viewer.ts` 的无 app 依赖重写）
- Create: `apps/vscode/src/webview/shell.ts`（webview 壳：内容区 + toc 面板 + **顶部提示条**（inline banner，`role="status"`）+ toc 头部徽标；原生 TS DOM；a11y 属性）
- Create: `apps/vscode/src/webview/theme.ts`（**动态令牌注入面**：kind → `--ui-*` 缺省 + capture 表 → `--vv-ts-*`；webview 侧 `<style>` 元素整体替换）
- Create: `apps/vscode/src/webview/dispatchHost.ts`（host 往返桥：相对文件读、导出写盘、外部链接、report 通道）
- Create: `apps/vscode/src/webview/store.ts`（singleFile 型 TreeStore 注入——core `createSingleFileStore` 先例）
- Modify: `packages/vviewer-render-doc/src/pdf.ts`（**新增** `setPdfWorkerUrlProvider` 注入缝；默认逐字节不变）
- Modify: `packages/vviewer-render-binary/src/hex.ts`（**新增** `setHexWorkerUrlProvider` 注入缝；默认逐字节不变）
- Test: `packages/vviewer-render-doc/test/pdfWorkerUrl.test.ts`（新建）、`packages/vviewer-render-binary/test/hexWorkerUrl.test.ts`（新建）
- Test: `apps/vscode/test/assemble.test.ts`、`apps/vscode/test/shell.test.ts`

**Interfaces:**
- `assemble.ts`（装配层，**零 `$app`/`import.meta.env`/store 依赖**）：
  - 注册表：`createRegistry()` → 按 web 端同序安装 MVP 渲染器（code → markdown → html → image → av → pdf → hex → jsonl；**archive/foreign/docx-xlsx-pptx 不装**——裁量 3；与 web 端 `viewer.ts:143-156` 的差别仅是跳过 diagram/foreign/Office 三块）；末段 `installFallbackExtensions('code', GENERATED_EXTENSIONS)` 补空位（generated 遇已认领扩展名跳过——`md`/`markdown`/`html`/`htm` 由 code 渲染器显式不认领，归 markdown/html 渲染器）。
  - **十一处 setter 接线（计数口径订正⑩ + 本轮订正③·接线补齐）——逐一断言全部注入**：
    | # | setter | 归属 | 位置 | 断言形态 |
    |---|---|---|---|---|
    | 1 | `setHighlightFence` | markdown 组合包 | markdownRenderer.ts:64 | `getHighlightFence()` === 注入值 |
    | 2 | `setMarkdownBackend` | markdown 组合包 | markdownRenderer.ts:98 | `getMarkdownBackend()` === 注入值 |
    | 3 | `setResolveRemoteBase` | markdown 组合包 | markdownRenderer.ts:119 | `getResolveRemoteBase()` === 注入值 |
    | 4 | `setMarkdownImageResolver` | markdown 组合包 | markdownRenderer.ts:141 | `getMarkdownImageResolver()` === 注入值 |
    | 5 | `setRelativeLinkResolver` | markdown 组合包 | markdownRenderer.ts:166 | `getRelativeLinkResolver()` === 注入值 |
    | 6 | `setRelativeLinkOpener` | markdown 组合包 | markdownRenderer.ts:180 | `getRelativeLinkOpener()` === 注入值 |
    | 7 | `setDiagramOptions` | markdown 组合包 | markdownRenderer.ts:240 | `getDiagramOptions()` 返回注入值 |
    | 8 | `setExternalImagePolicyProvider` | **@bhxch/vviewer-sanitize** | sanitize.ts:99 | `getExternalImagePolicyProvider()` === 注入值 |
    | 9 | `setRenderFailedText` | **@bhxch/vviewer-core** | dispatch/errors.ts:44 | 错误文案走注入值（触发一次失败取文案断言） |
    | 10 | `setPdfWorkerUrlProvider` | **@bhxch/vviewer-render-doc** | T3 Step 1 新增 | 注入后取到 worker URL（**不注入即 pdf 渲染死**——评审订正③） |
    | 11 | `setHexWorkerUrlProvider` | **@bhxch/vviewer-render-binary** | T3 Step 1 新增 | 注入后取到 worker URL（**不注入即 404 异步失败 → 渲染挂死**——评审订正③） |
    （①~⑦属 markdown 组合包（7）；⑧属 sanitize 包；⑨属 core 包；⑩⑪属两个渲染包——**总计 11 处 setter**。）
    接线：
    `setHighlightFence(fenceToHtml)`（围栏桥来自 `@bhxch/vviewer-render-text/markdown/markdownRenderer`，签名 `(code, lang) => Promise<string | null>`；**唯一注入点=T3，T4 不重复注入**——见 T4 的口径统一条）；
    `setMarkdownBackend(恒本地)`（扩展无服务端——`renderMarkdownBody`）；
    `setResolveRemoteBase(() => null)`；
    `setMarkdownImageResolver(...)`（相对图片 → blob URL，§7 ②）；
    `setRelativeLinkResolver(...)` + `setRelativeLinkOpener(...)`（§7 ①）；
    `setDiagramOptions(...)`（local/kroki/off + allowRemoteServices 闸）；
    `setExternalImagePolicyProvider(...)`（三档 + 白名单，映射 spec D）；
    `setRenderFailedText(() => t('errors.renderFailed'))`；
    **`setPdfWorkerUrlProvider(() => preferModernBuild() ? assets.pdfWorkerModernUrl : assets.pdfWorkerLegacyUrl)`**——**选支在 webview 侧做**：`preferModernBuild` 从 `@bhxch/vviewer-render-doc` 根导入（该包已在 webview bundle 内，host 侧不引 pdfjs）；能力判定与 pdfjs 主模块同环境，worker 与主模块构建分支必然一致（Global Constraints「包内 seam 纪律」条）；
    **`setHexWorkerUrlProvider(() => assets.binaryWorkerUrl)`**。
  - 数据面：`createSingleFileStore(file)` 注入 dispatcher 的 `FileSource.store`（core singleFile 先例，`packages/vviewer-core/src/tree/singleFile.ts`）——webview 内以 `new File([bytes], name)` 构造。
- **包内新增缝（跨包最小改动，默认零行为变化）**：
  ```ts
  // packages/vviewer-render-doc/src/pdf.ts
  let pdfWorkerUrlProvider: (() => string | null) | null = null;
  export function setPdfWorkerUrlProvider(fn: (() => string | null) | null): void { pdfWorkerUrlProvider = fn; }
  // 现 pdfWorkerUrl()（pdf.ts:128-132）改为：provider 存在且返回非 null → 取该值；否则逐字节回退现表达式。
  ```
  ```ts
  // packages/vviewer-render-binary/src/hex.ts
  let hexWorkerUrlProvider: (() => string | null) | null = null;
  export function setHexWorkerUrlProvider(fn: (() => string | null) | null): void { hexWorkerUrlProvider = fn; }
  // hexRenderer.render 的 createWorker：provider 返回非 null → new Worker(url, {type:'module'})；否则逐字节回退 new URL('./binary.worker.ts', import.meta.url)。
  ```
  **apps/web 零改动**（不注入 → 默认路径逐字节等价），三处 e2e 回归锚零翻转（RF 1）。
  **扩展侧必须接线**（本轮订正③）：T3 的装配层调用这两个 setter（见上表 ⑩⑪）；**pdf 双分支的消费面 = 按能力选支**——**选支在 webview 侧**（webview bundle 已含 pdfjs 主模块，host 侧不引 pdfjs）：`preferModernBuild` 从 `@bhxch/vviewer-render-doc` 根导入（render-doc/src/pdf.ts:96 导出；包 `exports["."]` = `src/pdf.ts`）→ `preferModernBuild() ? assets.pdfWorkerModernUrl : assets.pdfWorkerLegacyUrl`——两文件都有消费面，无死重，worker 与主模块构建分支必然一致，不绕开 pdf.ts 的能力分支。
- **动态令牌面（`theme.ts`）**：kind → `--ui-bg/--ui-fg/--ui-border/--code-*` 缺省值（**沿 `packages/vviewer-markdown/src/css.ts` 内既默认值，不引入新 token**——markdown.css 的 `var(--token, 默认值)` 契约自带缺省）；capture 色 → `themeToCssVars(table, CODE_CAPTURES)`（`@bhxch/vviewer-highlight`）注入 `--vv-ts-*`；表源 = 打包的两条主题（onelight/serika-dark，按 kind 选，裁量 4）；注入方式 = webview 侧 `<style id="vv-tokens">` 元素整体替换（**不进宿主的静态内联块**——主题变更时需整体替换）。
- **katex CSS 注入面**：webview 启动时 fetch `asWebviewUri(dist/webview/katex.min.css)` → `<style>` 注入（字体 URL 已是绝对 asWebviewUri，`font-src` 覆盖即生效）——包内 `pipeline.ts:643` 的动态 import 在 esbuild 下不注入样式，漏做即公式无排印（RF 7）。
- **验收锚 / e2e**：验收 = `packages/vviewer-render-doc` / `packages/vviewer-render-binary` 新增单测绿 + **既有包单测零回归** + `apps/vscode/test/{assemble,shell}.test.ts` 绿（**十一处 setter 逐一断言**——`assemble.test.ts` 对上表 11 项全覆盖：9 个 getter 形态断言 + 2 个 worker provider 断言「注入后取到 URL」）+ `pnpm run typecheck` 绿；**所触 e2e 锚文件（回归锚，不改断言）**：`e2e/b-pdf-range.spec.ts`、`e2e/b-pdf-range-2.spec.ts`、`e2e/b-binary-hex-archive.spec.ts`。

- [ ] **Step 1: 包内两缝（TDD RED→GREEN，默认路径锁死）**
  先写 `pdfWorkerUrl.test.ts`（未注入 → URL 形态与现表达式等价（`pdfjs-dist/build/pdf.worker.min.mjs` 或 legacy 分支）；注入 → 返回注入值）与 `hexWorkerUrl.test.ts`（未注入 → `new URL('./binary.worker.ts', import.meta.url)` 形态；注入 → 注入值；provider 返回 null → 回退默认）。Run: `pnpm vitest run packages/vviewer-render-doc packages/vviewer-render-binary` → RED → 落缝 → GREEN（**既有用例零回归** = 默认路径兼容锚）。
- [ ] **Step 2: webview 装配层 + 壳（RED→GREEN）**
  `assemble.test.ts`：注册表安装序（code → markdown → …；`md` 归 markdown）、**十一处 setter 逐一断言**（上表 11 项全覆盖——含 `setPdfWorkerUrlProvider` / `setHexWorkerUrlProvider` 两条**必须接线**的缝：断言注入后取到 worker URL，**不接即 pdf 渲染死 / hex 挂死**）、dispatcher 对单文件 source 选中预期渲染器。`shell.test.ts`（jsdom）：壳 DOM 契约 + a11y（toc 面板 `role="complementary"`/`aria-label`、折叠钮 `aria-expanded` 同步、**顶部提示条 `role="status"`**、toc 头部徽标有可读名称、图标钮 aria-label 含可见文本词形）。Run: `pnpm vitest run apps/vscode` → RED → GREEN。
- [ ] **Step 3: 动态令牌 + katex CSS 注入面**
  动态令牌 `<style id="vv-tokens">` 替换面（亮/暗两套，主题变更时整体替换）；katex CSS 自备注入面（RF 7）。两者均为 webview 侧运行时注入。
- [ ] **Step 4: 回归 + 门禁 + 提交**
  Run: `pnpm vitest run apps/vscode packages/vviewer-render-doc packages/vviewer-render-binary && pnpm run typecheck && pnpm lint` → 全绿；`pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-pdf-range b-pdf-range-2 b-binary-hex-archive` → 三域零翻转（RF 1 回归锚）。
  ```bash
  git add apps/vscode packages/vviewer-render-doc packages/vviewer-render-binary && git commit -m "feat(vscode): webview 装配层——viewer.ts 无 app 依赖重写（9 类渲染器 + 十一处 setter 逐一接线：九渲染/文案缝 + pdf/hex worker URL provider + singleFile store）+ 动态令牌注入面 + katex CSS 自备注入面 + 壳（内容区/toc/顶部提示条，无状态栏）；包内新增 pdf/hex worker URL 注入缝（默认逐字节不变）"
  ```

---

### Task 4: tree-sitter 离线高亮链路——blob worker + 本地 grammar/queries 资产 + 引擎档位

**Files:**
- Create: `apps/vscode/src/webview/highlight.ts`（worker 起活 + `HighlightClient` + `CodeHighlightClient` 适配 + `attachHighlightClient`；**不注入 `setHighlightFence`**——围栏桥由 T3 装配层统一注入，缝只注入一次）
- Create: `apps/vscode/src/webview/highlightWorker.ts`（**worker 入口**：import `serveWorker` 并自启——包内 `serveWorker`（worker.ts:109）已含 WorkerGlobalScope 自启语义）
- Create: `apps/vscode/src/webview/assets.ts`（资产 URI 解析 + manifest → GrammarTable + 缺件可见降级）
- Create: `apps/vscode/src/webview/engineBadge.ts`（当前高亮引擎态的可见指示——**顶部提示条 + toc 面板头部徽标**，不设状态栏）
- Test: `apps/vscode/test/highlight.test.ts`（纯逻辑：引擎档位裁决、缺件降级矩阵、grammar 表构造）

**Interfaces:**
- worker 起活（RF 6）：webview 内 `fetch(highlightWorkerSourceUrl)` → `new Blob([text], { type: 'text/javascript' })` → `URL.createObjectURL` → `new Worker(blobUrl)`；**worker bundle 必须 IIFE 自包含**（无 import）；起活失败 → 落 hljs/plain 并在顶部提示条显示（RF 3，不静默）。
- 握手（`HighlightClient` 构造即发 init，`packages/vviewer-highlight/src/client.ts`）：init 载荷 = `{ kind: 'init', grammars: GrammarTable, grammarsBase, queriesBase, runtimeDir }`——`grammars` 由扩展读 `assets/grammars/manifest.json` 的 `grammars` 键（`GrammarTable` 形态 `Record<string, { file: string; aliases?: string[]; base?: string }>`，core-parse.ts:20）；`grammarsBase`/`queriesBase`/`runtimeDir` 全为 `asWebviewUri` 绝对 URL（RF 5）。
- **资产与引擎的一致性**：`Language.load(joinPath(entry.base ?? grammarsBase, entry.file))`（core-parse.ts:417）→ manifest 条目**不得带 `base`**（否则绕开 grammarsBase 打到错误源）；queries 走 `fetch(`${queriesBase}${lang}/${name}`)`（core-parse.ts:484）→ `queriesBase` 必带尾 `/`（`joinPath` 语义）；runtime 走 `Parser.init({ locateFile: (f) => joinPath(runtimeDir, f) })`（core-parse.ts:210）→ `runtimeDir` 指向含 `tree-sitter.wasm` 的目录。三者同族绝对 URL（RF 5）。
- 引擎档位（`vviewer.code.highlightEngine`）：`'tree-sitter'`（默认，装 tree-sitter 链）｜`'hljs'`（不装 worker，渲染器走内置 hljs 兜底——`@bhxch/vviewer-render-text` 依赖 `highlight.js`，`renderCode.ts:259` 的 `hljsWholeFile` 为整文件兜底）｜`'plain'`（纯文本，无着色）。裁决单点：`resolveHighlightEngine(settings) → 'tree-sitter' | 'hljs' | 'plain'`（纯函数，单测锁）。
  **大小阈值沿渲染器既有策略**（`packages/vviewer-render-text/src/code/strategy.ts:89-94`：`TREE_SITTER_MAX_BYTES = 2MB` / `HLJS_MAX_BYTES = 20MB` / `PLAIN_MAX_BYTES = 200MB`）——故 hljs 档的着色覆盖面是：≤2MB 整文件 hljs、2~20MB lazy 行级 hljs、>20MB 纯文本；tree-sitter 档同理（>2MB 走 lazy chunk）。**200MB 上限与本计划 host 侧大文件闸同源**（spec §7 ⑤「对齐 web PLAIN_MAX_BYTES 口径」）。
- 降级矩阵（RF 3，可见）：worker 起活失败 / init 看门狗超时（client.ts:25 的 15s `INIT_TIMEOUT_MS`）→ hljs；grammar 清单缺失该语言 → hljs（清单感知门，apps/web 同款语义）；用户档位即 plain → 不起 worker（省内存与启动时间）。
- **验收锚 / e2e**：验收 = `apps/vscode/test/highlight.test.ts` 绿 + `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（扩展面）。

- [ ] **Step 1: 引擎档位与降级矩阵（TDD RED）**
  `highlight.test.ts`：档位裁决三态、缺件降级（worker 失败 → hljs；语言不在清单 → hljs；plain 不起 worker）、manifest → GrammarTable 构造（条目 base 恒 undefined）、queriesBase/runtimeDir 尾斜杠与绝对性断言。Run: `pnpm vitest run apps/vscode` → RED。
- [ ] **Step 2: worker 入口 + 资产解析 + client 适配**
  落 `highlightWorker.ts`（`import { serveWorker } from '@bhxch/vviewer-highlight/worker'; serveWorker();`）、`assets.ts`（读 manifest → GrammarTable；组装三段 base URL）、`highlight.ts`（blob worker 起活 → `new HighlightClient(worker, init)` → 适配 `CodeHighlightClient`（highlight/outline/cancelOutline/hasLocalGrammar——render-text 的鸭子面，`packages/vviewer-render-text/src/code/client.ts:34`）→ `attachHighlightClient(adapter)`）。**口径统一（评审订正⑨·本轮）**：围栏桥 `setHighlightFence(fenceToHtml)` **只在 T3 装配层注入一次**，本任务**不重复注入**（T3 的缝表 ① 与本任务共同构成 11 处 setter 的分工：T3 注入 11 处，T4 只做 client 适配与 attach——「缝一次性注入，重复注入即语义漂移」的纪律）。**不发 compute 路由**（扩展无服务端——`computeRouter` 不装配，调用恒本地）。
- [ ] **Step 3: 引擎态可见 + 门禁 + 提交**
  `engineBadge.ts`：顶部提示条 + toc 面板头部徽标显示当前引擎（tree-sitter / hljs（降级）/ plain），降级时附原因短语（RF 3）。Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿。
  ```bash
  git add apps/vscode && git commit -m "feat(vscode): tree-sitter 离线高亮链路——blob worker（IIFE 自包含）+ 本地 grammar/queries/runtime 资产（asWebviewUri 三段自洽）+ 引擎档位裁决与可见降级（顶部提示条与 toc 徽标指示，无状态栏）"
  ```

---

### Task 5: toc 面板 + 相对链接/图片解析 + 导出 HTML 写盘（含 resolveImage）+ 图表外联闸（逐语言映射 + 包内 allowRemote 缝）

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 A/B 组）、`docs/design/semantic-components.md`（核对面：本任务含 toc 面板这一「新增面板」——按「先登记后使用」方法论在本计划登记其语义角色）、`docs/design/ui-design-system.md`（零新 token）。

**Files:**
- Create: `apps/vscode/src/webview/toc.ts`（toc 数据面装配 + 面板交互 + 位置/折叠态）
- Create: `apps/vscode/src/webview/links.ts`（相对链接解析 + 相对图片 → blob URL + 外部链接通道）
- Create: `apps/vscode/src/webview/exportHtml.ts`（**导出 HTML 组装（选项名对齐真实 API）** + **resolveImage 实现** + 写盘请求）
- Modify: `apps/vscode/src/webview/shell.ts`（toc 面板挂载 + 顶部提示条反馈）
- Modify: `apps/vscode/src/webview/assemble.ts`（相对链接/图片 resolver 注入接线 + **图表外联闸接线**：`modeOf`/`rendererOf`/`allowRemote` 三项按设置注入）
- Create: `apps/vscode/src/webview/diagramGate.ts`（**图表外联闸纯函数**：`resolveDiagramMode(lang, settings)` + `resolveDiagramRenderer(lang, settings)` + `allowRemoteOf(settings)`——零依赖纯 .ts，vitest 直测）
- Modify: `packages/vviewer-markdown/src/markdownRenderer.ts`（**新增** `DiagramRenderOptions.allowRemote?: boolean` 字段——additive、缺省 undefined = 现有行为逐字节不变）
- Modify: `packages/vviewer-markdown/src/pipeline.ts`（消费 `allowRemote`：kroki 模式分支（:500-502）与 local 失败降级（:536-549）在 `allowRemote === false` 时**直接落源码块**，不经 `appendKrokiImg()`）
- Test: `packages/vviewer-markdown/test/allowRemote.test.ts`（新建：缺省 undefined = 既有降级链不变（kroki img 仍先落）；`false` 时 kroki/local 两分支均落源码块、无 kroki URL 构造）
- Test: `apps/vscode/test/toc.test.ts`、`apps/vscode/test/links.test.ts`、`apps/vscode/test/exportHtml.test.ts`、`apps/vscode/test/diagramGate.test.ts`（**逐类型断言**，见 Step 3）

**Interfaces:**
- toc 数据面（spec §7 技术订正）：markdown → `extractToc(scope)`（`@bhxch/vviewer-markdown`，markdownRenderer.ts:381）经渲染实例 `getToc?.()`（core `RenderedInstance` 鸭子面，types.ts:121）；code → 渲染实例 `getOutline?.()`（highlight 包 `pairsToOutline` 产出，`packages/vviewer-highlight/src/outline.ts:38`）。**统一为面板条目** `{ id, label, level, kind: 'heading' | 'symbol' }`。
- 面板行为：`vviewer.toc.side`（'left' 默认 'right'——spec §4.2）决定停靠侧；`vviewer.toc.defaultCollapsed`（默认 **true**——「右侧内容默认收起」即 toc 面板默认收起）；折叠态记忆 `workspaceState`（`context.workspaceState.update('vviewer.toc.collapsed', …)`，spec §4.2「折叠态记忆 workspaceState」）；折叠钮 `aria-expanded` 同步；点击条目 → 滚动到目标（markdown heading id / code 符号行号）。
- 相对链接（§7 ①）：webview 侧 `setRelativeLinkResolver` → 经 host 往返（`read-file` 消息 + `Uri.joinPath`）→ 命中则 `setRelativeLinkOpener` 打开（同一 custom editor 内切换文档）；未命中 → **顶部提示条**（`role="status"`）提示。
- 相对图片（§7 ②）：`setMarkdownImageResolver` → host 读 sibling bytes → webview 侧 `URL.createObjectURL(new Blob([bytes]))` → 渲染实例销毁时 revoke（包内视图托管 blob 生命周期，resolver 返回 URL 即由包内 revoke——`markdownRenderer.ts` 的 blob 登记语义）。
- **导出 HTML（§7 ③）——选项名对齐真实 API（订正⑧）**：
  ```ts
  // packages/vviewer-markdown/src/export.ts:84-105 的真实 ExportHtmlOptions
  collectExportHtml(doc, {
    title: string,            // 必填：导出文档标题（<title>）——传文件名
    styleCss: string,         // 必填：内联样式文本（exportBaseCss + 主题变量块）
    katexCss?: string,        // 可选：自包含 katex 排印样式（字体 data URI 内联）
    resolveImage(src: string): Promise<string | null>   // 必填：图片 data URI 解析回调
  });
  ```
  **无 `inlineCss` 选项名**——计划初版误写，订正为 `styleCss`（+ 必填 `title` / `resolveImage`）。
  - `styleCss` = `exportBaseCss`（包导出）+ 主题变量块（`--ui-*`/`--code-*`/`--vv-ts-*` 当前值快照）。
  - `katexCss` = 构建期产出的**自包含** katex CSS（woff2 字体 data URI 内联、woff/ttf 回退段移除——与 apps/web `katexExportCss.ts` 同形态的扩展侧实现，见台账⑤）。
  - **`resolveImage` 实现项（扩展侧 `resolveExportImage(src)`，语义对齐 `apps/web/src/lib/markdownExport.ts:27`）**：`data:` → 返回 null（原样保留）；外域 `http(s)`（origin ≠ 页面 origin）→ 返回 null（CORS 不可控不强拉）；`blob:` / 同源 `http(s)` / 相对路径 → fetch → 校验 `content-type` 为 `image/*`（空串按 `image/png` 兜底）→ 转 base64 data URI；非 2xx / 非 image 类型 / fetch 抛错 → 返回 null 降级（保留原 URL）。扩展内相对图片已被 resolver 转 blob URL，故主路径是 `blob:` 分支。
  - 写盘：webview → host `export-html` 消息（`html` + `suggestedName`）→ host `showSaveDialog` + `workspace.fs.writeFile` → 回 `export-result` → **顶部提示条**反馈成功/失败路径。
- **图表与外联闸（spec §4.4 + 约束②；逐语言映射口径见 Global Constraints「图表外联闸的落点」条）**：本地引擎 mermaid/katex/viz/nomnoml 随 webview bundle 动态 chunk（esbuild splitting）；设置项 `vviewer.markdown.diagramMode`（local/kroki/off）+ `vviewer.diagrams.allowRemoteServices`（默认 false）经 `diagramGate.ts` 纯函数映射为**逐语言**的三项注入：
  ```ts
  // apps/vscode/src/webview/diagramGate.ts（纯函数，vitest 直测）
  export const OFFLINE_ENGINES = new Set(['mermaid','graphviz','nomnoml','math','svgbob']);  // 真离线引擎集
  export function resolveDiagramMode(lang: string, s: { diagramMode: 'local'|'kroki'|'off'; allowRemoteServices: boolean }): DiagramMode;
  export function resolveDiagramRenderer(lang: string, s: { allowRemoteServices: boolean }): string | undefined;  // 恒 undefined（不选 'hpcc' 外联渲染器）
  export function allowRemoteOf(s: { allowRemoteServices: boolean }): boolean;   // → DiagramRenderOptions.allowRemote
  ```
  映射语义：
  - **闸关（`allowRemoteServices=false`，默认）**：`resolveDiagramMode` 对**注册表每个类型**判定——`type.local && type.engine && OFFLINE_ENGINES.has(type.engine)` → `'local'`；其余（17 个 kroki-only 类型 + 8 个 CDN 引擎族 + 未知语言）→ **`'source'`**（源码块，零外联）。**永不返回 'kroki'/'official'/'server'**（避免 `effectiveModeOf` 升格与外联）。
  - **闸开（`allowRemoteServices=true`）**：设置 'off' → `'source'`（**'off' 必须映射为 'source'——`DiagramMode` 无 'off'，diagrams.ts:7**）；'kroki' → `type.krokiType ? 'kroki' : 'source'`；'local' → `type.local && type.engine ? 'local' : (type.krokiType ? 'kroki' : 'source')`（与 web 端同语义，允许升格）。
  - `resolveDiagramRenderer` **恒返回 undefined**（graphviz 默认 viz-js 离线；'hpcc' 走 cdnEngines 外联——闸开也不选，MVP 不提供该渲染器）。
  - `allowRemoteOf` → `allowRemoteServices`（false 时注入 `allowRemote: false`，使包内降级链不经 kroki；true 时 `allowRemote: true` 或缺省——**缺省 undefined 亦为既有行为**，两者等价）。
  **配套包内 additive 缝**（`@bhxch/vviewer-markdown`）：`DiagramRenderOptions.allowRemote?: boolean`（markdownRenderer.ts:197-238）+ pipeline 消费点——kroki 模式分支（pipeline.ts:500-502）与 local 失败降级（pipeline.ts:536-549）在 `allowRemote === false` 时**直接落源码块**（`view.textContent = source`），不经 `appendKrokiImg()`；**缺省 undefined = 现有行为逐字节不变**（apps/web 不注入 → 零改动）。
- **验收锚 / e2e**：验收 = `apps/vscode/test/{toc,links,exportHtml,diagramGate}.test.ts` 绿 + `packages/vviewer-markdown/test/allowRemote.test.ts` 绿 + **包内既有单测零回归** + `pnpm run typecheck` 绿；**所触 e2e 锚文件（回归锚，不改断言——包内 additive 缝的默认路径必须逐字节不变）**：`e2e/b-md-diagrams-deep.spec.ts`（DM-05 effectiveModeOf 回退链：plantuml 强制 local → 回退 kroki img；math 强制 kroki → 回退 source）、`e2e/b-cdn-diagram-engines.spec.ts`（CDN-02 双跳回退链 / CDN-03 svgbob 本地 wasm / CDN-04 graphviz hpcc）。

- [ ] **Step 1: toc 纯逻辑 + 壳交互（RED→GREEN）**
  `toc.test.ts`：数据面归一（markdown TocEntry → 面板条目；code OutlineEntry → 面板条目；level 裁剪至 1-4）、位置与折叠态裁决（默认折叠 = true）、workspaceState 读写（桩）。`shell.test.ts` 扩：面板停靠侧切换、折叠钮 `aria-expanded` 同步、顶部提示条 `role="status"`（a11y 断言）。
- [ ] **Step 2: 相对链接/图片 + 导出写盘（含 resolveImage）**
  `links.test.ts`：host 往返协议（id 配对、缺件路径）、blob URL 生命周期（revoke 断言）、外部链接通道（`open-external` 消息）。`exportHtml.test.ts`：`collectExportHtml` 调用**选项名逐字对齐真实 API**（`title`/`styleCss`/`katexCss`/`resolveImage`，**断言不得出现 `inlineCss`**）；`resolveExportImage` 六态（data: 保留 / 外域保留 / blob 成功转 data URI / 同源 http 成功 / 非 image 类型保留 / fetch 失败保留）；导出产物含主题变量块与自包含 katex CSS（断言 `data:` 字体 URL 存在、无外部字体引用）；写盘请求消息形状。
- [ ] **Step 3: 图表外联闸（包内 allowRemote 缝 + 逐语言映射 + 逐类型断言）**
  先写 `packages/vviewer-markdown/test/allowRemote.test.ts`（TDD RED）：缺省 undefined → kroki 模式分支与 local 失败降级**仍先落 kroki img**（既有链不变）；`allowRemote: false` → 两分支**直接落源码块**、**零 kroki URL 构造**（断言 `createKrokiUrl` 未被调用 / 无 kroki img 的 `src`）。
  再写 `apps/vscode/test/diagramGate.test.ts`（TDD RED）：**逐类型断言**（遍历 `DIAGRAM_TYPES` 全部 30 类，diagrams.ts:42-73）——闸关时：mermaid/graphviz/nomnoml/math/svgbob 五类 → `'local'`；其余 25 类（17 kroki-only + 8 CDN 引擎族）→ **`'source'`**；闸关时**任何类型都不返回 'kroki'/'official'/'server'**；闸开 + 设置 'off' → 全部 `'source'`；闸开 + 'kroki' → 有 krokiType 者 'kroki'、其余 'source'；`resolveDiagramRenderer` 恒 undefined（**不得选 'hpcc'**——外联渲染器）。
  然后落包内缝（`DiagramRenderOptions.allowRemote?` + pipeline 两分支消费）与 `diagramGate.ts` + `assemble.ts` 接线。
  Run: `pnpm vitest run packages/vviewer-markdown apps/vscode && pnpm run typecheck && pnpm lint` → 全绿；**回归锚**：`pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-md-diagrams-deep b-cdn-diagram-engines` → 两域零翻转（apps/web 不注入 `allowRemote` → 缺省 undefined → 既有降级链逐字节不变；DM-05 effectiveModeOf 回退链、CDN-02/03/04 降级链断言零变动）。
  ```bash
  git add apps/vscode packages/vviewer-markdown && git commit -m "feat(vscode): toc 面板（左右可选/默认收起/折叠态记忆 workspaceState）+ 相对链接与相对图片解析（host 往返）+ 导出 HTML 写盘（选项名对齐 ExportHtmlOptions 真实契约 + resolveImage 图片 data URI 解析 + 自包含 katex 字体）+ 图表外联闸（逐语言 modeOf 映射：闸关仅离线引擎族给 local、其余 source；off→source）+ 包内 additive 缝 DiagramRenderOptions.allowRemote（缺省行为不变，闸关时降级链不经 kroki）"
  ```

---

### Task 6: 设置面 contributes.configuration + 配置/主题变更实时生效 + README

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A/B 组）、`docs/design/semantic-components.md`（核对面）、`docs/design/ui-design-system.md`（零新 token）。

**Files:**
- Modify: `apps/vscode/package.json`（`contributes.configuration` 七项 property 声明——**scope 必须 `language-overridable` 或 `resource`**，RF 9）
- Modify: `apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts`（**补键**——目录本体与 ESLint 覆盖块已在 T2 落地，本任务只加设置相关文案键）
- Modify: `apps/vscode/src/extension.ts`（`onDidChangeConfiguration`（vviewer 作用域过滤）+ `onDidChangeActiveColorTheme` → 向已开 webview postMessage 推送）
- Modify: `apps/vscode/src/webview/main.ts`（接收 settings/theme 推送 → 调 `applyTheme`/重渲染面，不要求重开文件——§7 ④）
- Modify: `apps/vscode/README.md`（设置全表 + per-language 覆盖示例 + 冒烟清单——spec §5 手工冒烟清单原文落此）
- Test: `apps/vscode/test/liveUpdate.test.ts`（配置/主题变更 → 推送路径）

**Interfaces:**
- `contributes.configuration`（七项；缺省值 = spec §4.5 与本计划 Global Constraints 一致）：
  | key | type | enum | default | scope |
  |---|---|---|---|---|
  | `vviewer.toc.side` | string | left/right | right | window |
  | `vviewer.toc.defaultCollapsed` | boolean | — | true | window |
  | `vviewer.code.highlightEngine` | string | tree-sitter/hljs/plain | tree-sitter | **language-overridable** |
  | `vviewer.markdown.diagramMode` | string | local/kroki/off | local | **language-overridable** |
  | `vviewer.diagrams.allowRemoteServices` | boolean | — | false | window |
  | `vviewer.markdown.externalImages` | string | blocked/manual/auto | blocked | window |
  | `vviewer.markdown.externalImageAllowlist` | array\<string\> | — | [] | window |
  **scope 纪律**：per-language 覆盖只对 `language-overridable` 生效——VSCode 原生机制要求（RF 9）；README 示例只示范 `vviewer.code.highlightEngine`（语言相关项）以免给出无效示例。
- 实时生效（§7 ④）：host 侧 `workspace.onDidChangeConfiguration(e => e.affectsConfiguration('vviewer'))` → 重算 `WebviewSettings`（按当前文档 languageId）→ postMessage；`window.onDidChangeActiveColorTheme` → 重算主题令牌 → postMessage；webview 侧：settings 变更 → 影响面重算（引擎档位/图表档位/外链图片档位）——**重渲染当前文档**（重渲染成本 > 增量，MVP 取全量重渲）；theme 变更 → `applyTheme({ mermaidTheme })`（markdown 实例面，markdownRenderer.ts:1051）+ **动态令牌 `<style>` 元素整体替换**（mermaid 重画随之生效）。
- README 冒烟清单（spec §5 原文）：md（图表/math/灯箱/导出 HTML）、py（tree-sitter 高亮 + 大纲）、png/mp4/pdf、主题切换联动、toc 左右/收起、per-language 覆盖、**离线（断网）全功能**——每条给可复制的操作步骤与期望结果（**含样式面验收**：markdown 排版/代码着色/图表/灯箱在断网下均正常）。
- **验收锚 / e2e**：验收 = `apps/vscode/test/liveUpdate.test.ts` 绿 + `apps/vscode/test/i18n.test.ts`（T2 建）零回归 + `pnpm lint` 绿 + `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（扩展面）。

- [ ] **Step 1: 设置声明 + 文案补键**
  写 `liveUpdate.test.ts`（配置变更 → 重算 → 推送（桩 `postMessage` 断言消息 kind 与载荷）；主题变更 → 令牌重算推送；webview 侧收到 settings → 触发重渲染）→ RED；`package.json` 补七项 configuration 声明（scope 按上表）；i18n 双目录补设置相关文案键（zh 先定稿 → en 对译，占位符一致）。Run: `pnpm vitest run apps/vscode` → RED→GREEN。
- [ ] **Step 2: 实时生效链路**
  落 `extension.ts` 订阅与 `main.ts` 消费（settings → 重渲；theme → 令牌 `<style>` 替换 + `applyTheme`）。
- [ ] **Step 3: README + 门禁 + 提交**
  README 落设置全表 + per-language 示例 + 冒烟清单（含样式面与离线项）。Run: `pnpm vitest run apps/vscode && pnpm lint && pnpm run typecheck` → 全绿。
  ```bash
  git add apps/vscode && git commit -m "feat(vscode): 设置面——contributes.configuration 七项（per-language 可覆盖项 scope=language-overridable）+ 配置/主题变更实时生效（不要求重开文件）+ i18n 目录补键 + README 设置表与冒烟清单（含样式与离线项）"
  ```

---

### Task 7: 发布 workflow（ovsx/vsce，只落文件不实跑）+ 全量门禁收尾 + 台账

**Files:**
- Create: `.github/workflows/publish-vscode.yml`（tag `v*` + `workflow_dispatch`；构建 → 体积门 → 双渠道**上传**；**secrets 缺失即跳过上传步**，不实跑）
- Modify: `apps/vscode/package.json`（发布元数据补齐：`repository`/`homepage`/`bugs`/`icon`/`license`/`galleryBanner`）
- Modify: `docs/superpowers/plans/2026-11-14-spec-H-vscode-extension.md`（Errata 记实施期勘误）

**Interfaces:**
- workflow 形态（约束④ + 裁量 8）：
  ```yaml
  name: Publish VSCode Extension
  on:
    push: { tags: ['v*'] }
    workflow_dispatch:
  jobs:
    build:
      # checkout → pnpm → setup-grammars(languages: lite) → pnpm --filter @bhxch/vviewer-vscode build
      # → 体积门（check-size.mjs，.vsix <100MB fail-fast）→ 上传 artifact
    publish-openvsx:
      needs: build
      if: ${{ secrets.OVSX_PAT != '' }}     # 无 secrets → 跳过（不实跑）
      # ovsx publish --pat …
    publish-marketplace:
      needs: build
      if: ${{ secrets.VSCE_PAT != '' }}     # 无 secrets → 跳过（不实跑）
      # vsce publish --pat … --no-dependencies
  ```
  **纪律**：①**上传**步以 `secrets` 存在性为守卫——本仓无 secrets，job 恒跳过（workflow 文件落库即止）；**本地 `vsce package` 体积门在 T1/T7 实跑，不受此守卫影响**；②版本号来源 = tag（`v*` 去前缀）；③双渠道任一失败须可见（不设 `continue-on-error`）；④**不得把发布写权限授予 build job**（`contents: read` 兜底）。CI 验证边界：workflow YAML 只能本地静态自查（YAML 解析 + 步序走查），真跑须用户配 secrets 后手动触发（台账①）。
- **build job 的构建前置（评审订正② + 本轮 Rust 工具链补项）**：`setup-grammars`（lite，34 语言）→ **Rust 工具链两步**（`dtolnay/rust-toolchain@stable` + `targets: wasm32-unknown-unknown`；`Swinatinem/rust-cache@v2` 缓存 `packages/vviewer-render-diagram/tools/svgbob-wasm`——**缺任一即 `pnpm gen:svgbob-wasm` 失败 → build job 红**，ci.yml:155-163 同款两步）→ **`pnpm gen:svgbob-wasm`**（缺则扩展构建走 T1 的**条件桩**——svgbob 围栏降级链含 kroki 外联一跳，见 Global Constraints「svgbob glue 的构建前置」条）→ `pnpm --filter @bhxch/vviewer-vscode build`（含 `vsce package` 体积门 + `.vsix` 产出）→ 上传 artifact（`.vsix` + `dist/`）供两个上传 job 消费。**发布链取完整 svgbob 能力**（非桩）。
- 发布元数据：`publisher: "bhxch"`、`displayName`、`description`、`repository`（仓 URL）、`license: "Apache-2.0"`、`icon: "media/icon.png"`（**icon 事实订正⑥·本轮**：vsce 4.1.1 **缺 `icon` 字段不报错**（package.js:857 仅在有 icon 时处理）；**指定了 `icon` 而文件不在包内才报错**（package.js:870-871 `The specified icon '...' wasn't found in the extension.`）；**SVG 图标被禁**（package.js:1046-1047）→ 填 `icon` 就必须把 PNG 复制进 VSIX 打包根 `dist/`（T1 的复制清单已含 `icon.png`））、`categories`、`keywords`、`galleryBanner`（可选）。

- [ ] **Step 1: 发布 workflow + 发布元数据**
  落 `publish-vscode.yml`（按上 Interface）+ `package.json` 发布字段；本地静态自查：YAML 可解析（`python3 -c "import yaml;yaml.safe_load(open('.github/workflows/publish-vscode.yml'))"`）+ 步序/权限走查（build job `contents: read`；两上传 job 以 secrets 守卫跳过）。**不实跑上传**。
- [ ] **Step 2: 全量门禁（控制器执行）——含五项必要前置**
  **前置（缺任一即大面积 skip → 「零翻转」成假绿；逐项产出并校验存在）**：
  1. `node tools/grammar-builder/gen-sources.mjs` + `node tools/grammar-builder/build.mjs --fetch --lite` + `node tools/grammar-builder/build.mjs --self-build`（grammar 资产；**扩展构建与 e2e 共同依赖**）
  2. `pnpm gen:svgbob-wasm`（svgbob wasm 引擎产物；缺则图表相关用例 skip——ci.yml e2e-prep 同款必做步；**扩展构建侧另有条件桩兜底**——本前置是 e2e 侧的必做步）
  3. `node tools/fetch-e2e-corpus.mjs`（多源渲染语料，不入库；缺则 corpus 域用例 skip）
  4. `uv run tools/gen-e2e-pdf-linearized.py`（PDF 夹具；缺则 PDF-RANGE-01/02/03/05/06/07 skip——`existsSync` 守卫）
  5. **`cargo build --release --manifest-path server/Cargo.toml`**（server 档 e2e 的 webServer 直执行 `server/target/release/vviewer`——`apps/web/playwright.server.config.ts:22/:33`；**必须 `--release`**——dev profile 产 `server/target/debug/vviewer`，仓内无 `.cargo/config.toml` 故无 profile 重定向；`apps/web/e2e-server/fixtures.mjs:18-19` 的 fail-fast 提示原文即「请先执行: cargo build --release --manifest-path …」；等价写法 `pnpm build:all`（package.json:14）——缺 release 二进制则 server 档整组无法起服）
  门禁序列：`pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量——扩展用例已由 vitest include 纳入）→ `pnpm --filter web build:e2e`（产出 `apps/web/build`，server 档 webServer 的 WEB_DIST 依赖它）→ `pnpm --filter web exec playwright test`（全量双 project）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档；**零翻转 = 本计划零 server/ 改动的一致性兑现**）→ `pnpm --filter @bhxch/vviewer-vscode build`（体积门：`.vsix` <100MB + 无未解析 import）→ `git status --porcelain` 净空。
  **skip 计数纪律**：全量 playwright 输出的 **skip 数须与基线一致**（或逐条列出差异并说明）——**skip 不是「零翻转」证据**（前置缺件时用例整组 skip，表面全绿实则未跑）；报告须同时给出 passed/failed/skipped 三元计数。
- [ ] **Step 3: review + 台账汇总**
  全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。台账汇总（实施期记档项随任务报告归集）：①**上传发布 deferred**——OVSX_PAT/VSCE_PAT 由用户在仓外配置，workflow 已落文件但未实跑（约束④；**本地 vsce package 体积门已实跑**）；②**VSCode 活动主题 JSON 精确注入列为增强**（spec §4.2 裁量 4，highlight 包已备件）；③**扩展真机行为无自动化门**——custom editor 接管/CSP 生效/worker 起活/**样式生效**靠 README 冒烟清单人工验收（spec §5 定 e2e 非门禁）；④**大文件字节通道内存翻倍**——postMessage 的 `Uint8Array` 为结构化克隆拷贝，>32MB 文件在 host 与 webview 各存一份（阈值化临时文件通道列为后续优化）；⑤**katex 导出 CSS 双实现**——扩展构建期自实现 data URI 内联（与 apps/web `katexExportCss.ts` 同源不同实现），两侧需随 katex 版本同步核对；⑥**扩展名清单依赖生成物**——`generated-extensions.ts` 不入库，扩展构建前须跑 `pnpm gen:sources`（缺件 fail-fast 已落）；⑦**扩展图标**——填 `icon` 即必须把 PNG 复制进 VSIX 打包根（vsce 缺 icon 不报错、填了缺文件才报错，package.js:857/:870-871）；若需新生成则记形态与体积；⑧**svgbob glue 条件桩**——未跑 `pnpm gen:svgbob-wasm` 时扩展构建走桩 → 运行期 svgbob 围栏**引擎失败 → kroki 外联图（appendKrokiImg，外部请求）→ img 加载失败才错误卡 + 源码同展**（pipeline.ts:536-549 → :425-447）；**外联闸关时（allowRemote=false）由包内 allowRemote 缝直接落源码块，不经 kroki**；发布链跑 `pnpm gen:svgbob-wasm` 取完整能力——**本地开发若长期只跑桩，svgbob 围栏能力与 web 端不一致，记档**。

## Errata（执行期勘误）

- 2026-11-18 **实施期勘误（T1~T6 落地实测，11 条）**：以下为按本计划实施时的实际形态与计划书的差异，逐条登记（不改计划语义，只记落地事实）：
  ①**i18n 键段数**：本计划 Interfaces 段写「key 三段 `{域}.{模块}.{语义}`」，但同段示例键 `viewer.tooLarge` 是**两段**。落地按**规范条款**（三段，且 frontend-conventions §3.1 同款）执行 → `viewer.document.tooLarge`；扩展自有四域（shell/viewer/notice/errors）不变。
  ②**`AssetUris` 增两项**：T2 定义的字段清单缺 `themesUrl`（webview 侧算 `--vv-ts-*` 需读打包的两条主题表）与 `katexExportCssUrl`（导出用的自包含 katex CSS 产物）——T4/T5 落地时补入（additive）。
  ③**协议增两个 kind**：`WebviewToHost` 增 `'navigate'`（spec §7 ① 的相对链接导航需宿主切文档，宿主侧落 `PanelHost.handleNavigate`）；`HostToWebview` 增 `'export-request'`（导出触发面——计划未指定触发入口，落地为宿主命令 `vviewer.exportHtml` → 该消息 → webview 组装 → 宿主写盘）。
  ④**两个包各增一个 exports 子路径**：`@bhxch/vviewer-markdown` 增 `'./css'`、`@bhxch/vviewer-highlight` 增 `'./theme'`——宿主侧只需 CSS 字符串常量与主题换算函数，走**包根**导入会把整包（dompurify/highlight.js/katex/mermaid… 与 web-tree-sitter）拖进 host bundle（实测 769KB，且 web-tree-sitter 的 node 分支动态 import 在 node 平台 bundle 里是 external 记录 → 触「产物无未解析 import」门）。
  ⑤**壳布局**：T1 落 `.vv-shell` 为横向 flex（内容区 + toc 面板）；T5 的顶部提示条需整宽置顶且不随内容滚动 → 改为 `.vv-shell` 纵向（提示条 + 主体行）+ 新增 `.vv-shell__body` 主体行容器（类名契约已同步进 `shellCss.ts` 与其单测）。
  ⑥**包内 `allowRemote` 缝的三个落点**（计划只写「kroki 模式分支与 local 失败降级」两处）：落地为①外联分支（kroki/official/server）的**早切**（mode → 'source'，wrapper 按 source 模式构造——无 toggle 钮）；②local 引擎失败的降级分支；③抽出 `showSourceBlock` 助手复用 source 模式语义（两处共用）。缺省 `undefined` 时三处均不触发 → 既有行为逐字节不变。
  ⑦**实时生效链路抽两个模块**（计划未列，为可测性）：webview 侧消费面 `webview/liveUpdate.ts`（`main.ts` 顶层 `acquireVsCodeApi()` 在 vitest 下不可 import）；宿主侧订阅面 `PanelHost.watchChanges()`（`extension.ts` 的静态 `import * as vscode` 同理不可测）。
  ⑧**katex 导出 CSS 为构建期产物**：`scripts/collect-assets.mjs` 的 `buildKatexExportCss`（woff2 → data URI 内联 + woff/ttf 回退段移除；368894 B）——与 apps/web 的 `katexExportCss.ts` 同形态不同实现（台账⑤）。
  ⑨**`assets.test.ts` 等单测的源码路径解析**：vitest 下 `new URL(rel, import.meta.url)` 被 vite 改写成 dev-server URL（`fileURLToPath` 即抛错）→ 按仓内先例单独求值 `import.meta.url` 取目录（`packages/vviewer-render-diagram/src/markdown/diagramEngines.test.ts` 同款）。
  ⑩**扩展面 ESLint 覆盖块与 CSS 载荷的冲突**：块 C 的 `cjkTemplateElement` 会命中 `SHELL_CSS` 模板串内的中文注释 → CSS 内注释改 ASCII 段落标记（中文说明留在 TS 注释面；不加 ignores 豁免）。
  ⑪**「逐类型断言」的注册表实况**：`DIAGRAM_TYPES` 30 类 = 离线引擎族 **5**（mermaid/graphviz/nomnoml/math/svgbob）+ kroki-only **17** + CDN 引擎族 **8**（excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/dbml/d2）——与计划 §「图表外联闸的落点」的「17 + 8」一致，离线族为 5 类。

- 2026-11-18 计划评审**第三轮**修订（7 条意见，逐条内联落定；基线由 `9e4ef1c` 前进至 `3210bd6`，源码面等价）：**本轮全部结论为源码级核对（实读仓内源码 + 本地已解包的 vsce 4.1.1 源码；未实跑 vsce package / esbuild 扩展构建 / playwright——apps/vscode 尚不存在，均属实现期动作）**：
  ①【高·构建门必红】**svgbob 条件桩的拦截路径拼写错误**——计划三处把真实路径写成 `svgbob-wasm-gen/svbob_wasm.js`（**少一个 g**）且行号误记 `:64`；实查 `packages/vviewer-render-diagram/src/markdown/diagramEngines.ts:63` 为 `import('./svgbob-wasm-gen/svgbob_wasm.js')`。照字面实现的 onResolve 过滤器**匹配不到真实 import → 桩不生效 → 新 checkout 仍以「Could not resolve」失败**（而本仓已有生成产物，机器上仍侥幸通过＝假绿）。**落定**：三处路径与行号订正为 `svgbob-wasm-gen/svgbob_wasm.js` 与 `:63`，并在 T1 的桩描述里写明「onResolve 过滤器路径逐字照抄真实 import」。
  ②【高·约束落空】**「allowRemoteServices 外联闸」在包内无落点，且包内降级链会把 local 升格为 kroki**——实查：`DiagramRenderOptions`（markdownRenderer.ts:197-238）**无任何 remote/offline 开关**；`effectiveModeOf`（pipeline.ts:201-220）语义为「requested==='local' → `type.local && type.engine` 否则 `type.krokiType ? 'kroki' : 'source'`」→ 对 **17 个 `local:false` 但有 krokiType 的类型**（plantuml/c4plantuml/ditaa/blockdiag/nwdiag/actdiag/seqdiag/erd/pikchr/packetdiag/rackdiag/goat/wireviz/structurizr/symbolator/tikz/umlet，diagrams.ts:42-50/:66-73）请求 'local' 仍被**升格为 kroki 外联**；`modeOf` 返回 'local' 的 **CDN 引擎族**（excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/dbml/d2，diagrams.ts:52-64）经 `renderDiagramEngine` → `cdnEngines.ts:5` 的 `CDN_DEFAULT='https://cdn.jsdelivr.net/npm'` **外联 jsdelivr**（`cdnEnginesHost` 只能换 host、不能禁用）；`DiagramMode`（diagrams.ts:7）**无 'off'**。**落定**：Global Constraints 新增「图表外联闸的落点」条（三条外联路径逐条封堵）+ **T5 增包内 additive 缝 `DiagramRenderOptions.allowRemote?: boolean`**（markdownRenderer.ts 增字段 + pipeline.ts 两分支消费：kroki 模式分支 :500-502、local 失败降级 :536-549 在 `allowRemote === false` 时直接落源码块；缺省 undefined = 现有行为逐字节不变、apps/web 零改动）+ **T5 增逐语言 `modeOf` 映射**（`diagramGate.ts` 纯函数：闸关时仅离线引擎集 mermaid/graphviz/nomnoml/math/svgbob 给 'local'，其余 25 类给 'source'；**'off' → 'source'**；`rendererOf` 恒 undefined 禁 'hpcc' 外联渲染器）；**T5 Step 3 的单测从「local 恒本地」改为逐类型断言**（遍历 `DIAGRAM_TYPES` 30 类，闸关下不产生任何 kroki/CDN 请求面）。
  ③【中·语义错】**svgbob 桩的降级行为描述错**——实查 pipeline.ts:536-549 的 catch 是「`type.krokiType` → `appendKrokiImg()`（pipeline.ts:425-447，kroki URL 的 `<img src>`，**外部请求**）→ 该 img 加载失败才错误卡 + 源码同展」，而 svgbob 的 `krokiType='svgbob'`（diagrams.ts:51）非空 → **先回落 kroki 外联图，不是直接回落源码块**。**落定**：三处「回落源码块」描述改为「引擎失败 → kroki 外联图 →（img 加载失败）错误卡 + 源码同展」，并把该外联一跳纳入外联闸口径（闸关时由 `allowRemote` 缝直接落源码块）。
  ④【中·计划内自相矛盾】**T1 Step 1 仍要求建 `.vscodeignore`**（与订正⑥「不建源侧」冲突）。**落定**：Step 1 建文件清单去掉 `.vscodeignore`、**补 `media/icon.png`**（T1 构建断言⑤依赖它，此前只在 Files 列表出现）。
  ⑤【低·口径漂移】**T3 commit 文案仍写「九注入缝」**（与任务标题「十一处 setter 接线」及缝表 11 项不符）→ 提交信息会被实现者逐字采用。**落定**：T3 commit 文案改为「十一处 setter 逐一接线：九渲染/文案缝 + pdf/hex worker URL provider + singleFile store」；**Errata ③ 的接线示例同步改为双 URL 按能力选支形态**（`preferModernBuild() ? assets.pdfWorkerModernUrl : assets.pdfWorkerLegacyUrl`）。
  ⑥【低·CI 前置缺项】**发布 workflow 的 build job 未列 Rust 工具链前置**——`pnpm gen:svgbob-wasm` 需 wasm32 target + wasm-bindgen CLI（ci.yml:155-163 的 `dtolnay/rust-toolchain` + `Swinatinem/rust-cache` 两步），缺任一即该步失败 → build job 红。**落定**：T7 的 build job 前置补齐这两步。
  ⑦【低·字段悬空】**`AssetUris.workerUrl` 无消费面且与 `highlightWorkerSourceUrl` 疑似重复**。**落定**：**删除该字段**（三个 worker 各有专名：`highlightWorkerSourceUrl`/`binaryWorkerUrl`/`pdfWorkerModernUrl`+`pdfWorkerLegacyUrl`），并在字段清单处注明专名对应关系。

- 2026-11-18 计划评审**第二轮**修订（9 条意见，逐条内联落定；基线由 `61d2e17` 前进至 `9e4ef1c`（上轮修订 commit），源码面等价）：**本轮的 vsce 结论均为「源码级核对」——只读检视 npm 包 `@vscode/vsce@4.1.1` 的 `out/validation.js` 与 `out/package.js`（未执行其代码；未实跑 `vsce package`，因 apps/vscode 尚不存在）**：
  ①【高·构建门必红】**VSIX manifest 与计划字段不兼容（三处硬校验）**——`validateManifestForPackaging`（package.js:1001-1044，由 `readManifest(...).then(validateManifestForPackaging)` package.js:1120 进入）：`name` 须匹配 `/^[a-z0-9][a-z0-9\-]*$/i`（validation.js:45）→ 拒 `@bhxch/vviewer-vscode`（`Invalid extension "name"`，validation.js:55-61）；`version` 必填且合法 semver（validation.js:64-70）→ 计划字段清单**未列 version**；`engines.vscode` 与 `devDependencies['@types/vscode']` 按 major.minor 比大小（package.js:1043-1044 / validation.js:100-137）→ `^1.90.0` 配未钉版的 `@types/vscode`（取最新版 1.1xx）即抛「greater than engines.vscode 1.90.0」。**落定**：**源 manifest（workspace 名 `@bhxch/vviewer-vscode`，带 scope）与 VSIX manifest 解耦**——构建产物 `dist/package.json` 重写 `name: "vviewer-vscode"`（无 scope）+ `publisher: "bhxch"`（marketplace 标识 `bhxch.vviewer-vscode`）+ `version` 透传 + `main: "./extension.js"`；源 manifest 补 `version`；devDep 钉 `@types/vscode: "~1.90.0"`。另记：`contributes.customEditors` 必留（vsce 的隐式激活事件来源，package.js:1014-1021；engines ≥1.74 下与 `main` 组合合法，package.js:1012-1041）。
  ②【高·构建门必红】**扩展构建缺 `pnpm gen:svgbob-wasm` 前置**——`packages/vviewer-markdown/src/pipeline.ts:20` 静态 import `@bhxch/vviewer-render-diagram` 的 `renderDiagramEngine`，其实现 `packages/vviewer-render-diagram/src/markdown/diagramEngines.ts:63` 为 `import('./svgbob-wasm-gen/svgbob_wasm.js')`，该生成目录不入库（.gitignore:56-57）→ esbuild 须静态解析该 dynamic import，**新 checkout 必构建失败**（本仓因已有生成产物而侥幸通过＝假绿）。**落定**：T1 构建脚本加 **svgbob 条件桩插件**（**onResolve 过滤器路径逐字照抄真实 import `svgbob-wasm-gen/svgbob_wasm.js`**——初版写成 `svbob_wasm.js`（少一个 g）且行号误记 :64，桩将不命中、构建仍以「Could not resolve」失败）；文件在 → 正常打包；不在 → 桩模块 `default()` 抛错 → 运行期 svgbob 围栏**先降级 kroki 外联图**（pipeline.ts:536-549 → appendKrokiImg，pipeline.ts:425-447）、img 再失败才错误卡 + 源码同展（**降级链描述订正：非直接回落源码块**；闸关时由 T5 的 allowRemote 缝直接落源码块）；扩展构建因此**不强制 Rust 工具链**，CI 发布 workflow 另跑 `pnpm gen:svgbob-wasm`（ci.yml:160 同款）取完整能力——「桩态下 svgbob 围栏降级链含 kroki 外联一跳」记台账⑧。
  ③【高·主功能断链】**两个 worker URL 注入缝无任何调用点**（grep 证实只有定义/改动行）→ 不注入即 pdf 渲染死（pdf.ts:128-132 在 webview chunk URL 下 404 → pdfjs 无 workerSrc）与 hex 挂死（hex.ts:805 的 try/catch 只兜同步抛错，404 是异步事件 → worker 永不应答）。**落定**：T3 装配层接线 `setPdfWorkerUrlProvider(() => preferModernBuild() ? assets.pdfWorkerModernUrl : assets.pdfWorkerLegacyUrl)`（**双 URL 按能力选支**——选支在 webview 侧，host 不引 pdfjs）与 `setHexWorkerUrlProvider(() => assets.binaryWorkerUrl)`；缝计数口径由「9」改为 **11 处 setter**（9 渲染/文案缝 + 2 worker provider），T3 验收锚逐一断言 11 项。
  ④【中高·门禁红】**T7 前置 #5 的 cargo profile 写错**——dev profile 产 `server/target/debug/vviewer`，而 `apps/web/playwright.server.config.ts:22` 的 BIN 是 `server/target/release/vviewer`（仓内无 `.cargo/config.toml` 故无 profile 重定向；`apps/web/e2e-server/fixtures.mjs:18-19` 的 fail-fast 提示原文即 `cargo build --release --manifest-path …`）。**落定**：改为 **`cargo build --release --manifest-path server/Cargo.toml`**（等价 `pnpm build:all`，package.json:14）。
  ⑤【中】**icon 事实判断错 + 未列入复制清单**——vsce 4.1.1：**缺 `icon` 字段不报错**（package.js:857 仅在有 icon 时处理）；**指定了 icon 而文件不在包内才报错**（package.js:870-871）；**SVG 被禁**（package.js:1046-1047）。**落定**：事实更正写入 T7 发布元数据条；`icon.png` 进 T1 的 dist 复制清单（源 `apps/vscode/media/icon.png` → 复制为 `dist/media/icon.png`，两处 manifest 的 `icon` 字段统一为 `"media/icon.png"`）；台账⑦改写。
  ⑥【中】**`.vscodeignore` 位置错**——vsce 从**包根**（= `dist/`）读该文件，放源侧 `apps/vscode/.vscodeignore` 即死资产且排除规则不生效。**落定**：**不建源侧 `.vscodeignore`**；改由 `build.mjs` 写 `dist/.vscodeignore`（内容针对 dist 产物，如 `**/*.map`）。
  ⑦【低】**legacy pdf worker 无消费面**——`AssetUris` 只有一个 `pdfWorkerUrl`、seam 只返回单值 → 未定义注入哪一支。**落定**：注入策略 = **按能力选支**——复用包内导出的 `preferModernBuild()`（render-doc/src/pdf.ts:96，包 `exports["."]` = `src/pdf.ts`）→ modern/legacy 两文件**都有消费面**，无死重，也不绕开 pdf.ts 的能力分支；体积门说明含两支合计 ~2.6MiB。
  ⑧【低】**`webviewHtml.test.ts` 需要 vscode-free 模块**——`webviewPanel.ts` 必然 `import * as vscode from 'vscode'`（运行时无此模块），若 HTML 模板函数与其同文件则 vitest 直解析即红。**落定**：HTML 模板函数拆到 **`apps/vscode/src/host/webviewHtml.ts`（零 vscode 依赖）**，入参 = `{ cspSource, nonce, scriptUri, styleText }`，单测直测该纯模块（与 `settings.ts`/`protocol.ts` 同款「纯 .ts」纪律）。
  ⑨【低】**`setHighlightFence` 在 T3/T4 重复注入**（与计划自订「缝一次性注入」相抵）。**落定**：**T3 装配层统一注入 11 处 setter**；T4 只做 client 适配与 `attachHighlightClient`，**不重复注入围栏桥**（T4 的 Files/Step 2 描述同步）。

- 2026-11-18 计划评审修订（10 条意见，逐条内联落定；基线由 `eed783c` 前进至 `61d2e17`（本文件初版 docs commit），源码面等价）：
  ①【高·主功能缺失】**样式供给面缺失**——初版把 `MARKDOWN_CSS` 只当「token 契约」，并在 Errata 写下「扩展零 CSS 构建处理」，推论错误（无 CSS 构建步骤 ≠ 无需 CSS）。事实：`createMarkdownView` 自身不注入样式（markdownRenderer.ts:958-961 明写「CSS 由消费方引入 markdown.css（或 MARKDOWN_CSS 常量注入 <style>）」；963-1050 无 style 注入），apps/web 侧供给面是 `app.css:7` 的 `@import`。**落定**：Global Constraints 新增「样式供给面」硬约束 + T1 落 `SHELL_CSS` 常量 + **T2 落样式内联**（`MARKDOWN_CSS` + `SHELL_CSS` 合成为一个 `<style nonce>`，单测断言含 `.vv-markdown`/`.ts-keyword`/`.md-lightbox` 与壳类名）；T3 落动态令牌 `<style>` 替换面与 katex CSS 自备注入面。
  ②【高·CSP 致命缺项】**CSP 缺 `script-src` 的 cspSource 与 `media-src`**——初版块：`script-src 'nonce-x' 'wasm-unsafe-eval'`（缺 `${webview.cspSource}` → 外链 ESM 入口与 dynamic chunk 全被拦 → 白屏）、全块无 `media-src`（`default-src 'none'` 下回落 → `<audio>`/`<video>` 被拦 → av 渲染器主功能死）。**落定**：CSP 扩为**七 directive**（`script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`；新增 `media-src ${webview.cspSource} blob: data:`）；T2 的 `webviewHtml.test.ts` 断言 **`cspSource` 出现在 `script-src` 与 `media-src`**（评审订正②的回归锚）。
  ③【高·资产无来源】**pdf worker 无来源**——初版声明了 `pdfWorkerUrl` 却在 T1 采集契约与 dist 布局中都没有该文件（esbuild 不做 vite 的裸说明符资产化——pdf.ts:124-127 注释明说该能力是 vite 特有）。**落定**：T1 采集契约增 **pdfjs worker modern + legacy 两文件**（各 ~1.3MB，落 `dist/webview/pdf/`）、dist 布局补该目录、T1 Step 4 构建断言锁两文件存在且非空。
  ④【高·webview 必需选项缺失】**`enableScripts` 与 `localResourceRoots` 未定义**（不开则脚本不执行 → 白屏；资源不在 roots 内则 asWebviewUri 资源 404，且在无 console 回传的 webview 里近乎静默）。**落定**：T2 接口补 `enableScripts: true` + `localResourceRoots: [Uri.joinPath(extensionUri, 'dist')]`，单测断言二者。
  ⑤【中高·门禁必红】**i18n 目录与 ESLint 覆盖块引入时机倒置**（T2 已有中文文案，T6 才立目录与覆盖块 → `pnpm lint` 必红：catalog 本体 CJK 无 ignores 豁免 + T2/T3/T5 裸 CJK 字面量）。**落定**：扩展 i18n 目录 + `core.ts` + ESLint 覆盖块**前置到 T2**（首个用户可见文案之前），覆盖块 `ignores: ['apps/vscode/src/i18n/**', 'apps/vscode/src/**/*.test.ts']`（catalog 本体豁免，同 apps/web 块 A 的 ignores 口径，eslint.config.js:243），T2/T3/T5 文案一律走目录；T6 改为「补键」。
  ⑥【中·门禁前置缺失】**T7 全量门禁缺四项必要前置**（e2e-prep job 在 ci.yml:160-200 逐项列出）：`node tools/fetch-e2e-corpus.mjs`（语料）、`uv run tools/gen-e2e-pdf-linearized.py`（PDF 夹具）、`pnpm gen:svgbob-wasm`、`cargo build --manifest-path server/Cargo.toml`（server 档 webServer 直执行 `server/target/release/vviewer`——playwright.server.config.ts:22/:33）。**落定**：T7 Step 2 补齐五项前置（含 grammar 资产链）+ **skip 计数纪律**（skip 不是零翻转证据，报告须给 passed/failed/skipped 三元计数）。
  ⑦【中·spec 验收锚漏承接】**「esbuild 产物无未解析 import」与「vsce package 体积 <100MB」两条 spec §5 锚无承接**（且初版诚实边界②称「vsce 体积门可实跑」但无任务实跑、devDep 未声明 vsce；`dist/package.json` 的 `main` 未重写即 404；VSIX 组装步未定义）。**落定**：T1 增 `check-unresolved-imports.mjs`（metafile 扫描）+ devDep 声明 `@vscode/vsce`/`ovsx` + **实跑 `vsce package` 并断言 `.vsix` 字节 <100MB**（`dist/` 递归字节为预检）+ `dist/package.json` 的 `main` 重写为 `./extension.js` + **VSIX 组装步**（cwd = `dist/`，README/LICENSE/CHANGELOG 复制进包根）；诚实边界②改写为「**上传** deferred，本地打包体积门在 T1/T7 实跑」。
  ⑧【中·接口签名错】**导出接口签名与真实 API 不符**（初版写 `collectExportHtml(doc, { inlineCss, katexCss })`；真实 `ExportHtmlOptions`（export.ts:84-105）为 `{ title(必填), styleCss(必填), katexCss?, resolveImage(必填) }`）。**落定**：T5 修正选项名并补齐三个必填项；**`resolveImage` 落为 T5 的明确实现项**（扩展侧 `resolveExportImage`，语义对齐 `apps/web/src/lib/markdownExport.ts:27`：data: 保留 / 外域保留 / blob 与同源 http 成功转 base64 data URI / 非 image 类型与 fetch 失败保留），单测六态。
  ⑨【低·偏离未登记】**webview 壳的「状态行」与 spec §4.2「无 FileTree/TabBar/状态栏」冲突**。**落定（消解而非登记）**：可见反馈面改为**内容区顶部提示条（inline banner，`role="status"`）+ toc 面板头部徽标**，**不引入状态栏**——spec §4.2 的「无状态栏」得以保持，同时满足 RF 3 的可见失败面要求（Global Constraints 新增该条；T3/T4/T5 的相关描述同步）。
  ⑩【低·事实偏差 + 计数不一致】**①ESLint 现状描述更正**：CJK 三形态**只挂块 A**（eslint.config.js:242 files `apps/web/src/lib/**`、:243 ignores i18n 与 `*.test.ts`），块 A2（:266）只挂 bareIntl、块 B（:277）只挂 bareIntl + runesOptOut → **CJK 三形态当前只覆盖 `apps/web/src/lib/**`，非 `apps/web` 全域**；扩展面当前零覆盖。**②注入缝计数更正为 9**：markdown 组合包 7 个（markdownRenderer.ts:64/98/119/141/166/180/240）+ sanitize 包 1 个（sanitize.ts:99 `setExternalImagePolicyProvider`）+ core 包 1 个（dispatch/errors.ts:44 `setRenderFailedText`）——初版「8 个缝」与分组标注均不准；T3 单测改为**逐一断言全部 9 个**。
- 2026-11-18 初版（规划师 H 基于 HEAD `eed783c` 编写；规划期关键实查已内联：packages 零 `$app`/`import.meta.env` 依赖（`rg` 零命中）｜`apps/web/src/lib/viewer.ts` 357 行装配单点与其 `$app`/i18n/store 依赖面、渲染器认领面与装序（viewer.ts:143-156）｜`@bhxch/vviewer-markdown` 导出面（index.ts:73 `MARKDOWN_CSS`、:8-102 整体）与 `createMarkdownView`（markdownRenderer.ts:963）/`extractToc`（:381）/`applyTheme`（:1051）｜**markdownRenderer.ts:958-961「CSS 由消费方引入」+ css.ts:216 `MARKDOWN_CSS` + app.css:7 `@import`**｜highlight 包 `serveWorker`（worker.ts:109）/`HighlightClient` 握手与 15s 看门狗（client.ts:25）/`GrammarTable`（core-parse.ts:20）/`Parser.init` locateFile（:210）/`Language.load`（:417）/queries fetch（:484）｜web 端 worker 与 init 配置形态（highlightClient.ts:414-424）｜pdf worker 裸说明符与 vite 专有资产化注释（render-doc/src/pdf.ts:124-132）｜hex worker `new URL('./binary.worker.ts', import.meta.url)`（render-binary/src/hex.ts:805）｜katex CSS 动态 import（vviewer-markdown/src/pipeline.ts:643）与导出面真实选项（export.ts:84-105/:226）｜`resolveExportImage` 语义先例（apps/web/src/lib/markdownExport.ts:27、MetaPanel.svelte:177-190）｜`EXTERNAL_IMAGE_POLICIES` 三档（vviewer-sanitize/src/sanitize.ts:55）｜`setRenderFailedText`（vviewer-core/src/dispatch/errors.ts:44）｜注册表 `installFallbackExtensions` 装序铁律（vviewer-core/src/registry/registry.ts）｜大小阈值（render-text/src/code/strategy.ts:89-94）｜lite grammar 集 34 wasm/46.4MiB + runtime 204KB（apps/web/static/grammars、tree-sitter.wasm）｜queries 341 语言 5.0MB（assets/queries）｜themes.json 214 键含 onelight/serika-dark｜pdfjs worker 双文件各 1.3MB（pdfjs-dist build/ 与 legacy/build/）｜生成物出库面与 grammar 构建链（.gitignore、build.mjs:40/:347-348、gen-sources.mjs 五产物、.github/actions/setup-grammars）｜vitest include 四项不含 apps/vscode（vitest.config.ts:4）｜根 typecheck 形态（package.json）与 pnpm workspace `apps/*`（pnpm-workspace.yaml）｜ESLint 块作用域（eslint.config.js:242/:243/:266/:277）｜e2e 前置四项与 server 档二进制（ci.yml:160-200、apps/web/playwright.server.config.ts:22/:33）｜非发布型 workflow 先例（desktop-build-probe.yml）｜pack-packages 显式清单不含扩展（tools/pack-packages.mjs:53））。规划期零 deferred 待决项：spec §6 六项裁量全部内联落定于 Global Constraints；spec §7 五条落定全部承接；约束①~⑥逐条落定于 Global Constraints 与各 Task。
