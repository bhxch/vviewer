# 前端工程规范借鉴落地（aelrova 对照）设计

- 日期：2026-11-11
- 状态：已批准（用户 /goal：按 2026-11-10 对照结论的「一、高价值」与「二、机制可借」清单执行，过程中自主决策；i18n 与 a11y 一并支持，该加设置项自主添加；形成 spec 后自动 writing-plans → SDD → 全量 code review → 修复全部 C/I/M → 推送 CI 绿）
- 参照系：aelrova（/share/rw/repo/aelrova）——`docs/规范/前端项目规范.md`、`docs/规范/前端可访问性与国际化规范.md`、`docs/规范/前端UI组件与样式规范.md`、`frontend/ui-shared/src/lib/i18n/*`、`frontend/ui-expenses/eslint.config.js`、`frontend/ui-expenses/tests/lint-config.test.ts`、`frontend/ui-shared/tests/{contrast.test.ts,a11y.ts}`、`frontend/ui-shell/tests/i18n-aggregate.test.ts`

## 1. 背景与目标

vviewer 前端现状（2026-11-10 对照盘点）：设计系统与文档体系发达（ui-design-system.md 红线、46+ 篇 e2e 场景文档、runes 编译硬执法、CI chunk 预算门禁），但**机器强制面近乎为零**——无 ESLint/format 工具链（CI 无 lint 步骤）、文案全量中文硬编码、a11y 无自动化验证（axe/对比度均无机检）、模态/浮层/z-index 靠惯例未成文。aelrova 的核心价值不在技术栈（shadcn/Tailwind/apigen 均不适用），而在**「每条规则要么落在可机检载体（编译器/ESLint/TS 类型/Vitest），要么落在 PR 必查清单，二者皆无不写入」的成文宪法**及其全套可执行载体。

本设计把对照结论中的可借项全部落地为 vviewer 的机器门槛与成文约定：

1. **ESLint 体系 + 机检自身被机检**（根单 flat config、svelte 全系 a11y 规则 error、runes 健壮性、lint-fixtures 必命中样例 + 真实 eslint 驱动自检测试、CI 接线）；
2. **i18n 全量落地**（aelrova typed t() 移植 + runes 响应式 locale、zh-CN/en 双目录、设置项、CJK 字面量禁令、聚合机检、Intl 唯一通道）；
3. **a11y 机检三件**（token 对比度 Vitest 机检、e2e 全页 axe 扫描、a11y lint 硬门槛）+ 减少动效设置 + `svelte:boundary` 兜底；
4. **成文约定文档**（语义交互清单「先登记后使用」、前端开发手册、AGENTS.md 规范入口指针）。

## 2. 非目标与边界

