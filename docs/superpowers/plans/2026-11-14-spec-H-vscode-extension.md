# VSCode 扩展（webview 只读渲染）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vviewer 的核心渲染器搬进 VSCode 扩展（spec H）：打开受支持文件即由 custom editor（viewType `vviewer.viewer`）在 webview 内直接渲染——markdown 全效果（管线/图表/katex/灯箱/导出 HTML）+ code（tree-sitter 离线高亮 + 大纲）+ 图片/音视频/PDF/HTML/JSONL/hex 基础渲染器；无目录树、无 tab 条；toc 面板默认收起、位置可选左右；设置走 `contributes.configuration` 且支持 VSCode 原生 per-language 覆盖；运行时**零外网 CDN 依赖**（grammar wasm/queries/tree-sitter runtime/katex 字体全部打进扩展本地资源，经 `asWebviewUri` 映射）；打包体积门 <100MB（lite grammar 集实测 46.4MiB）。

**Architecture:** 新增独立 workspace 包 `apps/vscode`（`@bhxch/vviewer-vscode`，非私有发布包）——extension host 侧（esbuild → CommonJS，外部 `vscode`）+ webview 侧（esbuild → ESM + code splitting）双 bundle，另出两个自包含 worker bundle（tree-sitter 高亮 worker / hex 解析 worker）；host↔webview 走 `postMessage` 协议（文件字节 / 设置 / 主题 / 相对文件读取 / 导出写盘）；webview 内装配方是 `apps/web/src/lib/viewer.ts`（357 行装配单点）的**无 app 依赖重写**——渲染器与注入缝直接消费 `packages/vviewer-*`（packages 零 `$app`/`import.meta.env`/IndexedDB/i18n 依赖，实查零命中），host 侧只做「读文件 + 发设置 + 收写盘请求」；grammar/queries/runtime 走构建期资产脚本从 `apps/web/static/grammars`（lite 集 34 语言）与 `packages/vviewer-highlight/assets/queries` 采集入 `dist/webview/assets/`，运行期经 `webview.asWebviewUri` 映射。

**Tech Stack:** TypeScript（ES2022 + bundler 解析）+ esbuild（host CJS / webview ESM splitting / worker IIFE）+ VSCode Extension API（`@types/vscode`）+ vitest（仓库根 jsdom，include 需扩 `apps/vscode/**`）+ Conventional Commits。**零 `.svelte`**：webview 壳为原生 TS DOM（裁量，见 Global Constraints）。

