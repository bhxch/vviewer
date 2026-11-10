# 前端工程规范借鉴落地 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 aelrova 前端规范的可机检门槛移植进 vviewer——ESLint 体系、i18n 全量（zh-CN/en + 设置项）、a11y 机检三件（axe e2e/对比度/valid-compile）、成文约定文档。

**Architecture:** 根单 ESLint flat config（D6 分期激活三条 i18n 规则）；i18n 双模块（`core.ts` 纯实现供 vitest 直测 + `index.svelte.ts` runes 胶水供组件响应式）；按域分文件目录（catalogs/zh-CN|en/{domain}.ts）；axe 违规真修且先于文案抽取（D20 顺序铁律）。

**Tech Stack:** eslint@^9 + typescript-eslint + eslint-plugin-svelte（flat）、@axe-core/playwright、Svelte 5.57 runes、vitest（根 jsdom）、Playwright 双 project。

**Spec:** `docs/superpowers/specs/2026-11-11-frontend-conventions-design.md`（本计划从 spec 论证；实现者两份都读）

## Global Constraints

- **D20 顺序铁律**：a11y 重构 → i18n 基建 → 分域抽取 → 三条 lint 规则激活 → a11y 机检/文档。任何域的抽取都晚于该域 a11y 改动。
- **zh 逐字节等价**：`catalogs/zh-CN/*.ts` 的值必须与被移除字面量逐字节等价（a11y 重构已改的 aria-label 以重构后终值为准）。全量 e2e 中文锚零回归的唯一保证。
- **默认 locale = `'zh-CN'`，无 `'auto'`**（D3）。
- **runes 纪律**（根 AGENTS.md）：`.svelte`/`.svelte.ts` 一律 runes 写法；vitest 直测纯逻辑用 `.ts` 且禁 runes/import runes 模块。组件 import 响应式 `t` 一律经 `i18n/index.svelte`；纯 .ts 模块 import `i18n/core`。
- **不 blanket 关规则**：lint 违规改代码；确属有意形态逐行 `// eslint-disable-next-line <rule>` + 理由注释（可审计豁免）。
- **递延 minor 三档**（用户既有拍板）：可修/挂 CI/知情维持（写明理由），无递延档。
- **e2e 前必 `pnpm --filter web build:e2e`**（裸 build 冲掉 CDN 注入致 GRF 假红）；CI=true 时确认 4173 无残留 preview。
- **commit 纪律**：Conventional Commits（feat/fix/test/docs/chore）、原子化、测试代码随实现同 commit。
- **收尾门**：每任务 `git status --porcelain` 必须净空（自查漏文件）。
- **en 词汇表**（保持一致）：标签页 Tab / 工作区 Workspace / 设置 Settings / 打开方式 Open with / 关闭 Close / 删除 Delete / 确认 Confirm / 取消 Cancel / 搜索 Search / 挂载 Mount / 连接 Connect / 服务器 Server / 文件夹 Folder / 渲染器 Renderer / 字体 Font / 主题 Theme / 布局 Layout / 专注模式 Zen mode / 重试 Retry / 下载 Download / 已加载 Loaded / 刷新 Refresh / 属性 Properties / 目录 Directory / 排除 Excluded / 快速打开 Quick open / 大纲 Outline / 撤销 Undo / 固定 Pin。

## Review Focus

1. **非显示用途字符串误入目录**（each key / `===` 比较 / 事件 detail / 持久化格式 / 对象键——registry label-keyed each 曾致 Svelte 5 prod 整页 500）→ 每抽取任务步骤「D8 审计」强制 `rg` 核查每个被抽取字符串的用法上下文。
2. **zh 目录值漂移**（多空格/标点/插值重组改变渲染输出）→ 每抽取任务「逐字节对照」步：抽取前后受影响域 e2e 定向跑。
3. **en 目录缺键/多键/占位符不一致** → Task 3 聚合测试机器化（键集 ⊆、无孤儿、占位符集合逐 key 相等），任何域目录改动即红。
4. **a11y 锚升级漏改直引文件**（tabbar-menu helper 之外约 5 个文件直引 aria-label 字符串）→ Task 2 `rg` 全仓核查步。
5. **Worker 内文案直用 t()**（gitWorker 等运行在 Worker 读不到主线程 locale，静默返回 fallback 而非报错）→ Task 9 明确「错误码出 Worker、主线程翻译」步骤。
6. **中间 commit lint 红**（D6 分期激活被跳步）→ 每任务收尾步 `pnpm lint` 必绿；三条 i18n 规则只在 Task 10 激活。