| 项 | 处置 | 理由 |
|---|---|---|
| shadcn/Tailwind/apigen/多仓依赖树 | 不借 | 技术栈不适用；vviewer 有自有 token 体系且明令禁外部 CSS 框架 |
| prettier/格式化改革 | 不做 | 不在借入清单；避免全仓无谓 churn |
| packages/*/src 的 i18n 抽取 | v1 不做（知情边界） | 包是独立发布面（@bhxch/vviewer-*），内部文案默认 zh-CN 不影响 app 全量中英切换；约 150-200 行字符串级 CJK 留待包侧需求出现时立项。markdown 包已有 `ui` 选项缝，若实现期确认 ≤20 键顺手接线（stretch，不设门禁） |
| RTL / 物理方向类禁令 | 不做 | vviewer 无 Tailwind 工具类体系；CSS 侧逻辑属性改造是独立议题 |
| WCAG 2.1 AA 全量达标 | 不承诺（aelrova 同款定级） | 定级为「关键可用性硬基线」：机检四门槛 + 评审必查清单；升级触发另立项 |
| `--ui-border` 对比度进机检清单 | 不进（知情维持） | GitHub Primer 同款：border #d0d7de/#30363d 对页面底 <3:1，属视觉分层设计而非缺陷；改色即全站视觉漂移。在对比度测试头部注释与本 spec 双登记 |
| 递延 minor | 不设递延档 | 用户既有拍板：修/挂 CI/维持三档，其余全修 |

## 3. 决策记录（以下均为本次自主决策）

- **D1 根单 ESLint flat config**：vviewer 是单仓 monorepo，不做 aelrova 的每仓一份 config；根 `eslint.config.js` 全仓覆盖 + 目录级 override。不启用 type-aware lint（`projectService`）——跨包 tsconfig 工程复杂且 svelte-check + `tsc -b` 已承载类型机检，lint 保持秒级。
- **D2 console 策略**：`no-console: ['error', { allow: ['warn', 'error', 'debug'] }]`。实测 apps/web 非测试代码 56 处 console 全部是结构化 warn/error/debug 观测留痕（降级警告、错误留痕、`?vvWorkerDebug` 探针），合法形态；禁的是 `log`/`info`（当前零命中，零 churn 执法）。
- **D3 locale 设计**：`settings.locale: 'zh-CN' | 'en'`，**默认 `'zh-CN'`，不设 `'auto'`**。理由：①Playwright/CI 浏览器默认 locale 为 en-US，auto 语义会使全量 e2e（约 1.4 万行中文锚）整体翻转，风险不可控；②现有用户零迁移；③en 覆盖是显式升级路径。`html[lang]` 随 locale 同步。
- **D4 响应式 t()（双模块，builder check Q3 裁决）**：根 vitest 无 svelte 插件，纯 `.ts` 模块导入含 `$state` 的 `.svelte.ts` 直接 `ReferenceError`（实测），且 AGENTS.md 规定 vitest 直测纯模块禁 runes——因此拆两层：`core.ts`（**纯 TS**：目录查表/`translate`/`setLocale` 内部实现/onChange 发布订阅，承载全部单测）+ `index.svelte.ts`（**响应式胶水**：`$state` locale 镜像 + `t()` 包装读 `$state`，组件模板/effects 内调用即自动追踪重渲；`setLocale` 经此写入 $state 与 core 双侧）。33 个单测文件消费的模块（settingsDraft 等）一律 import `core.ts`；组件 import `index.svelte.ts`。模板用法保持 `t('key')` 不变。非响应式模块调用时取当下 locale，切换后对新消息生效——成文写明。`createSubscriber` 方案与「根 vitest 加 svelte 插件」方案均否决（前者依赖 svelte/internal 运行时面，后者改全仓 transform 且违反 AGENTS.md 后缀纪律）。
- **D5 目录组织**：`apps/web/src/lib/i18n/`——`index.ts`（门面：t/locale/setLocale/getLocale）、`registry.ts`（interpolate/类型层）、`format.ts`（Intl 唯一通道：formatBytes/formatDate/formatDateTime）、`catalogs/zh-CN/{domain}.ts` + `catalogs/en/{domain}.ts`（**按域分文件**，跨 SDD 任务并行不冲突）。key 三段 `{域}.{模块}.{语义}`，域清单：shell/tabs/tree/quickopen/settings/viewer/mounts/git/search/notice/errors/a11y。`satisfies Record<`${domain}.${string}`, string>` 锁首段。
- **D6 lint 分期激活**：CJK 字面量禁令 / 禁裸 Intl / 禁直读 catalogs 三条规则**与文案抽取同步**——抽取完成前的中间 commit 保持 lint 绿（先例：门禁必须逐 commit 可跑），三条规则在最后一个抽取任务落地时激活，lint-fixtures 样例文件从基建任务即入库（eslint ignores），自检测试断言随激活同 commit 落地。其余规则（a11y/runes/no-console 等）基建任务即全量激活并清零存量。
- **D7 抽取保真不变式**：zh-CN 目录值必须与被移除的字面量**逐字节等价**（全量 e2e 约 1.4 万行中文锚零翻转的唯一保证）。每任务收尾跑受影响域 e2e。
- **D8 非显示字符串审计纪律**：抽取时逐一核实字符串是否用于**非显示用途**（`{#each}` key【label-keyed each 曾致 Svelte 5 prod 整页 500】、`===` 比较、事件 detail、持久化格式、map 键）。非显示用途一律改为稳定标识符（key/id/枚举），不进目录。
- **D9 axe 断言口径（builder check Q1 裁决）**：e2e 全页扫描 `@axe-core/playwright`，规则集 wcag2a+wcag21a（aelrova 同款，A 档；color-contrast 属 AA 档不在集内，由对比度机检承接），**零 violation 断言**——扫出的违规必须真修（改产品），不允许 exclude 豁免。builder check 实测既有外壳确有真违规（`label-content-name-mismatch`：`.vv-tabbar-menu` 触发钮 aria-label 与可见文本不含、`.vv-status-openwith` 同型；`nested-interactive`：`.vv-tab` 内嵌 close 按钮；`aria-required-children`：tablist/tree 子元素 role 落位；`document-title`：无 `<title>`）——全部按真缺陷修复，**a11y 重构任务排在文案抽取之前**（先定稿 UI 字符串与 aria 语义，抽取再按终值入目录，保逐字节等价基线）；受影响 e2e 锚同步升级（tabbar-menu helper 内部常量一处 + 5 个直引文件 + role 相关锚逐点核），SC-01 导航标签 toEqual 列举按新增节翻转。已识别的可达性修复方向：触发钮 aria-label 纳入可见文本（如「工作区：默认」）、`.vv-status-openwith` 同型、tab 关闭钮改 aria 委托或 role 落位内层、tree/tablist role 结构修正、app.html 补 `<title>`——具体以实现期逐条最小改方案为准，e2e 锚以类名为主不受 role 调整影响的先核对后改。
- **D10 svelte:boundary**：AppShell 顶层加单一边界（Svelte 5.57 支持），fallback 复用错误卡视觉 + 「重载」动作。现有渲染错误主通道（dispatcher catch → 错误卡）不动；边界只兜「渲染期未捕获异常」这一层（曾因 each_key_duplicate 在 prod 整页 500 的前科）。若实现期发现与既有错误通道冲突，降级为文档约定并记档。
- **D11 reduceMotion 设置**：`settings.reduceMotion: 'system' | 'on' | 'off'`（默认 system=现状）。CSS 落地：现 `@media (prefers-reduced-motion: reduce)` 块改写为「media 命中且 `:root:not([data-reduce-motion="off"])`」+「`:root[data-reduce-motion="on"]`」双块同体。设置中心新增「语言与辅助功能」节（locale + reduceMotion 两控件）。
- **D12 a11y lint 载体（builder check Q2 裁决）**：eslint-plugin-svelte 3.x **没有 `a11y-*` 前缀规则**（aelrova 的动态枚举实为静默空转——已证伪），Svelte 编译器 a11y 警告的真实 lint 载体是 `svelte/valid-compile: 'error'`（编译器 a11y 警告报为 lint error）。本仓 svelte-check 已 0E0W，存量即零；硬门槛意义 = 回归在 CI lint 一环即拦。配套：fixtures 增 a11y 违规必命中样例（如 click handler 无键盘可达的静态元素）断言 valid-compile 命中，`no-unused-svelte-ignore` 照置 error。a11y 规则枚举断言（spec 初版设想）作废。
- **D13 fixtures 与自检测试落位**：`tools/lint-selfcheck/lint-fixtures/`（必命中样例 + 合法样例）+ `tools/lint-selfcheck/test/lint-config.test.ts`（`--no-ignore` 显式驱动真实 eslint 断言命中）——命中根 vitest include `tools/*/test/**`（builder check 已核实）。对比度机检落 `tools/design-tokens/test/contrast.test.ts`（解析 `apps/web/src/app.css`；builder check 实测现值全部达标：文本配对最低 4.87:1、hit 叠加最低 5.88:1，dark 块与 system 块 30 token 逐值相等——零 token 改动）。
- **D14 对比度配对清单**：文本 ≥4.5:1——fg/bg、fg/side-bg、fg/tab-bg、fg/tab-active-bg、fg/input-bg、fg/statusbar-bg、fg/hover-bg? (hover-bg 是背景，fg/hover-bg 用于 hover 行文字，纳入)、fg-muted/bg、fg-muted/side-bg、accent/bg、danger/bg、success/bg、warning/bg、accent-2/bg、code-fg/code-bg、selection-bg 承载（fg/selection-bg）；非文本 ≥3:1——accent/bg（焦点环/链接实底）、danger/bg、success/bg、warning/bg、accent-2/bg。hit 系叠加色（--vv-hit-line-active 等 α 混合 code-bg 后 ≥4.5:1）按既有实测口径纳入。**system 块与 dark 块逐 token 等值断言**（防三块级联漏写漂移，§12.1 事故防线）。清单穷举、新增 token 同步增补。
- **D15 en 目录翻译**：全量覆盖为交付目标（任务内即译），`t()` 对 en 缺键回落 zh-CN 兜底 + 聚合测试断言 en 键集 ⊆ zh 键集且无多键。翻译词汇表随域任务产出自纠（设置/标签页/工作区等高频词保持一致）。
- **D16 文档三件**：`docs/design/semantic-components.md`（交互复用清单：OVERLAY_SELECTOR/浮层 z-index 档位/菜单模式/确认卡/状态条/错误卡/焦点环，先登记后使用）；`docs/design/frontend-conventions.md`（开发手册：分层与组件无副作用约定、状态域 .svelte.ts/纯逻辑 .ts 分工、i18n 纪律、a11y 基线与 PR 必查清单 8 条、错误处理约定、已知边界登记）；根 `AGENTS.md` 追加规范入口指针（触发词 → 两份文档，单源防漂移，不复制条款）。
- **D17 CI 接线**：ci.yml web job 在 typecheck 前插 `pnpm run lint`；根 package.json 增 `lint` script（`eslint .`）。
- **D18 `prefer-svelte-reactivity` 逐点裁决（builder check 实测 11 处存量）**：规则置 error，逐点核处置——该 Map/Set 若有响应式消费面（驱动渲染）则改 `SvelteMap`/`SvelteSet`；确属非响应式用途（纯数据结构）则逐行 `// eslint-disable-next-line` + 理由注释（aelrova「豁免申请」同款语义，逐条可审计），不 blanket 关规则。
- **D19 抽取连带面（builder check 实测）**：①三条 i18n 规则实际命中 **1020 处 / 67 文件**（早先行数估计系行数口径膨胀）；②**24 个单测文件的 107 行源码文本断言**会因字面量迁入目录而失效——抽取任务必须逐域盘点并改写这些锚（锚值改指向目录文件或新调用点）；③**Worker 内文案**（gitWorker 等）读不到主线程 locale——改为 Worker 返回错误码、主线程翻译；④`gitUi.ts` 两处裸 Intl 迁 `format.ts`（§4.2）；⑤app.html 补 `<title>`（a11y 重构任务）。
- **D20 任务顺序铁律**：a11y 重构（定稿 aria 语义与 UI 字符串）→ i18n 基建 → 分域抽取（每域抽取晚于该域 a11y 改动）→ 三条 lint 规则激活 → a11y 机检与文档批。SC-01 与 a11y 锚升级是**明确列举的有意翻转**，其余既有用例零回归。

## 4. 详细设计

### 4.1 ESLint 体系

devDeps（根）：`eslint@^9`、`@eslint/js`、`typescript-eslint`、`eslint-plugin-svelte`、`globals`；e2e 侧 `@axe-core/playwright`。

根 `eslint.config.js`（flat）结构：

1. **全局 ignores**：`**/node_modules/**`、`**/dist/**`、`**/build/**`、`**/.svelte-kit/**`、`**/.temp/**`、`**/.zcode/**`、`**/coverage/**`、`apps/web/static/**`、`apps/web/test-results/**`、`apps/web/playwright-report/**`、`packages/vviewer-render-diagram/src/markdown/svgbob-wasm-gen/**`、`tools/grammar-builder/out/**`、`server/worker/.wrangler/**`、`tools/lint-selfcheck/lint-fixtures/**`（自检测试以 `--no-ignore` 驱动）——后三项为 builder check 实测补充（缺则十万级误报）。
2. **基础层**：`eslint.configs.recommended` + `tseslint.configs.recommended`（非 type-aware）+ `svelte.configs['flat/recommended']`；`.svelte` 经 svelte-eslint-parser + tseslint.parser。
3. **svelte 规则块**（`*.svelte` + `*.ts`）：`valid-compile: 'error'`（a11y 硬门槛载体，D12）、`no-unused-svelte-ignore`、legacy 检测六条、runes 健壮性五条（`prefer-svelte-reactivity` 见 D18）、`require-each-key`、`require-event-prefix`、`prefer-derived-over-derived-by`/`no-unused-props` warn、`@typescript-eslint/no-unused-vars`（`^_` 豁免）、`no-console`（allow warn/error/debug；builder check 复核实为 50 处全为 warn/error/debug）。
4. **测试与 e2e 放开块**：`**/*.test.ts`、`apps/web/e2e/**`、`apps/web/e2e-server/**`、`packages/*/test/**`、`tools/*/test/**` → `no-console: off`。
5. **i18n 纪律块**（分期激活，D6）：CJK 字面量三形态（`Literal`/`TemplateElement`/`SvelteText`，作用域 `apps/web/src/lib/**` 除 `lib/i18n/**` 与 `*.test.ts`）、禁裸 `Intl.*`/`toLocale*`（apps/web 全域，`lib/i18n/format.ts` 豁免）、禁直读 catalogs（`no-restricted-imports` patterns，豁免 `lib/i18n/index.ts` 与 `lib/i18n/registry.ts`）。
6. **配置文件块**：`*.config.js`/`*.mjs` 给 node globals。

**机检自身被机检**（aelrova 同款移植）：fixtures 三件——`sample.script.ts`（CJK/裸 Intl/直读 catalogs 必命中）、`sample.markup.svelte`（SvelteText CJK 命中）、`sample.clean.ts`（合法零报错防误伤：`\u` 转义正则、`console.warn`、i18n 门面导入不命中）；`lint-config.test.ts` 断言逐条命中/零误伤（eslint CLI spawn，用例超时 30s）。svelte a11y 规则的动态 error 枚举另有静态断言：配置模块导出规则计数 > 0 且抽查三条具名规则在列（防枚举失效静默为空）。

存量清零口径：`pnpm lint` 必须绿——违规改代码不 blanket-disable；确属规则误伤的逐条报评审裁决。

### 4.2 i18n 体系

**类型与运行时**（aelrova t.ts 移植 + 响应式扩展）：

- `Placeholders<S>` 模板字面量类型推导插值参数名；`TFunction<M>` 无占位符禁传参；`createT` 不引入（单 app 无包级目录，全局 t 直读聚合目录即可）；en 缺键回落 zh-CN，两侧皆缺抛错（对齐 aelrova「未知 key 抛错」）。
- locale 响应式：`i18n.svelte.ts` 导出 `$state` locale 与 `setLocale()`；`t()` 内 `catalogs[locale] ?? catalogs['zh-CN']` 两级查表。`setLocale` 同步 `document.documentElement.lang`。
- `interpolate`：`{name}` 占位符替换，未提供的占位符保留原样（aelrova 同款，漏参可发现）。

**目录与聚合机检**（移植 i18n-aggregate.test.ts 三道断言 + 扩展）：

1. zh 各域文件 key 数之和 == 聚合总数（spread 静默覆盖即红）；
2. 全部 key 首段 == 其域文件域段（`satisfies` 编译期 + 运行时双锁）；
3. en 键集 ⊆ zh 键集（无孤儿键），en 覆盖数 == zh 总数（全量覆盖目标，缺键在测试输出明示清单——回落机制是安全网不是欠账通道，收口时必须 100%）。

**format.ts**（Intl 唯一通道）：现有两处消费迁移（`gitUi.ts` 的 `toLocaleDateString`/`toLocaleString` → `formatDate`/`formatDateTime`，git 时间戳为秒级 epoch，helper 以 `Date` 入参、显式 locale（随当前 locale 取 `zh-CN`/`en-US`）、不涉时区转换——git 日期是仓库本地语义，维持浏览器本地时区展示，`Intl.DateTimeFormat` 二参不传 timeZone 即本地时区，显式化注释说明与 aelrova 业务时间戳强制 timeZone 的差异缘由）。文件大小格式化（现状散落的 B/KB/MB 拼接）若实现期确认可低风险收敛则一并入 helper，否则不强制（避免触碰 e2e 字节锚）。

**settings 集成**：`Settings` 增 `locale`/`reduceMotion` 字段 → `DEFAULTS` 补默认 → `normalizeSettings` 白名单（枚举校验脏值归位）→ settingsDraft 校验/合并面自动同构（`mergeFields` 与 Settings 同构，补字段即覆盖）→ 新设置节组件（下拉控件，语义与现有 select 控件一致）→ AppShell `onSettingsChanged` 接线 `setLocale`/`applyReduceMotion`（html data 属性）→ 启动时 `loadSettings()` 初值应用。导入导出/JSON 视图/存储管理七分类中的设置清除自动覆盖（kv 键同体）。

**e2e 种子**：沿用 rendererDefaults 的 addInitScript 预置模式（`settings-center.ts` 装置扩展 locale/reduceMotion 种子助手），既有用例零改动（默认 zh-CN）。

### 4.3 a11y 机检

- **对比度**（D13/D14）：解析 app.css `:root` / `[data-theme-mode="dark"]` / system 块；颜色形态 hex `#rgb`/`#rrggbb`、`rgb(r g b / a%)`、`rgba(r,g,b,a)`；α 混合按指定底色合成后计算；对拍锚（白≈1/黑≈0、黑白对比≈21）移植。三块等值断言：dark 块与 system 块逐 token 相等（注释豁免：`--vv-hit-*` 等两块都显式写值）。
- **e2e axe 域**：新 `apps/web/e2e/b-a11y-axe.spec.ts`（域前缀 A11Y-），扫描状态集：空壳、样例文件打开（markdown+code）、设置中心、目录管理、QuickOpen 开启、全局搜索开启、TabBarMenu 开启；每态 `AxeBuilder` wcag2a+wcag21a 零 violation。违规真修（D9）。CI 默认套件自动覆盖（无网络依赖，axe-core 本地打包）。
- **a11y lint**：4.1 规则块；存量清零（预计少量：5 处既有 svelte-ignore 已带理由注释，核实无僵尸即可）。
- **reduceMotion**（D11）。
- **svelte:boundary**（D10）。

### 4.4 文案抽取分域（最大工作量；builder check 精确实测：三条 lint 规则命中 1020 处 / 67 文件；标记文本 ≈287 行、aria-label CJK ≈162 行另计）

按域任务切分（域间文件互斥）：

| 任务域 | 主要文件 | 说明 |
|---|---|---|
| 域 A 壳与标签 | AppShell.svelte、TabBar.svelte、TabBarMenu.svelte、tabsModel、tabOrder、tabBadge、ZenEsc 等 | 域段 shell/tabs |
| 域 B 树与快开 | FileTree、TreeNodeRow、QuickOpenPanel、quickOpen | 域段 tree/quickopen |
| 域 C 设置中心 | SettingsCenter + 11 个 Section、settingsDraft、stores/settings | 域段 settings（新节本任务建） |
| 域 D 查看器 | ViewerPane、foreignRenderers、viewer.ts、saveAs、foreignZoom、DownloadProgressCard、MetaPanel 等 | 域段 viewer/errors |
| 域 E 挂载与连接 | MountsManager、mountsSync、ServerConnectForm、serverConnect、directS3/directDav | 域段 mounts |
| 域 F git 与搜索 | git/*、GlobalSearchPanel、search 相关 | 域段 git/search |
| 域 G 散量收尾 | theme、fontsStore、iconTheme、metaStore、openFlow、grammarLayers、highlightClient、MountsManager 残余、fontsSection 等 | 域段 notice/errors/a11y + 三条 lint 规则激活 + fixtures 断言 |

每任务交付：该域文件字面量→`t()` 全量替换、域目录两份（zh 逐字节等价 + en 翻译）、D8 审计记录（发现非显示用途即改标识符并在任务报告列出）、D19 连带面处置（源码文本锚改写清单、Worker 错误码化）、受影响域 e2e 定向跑绿。**顺序服从 D20**：分域抽取整体排在 a11y 重构之后。

### 4.5 CI

web job 步骤序：install → setup-grammars → **`pnpm run lint`（新）** → gen-code-extensions --check → check-foreign-deps --check → typecheck → vitest → build → e2e。eslint 失败即 fast-fail（置于最前，秒级成本）。

## 5. 验收门禁

1. `pnpm lint` 0 错（含分期激活后的三条 i18n 规则）；`lint-config.test.ts` 全绿（含合法样例零误伤）。
2. `pnpm typecheck` + `pnpm --filter web typecheck`（svelte-check）0E0W。
3. vitest 全量绿（新增：聚合/冲突/回落/覆盖测试、对比度机检、lint 自检）。
4. playwright 全量（双 project）零回归：既有用例除 D20 明确列举的有意翻转（SC-01 导航清单 +2、a11y 重构域锚升级）外零改动通过（zh-CN 默认 + zh 目录逐字节等价兜底），新增 A11Y-（axe ≥7 态零 violation）与 I18N-（切换/persist/html lang/回落）域。
5. `git status --porcelain` 净空（收尾核查在途文件）。
6. 文档三件入库（semantic-components / frontend-conventions / AGENTS.md 指针），ui-design-system.md 若 reduceMotion 改写触碰 §11 表述则同步补记。
7. 推送后 GitHub CI（rust/web/e2e 三 job）全绿 + Pages success。

## 6. 已知边界与知情维持（非递延）

- `--ui-border` 不进对比度机检清单（§2 理由，Primer 同款）。
- packages 内部文案不随 locale 切换（§2 边界）；markdown `ui` 缝接线为 stretch 项。
- 非 .svelte/.ts 模块（renderer 包内的渲染产物 DOM）文案不受 t() 覆盖。
- e2e 语料/夹具中的中文（fixtures、语料文档）非 UI 文案，不在禁令域。
- D10 svelte:boundary 若与既有错误通道冲突，按 D10 降级条款处置并记档。
