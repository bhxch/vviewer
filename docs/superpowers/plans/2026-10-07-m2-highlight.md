# M2 tree-sitter 全量高亮 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 代码查看从 hljs 升级为 tree-sitter 高亮（Worker 解析 → 区间+capture → 主题渲染），全量语言资产从 helix/markpad 生成，hljs 降为兜底；语言检测接入 helix languages.json；主题三层之"代码主题"全量上线。

**Architecture:** 新增 `tools/helix-assets`（构建期从 helix/markpad 生成 languages.json/themes.json、拷贝 vendored queries）与 `tools/grammar-builder`（wasm 资产管线）；新增 `packages/highlight`（查询继承展开、web-tree-sitter Worker 运行时、injection 递归、主题映射）；`render-text` 的 code renderer 改为消费 highlight 包，hljs 成为降级路径。

**Tech Stack:** web-tree-sitter 0.27（ABI 13–15）、tree-sitter-wasms 0.1.13（预编译 wasm 主路径）、tree-sitter CLI 0.26.11（自建路径，需 emcc，本机不可用时产出失败清单）、helix `languages.toml`/`runtime/queries`/`runtime/themes` 与 markpad `queries/`/`grammars/`（本地现成资产）。

**Spec:** `docs/superpowers/specs/2026-10-06-vviewer-design.md`（5.2 代码高亮 + 2.3 避坑结论 + 5.10 主题三层 + 决策 Q11/Q14）

## Global Constraints

- 沿用 M1 全局约束（TS strict + noUncheckedIndexedAccess、Angular 中文 commit、`@vviewer/*`）。
- **环境事实**：本机无 emcc/docker/dnf emscripten → 自建 wasm 构建路径必须实现为"检测 emcc，缺失则记入失败清单不失败"；wasm 主路径用 tree-sitter-wasms 预编译产物（npm 已确认可达）。
- helix 资产为 MPL-2.0：`tools/helix-assets` 生成的文件头部加来源注释；queries 拷贝保留原文件内容。
- 高亮中间表示固定：`HighlightInterval = { start: number; end: number; capture: string }`（start 为 UTF-16 代码单元偏移，与 JS 字符串索引一致）。
- injection 递归深度 ≤ 3；解析在 Worker 内，主线程零 tree-sitter 依赖。
- M2 验收：samples 高亮断言（js 文件出现 @keyword 色彩的 span）；主题切换不重解析；5MB 文本高亮完成 < 2s（Worker 内解析，实测记录）。

---

### Task 1: tools/helix-assets——生成 languages.json / themes.json / vendored queries

**Files:**
- Create: `tools/helix-assets/{package.json,generate.mjs,README.md}`
- Create（生成产物，入库）: `packages/highlight/assets/languages.json`、`packages/highlight/assets/themes.json`、`packages/highlight/assets/queries/`（从 markpad 拷贝 286 目录）
- Test: `tools/helix-assets/test/generate.test.ts`

**Interfaces:**
- Produces:
  - `languages.json`: `Record<langName, { scope: string; injections?: string; fileTypes: string[]; globFileTypes?: string[]; shebangs: string[]; grammar: string; aliases?: string[] }>`（解析 helix `languages.toml` 的 `[[language]]` 与 `[[grammar]]`；fileTypes 中的字符串为后缀、`{glob="..."}` 归入 globFileTypes；grammar 默认等于 name）。
  - `themes.json`: `Record<themeName, Record<capture, { fg?: string; bg?: string; modifiers?: string[] }>>`（220 个 helix 主题 TOML → JSON；`[palette]` 已解析内联）。
  - `queries/`：markpad `src-tauri/queries/` 原样拷贝（286 目录，含继承父目录），不改内容。