---

### Task 1: ESLint 基建与存量清零

**Files:**
- Create: `eslint.config.js`（仓库根）、`tools/lint-selfcheck/lint-fixtures/{sample.markup.svelte,sample.clean.ts}`、`tools/lint-selfcheck/test/lint-config.test.ts`
- Modify: `package.json`（devDeps + `lint` script）、`.github/workflows/ci.yml`、11 处 `prefer-svelte-reactivity` 存量点与其它违规点
- Test: `tools/lint-selfcheck/test/lint-config.test.ts`

**Interfaces:**
- Produces: 根命令 `pnpm lint`（CI web job 复用）；`tools/lint-selfcheck/lint-fixtures/` 目录（Task 10 扩展断言）；fixtures 已 ignore 不进常规 lint。

- [ ] **Step 1: 安装 devDeps**

```bash
pnpm add -w -D eslint @eslint/js typescript-eslint eslint-plugin-svelte globals
pnpm --filter web add -D @axe-core/playwright
```

若 eslint-plugin-svelte 的 svelte peer 解析失败（pnpm strict），根 devDeps 显式补 `svelte`（版本对齐 apps/web）。

- [ ] **Step 2: 写根 `eslint.config.js`（flat）**

结构（完整规则清单=spec §4.1，值为钉死项）：

```js
// 全局 ignores（含 builder check 实测三处：grammar-builder/out、server/worker/.wrangler、.zcode）
// eslint.configs.recommended + tseslint.configs.recommended（非 type-aware）+ svelte.configs['flat/recommended']
// *.svelte：languageOptions.parserOptions = { parser: tseslint.parser, extraFileExtensions: ['.svelte'] }
// 规则块（files: ['**/*.svelte','**/*.ts']）：
//   'svelte/valid-compile': 'error'                    ← a11y 硬门槛载体（D12）
//   'svelte/no-unused-svelte-ignore': 'error'
//   'svelte/no-reactive-functions'|'no-reactive-literals'|'no-immutable-reactive-statements'|
//   'svelte/no-dupe-on-directives'|'no-not-function-handler'|'no-at-debug-tags': 'error'
//   'svelte/no-unnecessary-state-wrap'|'no-extra-reactive-curlies'|'require-event-prefix': 'error'
//   'svelte/prefer-svelte-reactivity': 'error'
//   'svelte/require-each-key': 'error'
//   'svelte/prefer-derived-over-derived-by': 'warn'; 'svelte/no-unused-props': 'warn'
//   '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern:'^_', varsIgnorePattern:'^_', caughtErrorsIgnorePattern:'^_' }]
//   'no-console': ['error', { allow: ['warn', 'error', 'debug'] }]
// 测试放开块（'**/*.test.ts','apps/web/e2e/**','apps/web/e2e-server/**','packages/*/test/**','tools/*/test/**'）：no-console off
// 配置文件块（'*.config.js','*.config.ts','**/*.mjs'）：globals.node
```

i18n 三条规则（CJK/裸 Intl/直读 catalogs）**本任务不落**（D6，Task 10 激活）；文件头注释预留说明。

- [ ] **Step 3: 写 fixtures 与自检测试**

`tools/lint-selfcheck/lint-fixtures/sample.markup.svelte`：含一处 a11y 违规（如带 onclick 的静态 div 无 role/键盘可达）——`valid-compile` 必命中；`sample.clean.ts`：合法代码（`console.warn`、`_` 前缀未用变量）零报错。`lint-config.test.ts` 仿 aelrova：`execFileSync(仓库根 node_modules/.bin/eslint, ['--no-ignore','--format','json', fixture])` 断言命中 message / 合法样例 exit 0；用例超时 30_000；eslint 运行 cwd=仓库根。