**Spec:** `docs/superpowers/specs/2026-11-12-vscode-extension-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 目标/非目标/反目标、§4 设计、§5 验收锚点、§6 留给 builder 的裁量、§7 builder check 订正与落定同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `eed783c`（main；工作树 clean）。spec A/B/C/D/E/F/G/I 已全部落地（7 个 spec 的 commit 均在 HEAD）；**spec H 此前零落地**——实查 `rg "vviewer-vscode" .`（排除 node_modules）零命中，`apps/` 下仅 `desktop/`（Tauri 薄壳）与 `web/`（SvelteKit）两个目录，无 `apps/vscode`。本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7，**严格串行**。理由：T1 的 workspace 包 + 构建链 + 资产脚本是 T2~T6 全部源码的宿主与门禁（无 `apps/vscode/tsconfig.json` 则后续任务无法 typecheck）；T2 的 custom editor 注册与文件字节通道是 T3 装配层的输入面（webview 拿不到字节即无渲染）；T3 的注入缝与 CSP 是 T4 高亮链路与 T5 toc/导出的挂载点（`setHighlightFence`/`setMarkdownImageResolver` 等缝一次性注入，重复注入即语义漂移）；T4 的 tree-sitter worker 与资产 URI 依赖 T1 的资产脚本产物；T5 的 toc/导出依赖 T3 的渲染实例面（`getToc`/`getOutline` 鸭子面）；T6 的设置面与实时生效依赖 T3/T4/T5 已有的消费面（配置项逐项对应既有消费点，不先有消费面则设置无处生效）；T7 收尾（发布 workflow + 全量门禁 + 台账）。
- **grammar 构建链条件核查（本计划与 C/I 两份计划相反——本计划**依赖** grammar 链）**：扩展要打包 lite grammar 集，wasm 产物**不入库**（`.gitignore`：`tools/grammar-builder/out/`、`apps/web/static/grammars/`、`*.wasm` 全局规则），来源链为 `pnpm gen:sources`（spec F 源头化：产 `languages.toml`/`build-list.json`/`packages/vviewer-highlight/assets/{languages.json,themes.json,queries}` 与 `packages/vviewer-core/src/registry/generated-extensions.ts`）→ `node tools/grammar-builder/build.mjs --fetch --lite` → `node tools/grammar-builder/build.mjs --self-build`（wasm 直写 `apps/web/static/grammars/` + `manifest.json`，runtime wasm 落 `apps/web/static/tree-sitter.wasm`，`build.mjs:40/:347-348`）。**故扩展构建前必须先跑该链**（CI 侧复用现成 composite action `.github/actions/setup-grammars`，默认 `languages: lite` 即 34 语言集）。**附带依赖**：`packages/vviewer-core/src/registry/generated-extensions.ts`（生成物、不入库）被扩展名清单生成消费——缺失即 fail-fast 并提示 `pnpm gen:sources`（`tools/e2e-list-guard.mjs:15` 同款纪律）。
- **不触及 server/（Rust）**：本计划零 `server/` 文件改动——扩展是纯 TS 前端产物，扩展内不做任何服务端依赖（spec §3 反目标：compute/watch/mounts 全部不适用）；`rg -i "vscode" server/` 仅命中 markdown 渲染语义比对注释，无相关实现面。
- **UI 文案/i18n/组件/a11y 触及面**：**有**——扩展自建 webview 壳（toc 面板、超限占位、错误占位、导出反馈）与中文/英文文案集（spec §4.4「i18n 文案内置中文/英文按 VSCode locale」）。开工前必读（Task 3/5/6 各自标注）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A 组/B 组）、`docs/design/semantic-components.md`（**核对面**：扩展 webview 是独立运行时，不复用 apps/web 组件库，该文档的浮层/菜单登记表**不覆盖**扩展面；但其 a11y 与「先登记后使用」的方法论沿用——扩展自建浮层（无）逐条自检并在本计划登记）、`docs/design/ui-design-system.md`（令牌口径：扩展用 `--ui-*`/`--code-*`/`--vv-ts-*` 变量族，**不引入新 token**，缺省值沿 markdown.css 内既默认值）。
- **e2e 定向锚文件**：**无扩展专属 e2e**（spec §5 拍板「自动化裁量：MVP 以编译门+冒烟清单为主；e2e（@vscode/test-electron）列为增强非门禁」）。唯一涉及 apps/web e2e 的是 **T3 的两处包内 worker-URL 注入缝**（`packages/vviewer-render-doc` / `packages/vviewer-render-binary`）——新增缝**默认值逐字节不变**、apps/web 零改动，故其为**回归锚**而非改动面：`e2e/b-pdf-range.spec.ts`、`e2e/b-pdf-range-2.spec.ts`（pdf worker）、`e2e/b-binary-hex-archive.spec.ts`（hex worker）。

## Global Constraints

- **拍板项不得偏离**（spec §1/§3/§4/§7 落定）：
  - **MVP 范围**（spec §4.4 逐项）：markdown / code / image / av / pdf / html / text / jsonl / hex 九类渲染器 + archive **裁剪**（裁量落定，见下）。**foreign 20 组渲染器、Office 三件套（docx/xlsx/pptx）、目录树/多 tab/全局搜索/设置中心/另存为/挂载体系、移动端形态、webview 内编辑一律不做**（spec §3 非目标）。
  - **注册协议**：custom editor（`contributes.customEditors`，viewType `vviewer.viewer`，`priority: "default"`）——「打开文件时直接渲染」；用户可切回 VSCode 原生编辑器（custom editor 自带切换）。
  - **零外网 CDN 依赖**（约束②）：grammar wasm / queries / tree-sitter runtime / katex 字体**全部打进扩展本地资源**，运行期经 `webview.asWebviewUri` 映射；kroki/plantuml 等外联图表服务默认关闭（`vviewer.diagrams.allowRemoteServices` 默认 `false`）。
  - **打包体积 <100MB**（约束③）：门禁脚本断言 `.vsix`/打包目录字节 <100MB；lite grammar 集实测 46.4MiB（`du -sh apps/web/static/grammars` = 47M，34 个 wasm + manifest.json）。
  - **发布只落文件不实跑**（约束④）：`ovsx`/`vsce` 双渠道 workflow 落文件即止——**无 secrets**（OVSX_PAT/VSCE_PAT 由用户在仓外配置），首跑实测属**仓外 deferred**（台账①）。
  - **CSP**（约束⑤ + spec §7）：`script-src` 必须含 `'wasm-unsafe-eval'`（tree-sitter wasm 实例化必需）；`font-src` 必须覆盖 `asWebviewUri` 源（katex 字体）；另需 `worker-src`（webview 内 worker）+ `connect-src`（worker 内 fetch wasm——`default-src 'none'` 下 `connect-src` 回落即断）。
  - **设置面走 `contributes.configuration`**（约束⑥）：六项设置（toc.side / toc.defaultCollapsed / code.highlightEngine / markdown.diagramMode / diagrams.allowRemoteServices / markdown.externalImages）+ 外链图片白名单；per-language 覆盖用 VSCode 原生机制——host 侧 `workspace.getConfiguration('vviewer', { languageId })` 读取即天然支持，**声明 scope 必须是 `language-overridable`**（否则 VSCode 拒绝 per-language 覆盖——原生机制前提，非自研）。
  - **反目标**（spec §3）：把 AppShell 塞进 webview；扩展内任何服务端依赖；运行时外网 CDN 依赖；webview 内编辑（纯只读）。
- **spec §7 落定项承接**：①**相对链接导航在 MVP 接线**——webview 侧注入 workspace 版 `resolveRelativeLink`（`Uri.joinPath` + `workspace.fs.readFile` 探测）；②**相对图片一并解析**（sibling bytes → blob URL）——§4.3「相对图片 MVP 不解析」作废；数据通道相应加「按路径读文件」的 host 往返消息面；③**导出 HTML 保留在 MVP**——webview→host 写盘面（`showSaveDialog` + `fs.writeFile`），katex 字体内联走 `collectExportHtml` 既有形态；④**设置/主题变更实时生效**——`onDidChangeConfiguration`（vviewer 作用域过滤）+ `onDidChangeActiveColorTheme` → postMessage 推送已打开 webview → `applyTheme`/重渲染面应用，不要求重开文件；⑤**大文件上限 200MB**（对齐 web `PLAIN_MAX_BYTES` 口径），超限 webview 显示引导占位（提示改用 VSCode 原生编辑器）。
- **裁量落定**（spec §6 六项，本计划逐项内联）：
  1. **打包器 = esbuild**（非 rolldown）：host bundle `format: 'cjs'` + `external: ['vscode']`；webview bundle `format: 'esm'` + `splitting: true`（mermaid/katex/pdfjs 动态 chunk 按需取——spec §4.4「动态 chunk（esbuild code splitting）」）；worker bundle `format: 'iife'` 自包含（blob worker 前提）。不用 vite：扩展构建无 PWA/HMR/SvelteKit 需求，vite 的 CSS 资产化与 worker 插件在此场景收益低于其配置面成本。
  2. **webview 壳 = 原生 TS DOM（零 Svelte）**：扩展 webview 是独立运行时（CSP 独立、base URL 独立、无 SvelteKit），壳仅三件（内容区 / toc 面板 / 状态占位）；引 Svelte 需把 svelte 编译器接进 esbuild 链（插件 + 编译期），收益不抵成本。**副作用**：apps/vscode 零 `.svelte` 文件 → 仓库「全局强制 runes」纪律无适用面（AGENTS.md 约束的是 `.svelte`/`.svelte.ts` 写法）；a11y/i18n 纪律仍按 `frontend-conventions.md` 逐条自检。
  3. **archive 渲染器裁掉**（libarchive wasm + worker bundle 打包成本 vs 价值）：spec §4.4 授权「视依赖复杂度裁量裁剪」。裁剪后 hex 仍覆盖二进制查看面。
  4. **theme JSON 精确注入列为增强**（spec §4.2 拍板）：MVP 按 `activeColorTheme.kind` 注入 dark/light 缺省 UI 令牌；**代码 capture 着色**用打包进扩展的两条 helix 主题表（`onelight` / `serika-dark`，从 `packages/vviewer-highlight/assets/themes.json` 构建期裁剪，随资源入扩展）经 `themeToCssVars` 注入 `--vv-ts-*`——零外网、零 apps/web 依赖、无重复调色板（apps/web 的 `DEFAULT_CODE_THEME` 同这两条，语义同源）。读 VSCode 活动主题 JSON 精确注入 = 增强项（highlight 包已备 `validateVscodeTheme`/`tokenColorsToThemeTable`，实现成本低，**记台账②**）。
  5. **serializer / panel 复用**：MVP **不做** `WebviewPanelSerializer`（spec §4.2 明示「裁量可先不做 serializer」）；同文件复用 panel（`viewType` + 文档 URI 比对，命中即 reveal 既有 panel 而非新开）。
  6. **扩展名清单生成脚本形态**：构建期脚本用 esbuild 打包一个 TS 入口跑真实注册表（`createRegistry` + MVP 渲染器 install + `installFallbackExtensions('code', GENERATED_EXTENSIONS)`），输出**有效认领扩展名全集** → 写进生成的 `package.json` 的 `contributes.customEditors[].selector`（零重复维护、与渲染器安装序天然一致——**装序铁律只有一条：专有渲染器先于 generated 兜底安装**，`installFallbackExtensions` 遇已认领扩展名跳过；`md`/`markdown`/`html`/`htm` 由 code 渲染器显式不认领（render-text/src/code/index.ts 注 2），故归 markdown/html 渲染器）。
  7. **i18n 文案集**：扩展自有 `apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts`，key 三段 `{域}.{模块}.{语义}`（沿 `frontend-conventions.md` §3.1 纪律）；locale 由 `vscode.env.language` 选（`zh*` → zh-CN，其余 → en）。
  8. **发布 workflow 与 release.yml 编排**：**独立** `.github/workflows/publish-vscode.yml`（tag `v*` 触发 + workflow_dispatch），不并入 `release.yml`（后者四路产物 + npm 双发布面已密；并入会把无 secrets 的发布 job 挂进主发布链的成败判定）。
- **扩展包 manifest 纪律**：`apps/vscode/package.json` **不得标 `private: true`**（Marketplace/OVSX 发布要求；仓内其余包皆 `private: true` 是 npm 侧纪律，扩展走 marketplace 通道不适用）——`pnpm publish` 不涉及（发布面是 vsce/ovsx），`tools/pack-packages.mjs` 的 PACKAGES 常量不含扩展（零交叉）。
- **本仓纪律对扩展面的映射**：
  - **runes 纪律**：apps/vscode 零 `.svelte` 文件（裁量 2），无适用面；**若实施期引入 `.svelte` 则一律 runes 写法**（AGENTS.md 全局强制，不得逐组件退出）。
  - **i18n 纪律**：扩展文案只落自有目录（禁直读裸字面量）；ESLint 的 CJK 三形态机检当前**只覆盖 `apps/web/**`**（`eslint.config.js` 块 A/块 A2/块 B 的 files 作用域）——Task 6 **新增 `apps/vscode/src/**` 覆盖块**把同款 CJK/bareIntl 规则接入（按覆盖展开纪律，该块须一并展开 `runesOptOut`），使扩展文案纪律机检化。
  - **a11y 基线**：`frontend-conventions.md` §4 基线 + §6 A 组八条逐条自检（图标按钮有可读名称且 aria-label 含可见文本词形；异步反馈走 `role="status"`/`aria-live`；错误与输入关联；焦点可见；状态不只靠颜色）。扩展面**无 axe 扫描**（无 e2e），故 a11y 靠**评审必查 + 单测断言**兜（Task 3/5 的 DOM 单测锁关键 aria 属）。
  - **门禁口径**：vitest 一律在**仓库根**跑（`pnpm vitest run apps/vscode`——**须先扩 `vitest.config.ts` 的 include**，现 include 四项为 `packages/*/test/**`、`packages/*/src/**`、`tools/*/test/**`、`apps/web/src/**`，不含 `apps/vscode/**`）；typecheck 仓库根 `pnpm run typecheck`（**Task 1 扩根脚本纳入 `tsc -b apps/vscode/tsconfig.json`**）；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入——本计划零 apps/web 改动，仅 T3 回归时需要）。
  - **commit 纪律**：Conventional Commits（feat/fix/test/ci/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **诚实边界**：①发布首跑（ovsx/vsce 实跑）无 secrets → 台账 deferred；②`vsce package` 体积门在本仓可实跑（本地打包断言字节），但 **Marketplace 上传实跑不可**（需 PAT）——台账；③扩展真机行为（VSCode 内 custom editor 接管、webview CSP 生效、worker 起活）**无法在本仓 CI 自动化**（无 @vscode/test-electron 基建，spec §5 定为非门禁）→ 以「编译门 + 包内单测 + README 冒烟清单」兑现，冒烟清单由用户在 VSCode 内手测（台账③）。

## Review Focus

1. **包内 seam 的默认值不可漂移**（T3，最高风险）：`packages/vviewer-render-doc`（pdf worker URL）与 `packages/vviewer-render-binary`（hex worker URL）新增注入缝——**默认值必须与现实现逐字节等价**（pdf：`preferModernBuild() ? new URL('pdfjs-dist/build/pdf.worker.min.mjs', …) : new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', …)`（pdf.ts:128-132）；hex：`new Worker(new URL('./binary.worker.ts', import.meta.url), { type: 'module' })`（hex.ts:805））。apps/web 不注入 → 行为零变化；三处 e2e 回归锚（pdf×2 + hex）必须零翻转；单测锁「未注入 = 原表达式形态」「注入 = 返回注入值」。
2. **CSP 六 directive 缺一即功能面静默失效**（T3）：`default-src 'none'` 下，`connect-src` 缺 → worker 内 fetch grammar/runtime wasm 被拦 → tree-sitter 全链静默降级 hljs；`worker-src` 缺 → blob worker 起不来；`font-src` 缺 → katex 字体不加载；`script-src` 缺 `'wasm-unsafe-eval'` → wasm 实例化被拦。**每条 directive 都要有对应的可见失败面**（不能静默——见 Review Focus 3）。
3. **静默降级面必须可见**（T3/T4）：tree-sitter worker 起不来 / grammar wasm 404 / queries 缺失 → 落 hljs 或 plain，**但 webview 必须显示当前高亮引擎态**（状态行/角标），否则与「装好了却没高亮」不可区分。webview 内零 console 出口（webview console 不回传 host）→ 状态行 + host 侧 `console.warn` 双通道。
4. **资产 URI 三段必须自洽**（T1/T4）：`grammarsBase`（`<assets>/grammars/`）、`queriesBase`（`<assets>/queries/`）、`runtimeDir`（`<assets>/`，`Parser.init` 经 `locateFile(joinPath(runtimeDir, 'tree-sitter.wasm'))` 取用——core-parse.ts:210）——三者同为 `asWebviewUri` 家族，**不得混用相对路径**（`Language.load(joinPath(entry.base ?? grammarsBase, entry.file))` core-parse.ts:417；queries 走 `fetch(`${dir}/${name}`)` core-parse.ts:484）。三条路径任一错 → 该语言静默无高亮。
5. **blob worker 的 base URL 陷阱**（T4）：blob worker 内 `import.meta.url` 为 `blob:` 域 → 一切相对资产 URL 失效 → wasm URL 必须**绝对**（`asWebviewUri` 绝对 URL）；worker bundle 必须**自包含 IIFE**（无 import），否则 blob worker 解析失败。起活失败必须走可见降级（RF 3），不得静默。
6. **katex CSS 双形态**（T3/T5）：包内 `pipeline.ts:643` 的 `import('katex/dist/katex.min.css')` 在 vite 下自动注入 <style>，**esbuild 下不会**（CSS 抽成独立产物，运行期不注入）→ 扩展必须**自备** katex CSS 注入面（构建期拷 `katex.min.css` + 20 个 woff2 → 字体 URL 改写为 asWebviewUri 绝对 URL）；漏做 → 公式出无排印 HTML（与 web 端 2026-10-19 前同款潜伏缺陷）。导出面另需**自包含** katex CSS（字体 data URI 内联）——两处 CSS 同源不同形态，不可混用。
7. **扩展名清单与渲染器认领面必须一致**（T2）：custom editor 的 selector 集合 = 注册表**有效认领**扩展名全集（生成脚本实跑注册表得出）。认领面大于 selector → 用户双击某扩展名不接管（落到原生编辑器，体验断裂）；小于 selector → 接管后 dispatch 无渲染器 → 错误卡片。两面同源于生成脚本，单一来源。
8. **per-language 覆盖的真前提是 scope**（T6）：`contributes.configuration` 的 property `scope` 必须是 `language-overridable`（或 `resource`），否则 VSCode **静默忽略** `"[markdown]": {…}` 覆盖——用户以为配了却不生效。README 需给可复制示例 + 生效验证步骤。

---

### Task 1: 扩展工程骨架 + esbuild 构建链 + 资产打包脚本 + 体积门禁

**Files:**
- Create: `apps/vscode/package.json`（`@bhxch/vviewer-vscode`；**非 private**；`publisher: "bhxch"`、`engines.vscode`、`main`、`contributes` 占位、`scripts.build`）
- Create: `apps/vscode/tsconfig.json`（`extends ../../tsconfig.base.json`，`include: ["src", "test"]`，`types: ["node"]`）
- Create: `apps/vscode/build.mjs`（esbuild 三产物编排：host CJS / webview ESM+splitting / worker IIFE×2；资产拷贝；生成 package.json 合并产物）
- Create: `apps/vscode/scripts/collect-assets.mjs`（grammar lite 集 + queries 过滤 + runtime wasm + 两条主题表 + katex css/fonts 采集）
- Create: `apps/vscode/scripts/gen-manifest.mjs`（扩展名清单生成：esbuild 打包 TS 入口跑真实注册表 → 写 `contributes.customEditors[].selector`）
- Create: `apps/vscode/scripts/check-size.mjs`（打包体积门 <100MB）
- Create: `apps/vscode/README.md`（骨架：功能概述 + 构建/本地调试说明；冒烟清单与设置示例在 T6 补全）
- Create: `apps/vscode/LICENSE`（Apache-2.0 副本，与仓根一致）
- Create: `apps/vscode/.vscodeignore`（排除 src/scripts/node_modules）
- Modify: `package.json`（根）：`typecheck` 脚本纳入 `tsc -b apps/vscode/tsconfig.json`；新增 `build:vscode` 便捷脚本
- Modify: `vitest.config.ts`：include 增 `apps/vscode/src/**/*.test.ts` 与 `apps/vscode/test/**/*.test.ts`
- Modify: `.gitignore`：新增 `apps/vscode/dist/`（构建产物，含打包进来的 wasm 资产——`*.wasm` 全局规则已覆盖 wasm 本体，dist 整目录需显式）
- Modify: `pnpm-lock.yaml`（`pnpm install` 产物）

**Interfaces:**
- `apps/vscode/package.json` 关键字段：`name: "@bhxch/vviewer-vscode"`、`displayName: "VViewer"`、`publisher: "bhxch"`、`engines.vscode: "^1.90.0"`、`main: "./dist/extension.js"`、`categories: ["Other"]`、`contributes`（`customEditors` + `configuration` 的**生成前占位**，最终清单由 T2/T6 落、`gen-manifest.mjs` 只补 `selector`）；`scripts.build: "node build.mjs"`、`scripts.test: "vitest run"`；devDeps：`@types/vscode`、`esbuild`、`@types/node`；deps：workspace 包 `@bhxch/vviewer-{core,detect,highlight,markdown,lightbox,render-text,render-media,render-doc,render-binary,render-diagram,sanitize}` + `katex`。
- 构建产物布局（`apps/vscode/dist/`）：
  ```
  dist/
  ├── extension.js            # host bundle（CJS，external vscode）
  ├── webview/
  │   ├── main.js             # webview bundle（ESM，splitting → chunk-*.js 同目录）
  │   ├── chunk-*.js          # 动态 import 产物（mermaid/katex/pdfjs 等按需取）
  │   ├── highlight-worker.js # tree-sitter worker（IIFE 自包含）
  │   ├── binary-worker.js    # hex 解析 worker（IIFE 自包含）
  │   ├── katex.min.css       # katex 排印样式（字体 URL 指向同目录 fonts/）
  │   ├── fonts/KaTeX_*.woff2 # 20 个 woff2
  │   └── assets/
  │       ├── grammars/{34 wasm + manifest.json}
  │       ├── queries/<lang>/{highlights,injections,tags}.scm}
  │       ├── tree-sitter.wasm
  │       └── themes.json     # 裁剪为 onelight + serika-dark 两条
  └── package.json            # 合并产物（源 manifest + 生成的 selector）
  ```
- 资产采集契约（`collect-assets.mjs`）：grammar 源 = `apps/web/static/grammars`（lite 集，`manifest.json` 的 `grammars` 键集即语言集）；queries 源 = `packages/vviewer-highlight/assets/queries/<lang>/`（**仅** manifest 语言集命中项——canonical 语言名即查询目录名，alias 不另取：引擎按 canonical lang 取查询，core-parse.ts:484）；runtime 源 = `apps/web/static/tree-sitter.wasm`；主题源 = `packages/vviewer-highlight/assets/themes.json` 的 `onelight`/`serika-dark` 两键；katex 源 = `node_modules/katex/dist/katex.min.css` + `dist/fonts/*.woff2`（20 个 woff2，woff/ttf 不取——web 端同款取舍）。**任一源缺失即 fail-fast 并打印可执行修复命令**（`pnpm gen:sources` / `node tools/grammar-builder/build.mjs --fetch --lite` / `--self-build`）——不做静默降级（缺 grammar = 扩展无高亮，属构建期必须暴露的失败）。
- 体积门（`check-size.mjs`）：递归求 `dist/` 总字节，断言 < `100 * 1024 * 1024`；超限打印各子目录占用 Top-N 便于定位（lite grammar 集 ~46.4MiB 为预期大头）。

- [ ] **Step 1: 骨架文件 + 根脚本纳入（vitest include / typecheck / gitignore）**
  建 `apps/vscode/{package.json,tsconfig.json,.vscodeignore,LICENSE}`；`pnpm install`（新 workspace 包入锁）；改根 `package.json` 的 `typecheck` 为 `tsc -b packages/*/tsconfig.json apps/vscode/tsconfig.json apps/web/tsconfig.e2e.json --noEmit && pnpm --filter web typecheck`；改 `vitest.config.ts` include；`.gitignore` 加 `apps/vscode/dist/`。Run: `pnpm run typecheck` → Expected: PASS（空工程零报错；证明 `tsc -b` 纳入新工程不破既有链）。`pnpm vitest run apps/vscode` → Expected: 「No test files found」（证明 include 已生效前的现状；Step 2 建测试后转绿）。

- [ ] **Step 2: 构建链 + 资产脚本（TDD 最小面：资产脚本的纯函数单测）**
  先写 `apps/vscode/test/assets.test.ts`（纯函数：queries 语言过滤——按 manifest 语言集取目录、缺目录跳过；katex 字体清单——20 个 woff2 名单与体积；主题裁剪——输出只含两键）；再落 `build.mjs`（esbuild 三产物 + 资产拷贝 + 合并 manifest）与 `collect-assets.mjs`/`check-size.mjs`。Run: `pnpm vitest run apps/vscode` → RED→GREEN。
  **前置**：`node tools/grammar-builder/gen-sources.mjs`（若 `apps/web/static/grammars/manifest.json` 缺失则先 `node tools/grammar-builder/build.mjs --fetch --lite` + `--self-build`）——资产脚本的源缺失路径必须 fail-fast（单测用临时目录构造缺件场景断言错误信息含修复命令）。

- [ ] **Step 3: 扩展名清单生成脚本（真实注册表实跑）**
  `gen-manifest.mjs`：esbuild 打包 `apps/vscode/scripts/collect-extensions.ts`（import `@bhxch/vviewer-core` 的 `createRegistry` + MVP 渲染器 + `GENERATED_EXTENSIONS`）→ 在 Node 执行 → 得有效认领扩展名全集 → 写 `contributes.customEditors[0].selector`（`{ filenamePattern: "*.ext" }` 逐项）。单测：断言 markdown 类扩展名（md/markdown）由 markdown 认领（非 code）、generated 兜底扩展名在集内、集合非空且与渲染器 extensions 并集一致（RF 7）。

- [ ] **Step 4: 门禁 + 提交**
  Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿；`pnpm --filter @bhxch/vviewer-vscode build` → 产出三 bundle + 资产 + 体积门 <100MB 通过。
  ```bash
  git add apps/vscode package.json vitest.config.ts .gitignore pnpm-lock.yaml && git status --porcelain 自查后 commit -m "feat(vscode): 扩展工程骨架——@bhxch/vviewer-vscode workspace 包 + esbuild 三产物构建链（host CJS/webview ESM splitting/worker IIFE）+grammar lite 集与 queries/katex/主题资产采集脚本 + 体积门 <100MB + 根 typecheck 纳入 tsc -b"
  ```

---

### Task 2: 扩展 host 侧——custom editor 注册 + 文件字节通道 + 大文件上限 + panel 复用

**Files:**
- Create: `apps/vscode/src/extension.ts`（`activate`/`deactivate`；custom editor provider 注册；命令注册）
- Create: `apps/vscode/src/host/editorProvider.ts`（`CustomTextEditorProvider` 或 `CustomReadonlyEditorProvider` 实现）
- Create: `apps/vscode/src/host/webviewPanel.ts`（panel 创建/复用/reveal；HTML 模板生成；CSP + nonce；`asWebviewUri` 资源映射）
- Create: `apps/vscode/src/host/fileChannel.ts`（读文件字节 + 大小上限 + 编码无关的原始字节通道）
- Create: `apps/vscode/src/host/protocol.ts`（host↔webview 消息类型——**纯 .ts，vitest 直测**）
- Create: `apps/vscode/src/host/settings.ts`（配置读取 + per-language 解析——**纯 .ts**，注入 `vscode` API 便于单测）
- Test: `apps/vscode/test/protocol.test.ts`、`apps/vscode/test/settings.test.ts`

**Interfaces:**
- 注册协议（spec §4.1）：`contributes.customEditors` = `[{ viewType: "vviewer.viewer", displayName: "VViewer", priority: "default", selector: [ …生成清单… ] }]`；host 侧 `window.registerCustomEditorProvider('vviewer.viewer', provider, { supportsMultipleEditorsPerDocument: false, webviewOptions: { enableFindWidget: true, retainContextWhenHidden: true } })`。
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
- `AssetUris`：`{ grammarsBase: string; queriesBase: string; runtimeDir: string; grammars: GrammarTable; workerUrl: string; binaryWorkerUrl: string; pdfWorkerUrl: string; fontsBase: string; katexCssUrl: string; highlightWorkerSourceUrl: string }`——**全部为 `webview.asWebviewUri` 绝对 URL**（RF 4/5）。
- 大文件上限（spec §7 ④）：`MAX_BYTES = 200 * 1024 * 1024`（对齐 web `PLAIN_MAX_BYTES` 口径）；超限 → **不读文件**，webview 显示引导占位（文案：文件超过 200MB，建议改用 VSCode 原生编辑器打开）——host 侧 `fileChannel.ts` 读 `vscode.workspace.fs.stat` 拿 size 后判定（`fs.readFile` 前置判定，避免大文件全量入内存）。
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

- **验收锚 / e2e**：验收 = `apps/vscode/test/{protocol,settings}.test.ts` 全绿（协议形状/脏值归一/per-language 覆盖解析）+ `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（纯扩展面，apps/web 零改动）。单测用注入式 `vscode` 假对象（`getConfiguration` 桩：按 scope/语言 id 返回不同值 → 断言 per-language 覆盖优先）。