**关键实现事实（写给实现者）**：TOML 解析用 `smol-toml`（纯 JS，无原生依赖）。helix `languages.toml` 在 `/share/rw/repo/github/helix-editor/helix/languages.toml`；markpad 的在 `/share/rw/repo/markpad-aio/Markpad/src-tauri/languages.toml`（同源含 rev/subpath）。**用 markpad 的那份**（其 grammar 清单带验证过的 subpath 表）。查询源：`/share/rw/repo/markpad-aio/Markpad/src-tauri/queries/`。主题源：`/share/rw/repo/github/helix-editor/helix/runtime/themes/*.toml`（ helix 25.07 版约 220 个；`theme.toml` 与 `base16_*.toml` 跳过）。

- [ ] **Step 1: 写 generate.mjs**（读三处源 → 产出三件资产；产物头注释 `// Generated from helix-editor/helix (MPL-2.0) & markpad-aio queries — do not edit`；smol-toml 解析；主题解析内联 palette 并处理 `fg = "grey2"` 引用）
- [ ] **Step 2: 写失败测试**（languages.json 含 rust 且 fileTypes 含 'rs'、grammar 字段存在；themes.json 含 serika-dark 且 `"comment"` 键存在；queries/ 目录数 ≥ 280 且 `ecma/highlights.scm` 存在且首行含 inherits）
- [ ] **Step 3: 跑测试失败 → 实现 → 跑绿**（generate.mjs 用 `node tools/helix-assets/generate.mjs` 可重复执行，产物幂等）
- [ ] **Step 4: 执行生成并提交产物**（queries 286 目录全部入库——git add 注意 `.gitignore` 的 `*.wasm` 不影响 .scm）
- [ ] **Step 5: Commit** `feat(tools): helix 资产生成器（languages/themes/queries）`

---

### Task 2: packages/highlight 骨架——查询继承展开器与主题映射

**Files:**
- Create: `packages/highlight/{package.json,tsconfig.json}`
- Create: `packages/highlight/src/{queries.ts,theme.ts,index.ts}`
- Test: `packages/highlight/test/{queries.test.ts,theme.test.ts}`

**Interfaces:**
- Produces:
  - `expandQuery(assets: Map<string, {highlights?: string; injections?: string}>, lang: string): { highlights: string; injections: string } | null`——递归解析文件头 `; inherits: a, b`（父在前子在后；只认头部注释区；环检测抛 `Error('循环继承')`；缺父目录记 console.warn 并跳过）。
  - `resolveCapture(theme: ThemeTable, capture: string): ThemeStyle`——最长前缀回退（`function.builtin` 未命中则试 `function`，逐段剥 `.xxx`；`ThemeStyle = { fg?: string; bg?: string; modifiers?: string[] }`）。
  - `themeToCssVars(theme: ThemeTable, captures: string[]): string`——生成 `--vv-ts-<capture 点转->>: <color>` 文本。
  - 类型：`ThemeTable = Record<string, ThemeStyle>`。

- [ ] **Step 1: 写失败测试**（构造内联 scm 字符串测继承：子 `; inherits: parent` + 父内容 → 展开后父在前；多层链 a→b→c；环 a→b→a 抛错；resolveCapture：命中精确/回退父级/未命中返回 `{}`）
- [ ] **Step 2: 红→绿→Commit** `feat(highlight): 查询继承展开器与主题最长前缀映射`

---

### Task 3: grammar-builder——wasm 资产管线

**Files:**
- Create: `tools/grammar-builder/{package.json,build-list.mjs,build.mjs,README.md}`
- Create（产物，入库）: `apps/web/static/grammars/manifest.json` + `apps/web/static/grammars/*.wasm`（子集，见下）
- Modify: `.gitignore`（允许 `apps/web/static/grammars/*.wasm` 入库——wasm 是构建产物但 M2 决定入库以保证纯前端版开箱可用；单文件上限 3MB，超限跳过记清单）