- [ ] **Step 4: 跑自检测试验证**

Run: `pnpm vitest run tools/lint-selfcheck`（仓库根）
Expected: PASS（必命中 + 零误伤）

- [ ] **Step 5: 存量清零**

`pnpm lint` 全仓首跑（builder check 实测约 95 错）。逐条修：`prefer-svelte-reactivity` 11 处逐点裁决（D18：响应式消费面→SvelteMap/SvelteSet；非响应式→逐行 disable + 理由）；其余违规改代码不关规则。修完 `pnpm vitest run` 全量确认无连带回归。

- [ ] **Step 6: CI 接线**

`.github/workflows/ci.yml` web job 在 `pnpm install` 之后、`setup-grammars` 之前插 `- run: pnpm run lint`（fast-fail）。根 package.json scripts 增 `"lint": "eslint ."`。

- [ ] **Step 7: 门禁 + 提交**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`（全绿）
```bash
git add -A && git commit -m "feat(lint): 根单 ESLint flat config + lint 自检（机检自身被机检）——a11y 载体 valid-compile、no-console 三放行、存量清零"
```

---

### Task 2: a11y 重构 + axe e2e 域（RED→GREEN）

**Files:**
- Create: `apps/web/e2e/b-a11y-axe.spec.ts`（A11Y- 域）
- Modify: `apps/web/src/app.html`（title）、`apps/web/src/lib/AppShell.svelte`、`TabBar.svelte`、`TabBarMenu.svelte`、`TreeNodeRow.svelte`/`FileTree.svelte`、MetaPanel/openwith 状态栏、`apps/web/e2e/tabbar-menu.ts` helper + 直引文件
- Test: `apps/web/e2e/b-a11y-axe.spec.ts` + 受影响既有锚

**Interfaces:**
- Produces: 全站终版 aria 语义（后续抽取按此终值入目录）；A11Y- e2e 域（CI 默认套件自动覆盖）。

- [ ] **Step 1: 建 RED 探针 spec**

`b-a11y-axe.spec.ts`：状态矩阵 ≥7 态——空壳 / 打开 markdown 样例 / 打开 code 语料 / 设置中心 / QuickOpen 开启 / 目录管理面板 / 全局搜索面板 / TabBarMenu 融合菜单展开。每态：

```ts
const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag21a']).analyze();
expect(results.violations, JSON.stringify(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })))).toEqual([]);
```

夹具复用既有 helper（markdown/code 用既有开文件装置；面板态用既有点击装置）。Run: `pnpm --filter web build:e2e` 后 `pnpm exec playwright test b-a11y-axe` → **Expected: FAIL**，失败清单即整改项（builder check 已探明五类：`document-title`、`label-content-name-mismatch`×2、`nested-interactive`（tab 内嵌 close）、`aria-required-children`（tablist/tree）——以本探针全量清单为准）。

- [ ] **Step 2: 真修违规**

逐条最小改：app.html 补 `<title>vviewer</title>`（`%sveltekit.head%` 之外的静态兜底即可）；`.vv-tabbar-menu` 触发钮 aria-label 纳入可见文本（如「工作区：默认」动态拼接工作区名）；`.vv-status-openwith` 同型（label 含当前可见值或改 aria-labelledby 指向可见文本节点）；tab close 按钮消 `nested-interactive`（优先：close 钮移出 role=tab 元素、以 aria 结构表达，e2e 类名锚不动；若必须保留 DOM 结构则改 tab 的 role 落位）；`.vv-tree`/`.vv-tabbar` 子元素 role 落位修正（treeitem 前置、或非 treeitem 子元素 presentation）。改语义前先 `rg` 该 aria-label/role 在 e2e 的全部直引点（tabbar-menu helper 内部常量一处 + 约 5 个直引文件），同步升级。

- [ ] **Step 3: GREEN**

Run: `pnpm exec playwright test b-a11y-axe`
Expected: 全态零 violation PASS。受影响域（tabs/tree/menu）既有 spec 定向跑零回归（类名锚为主，预期零改动；role 断言若有逐点升级并记录）。

- [ ] **Step 4: 门禁 + 提交**

Run: `pnpm lint && pnpm --filter web typecheck && pnpm vitest run tools`
```bash
git add -A && git commit -m "fix(a11y): 外壳五类 axe 违规真修（title/触发钮 label/nested-interactive/tablist-tree role）+ A11Y- 全页扫描域"
```

---

### Task 3: i18n 基建（core/胶水/目录骨架/format/settings/AppShell/I18N 域）

**Files:**
- Create: `apps/web/src/lib/i18n/core.ts`、`index.svelte.ts`、`format.ts`、`catalogs/zh-CN.ts`、`catalogs/en.ts`、`catalogs/zh-CN/{settings,a11y}.ts`、`catalogs/en/{settings,a11y}.ts`、`core.test.ts`（或 `catalogs.aggregate.test.ts`）、`apps/web/e2e/b-i18n-locale.spec.ts`、`apps/web/src/lib/settings/LanguageA11ySection.svelte`
- Modify: `apps/web/src/lib/stores/settings.ts`（locale/reduceMotion 字段 + normalize）、`apps/web/src/lib/settingsDraft.ts`（validateSettings 枚举手补——builder check 证实不自动覆盖）、`SettingsCenter.svelte`（新节注册）、`AppShell.svelte`（启动+订阅接线）、`app.css`（reduced-motion 双块改写）、`apps/web/src/lib/git/gitUi.ts`（2 处裸 Intl 迁移）
- Test: `apps/web/src/lib/i18n/*.test.ts`、`b-i18n-locale.spec.ts`、既有 settings/settingsDraft 单测

**Interfaces:**
- Produces（Task 4-10 全量消费，签名钉死）:
  - 组件/`.svelte.ts`：`import { t, setLocale, getLocale } from '.../i18n/index.svelte'`；`t(key, args?) => string` 响应式（模板内调用自动追踪）；`key: MessageKey`（= keyof typeof 全量 zh 目录）。
  - 纯 `.ts`：`import { translate as t } from '.../i18n/core'`（同签名，非响应式）。
  - 域目录文件契约：`export const messages = { '<domain>.<module>.<semantic>': '文案' } as const satisfies Record<\`${domain}.${string}\`, string>`；zh 与 en 同键集；`catalogs/zh-CN.ts` 显式 spread 全部域文件并导出 `messages` 与 `MESSAGE_PACKS`（domain→pack 记录）；en 同构。
  - `format.ts`：`formatDate(d: Date): string` / `formatDateTime(d: Date): string`（locale 跟随 getLocale→`zh-CN`/`en-US`；不传 timeZone=浏览器本地时区，git 时间戳语义，注释说明与 aelrova 业务时间戳差异）。

- [ ] **Step 1: core.ts（纯 TS）+ 单测先行**

`core.ts`：`LOCALES = ['zh-CN','en'] as const`；目录双级查表（当前 locale 缺键回落 `'zh-CN'`，两侧皆缺 `throw`）；`interpolate`（`{name}` 替换、未提供占位符保留原样）；`Placeholders<S>`/`TFunction<M>` 类型（aelrova t.ts 逐字移植）；`translate` 严格签名（无占位符禁传参）；`setLocaleInternal`/`getLocale`/`onChange`（发布订阅，纯变量）。测试（TDD 先写）：未知 key 抛错 / en 缺键回落 zh / interpolate 漏参保留 / 严格签名（`@ts-expect-error` 无占位符传参）/ 占位符名推导。

Run: `pnpm vitest run apps/web/src/lib/i18n` → RED→GREEN。

- [ ] **Step 2: 目录骨架 + 聚合机检**

先建 `catalogs/zh-CN/settings.ts` + `catalogs/en/settings.ts`（新设置节的全部文案，§Step 5 先定稿）与 `catalogs/{zh-CN,en}/a11y.ts`（axe/reduceMotion 相关节文案）。聚合测试 `aggregate`：①zh 各域文件 key 数之和 == 聚合总数；②全部 key 首段==其域段；③en 键集==zh 键集（缺键/孤儿键断言，失败输出差集清单）；④**zh/en 逐 key 占位符集合相等**（从值中抽 `{name}` 对比）；⑤registerAll 后查表含全量（如有运行时注入则对齐，无则跳过——单 app 直读目录，无 aelrova registry 注入层，勿生搬）。

- [ ] **Step 3: index.svelte.ts 胶水**

`$state` locale 镜像 + `t()`（读 `$state` 后委托 core.translate）+ `setLocale`（写 $state + core.setLocaleInternal + `document.documentElement.lang = locale`）。源码契约锚单测（vitest 不可导入 .svelte.ts——仓库先例）：断言该文件含 `$state`/`documentElement.lang` 关键形态。

- [ ] **Step 4: format.ts + gitUi 迁移**

`formatDate`/`formatDateTime` 实现 + gitUi.ts 两处 `toLocaleDateString`/`toLocaleString` 改为 import（epoch 秒→`new Date(ts*1000)`）。gitUi 既有单测若锚中文日期串则按 locale 意图升级。

- [ ] **Step 5: settings 字段 + 新设置节**

`settings.ts`：`locale: 'zh-CN'|'en'`、`reduceMotion: 'system'|'on'|'off'` 进 `Settings`/`DEFAULTS`（locale:'zh-CN'、reduceMotion:'system'）；`normalizeSettings` 枚举白名单（脏值归位）。`settingsDraft.ts` `validateSettings` 手补两字段枚举校验（builder check：该函数逐字段手写，不自动覆盖）。`LanguageA11ySection.svelte`（「语言与辅助功能」节）：界面语言下拉（简体中文/English）+ 减少动效下拉（跟随系统/减弱/照常）——控件形态镜像既有 Section 的 select 控件与禁用/脏态语义；`SettingsCenter.svelte` 注册（分组顺序置于「外观」之后）。文案即用 `t()`（本节是目录首批消费者）。SC-01 导航标签 toEqual 列表 +1（明确列举翻转）。

- [ ] **Step 6: AppShell 接线 + CSS 双块 + svelte:boundary 兜底**

AppShell 启动（`loadSettings()` 后）与 `onSettingsChanged` 订阅内：`setLocale(s.locale)`、`document.documentElement.dataset.reduceMotion = s.reduceMotion === 'system' ? 移除属性 : s.reduceMotion`。AppShell 顶层加 `<svelte:boundary onerror={...}>`（D10）：fallback 复用错误卡视觉类名 + 「重载」动作（`location.reload()`）；现有 dispatcher catch→错误卡主通道不动，边界只兜渲染期未捕获异常；若实现期发现与既有错误通道冲突（如错误状态被边界吞掉不放行），按 D10 降级为文档约定并记档。`app.css` reduced-motion 块改写为双块：

```css
@media (prefers-reduced-motion: reduce) {
  :root:not([data-reduce-motion="off"]) *, ::before, ::after { /* 原三条 */ }
}
:root[data-reduce-motion="on"] *, ::before, ::after { /* 同三条 */ }
```

- [ ] **Step 7: I18N e2e 域**

`b-i18n-locale.spec.ts`：I18N-01 默认 zh（设置中心该节标签为中文 + `html[lang]="zh-CN"`）；I18N-02 切 en（UI 点击）→ 标签翻英 + `html[lang]="en"`；I18N-03 reload 持久化 en；I18N-04 切回 zh-CN；I18N-05 减少动效=减弱 → `html[data-reduce-motion="on"]`，=照常 → `data-reduce-motion="off"`，跟随系统 → 属性移除。Run: `build:e2e` 后 `pnpm exec playwright test b-i18n-locale`。

- [ ] **Step 8: 门禁 + 提交**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm exec playwright test b-i18n-locale b-settings-center`
```bash
git add -A && git commit -m "feat(i18n): typed t() 双模块基建（core 纯/胶水响应式）+ zh/en 目录骨架 + locale/reduceMotion 设置项 + I18N- e2e 域"
```