- [ ] **Step 1: 协议与设置纯逻辑（TDD RED）**
  `protocol.test.ts`：消息判别（`kind` 穷尽）、`read-file`/`export-html` 的 id 单调性、`WebviewSettings` 归一（脏值/缺省/白名单规范化）。`settings.test.ts`：`getConfiguration('vviewer', {languageId })` 桩 → 断言语言级覆盖 > 窗口级 > 缺省（RF 8）。Run: `pnpm vitest run apps/vscode` → Expected: RED（模块不存在）。

- [ ] **Step 2: 实装 host 侧（provider / panel / 文件通道）**
  按 Interfaces 落地：`extension.ts` 激活时注册 provider + 命令（`vviewer.openWithNative`（打开原生编辑器）/`vviewer.reload`（重渲染））；`webviewPanel.ts` 生成 HTML（nonce + CSP 六 directive，见 Task 3）+ 资源 URI 映射；`fileChannel.ts` 实现 200MB 判定与字节读（`vscode.workspace.fs.readFile`）。**CSP 六 directive 在本任务先落骨架**（Task 3 补 asset 面），单测断言 HTML 模板含 `wasm-unsafe-eval`、`font-src`、`worker-src`、`connect-src` 四项关键 directive（RF 2）。

- [ ] **Step 3: 门禁 + 提交**
  Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿。
  ```bash
  git add apps/vscode && git commit -m "feat(vscode): host 侧——custom editor provider（viewType vviewer.viewer/priority default）+ 文件字节通道（200MB 上限前置判定）+ panel 复用 + 设置读取（per-language 覆盖）+ host↔webview 消息协议"
  ```