**Interfaces:**
- Produces:
  - `manifest.json`: `{ generatedAt: string; source: 'tree-sitter-wasms' | 'self-built'; grammars: Record<lang, { file: string; abi: number | null; sha256: string; aliases: string[] }> }`（lang 与 languages.json 键对齐；aliases 来自 `injection-regex` 无法可靠反解，M2 用手工别名字典 `tools/grammar-builder/aliases.json` 覆盖常见别名 js/ts/py/rs/sh/c++/golang 等 ≥30 条）。
  - `build-list.mjs`：读 helix languages.toml + markpad grammar_info.json 的 subpath 表 → `build-list.json`（判据：grammar 源目录 `src/parser.c` 实际存在）。
  - `build.mjs`：两模式——`--from-wasms`（从 `node_modules/tree-sitter-wasms/out/*.wasm` 按名字典映射拷贝到 static/grammars/，计算 sha256，写 manifest）与 `--self-build`（对 build-list 逐个 `tree-sitter build --wasm`，检测 emcc 缺失则整批记 `failure-list.json` 不抛错）。M2 主跑 `--from-wasms`。
- tree-sitter-wasms 的文件名是 grammar 仓库名（如 `tree-sitter-typescript.wasm` 对 typescript + tsx 两个？——实测确认其 out/ 清单后写映射；aliases.json 同步校正）。**执行者第一步：`pnpm add -w -D tree-sitter-wasms` 后 `ls node_modules/tree-sitter-wasms/out/ | head -50` 实测清单再写映射字典。**

- [ ] **Step 1: 探明 tree-sitter-wasms 产物清单并写 aliases.json 初版（≥30 别名）**
- [ ] **Step 2: build-list.mjs + 测试**（判据逻辑：存在 parser.c 的目录入选；产出计数断言 ≥ 250）
- [ ] **Step 3: build.mjs --from-wasms + 运行**（产物入 static/grammars/；wasm 总量入库上限 80MB，超出按「高频语言优先」截断并记 manifest.source 注释）
- [ ] **Step 4: build.mjs --self-build 路径 + emcc 检测**（本机跑一次确认产出 failure-list 而非崩溃）
- [ ] **Step 5: Commit** `feat(tools): grammar wasm 资产管线（tree-sitter-wasms 主路径 + 自建路径 + 失败清单）`

---

### Task 4: packages/highlight——Worker 解析运行时

**Files:**
- Create: `packages/highlight/src/{types.ts,worker.ts,client.ts}`
- Test: `packages/highlight/test/runtime.test.ts`（jsdom + 真实 wasm：用 tree-sitter-wasms 里最小的 grammar（如 `query` 或 `bash`）实测解析与区间）

**Interfaces:**
- Produces:
  - `types.ts`: `HighlightInterval = { start: number; end: number; capture: string }`；`HighlightRequest = { id: number; text: string; lang: string; injectionsDepth?: number }`；`HighlightResponse = { id: number; ok: boolean; intervals?: HighlightInterval[]; error?: string; engine?: 'tree-sitter' | 'hljs' }`。
  - `client.ts`: `class HighlightClient { constructor(worker: Worker); highlight(text: string, lang: string): Promise<HighlightInterval[]>; cancelAll(): void; dispose(): void }`——请求去重：同 lang 连续请求取消前一个未完成者。
  - `worker.ts`: Worker 入口——`import { Parser, Language } from 'web-tree-sitter'`；`Parser.init({ locateFile })` 指向 static 资产；grammar wasm 按 lang 缓存（`Language.load(url)`）；查询经 Task 2 的 expandQuery 编译（`lang.query(scm)`）；**区间生成**：`query.captures(tree.rootNode)` → `{start: node.startIndex, end: node.endIndex, capture: name}` → 按 `(start asc, end desc)` 排序 → 渲染端用"已覆盖跳过"策略去重叠（不在此处去重，保留全量供主题切换）；**injection**：解析 injections.scm 的 `@injection.language` capture 与 `#set! injection.language` 属性 → 对子文本递归 `highlight(subText, subLang, depth+1)`（depth>3 停止）；`injection.include-unnamed-children`/`@injection.shebang` 做 shim（`#set!` 属性经 `query` 的 setProperties 读取；web-tree-sitter 0.27 的 Query API 支持有限时降级：从 scm 文本静态预解析 `#set!` 行——执行者按实测 API 选择，报告说明）。
  - Worker 内解析失败/语言无 grammar/无查询 → 返回 `{ok:false, error}`，由上层决定降级 hljs。