---

### 抽取任务标准流程（Task 4-10 共用；每任务重复以下步骤，替换域清单）

- **S1 盘点**：`rg -n "['\"][^'\"]*[\x{4e00}-\x{9fff}]" <域文件>` + 标记文本/aria-label 形态，列全字符串清单。
- **S2 D8 审计**：逐串核查用法上下文（`rg "<串>"` 看是否 each key/比较/对象键/事件 detail/persist/class 名/role 值）；非显示用途改稳定标识符（id/枚举/key），记入任务报告。
- **S3 抽取**：组件→`t()`（import `i18n/index.svelte`）；纯模块→`translate as t`（import `i18n/core`）；模板 `{t('domain.x.y')}`；多态串（如按钮显隐文案）用键分支不用字符串比较。Worker 内文件（域 F gitWorker）：**错误码出 Worker、主线程 t() 翻译**（Worker 文件不 import i18n）。
- **S4 目录落盘**：`catalogs/zh-CN/<domain>.ts`（逐字节等价，含 Task 2 改过的 aria 终值）+ `catalogs/en/<domain>.ts`（按 Global Constraints 词汇表全量翻译，插值占位符与 zh 一致）；`catalogs/zh-CN.ts`/`en.ts` 注册该域。
- **S5 锚改写**：`rg "<被抽取串>" apps/web/src/**/*.test.ts apps/web/e2e`——单测源码文本锚（全仓 24 文件 107 行，builder check 实测）与 e2e 断言改指目录值或新形态；**e2e 断言不改动**（zh 逐字节等价保证），仅源码文本锚需改。
- **S6 验证**：`pnpm lint && pnpm vitest run`（i18n 三条规则未激活，S3 的新字面量只在目录文件内、本身合规）；受影响域 e2e 定向跑（`pnpm exec playwright test <域spec...>`，先 `build:e2e`）。
- **S7 提交**：原子 commit（feat(i18n): <域> 文案抽取 + en 目录）。