---

### Task 3: webview 装配层——渲染器注册 + 注入缝 + CSP/主题令牌 + 包内 worker URL 缝新增

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A/B 组）、`docs/design/semantic-components.md`（**核对面**：扩展 webview 独立运行时，该文档登记表不覆盖扩展面；本任务无新浮层/菜单/确认通道——「用编辑器打开」走 VSCode 原生命令而非自建菜单）、`docs/design/ui-design-system.md`（令牌口径：零新 token）。

**Files:**
- Create: `apps/vscode/src/webview/main.ts`（webview 入口：消息协议接线 + 装配 + 渲染调度）
- Create: `apps/vscode/src/webview/assemble.ts`（**纯 TS 装配层**——`apps/web/src/lib/viewer.ts` 的无 app 依赖重写）
- Create: `apps/vscode/src/webview/shell.ts`（webview 壳：内容区 + toc 面板 + 状态行；原生 TS DOM；a11y 属性）
- Create: `apps/vscode/src/webview/theme.ts`（主题令牌注入：kind → `--ui-*` 缺省 + capture 表 → `--vv-ts-*`）
- Create: `apps/vscode/src/webview/dispatchHost.ts`（host 往返桥：相对文件读、导出写盘、外部链接、report 通道）
- Create: `apps/vscode/src/webview/store.ts`（singleFile 型 TreeStore 注入——core `createSingleFileStore` 先例）
- Modify: `packages/vviewer-render-doc/src/pdf.ts`（**新增** `setPdfWorkerUrlProvider` 注入缝；默认逐字节不变）
- Modify: `packages/vviewer-render-binary/src/hex.ts`（**新增** `setHexWorkerUrlProvider` 注入缝；默认逐字节不变）
- Test: `packages/vviewer-render-doc/test/pdfWorkerUrl.test.ts`（新建）、`packages/vviewer-render-binary/test/hexWorkerUrl.test.ts`（新建）
- Test: `apps/vscode/test/assemble.test.ts`、`apps/vscode/test/shell.test.ts`（webview 壳的 DOM 契约与 a11y 断言）