- web-tree-sitter 依赖：`packages/highlight` dependencies 加 `web-tree-sitter@^0.27.0`；`tree-sitter.wasm`（runtime）与 grammar wasm 都放 `apps/web/static/`（Worker locateFile 指过去）。**Vite Worker 构建**：client 用 `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`，Vite 原生支持。

- [ ] **Step 1: 写 runtime.test.ts 失败用例**（加载真实 bash grammar + bash highlights.scm：`echo hello` → 期望存在 capture 为 `@string` 或非空区间数组；注入：markdown 样例文本含 ```` ```js ```` 围栏 → 递归返回 js 区间）
- [ ] **Step 2: 实现三个文件 → 测试绿**（Worker 在 vitest jsdom 的兼容方案：`new Worker(URL)` jsdom 不支持——用 vite-plugin-...？不引入新插件；改用 vitest 的 `environment: 'jsdom'` + `@vitest/web-worker` mock？**执行者裁决空间**：优先尝试 vitest `deps.interopDefault` + `new Worker` stub 方案；若不可行，把核心解析逻辑提取为 `core-parse.ts`（Worker 与测试共用），测试直接调用 `core-parse.ts` 绕过 Worker，Worker 只是薄壳——报告说明选择）
- [ ] **Step 3: Commit** `feat(highlight): web-tree-sitter Worker 解析运行时（区间/注入/取消）`

---

### Task 5: 代码渲染器升级——tree-sitter 主路径 + hljs 兜底 + 降级链

**Files:**
- Modify: `packages/render-text/src/code.ts`（重写渲染管线）
- Modify: `apps/web/src/lib/viewer.ts`、`apps/web/src/lib/ViewerPane.svelte`（接入 HighlightClient 生命周期——client 随应用单例，tab 切换 cancelAll）
- Test: `packages/render-text/test/code.test.ts`（扩展）

**Interfaces:**
- Produces（code.ts 内部结构，外部 Renderer 接口不变）:
  - 渲染流程：`render(buffer, target, source, det)` → 语言检测（`det.lang` 或由扩展名查 languages.json）→ `highlightClient.highlight`（若超阈值直接跳过）→ 区间 → 按行分配渲染。
  - 降级链：≤5MB tree-sitter（失败→hljs 整文件）；5–20MB hljs 按可视窗口分块（实现：虚拟滚动 onRange 时对可见行范围跑 hljs.highlight 该行段，缓存已高亮行）；>20MB 纯文本。
  - 区间→行渲染：区间按 start 排序后切到行（复用 splitHighlightedLines 的思路但输入是区间而非 hljs HTML）；行内重叠区间"已覆盖跳过"。
  - `renderCode` 返回对象新增 `getScrollHost(): HTMLElement`（供 ViewerPane 滚动恢复接 `.vv-code-pre`——修复 M1 遗留"codeRenderer 滚动持久化无效"）。
  - ViewerPane：滚动监听改造——code tab 用 `renderCode` 返回的 setScrollTop/scrollTop，其他 tab 用外层容器（现状）。
- 语言检测接入：`apps/web` 侧在 dispatch 前把 languages.json 的扩展名映射并入 `det.lang`（实现为 `packages/highlight/src/langdetect.ts` 导出 `detectLanguage(ext: string, text?: string): string | null`——先查 fileTypes 精确表，shebang 检测读首行正则 `^#!\s*(?:\S*[/\\](?:env\s+(?:-\S+\s+)*)?)?([^\s.\d]+)` 映射 languages.json 的 shebangs）。