### Task 4: 抽取域 A——壳与标签

**Files:** Modify: `apps/web/src/lib/{AppShell.svelte,TabBar.svelte,TabBarMenu.svelte,tabsModel.svelte.ts,tabOrder.ts,tabBadge.ts,ZenEsc 相关,WorkspaceList.svelte}`；Create: `catalogs/{zh-CN,en}/shell.ts`、`catalogs/{zh-CN,en}/tabs.ts`
**Interfaces:** Consumes: Task 3 `t`/`translate` 签名；Produces: `shell.*`/`tabs.*` 键段。
（步骤=标准流程 S1-S7；AppShell 558 行 CJK 为全仓最大单文件，注释与字符串区分以字面量为准）

### Task 5: 抽取域 B——树与快开

**Files:** Modify: `apps/web/src/lib/{FileTree.svelte,TreeNodeRow.svelte,QuickOpenPanel.svelte,quickOpen.ts}`；Create: `catalogs/{zh-CN,en}/tree.ts`、`catalogs/{zh-CN,en}/quickopen.ts`
（标准流程；TreeNodeRow 递归行含 aria-label 密集面）

### Task 6: 抽取域 C——设置中心

**Files:** Modify: `apps/web/src/lib/{SettingsCenter.svelte,settingsDraft.ts}`、`apps/web/src/lib/settings/*.svelte`（11 节）、`stores/settings.ts`（若有文案残留）；Create: `catalogs/{zh-CN,en}/settings.ts` 扩充
（标准流程；settingsDraft/normalize 的校验提示文案进目录——纯 .ts 用 `translate`；Task 3 新节文案并入本域统一核对；settingsDraft 单测锚文案串的改写在本任务）