**Interfaces:**
- `assemble.ts`（装配层，**零 `$app`/`import.meta.env`/store 依赖**）：
  - 注册表：`createRegistry()` → 按 web 端同序安装 MVP 渲染器（code → markdown → html → image → av → pdf → hex → jsonl；**archive/foreign/docx-xlsx-pptx 不装**——裁量 3；与 web 端 `viewer.ts` 的差别仅是跳过 diagram/foreign/Office 三块）；末段 `installFallbackExtensions('code', GENERATED_EXTENSIONS)` 补空位（generated 遇已认领扩展名跳过——`md`/`markdown`/`html`/`htm` 由 code 渲染器显式不认领，归 markdown/html 渲染器）。
  - 注入缝（markdown 组合包）：`setHighlightFence(fenceToHtml)`（围栏桥来自 `@bhxch/vviewer-render-text/markdown/markdownRenderer`）、`setMarkdownBackend(本地渲染)`（**恒本地**——扩展无服务端；`renderMarkdownBody`）、`setResolveRemoteBase(() => null)`、`setMarkdownImageResolver(...)`（相对图片 → blob URL，RF/§7 ②）、`setRelativeLinkResolver(...)` + `setRelativeLinkOpener(...)`（§7 ①）、`setDiagramOptions(...)`（local/kroki/off + allowRemoteServices 闸）、`setExternalImagePolicyProvider(...)`（三档 + 白名单，映射 spec D）。
  - core 错误文案缝：`setRenderFailedText(...)`（扩展自有文案，非 apps/web 目录）。
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
- CSP（webview HTML，**六 directive 全列**）：
  ```
  default-src 'none';
  img-src ${webview.cspSource} data: blob: https:;
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src 'nonce-${nonce}' 'wasm-unsafe-eval';
  worker-src ${webview.cspSource} blob:;
  font-src ${webview.cspSource} data:;
  connect-src ${webview.cspSource} data: blob: https:;
  ```
  说明：`script-src` 用 nonce（宿主 HTML 内联脚本）；`'wasm-unsafe-eval'` 为 tree-sitter wasm 实例化必需（约束⑤）；`font-src` 覆盖 `asWebviewUri`（katex 字体）；`connect-src` 必需——`default-src 'none'` 下缺它则 worker 内 fetch wasm 被拦（RF 2）。
- 主题令牌（`theme.ts`）：kind → `--ui-bg/--ui-fg/--ui-border/--code-*` 缺省值（**沿 `packages/vviewer-markdown/src/css.ts` 内既默认值，不引入新 token**——markdown.css 的 `var(--token, 默认值)` 契约自带缺省）；capture 色 → `themeToCssVars(table, CODE_CAPTURES)`（`@bhxch/vviewer-highlight`）注入 `--vv-ts-*`；表源 = 打包的两条主题（onelight/serika-dark，按 kind 选，裁量 4）。
- **验收锚 / e2e**：验收 = `packages/vviewer-render-doc` / `packages/vviewer-render-binary` 新增单测绿 + **既有包单测零回归** + `apps/vscode/test/{assemble,shell}.test.ts` 绿 + `pnpm run typecheck` 绿；**所触 e2e 锚文件（回归锚，不改断言）**：`e2e/b-pdf-range.spec.ts`、`e2e/b-pdf-range-2.spec.ts`、`e2e/b-binary-hex-archive.spec.ts`。

- [ ] **Step 1: 包内两缝（TDD RED→GREEN，默认路径锁死）**
  先写 `pdfWorkerUrl.test.ts`（未注入 → URL 形态与现表达式等价（`pdfjs-dist/build/pdf.worker.min.mjs` 或 legacy 分支）；注入 → 返回注入值）与 `hexWorkerUrl.test.ts`（未注入 → `new URL('./binary.worker.ts', import.meta.url)` 形态；注入 → 注入值；provider 返回 null → 回退默认）。Run: `pnpm vitest run packages/vviewer-render-doc packages/vviewer-render-binary` → RED → 落缝 → GREEN（**既有用例零回归** = 默认路径兼容锚）。

- [ ] **Step 2: webview 装配层 + 壳（RED→GREEN）**
  `assemble.test.ts`：注册表安装序（markdown 先于 code → `md` 归 markdown）、注入缝齐备性（8 个缝均已注入，逐一断言 setter 生效：注入后 `getXxx()` 返回注入值）、dispatcher 对单文件 source 选中预期渲染器。`shell.test.ts`（jsdom）：壳 DOM 契约 + a11y（toc 面板 `role="complementary"`/`aria-label`、折叠钮 `aria-expanded` 同步、状态行 `role="status"`、图标钮有可读名称）。Run: `pnpm vitest run apps/vscode` → RED → GREEN。

- [ ] **Step 3: CSP 六 directive + 主题令牌 + katex CSS 注入面**
  CSP 六项齐备（单测断言 HTML 模板字符串含六 directive 与 nonce）；主题令牌注入（亮/暗两套）；**katex CSS 自备注入面**（RF 6）：webview 启动时 fetch `asWebviewUri(dist/webview/katex.min.css)` → `<style>` 注入（字体 URL 已是绝对 asWebviewUri，`font-src` 覆盖即生效）——包内 `pipeline.ts:643` 的动态 import 在 esbuild 下不注入样式，漏做即公式无排印。