- [ ] **Step 1: 写失败测试**（langdetect：'rs'→rust；shebang `#!/usr/bin/env python3`→python；code.ts 降级链阈值函数 `resolveStrategy(size)`→'tree-sitter'|'hljs-block'|'plain'；区间行分配纯函数 `assignIntervalsToLines(intervals, lineOffsets)`）
- [ ] **Step 2: 实现并接 ViewerPane → 全部验证绿**
- [ ] **Step 3: Commit** `feat(render-text): tree-sitter 主路径高亮与降级链（hljs 兜底/分块/纯文本）`

---

### Task 6: 主题系统——代码主题全量与切换零重解析

**Files:**
- Modify: `apps/web/src/app.css`（主题变量注入点样式）
- Create: `apps/web/src/lib/theme.ts`（主题状态与注入）
- Modify: `apps/web/src/lib/TopBar.svelte`（代码主题下拉：精选置顶 6 个 + 全量 220 按 A-Z 分组；亮暗各自记忆——存 settings 的 `codeThemeLight`/`codeThemeDark`）
- Modify: `apps/web/src/lib/stores/settings.ts`（Settings 加 `codeThemeLight: string; codeThemeDark: string`，默认 `serika-dark` / `one-light`——以 themes.json 实际键名为准）
- Test: `apps/web/src/lib/theme.test.ts`

**Interfaces:**
- Produces: `applyCodeTheme(name: string, mode: 'light' | 'dark'): void`——resolveCapture 全量捕获集 → 生成 `<style id="vv-code-theme">` CSS 变量注入；`listThemes(): string[]`。切换主题只换 CSS 变量（区间已在 DOM 类名上），零重解析。
- 捕获名→CSS 类：渲染 span 时 class 用 `ts-<capture 转义>`，颜色 `var(--vv-ts-<...>, inherit)`。

- [ ] **Step 1: 写失败测试**（applyCodeTheme 后 document 存在 style#vv-code-theme 且含 `--vv-ts-keyword`；两次 apply 不叠加 style 节点）
- [ ] **Step 2: 实现 + UI 下拉 → build 绿**
- [ ] **Step 3: Commit** `feat(web): 代码主题全量接入（helix 220 主题、亮暗记忆、零重解析切换）`

---

### Task 7: M2 E2E 与性能验证

**Files:**
- Create: `apps/web/e2e/m2.spec.ts`、`samples/m2/{sample.rs,sample.md}`
- Modify: `apps/web/e2e/m1.spec.ts`（若 hljs→tree-sitter 改动影响 m1 断言，同步修正）

**Interfaces:**
- 验收断言：打开 sample.rs → `.vv-code-pre` 内出现 `ts-keyword` 类 span（tree-sitter 生效，非 hljs）；切换代码主题 → span 类名不变、style#vv-code-theme 内容变化（零重解析的证据）；构造 6MB 文本文件（E2E 内生成到 tmp 目录通道）→ 打开后引擎显示为 hljs 分块或纯文本（降级链生效）。性能实测：`console.time` 在 Worker 外包裹 highlight 调用，5MB 高亮 <2s（记录到报告，超阈值不阻塞但必须记录数值）。

- [ ] **Step 1: 样例与测试**
- [ ] **Step 2: 跑绿（连续 3 次）**
- [ ] **Step 3: Commit** `test(web): M2 E2E（tree-sitter 高亮/主题零重解析/降级链）`

---

## Self-Review 记录

- Spec 覆盖：5.2 的前端 wasm 路线（T3/T4/T5）、hljs 兜底（T5）、降级链（T5）、继承展开（T2）、injection（T4）、主题（T1/T6）、languages.json 检测（T5 的 langdetect）；服务端原生高亮属 M6。
- 类型一致性：HighlightInterval 全文一致；expandQuery/resolveCapture 在 T4/T6 的消费签名一致。
- 风险标注：T4 的 vitest Worker 兼容与 web-tree-sitter Query API 的 `#set!` 支持是两个实测决定点，均已给执行者裁决空间与降级方案。