### Task 7: 抽取域 D——查看器

**Files:** Modify: `apps/web/src/lib/{ViewerPane.svelte,foreignRenderers.ts,viewer.ts,saveAs.ts,foreignZoom.ts,DownloadProgressCard.svelte,MetaPanel 相关,errorMessageOf 所在模块}`；Create: `catalogs/{zh-CN,en}/viewer.ts`、`catalogs/{zh-CN,en}/errors.ts`
（标准流程；**registry label 重点审计**：渲染器 label 曾为 each key 撞名 prod 500——label 全部改 key 派生显示，`each` key 用渲染器 id；foreignRenderers 的 label 用于显示的进目录、用于标识的改 id）

### Task 8: 抽取域 E——挂载与连接

**Files:** Modify: `apps/web/src/lib/{MountsManager.svelte,mountsSync.ts,ServerConnectForm.svelte,serverConnect.svelte.ts,directS3.ts,directDav.ts,WorkspaceCreate 相关}`；Create: `catalogs/{zh-CN,en}/mounts.ts`
（标准流程；mountsSync 的 console.warn 文案属日志不属 UI——保留中文/英文皆可但**不进目录**，改为英文结构化日志 [vviewer] 前缀原样保留亦可，仅 UI 面字符串抽取）

### Task 9: 抽取域 F——git 与搜索