- [ ] **Step 4: 回归 + 门禁 + 提交**
  Run: `pnpm vitest run apps/vscode packages/vviewer-render-doc packages/vviewer-render-binary && pnpm run typecheck && pnpm lint` → 全绿；`pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-pdf-range b-pdf-range-2 b-binary-hex-archive` → 三域零翻转（RF 1 回归锚）。
  ```bash
  git add apps/vscode packages/vviewer-render-doc packages/vviewer-render-binary && git commit -m "feat(vscode): webview 装配层——viewer.ts 无 app 依赖重写（9 类渲染器注册+八注入缝+singleFile store）+CSP 六 directive（wasm-unsafe-eval/font-src asWebviewUri/connect-src）+主题令牌与 katex CSS 自备注入面；包内新增 pdf/hex worker URL 注入缝（默认逐字节不变）"
  ```

---

### Task 4: tree-sitter 离线高亮链路——blob worker + 本地 grammar/queries 资产 + 引擎档位

**Files:**
- Create: `apps/vscode/src/webview/highlight.ts`（worker 起活 + `HighlightClient` + `CodeHighlightClient` 适配 + `attachHighlightClient` + `setHighlightFence`）
- Create: `apps/vscode/src/webview/highlightWorker.ts`（**worker 入口**：import `serveWorker` 并自启——包内 `serveWorker`（worker.ts:109）已含 WorkerGlobalScope 自启语义）
- Create: `apps/vscode/src/webview/assets.ts`（资产 URI 解析 + manifest → GrammarTable + 缺件可见降级）
- Create: `apps/vscode/src/webview/engineBadge.ts`（当前高亮引擎态的可见指示——RF 3）
- Test: `apps/vscode/test/highlight.test.ts`（纯逻辑：引擎档位裁决、缺件降级矩阵、grammar 表构造）

**Interfaces:**
- worker 起活（RF 5）：webview 内 `fetch(highlightWorkerSourceUrl)` → `new Blob([text], { type: 'text/javascript' })` → `URL.createObjectURL` → `new Worker(blobUrl)`；**worker bundle 必须 IIFE 自包含**（无 import）；起活失败 → 落 hljs/plain 并在壳状态行显示（RF 3，不静默）。
- 握手（`HighlightClient` 构造即发 init，`packages/vviewer-highlight/src/client.ts`）：init 载荷 = `{ kind: 'init', grammars: GrammarTable, grammarsBase, queriesBase, runtimeDir }`——`grammars` 由扩展读 `assets/grammars/manifest.json` 的 `grammars` 键（`GrammarTable` 形态 `Record<string, { file: string; aliases?: string[]; base?: string }>`，core-parse.ts:20）；`grammarsBase`/`queriesBase`/`runtimeDir` 全为 `asWebviewUri` 绝对 URL（RF 4）。
- **资产与引擎的一致性**：`Language.load(joinPath(entry.base ?? grammarsBase, entry.file))`（core-parse.ts:417）→ manifest 条目**不得带 `base`**（否则绕开 grammarsBase 打到错误源）；queries 走 `fetch(`${queriesBase}${lang}/${name}`)`（core-parse.ts:484）→ `queriesBase` 必带尾 `/`（`joinPath` 语义）；runtime 走 `Parser.init({ locateFile: (f) => joinPath(runtimeDir, f) })`（core-parse.ts:210）→ `runtimeDir` 指向含 `tree-sitter.wasm` 的目录。三者同族绝对 URL（RF 4）。
- 引擎档位（`vviewer.code.highlightEngine`）：`'tree-sitter'`（默认，装 tree-sitter 链）｜`'hljs'`（不装 worker，渲染器走内置 hljs 兜底——`@bhxch/vviewer-render-text` 依赖 `highlight.js`，`renderCode.ts:259` 的 `hljsWholeFile` 为整文件兜底）｜`'plain'`（纯文本，无着色）。裁决单点：`resolveHighlightEngine(settings) → 'tree-sitter' | 'hljs' | 'plain'`（纯函数，单测锁）。
  **大小阈值沿渲染器既有策略**（`packages/vviewer-render-text/src/code/strategy.ts:89-94`：`TREE_SITTER_MAX_BYTES = 2MB` / `HLJS_MAX_BYTES = 20MB` / `PLAIN_MAX_BYTES = 200MB`）——故 hljs 档的着色覆盖面是：≤2MB 整文件 hljs、2~20MB lazy 行级 hljs、>20MB 纯文本；tree-sitter 档同理（>2MB 走 lazy chunk）。**200MB 上限与本计划 host 侧大文件闸同源**（spec §7 ④「对齐 web PLAIN_MAX_BYTES 口径」）。
- 降级矩阵（RF 3，可见）：worker 起活失败 / init 看门狗超时（client.ts 的 15s `INIT_TIMEOUT_MS`）→ hljs；grammar 清单缺失该语言 → hljs（清单感知门，apps/web 同款语义）；用户档位即 plain → 不起 worker（省内存与启动时间）。
- **验收锚 / e2e**：验收 = `apps/vscode/test/highlight.test.ts` 绿 + `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（扩展面）。

- [ ] **Step 1: 引擎档位与降级矩阵（TDD RED）**
  `highlight.test.ts`：档位裁决三态、缺件降级（worker 失败 → hljs；语言不在清单 → hljs；plain 不起 worker）、manifest → GrammarTable 构造（条目 base 恒 undefined）、queriesBase/runtimeDir 尾斜杠与绝对性断言。Run: `pnpm vitest run apps/vscode` → RED。
- [ ] **Step 2: worker 入口 + 资产解析 + client 适配**
  落 `highlightWorker.ts`（`import { serveWorker } from '@bhxch/vviewer-highlight/worker'; serveWorker();`）、`assets.ts`（读 manifest → GrammarTable；组装三段 base URL）、`highlight.ts`（blob worker 起活 → `new HighlightClient(worker, init)` → 适配 `CodeHighlightClient`（highlight/outline/cancelOutline/hasLocalGrammar——render-text 的鸭子面，`packages/vviewer-render-text/src/code/client.ts`）→ `attachHighlightClient(adapter)`；围栏桥 `setHighlightFence(fenceToHtml)`）。**不发 compute 路由**（扩展无服务端——`computeRouter` 不装配，调用恒本地）。
- [ ] **Step 3: 引擎态可见 + 门禁 + 提交**
  `engineBadge.ts`：壳状态行显示当前引擎（tree-sitter / hljs（降级）/ plain），降级时附原因短语（RF 3）。Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿。
  ```bash
  git add apps/vscode && git commit -m "feat(vscode): tree-sitter 离线高亮链路——blob worker（IIFE 自包含）+本地 grammar/queries/runtime 资产（asWebviewUri 三段自洽）+引擎档位裁决与可见降级（hljs/plain 回落带状态行指示）"
  ```

---

### Task 5: toc 面板 + 相对链接/图片解析 + 导出 HTML 写盘 + 图表本地引擎

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 A/B 组）、`docs/design/semantic-components.md`（核对面：本任务含 toc 面板这一「新增面板」——按「先登记后使用」方法论在计划内登记其语义角色）、`docs/design/ui-design-system.md`（零新 token）。

**Files:**
- Create: `apps/vscode/src/webview/toc.ts`（toc 数据面装配 + 面板交互 + 位置/折叠态）
- Create: `apps/vscode/src/webview/links.ts`（相对链接解析 + 相对图片 → blob URL + 外部链接通道）
- Create: `apps/vscode/src/webview/exportHtml.ts`（导出 HTML 组装 + 写盘请求）
- Modify: `apps/vscode/src/webview/shell.ts`（toc 面板挂载 + 状态行反馈）
- Modify: `apps/vscode/src/webview/assemble.ts`（相对链接/图片 resolver 注入接线）
- Test: `apps/vscode/test/toc.test.ts`、`apps/vscode/test/links.test.ts`、`apps/vscode/test/exportHtml.test.ts`

**Interfaces:**
- toc 数据面（spec §7 技术订正）：markdown → `extractToc(scope)`（`@bhxch/vviewer-markdown`，markdownRenderer.ts:381）经渲染实例 `getToc?.()`（core `RenderedInstance` 鸭子面，types.ts:121）；code → 渲染实例 `getOutline?.()`（highlight 包 `pairsToOutline` 产出，`packages/vviewer-highlight/src/outline.ts:38`）。**统一为面板条目** `{ id, label, level, kind: 'heading' | 'symbol' }`。
- 面板行为：`vviewer.toc.side`（'left' 默认 'right'——spec §4.2）决定停靠侧；`vviewer.toc.defaultCollapsed`（默认 **true**——「右侧内容默认收起」即 toc 面板默认收起）；折叠态记忆 `workspaceState`（`context.workspaceState.update('vviewer.toc.collapsed', …)`，spec §4.2「折叠态记忆 workspaceState」）；折叠钮 `aria-expanded` 同步；点击条目 → 滚动到目标（markdown heading id / code 符号行号）。
- 相对链接（§7 ①）：webview 侧 `setRelativeLinkResolver` → 经 host 往返（`read-file` 消息 + `Uri.joinPath`）→ 命中则 `setRelativeLinkOpener` 打开（同一 custom editor 内切换文档）；未命中 → 状态行提示（`role="status"`）。
- 相对图片（§7 ②）：`setMarkdownImageResolver` → host 读 sibling bytes → webview 侧 `URL.createObjectURL(new Blob([bytes]))` → 渲染实例销毁时 revoke（包内视图托管 blob 生命周期，resolver 返回 URL 即由包内 revoke——`markdownRenderer.ts` 的 blob 登记语义）。
- 导出 HTML（§7 ③）：webview 侧 `collectExportHtml(doc, { inlineCss, katexCss })`（`@bhxch/vviewer-markdown`，export.ts:226）+ `exportBaseCss` + 主题变量块 + **自包含 katex CSS（字体 data URI 内联）** → host 侧 `showSaveDialog` + `workspace.fs.writeFile` → 回 `export-result` → 状态行反馈成功/失败路径。
- 图表（spec §4.4）：本地引擎 mermaid/katex/viz/nomnoml 随 webview bundle 动态 chunk（esbuild splitting）；`vviewer.markdown.diagramMode`（local/kroki/off）+ `vviewer.diagrams.allowRemoteServices`（默认 false）——**kroki 通道仅在 allowRemoteServices=true 时可用**（约束②：运行时零外网 CDN 依赖的默认面；用户显式开启才外联）。
- **验收锚 / e2e**：验收 = `apps/vscode/test/{toc,links,exportHtml}.test.ts` 绿 + `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（扩展面；markdown 包既有 e2e 不受本任务影响——本任务不改包）。

- [ ] **Step 1: toc 纯逻辑 + 壳交互（RED→GREEN）**
  `toc.test.ts`：数据面归一（markdown TocEntry → 面板条目；code OutlineEntry → 面板条目；level 裁剪至 1-4）、位置与折叠态裁决（默认折叠 = true）、workspaceState 读写（桩）。`shell.test.ts` 扩：面板停靠侧切换、折叠钮 `aria-expanded` 同步（a11y 断言）。
- [ ] **Step 2: 相对链接/图片 + 导出写盘**
  `links.test.ts`：host 往返协议（id 配对、缺件路径）、blob URL 生命周期（revoke 断言）、外部链接通道（`open-external` 消息）。`exportHtml.test.ts`：`collectExportHtml` 产物含主题变量块与自包含 katex CSS（断言 `data:` 字体 URL 存在、无外部字体引用）、写盘请求消息形状。
- [ ] **Step 3: 图表档位与外联闸 + 门禁 + 提交**
  `diagramMode` 三档 × `allowRemoteServices` 闸的单测（local 恒本地；kroki 在闸关时回落源码块——spec §4.4「kroki 通道类型默认回落源码块（离线优先）」）。Run: `pnpm vitest run apps/vscode && pnpm run typecheck && pnpm lint` → 全绿。
  ```bash
  git add apps/vscode && git commit -m "feat(vscode): toc 面板（左右可选/默认收起/折叠态记忆 workspaceState）+相对链接与相对图片解析（host 往返）+导出 HTML 写盘（showSaveDialog 自包含 katex 字体）+图表本地引擎与外联闸（allowRemoteServices 默认关）"
  ```

---

### Task 6: 设置面 contributes.configuration + 配置/主题变更实时生效 + README

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 A/B 组）、`docs/design/semantic-components.md`（核对面）、`docs/design/ui-design-system.md`（零新 token）。

**Files:**
- Modify: `apps/vscode/package.json`（`contributes.configuration` 七项 property 声明——**scope 必须 `language-overridable` 或 `resource`**，RF 8）
- Create: `apps/vscode/src/i18n/catalogs/zh-CN.ts`、`apps/vscode/src/i18n/catalogs/en.ts`（扩展自有文案目录；key 三段 `{域}.{模块}.{语义}`）
- Create: `apps/vscode/src/i18n/core.ts`（纯层 `translate(key, params)`；locale 由 `vscode.env.language` 选）
- Modify: `apps/vscode/src/extension.ts`（`onDidChangeConfiguration`（vviewer 作用域过滤）+ `onDidChangeActiveColorTheme` → 向已开 webview postMessage 推送）
- Modify: `apps/vscode/src/webview/main.ts`（接收 settings/theme 推送 → 调 `applyTheme`/重渲染面，不要求重开文件——§7 ④）
- Modify: `eslint.config.js`（**新增** `apps/vscode/src/**` 覆盖块：CJK 三形态 + bareIntl + `runesOptOut` 展开——按仓库「后块整体覆盖前块」纪律，必须一并展开 `runesOptOut`）
- Modify: `apps/vscode/README.md`（设置全表 + per-language 覆盖示例 + 冒烟清单——spec §5 手工冒烟清单原文落此）
- Test: `apps/vscode/test/i18n.test.ts`（键集 zh==en、占位符集合相等）、`apps/vscode/test/liveUpdate.test.ts`（配置/主题变更 → 推送路径）

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
  **scope 纪律**：per-language 覆盖只对 `language-overridable` 生效——VSCode 原生机制要求（RF 8）；README 示例只示范 `vviewer.code.highlightEngine`（语言相关项）以免给出无效示例。
- 实时生效（§7 ④）：host 侧 `workspace.onDidChangeConfiguration(e => e.affectsConfiguration('vviewer'))` → 重算 `WebviewSettings`（按当前文档 languageId）→ postMessage；`window.onDidChangeActiveColorTheme` → 重算主题令牌 → postMessage；webview 侧：settings 变更 → 影响面重算（引擎档位/图表档位/外链图片档位）——**重渲染当前文档**（重渲染成本 > 增量，MVP 取全量重渲）；theme 变更 → `applyTheme({ mermaidTheme })`（markdown 实例面，markdownRenderer.ts:1051）+ 令牌重注入（mermaid 重画随之生效）。
- 扩展 i18n 目录：`apps/vscode/src/i18n/catalogs/{zh-CN,en}.ts`；键集相等 + 占位符集合相等由 `i18n.test.ts` 硬断言（沿 apps/web 聚合机检纪律，apps/web 机检不覆盖扩展面故扩展自建单测）。
- README 冒烟清单（spec §5 原文）：md（图表/math/灯箱/导出 HTML）、py（tree-sitter 高亮 + 大纲）、png/mp4/pdf、主题切换联动、toc 左右/收起、per-language 覆盖、**离线（断网）全功能**——每条给可复制的操作步骤与期望结果。

- **验收锚 / e2e**：验收 = `apps/vscode/test/{i18n,liveUpdate}.test.ts` 绿 + `pnpm lint` 绿（新增 ESLint 覆盖块生效：扩展源码内 CJK 字面量被拦——用 `--stdin --stdin-filename apps/vscode/src/x.ts` 断言命中，与 `tools/lint-selfcheck` 同款探针思路）+ `pnpm run typecheck` 绿；**所触 e2e 锚文件：无**（扩展面）。

- [ ] **Step 1: 设置声明 + 扩展 i18n 目录（RED→GREEN）**
  写 `i18n.test.ts`（zh==en 键集、占位符集合相等、locale 选择：zh* → zh-CN / 其余 → en）+ 落 `catalogs/{zh-CN,en}.ts` 与 `core.ts`；`package.json` 补七项 configuration 声明（scope 按上表）。Run: `pnpm vitest run apps/vscode` → RED→GREEN。