**Files:** Modify: `apps/web/src/lib/git/*`（含 `gitWorker.ts`）、`apps/web/src/lib/{GlobalSearchPanel.svelte,search 相关}`；Create: `catalogs/{zh-CN,en}/git.ts`、`catalogs/{zh-CN,en}/search.ts`
（标准流程 + **Worker 错误码化强制步**：gitWorker 内所有面向用户的中文串改枚举/错误码上行，主线程映射 `git.*` 键；gitUi/format 日期文案核对 locale 生效）

### Task 10: 抽取域 G——散量收尾 + 三条 lint 规则激活

**Files:** Modify: 其余全部残留文件（`theme.ts、fontsStore.ts、iconTheme.svelte.ts、metaStore.svelte.ts、openFlow.svelte.ts、grammarLayers.ts、highlightClient.ts、FontsSection 等 Task 4-9 未覆盖文件`）；Modify: `eslint.config.js`、`tools/lint-selfcheck/lint-fixtures/sample.script.ts`（新建）+ `lint-config.test.ts`；Create: `catalogs/{zh-CN,en}/notice.ts` 及残余域文件
**Interfaces:** Consumes: Task 3 签名；Produces: lint 三规则全量执法 + 全仓 CJK 字面量清零证明。
- **S1-S5 标准流程**对残留文件（散量串归 notice/errors 域）；纯模块通知文案（`showStatusNotice` 消息构造点）逐个迁移。
- **S6 激活**：`eslint.config.js` 增三条规则（作用域按 spec §4.1：CJK 三形态限 `apps/web/src/lib/**` 除 `lib/i18n/**` 与 `*.test.ts`；裸 Intl apps/web 全域除 `lib/i18n/format.ts`；直读 catalogs 豁免 `index.svelte.ts`/`core.ts`）；fixtures `sample.script.ts`（CJK 字面量/裸 Intl/直读 catalogs 各一处必命中）+ `sample.markup.svelte` 增 SvelteText CJK 命中；`lint-config.test.ts` 断言扩展。全仓 `pnpm lint` 清零（含 e2e 目录例外核对）。
- **S7 验证**：`pnpm lint && pnpm vitest run && pnpm exec playwright test`（受影响域定向）。提交拆两笔：`feat(i18n): 残余域文案抽取` + `feat(lint): CJK/裸Intl/直读catalogs 三规则激活 + fixtures 断言`。

---

### Task 11: token 对比度机检

**Files:**
- Create: `tools/design-tokens/test/contrast.test.ts`
- Test: 同上（根 vitest include `tools/*/test/**` 覆盖——builder check 已核实）

**Interfaces:**
- Consumes: `apps/web/src/app.css`（只读解析）；Produces: token 配对穷举机检（新增 token 必须同步增补清单）。

- [ ] **Step 1: 写测试（TDD：先断言解析器对拍锚）**