- [ ] **Step 2: 实时生效链路**
  `liveUpdate.test.ts`：配置变更 → 重算 → 推送（桩 `postMessage` 断言消息 kind 与载荷）；主题变更 → 令牌重算推送；webview 侧收到 settings → 触发重渲染（桩断言 `applyTheme`/重渲调用）。落 `extension.ts` 订阅与 `main.ts` 消费。
- [ ] **Step 3: ESLint 覆盖块 + README + 门禁 + 提交**
  `eslint.config.js` 新增 `apps/vscode/src/**` 块（CJK 三形态 + bareIntl + `runesOptOut` 展开）；用 `pnpm exec eslint --stdin --stdin-filename apps/vscode/src/probe.ts` 断言 CJK 字面量被拦（探针形态，**不入库**）；README 落设置全表 + per-language 示例 + 冒烟清单。Run: `pnpm vitest run apps/vscode && pnpm lint && pnpm run typecheck` → 全绿。
  ```bash
  git add apps/vscode eslint.config.js && git commit -m "feat(vscode): 设置面——contributes.configuration 七项（per-language 可覆盖项 scope=language-overridable）+扩展自有 zh/en 目录（键集与占位符机检）+配置/主题变更实时生效（不要求重开文件）+ESLint i18n 纪律接入扩展面 +README 设置表与冒烟清单"
  ```

---

### Task 7: 发布 workflow（ovsx/vsce，只落文件不实跑）+ 全量门禁收尾 + 台账

**Files:**
- Create: `.github/workflows/publish-vscode.yml`（tag `v*` + `workflow_dispatch`；构建 → 体积门 → 双渠道发布；**secrets 缺失即跳过发布步**，不实跑）
- Modify: `apps/vscode/package.json`（发布元数据补齐：`repository`/`homepage`/`bugs`/`icon`/`license`；`files`/`.vscodeignore` 口径）
- Create: `apps/vscode/CHANGELOG.md`（vsce 要求项之一）
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
      # → 体积门（check-size.mjs，<100MB fail-fast）→ 上传 dist artifact
    publish-openvsx:
      needs: build
      if: ${{ secrets.OVSX_PAT != '' }}     # 无 secrets → 跳过（不实跑）
      # ovsx publish --pat …（双渠道之一）
    publish-marketplace:
      needs: build
      if: ${{ secrets.VSCE_PAT != '' }}     # 无 secrets → 跳过（不实跑）
      # vsce publish --pat … --no-dependencies
  ```
  **纪律**：①发布步以 `secrets` 存在性为守卫——本仓无 secrets，job 恒跳过（workflow 文件落库即止）；②版本号来源 = tag（`v*` 去前缀）；③双渠道任一失败不影响另一渠道（`continue-on-error` 不设——发布失败须可见）；④**不得把发布写权限授予 build job**（`contents: read` 兜底）。CI 验证边界：workflow YAML 只能本地静态自查（YAML 解析 + 步序走查），真跑须用户配 secrets 后手动触发（台账①）。
- 发布元数据：`publisher: "bhxch"`、`displayName`、`description`、`repository`（仓 URL）、`license: "Apache-2.0"`、`icon`（需 ≥128×128 PNG——若无现成图标则用 `tools/gen-icons.mjs` 同款思路生成一枚最小图标，**不入库二进制大文件**；图标缺失则 vsce 报错，落地时按实测处理并记档）、`categories`、`keywords`、`galleryBanner`（可选）。

- [ ] **Step 1: 发布 workflow + 发布元数据**
  落 `publish-vscode.yml`（按上 Interface）+ `package.json` 发布字段 + `CHANGELOG.md`；本地静态自查：YAML 解析（`node -e "require('yaml')"`…若仓内无 yaml 依赖则用 `python3 -c "import yaml,sys;yaml.safe_load(open(...))"` 断言可解析）+ 步序/权限走查（build job `contents: read`；两发布 job 以 secrets 守卫跳过）。**不实跑发布**。
- [ ] **Step 2: 全量门禁（控制器执行）**
  `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量——注意：扩展用例已由 vitest include 纳入）→ `pnpm --filter web build:e2e` → `pnpm --filter web exec playwright test`（全量双 project；**对比基线：除 T3 三处回归锚外零翻转**——扩展面零 apps/web 行为改动）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转——本计划零 server/ 改动的一致性兑现）→ `pnpm --filter @bhxch/vviewer-vscode build`（体积门 <100MB 通过）→ `git status --porcelain` 净空。
- [ ] **Step 3: review + 台账汇总**
  全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。台账汇总（实施期记档项随任务报告归集）：①**发布首跑 deferred**——OVSX_PAT/VSCE_PAT 由用户在仓外配置，workflow 已落文件但未实跑（约束④）；②**VSCode 活动主题 JSON 精确注入列为增强**（spec §4.2 裁量 4，highlight 包已备件）；③**扩展真机行为无自动化门**——custom editor 接管/CSP 生效/worker 起活靠 README 冒烟清单人工验收（spec §5 定 e2e 非门禁）；④**大文件字节通道内存翻倍**——postMessage 的 `Uint8Array` 为结构化克隆拷贝，>32MB 文件在 host 与 webview 各存一份（阈值化临时文件通道列为后续优化）；⑤**katex 导出 CSS 双实现**——扩展构建期自实现 data URI 内联（与 apps/web `katexExportCss.ts` 同源不同实现），两侧需随 katex 版本同步核对；⑥**扩展名清单依赖生成物**——`generated-extensions.ts` 不入库，扩展构建前须跑 `pnpm gen:sources`（缺件 fail-fast 已落）。

## Errata（执行期勘误）

- 2026-11-18 初版（规划师 H 基于 HEAD `eed783c` 编写；规划期关键实查已内联：packages 零 `$app`/`import.meta.env` 依赖（`rg` 零命中）｜`apps/web/src/lib/viewer.ts` 357 行装配单点与其 `$app`/i18n/store 依赖面｜`@bhxch/vviewer-markdown` 导出面（index.ts:8-102）与 `createMarkdownView`（markdownRenderer.ts:963）/`extractToc`（:381）/`applyTheme`（:1051）｜`MARKDOWN_CSS` 为 TS 字符串常量（css.ts）→ 扩展零 CSS 构建处理｜highlight 包 `serveWorker`（worker.ts:109）/`HighlightClient` 握手与 15s 看门狗（client.ts）/`GrammarTable`（core-parse.ts:20）/`Parser.init` locateFile（:210）/`Language.load`（:417）/queries fetch（:484）｜web 端 worker 与 init 配置形态（highlightClient.ts:414-424）｜pdf worker 裸说明符（render-doc/src/pdf.ts:128-132）与 hex worker `new URL('./binary.worker.ts', import.meta.url)`（render-binary/src/hex.ts:805）｜katex CSS 动态 import（vviewer-markdown/src/pipeline.ts:643）与导出 CSS 自包含形态（export.ts:226）｜`EXTERNAL_IMAGE_POLICIES` 三档（vviewer-sanitize/src/sanitize.ts:55）｜注册表 `installFallbackExtensions` 装序铁律（vviewer-core/src/registry/registry.ts）｜lite grammar 集 34 wasm/46.4MiB + runtime 204KB（apps/web/static/grammars、tree-sitter.wasm）｜queries 341 语言 5.0MB（assets/queries）｜themes.json 214 条含 onelight/serika-dark｜生成物出库面（.gitignore）与 grammar 构建链（build.mjs:40/:347-348、gen-sources.mjs 五产物、.github/actions/setup-grammars）｜vitest include 四项不含 apps/vscode（vitest.config.ts）｜根 typecheck 形态（package.json）与 pnpm workspace `apps/*`（pnpm-workspace.yaml）｜ESLint i18n 纪律作用域仅 apps/web/**（eslint.config.js 块 A/A2/B）｜a11y/i18n 纪律正文（docs/design/frontend-conventions.md §3/§4/§6、semantic-components.md、ui-design-system.md）｜非发布型 workflow 先例（desktop-build-probe.yml））。规划期零 deferred 待决项：spec §6 六项裁量全部内联落定于 Global Constraints；spec §7 五条落定全部承接；约束①~⑥逐条落定于 Global Constraints 与各 Task。