移植 aelrova contrast.test.ts 骨架，替换为 vviewer 形态：解析器支持 `#rgb`/`#rrggbb`/`rgb(r g b / a%)`/`rgba(r,g,b,a)`（**非 oklch**）；三块解析——首个 `:root`（light）、`[data-theme-mode="dark"]`、media 内 `[data-theme-mode="system"]`；α 通道对配对底色合成。对拍锚：白≈1/黑≈0/黑白对比≈21/已知 hex→sRGB 对拍一例。配对清单（D14）：文本 ≥4.5:1——fg/bg、fg/side-bg、fg/tab-bg、fg/tab-active-bg、fg/input-bg、fg/statusbar-bg、fg/hover-bg、fg/selection-bg、fg-muted/bg、fg-muted/side-bg、accent/bg、danger/bg、success/bg、warning/bg、accent-2/bg、code-fg/code-bg；非文本 ≥3:1——accent/bg、danger/bg、success/bg、warning/bg、accent-2/bg；hit 系叠加六组合（app.css 注释所载组合，α 合成 code-bg 或双层）≥4.5:1 vs code-fg。**dark 块与 system 块逐 token 等值断言**（两块共有 token 集合）。文件头注释登记 `--ui-border` 不入清单的知情维持理由。

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run tools/design-tokens`
Expected: PASS（builder check 实测现值全达标：文本最低 4.87、hit 最低 5.88）

- [ ] **Step 3: 提交**

```bash
git add tools/design-tokens && git commit -m "test(a11y): token 对比度机检——WCAG 配对穷举 + dark/system 块等值断言"
```

---

### Task 12: 成文文档批

**Files:**
- Create: `docs/design/semantic-components.md`、`docs/design/frontend-conventions.md`
- Modify: `AGENTS.md`（根）、`docs/design/ui-design-system.md`（§11 reduceMotion 双块表述补记）、`README.md`（如有 lint/i18n 面提及则同步）

- [ ] **Step 1: semantic-components.md**——交互复用清单：OVERLAY_SELECTOR 浮层注册、z-index 档位（10/20/30/50/90 现值盘点）、菜单/下拉模式（TabBarMenu 先例）、确认卡/错误卡/状态条通道、焦点环 token、**「新建交互前必须 grep 本清单，命中即复用；新增条目先登记后使用」**机械规则（aelrova SEMANTIC-COMPONENTS 同款精神）。
- [ ] **Step 2: frontend-conventions.md**——分层与组件无副作用约定（props 注入/façade 接线/openFlow 先例）、状态域 `.svelte.ts` vs 纯逻辑 `.ts` 分工、i18n 纪律（key 三段/目录归属/逐字节等价职责/非显示串禁入目录）、a11y 基线（valid-compile/axe/对比度三机检落点 + PR 必查清单 8 条移植）、错误处理约定（错误卡/状态条双通道、svelte:boundary 兜底、console 纪律、Worker 错误码化）、已知边界登记节（border 对比度/packages 文案/非响应式模块切换时机）。
- [ ] **Step 3: AGENTS.md 指针**——追加「前端规范入口」节：触发词（改 UI 文案/新增交互件/无障碍/格式化）→ 指向上述两文档 + spec；不复制条款（单源防漂移）。
- [ ] **Step 4: 提交**

```bash
git add docs AGENTS.md README.md && git commit -m "docs: 语义交互清单与前端开发手册成文——可机检宪法落点登记（aelrova 同款纪律）"
```

---

### Task 13: 全量门禁与收尾（控制器执行）

- [ ] `node tools/fetch-e2e-corpus.mjs`（语料）→ `pnpm lint && pnpm typecheck && pnpm vitest run` → `pnpm --filter web build:e2e` → playwright 全量双 project（对比基线 1394p：除 SC-01/A11Y 重构域列举翻转外零回归）→ `pnpm exec playwright test --config playwright.server.config.ts`（server 档零翻转）→ `git status --porcelain` 净空。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审，推送并守护 GitHub CI（rust/web/e2e 三 job）+ Pages 全绿。
