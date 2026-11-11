# vviewer 前端开发手册

版本：2026-11-12（首版，Task 12 成文）。
适用范围：`apps/web`（SvelteKit 3 + Svelte 5 runes 单页查看器）及其对 `packages/*` 的注入面。
上位文档：设计系统红线见 `ui-design-system.md`（§0 实施红线优先于本手册）；交互形态复用见 `semantic-components.md`；设计决策记录见 `docs/superpowers/specs/2026-11-11-frontend-conventions-design.md`（2026-11-11 前端工程规范）。

成文宪法（aelrova 同款）：**每条规则要么落在可机检载体（编译器/ESLint/TS 类型/Vitest/Playwright axe），要么落在 §6 评审必查清单，二者皆无不写入**。口号式条款不进本手册；本文每条规则在 §7 总表有落点。

---

## 1. 分层与组件无副作用

三层结构（依赖单向，无环）：

| 层 | 载体 | 职责 | 先例 |
|---|---|---|---|
| 组件层 | `.svelte` | 渲染与交互；**无副作用**——数据经 props 注入、行为经回调 props 上行（`onclose`/`onremove`/`onconfirm` 形态），不自行触网络/持久化/全局 store 写入 | MountsManager（`{#if}` 条件挂载 + `onclose`）、DownloadConfirmCard（`onconfirm`/`oncancel`）、SettingsCenter 各节（draft + touch()） |
| 域逻辑层 | 纯逻辑 `.ts` / runes 状态 `.svelte.ts`（分工见 §2） | 装配纯函数、模型、store | `mountsManager.ts`（装配三组 sections）、`tabsModel.svelte.ts`、`foreignRenderers.ts` |
| façade 接线层 | `AppShell.svelte` + `*.svelte.ts` façade | 装配接线、跨域事件、键盘/Esc 全局路由 | `openFlow.svelte.ts`（依赖单向 `tabsModel ← serverConnect ← openFlow`，无环）、`serverConnect.svelte.ts` |

规则与落点：

1. 组件不 import 网络层/持久化层；跨组件状态一律由 façade（AppShell 或域 façade 模块）下发——「面板组件由 AppShell 挂载 + props 注入」是 e2e 与单测共同锚定的契约形态（`mountsManagerUi.test.ts:149-154` 断言 `{#if}` 挂载与 onclose 接线）。
2. 面板的打开/关闭态归 façade（`mountsOpen` 等 `$state` 在 AppShell），组件内部不持有开关全局态。
3. 回调 props 命名 `onXxx`；本命名约定不由 lint 执法（`svelte/require-event-prefix` 未启用，见 spec 执行期订正），落 §6 评审必查 B2。

**载体**：契约形态由组件单测源码锚锁（mountsManagerUi / settingsCenter / downloadConfirm 等先例）；「新组件落三层形态」落 §6 B1。

## 2. 状态域：`.svelte.ts` vs 纯逻辑 `.ts`

后缀纪律（AGENTS.md 既载，此处只记分工面）：

| 后缀 | 内容 | 消费方 | 测试 |
|---|---|---|---|
| `.ts`（纯） | 查表/纯函数/locale 纯变量+发布订阅 | 组件与非响应式模块均可 | **vitest 直测唯一入口**（根 vitest 无 svelte 插件：纯 `.ts` 导入含 `$state` 的 `.svelte.ts` 即 `ReferenceError`） |
| `.svelte.ts`（runes） | `$state`/`$derived` 状态域、响应式胶水 | 组件模板/effects、其他 `.svelte.ts` | 不被 vitest 直测导入；形态由 contract 文本锚锁（`index.svelte.contract.test.ts` 先例） |

**范本：i18n 双模块（D4 裁决）**——`i18n/core.ts`（目录查表/`translate`/`setLocaleInternal`/`onChange`，全部单测承载）+ `i18n/index.svelte.ts`（`$state` locale 镜像 + 响应式 `t()` + `setLocale` 双写 $state 与 core）。消费契约：

- 组件/`.svelte.ts`：`import { t, setLocale, getLocale } from '.../i18n/index.svelte'`——模板内 `t()` 读 `$state` 自动追踪，locale 切换即重渲；
- 纯 `.ts`：`import { translate as t } from '.../i18n/core'`——**非响应式**：调用时取当下 locale，切换后对新消息生效（历史消息不回写，见 §5 边界③）。

**载体**：全局 runes 强制三层执法——编译期 `vite.config.ts` `compilerOptions: { runes: true }`、lint 期 `eslint.config.js` 同源 `svelteConfig` + `svelte/valid-compile` error（legacy 语法即编译错误）、逐组件退 runes 后门 `no-restricted-syntax`（runesOptOut 选择器，`<svelte:options runes={false}>` 必红；自检样例 sample.optout.svelte + sample.libprobe.svelte 锁两块并存不互顶）。

## 3. i18n 纪律

### 3.1 目录结构与 key 纪律

- **目录**：`apps/web/src/lib/i18n/catalogs/{zh-CN,en}/{域}.ts` 双侧对称，域内注释分节；聚合层 `catalogs/zh-CN.ts` / `catalogs/en.ts`。
- **key 三段** `{域}.{模块}.{语义}`；域全集 12 个：`shell / tabs / tree / quickopen / settings / viewer / mounts / git / search / notice / errors / a11y`。首段由 `satisfies` + `MessageKey = keyof typeof zhMessages` 类型锁。
- **归属跟随组件**：文案键落其组件所属域；跨组件同值同动作复用同键（先例：`tabs.ctx.saveAsFailed` 被 ViewerPane 另存为失败复用、`shell.empty.title` 承接全局搜索/快开的空态标题）；**zh 同值但语义/模块不同各落各键**（先例：`settings.storage.cancel` 与 `center.importModal` 的「取消」不复用）——防同义双键漂移与防误并键两个方向都按先例办。
- **en 全量覆盖**：en 键集 == zh 键集是聚合机检硬断言（缺键在测试输出明示差集）；回落 zh-CN 只是运行时安全网不是欠账通道。

**载体**：聚合机检 `catalogs.aggregate.test.ts` 四断言——①zh 各域 key 数之和 == 聚合总数（spread 静默覆盖即红）②全部 key 首段 == 域段 ③en 键集 == zh 键集 ④zh/en 逐 key 占位符集合相等。key 语义贫瘠（`button1`/`msg2`）类型层拦不住，落 §6 B3。

### 3.2 逐字节等价职责（D7）

zh 目录值必须与被替换的字面量**逐字节等价**（含空白与全半角标点）——这是全量 e2e 约 1.4 万行中文锚零翻转的唯一保证。改目录值 = 改渲染输出；确需改文案时 e2e 锚随之升级，且必须在任务/PR 描述中**明示列举**翻转面（D20 口径：SC-01 与 a11y 锚升级是登记在案的有意翻转先例）。插值占位符 `{name}` 双侧同名；未提供的占位符保留原样（漏参可发现）。

### 3.3 非显示串禁入目录（D8 审计纪律）

抽取/新增文案时逐一核实字符串用途：`{#each}` key、`===` 比较、事件 detail、持久化格式、map 键等**非显示用途一律用稳定标识符**（id/枚举/code），不进目录。**非翻译数据值**（运行时含 CJK 但非文案）以 `\u` 转义形态保留——lint 按**源码 raw 形态**匹配，转义形态即合法（先例：字体 family 名、默认工作区名 `'\u9ed8\u8ba4'`、openFlow「根N」storeId 段、主题注入注释头；合法性由自检样例 `sample.clean.ts` 锁）。判别符禁用显示串（先例：`data-mode` 曾以 `modeLabel === '直连'` 判别，Task 8 改 `record.kind` 并补单测锚防回退）。

**载体**：CJK 三形态 lint（`Literal[raw]`/`TemplateElement[value.raw]`/`SvelteText[value]`+`SvelteLiteral[value]` 两臂专属 message 供自检判别）；each key 在场经 `svelte/require-each-key` error，key 是否文案派生落 §6 B4。

### 3.4 消费与豁免面

- **禁直读 catalogs**：消费方一律经 `i18n/index.svelte`（响应式）或 `i18n/core`（纯层）门面——`no-restricted-imports` error（豁免 `i18n/**` 实现面与 `*.test.ts` 双锁锚）。
- **禁裸 `Intl.*` / `toLocale*`**（apps/web 全域）：格式化单点 `i18n/format.ts`（`formatDate`/`formatDateTime`，locale 跟随应用 locale 而非浏览器 locale；formatter 实例缓存）。唯一豁免点 format.ts 本体（`eslint.config.js` 块 A2 双向探针锁：lib 普通路径必命中、format.ts 虚拟路径零报）。
- **日志串不进目录**：console 输出英文化 + `[vviewer]`/`[vv-boundary]` 结构化前缀（console 纪律见 §5.3）。

### 3.5 机检自身被机检

`tools/lint-selfcheck/test/lint-config.test.ts` 以 `--no-ignore` / `--stdin --stdin-filename` 驱动真实 eslint 扫 `lint-fixtures/` 必命中与合法样例（12 用例：a11y/legacy/退 runes/失效指令/i18n 三纪律/合法面/style 块排除/裸 Intl 双向/子集覆盖探针）。**改 eslint.config.js 必须同步 fixtures 断言并跑本测试**——规则被改名/顶掉/降级时静默即防线上的洞（`reportUnusedDisableDirectives: 'error'` 对称执法：写了 disable 而规则没报也红）。

## 4. a11y 基线

定级：**关键可用性硬基线**（aelrova 同款），不承诺 WCAG 2.1 AA 全量达标；机检三件 + 评审必查清单为全部强制面。

### 4.1 机检三件落点

| 件 | 载体 | 落点 | 口径 |
|---|---|---|---|
| a11y lint | `svelte/valid-compile: 'error'` | `eslint.config.js`（`*.svelte` + `*.ts` 块） | eslint-plugin-svelte 3.x **无 a11y-\* 前缀规则**（aelrova 的动态枚举实为静默空转，已证伪）——Svelte 编译器 a11y 警告的真实 lint 载体是 valid-compile（D12 裁决）。lint 期编译按 `svelteConfig: { compilerOptions: { runes: true } }` 进行（兼全局 runes 执法载体）。载体自检：lint-config 用例断言带 onclick 静态 div 以 `a11y_click_events_have_key_events` 等 error 命中 |
| axe 全页扫描 | `@axe-core/playwright` | `apps/web/e2e/b-a11y-axe.spec.ts`（A11Y- 域） | 规则集 wcag2a+wcag21a（A 档；color-contrast 属 AA 档由对比度机检承接），**零 violation 断言**——违规必须真修（改产品），不允许 exclude/withRules 豁免（D9）。状态矩阵 9 态：空壳/markdown/code/设置中心/「语言与辅助功能」组/QuickOpen/目录管理/全局搜索/TabBarMenu 展开；双 project（桌面 + mobile 375×667）。新增浮层/面板按同法补扫描态 |
| 对比度 | Vitest 只读解析 app.css | `tools/design-tokens/test/contrast.test.ts` | D14 配对穷举：文本 16 对 ≥4.5:1 + 非文本 5 对 ≥3:1 + hit 系叠加 8 组合（4 单层 + 2×2 双层全矩阵）≥4.5 vs code-fg + hljs 七色 ≥4.5；三块级联同写断言（dark ≡ system 键集合一致 + 逐 token 等值）；**清单穷举机检**（每块颜色 token 集合 === 已测 ∪ 豁免——新增颜色 token 不同步增补配对或 EXEMPT 登记即红）；豁免登记 EXEMPT 理由必填（`--ui-border`/`--code-gutter`/`--vv-scrim`，见 §5 边界①） |

配套硬规则：`svelte/no-unused-svelte-ignore` + `svelte/comment-directive`（reportUnusedDisableDirectives）error——僵尸豁免指令必红；`<!-- svelte-ignore a11y-* -->` 视同豁免申请，必须随附依据注释（§6 A8）。

### 4.2 减少动效与错误兜底（a11y 关联件）

- **reduceMotion 双块门控**（app.css:107-130）：`@media (prefers-reduced-motion: reduce)` 命中且 `:root:not([data-reduce-motion="off"])` 一块 + `:root[data-reduce-motion="on"]` 一块，同体压 `animation-duration`/`transition-duration` 至瞬时；**selector list 纪律**：门控前缀（`:root…`）必须对每个选择器逐项重复——裸 `::before, ::after` 不继承前缀限定（裸写 = 全站伪元素动效对所有用户无条件压制；计划 Errata 2026-11-11 勘误即此坑）。AppShell `applyLocaleAndReduceMotion` 写 `html data-reduce-motion`（`system` 移除属性）。表述补记已同步 `ui-design-system.md` §11。
- **svelte:boundary**（AppShell.svelte:1264-1548）：顶层单一边界，只兜**渲染期未捕获异常**（each_key_duplicate 曾致 prod 整页 500 的前科面）；failed 片段复用 `.vv-error-*` 错误卡视觉 + 「重载」（`location.reload()`——`reset()` 局部重放对确定性渲染错误只会原样复抛）。现有主通道（dispatcher catch → 错误卡，异步回调不经渲染期）不动、不受边界吞接。

### 4.3 aria 形态惯例（机检落点随列）

- 图标按钮必须带可读名称（`aria-label` 走 `t()`——静态属性值 CJK lint 拦非 t() 面）；**aria-label 与可见文本包含**（axe `label-content-name-mismatch` 曾两处真违规真修：触发钮「工作区：{name}」、状态栏 openwith 动态全等形态）。
- 异步反馈经 `role="status"` / `aria-live` 通道对读屏可达（现状 23 处：`role="status"` 21 + `aria-live="polite"` 2；新增点经 §6 A2 逐条核）。
- tablist 结构：`role=tablist` 落 `.vv-tabbar-tabs`（tab 容器直下有非 tab 可聚焦后代即 axe `aria-required-children` 违规）、`tabindex="-1"` 仅为过 `a11y_interactive_supports_focus`（不影响 tab 序，焦点落 `.vv-tab-hit[tabindex=0]`，APG tab 惯例）、`.vv-tab` 壳 `role="presentation"`、关闭钮 `span.vv-tab-close aria-hidden`（键盘关闭走 Delete/Backspace 或右键菜单）。
- 源行 `role=treeitem` + `aria-selected` + `aria-expanded`（tree required owned 结构）；边界⑦ 的悬空面见 §5。

## 5. 已知边界登记（知情维持，非递延缺陷）

逐条含裁决出处；改动任一条须先推翻其出处裁决并登记新裁决。

| # | 边界 | 内容与理由 | 出处 |
|---|---|---|---|
| ① | `--ui-border` 对比度不入机检清单 | Primer border.default 同款立场：分隔线/装饰性边界豁免 WCAG 1.4.11；实测亮 #d0d7de 1.45:1 / 暗 #30363d 1.55:1，控件另有全局焦点环与 hover 底色冗余提示。contrast.test.ts EXEMPT 登记理由必填同源 | spec §2/§6；Task 11 报告 §1/§5 |
| ② | packages 内部文案不随 locale | `@bhxch/vviewer-*` 是独立发布面，内部文案默认 zh-CN 不影响 app 全量中英切换；包零 i18n 依赖（依赖方向 apps/web → core 不反转）。**例外：core 注入缝三处**——`setRenderFailedText`（dispatch/errors.ts:44；viewer.ts:64 注入 `t('errors.renderFailed')`）、`httpFailedText`/`davHttpFailedText`（directS3.ts:112-140；mountsSync.ts 顶层注入目录键）——apps/web 恒注入，故直连面/渲染失败错误卡恒走目录值 | spec §2；Task 7 裁决 3；Task 8 裁决 2、§12 I-1 |
| ③ | 非响应式模块/注入缝文案：切换后对新消息生效 | 纯层 `translate`、注入缝 getter、组件模板位外的消费点均在调用/构造时刻取当下 locale；locale 切换后历史消息不回写，面板重开/重校验/重开 tab 即刷新 | spec D4；Task 8 §11 M-1（维持不修记档）；Task 6 §12.2；Task 7 §9.3 |
| ④ | gitWorker 错误码快照语义 | worker 零 i18n import，面向用户错误以「稳定错误码 + 参数」上行（`GitWorkerErrorCode` + `CODED_ERROR_CODES` 白名单 satisfies + `isWorkerErrorCode` 守卫）；主线程 `WORKER_ERROR_KEYS` 映射目录键翻译——消息为主线程接收时刻快照；ENOENT 码透传保 isogit 回落链 | Task 10 §1 移交项 6；`gitWorker.ts:131`、`gitClient.ts` 注释 |
| ⑤ | lastError 落库为事件时刻 locale 快照 | mountsSync 对账失败消息以事件时刻 locale 落 IndexedDB，locale 切换后历史 badge 文案不回写（重启服务端重对账后更新；记录级自愈——下次对账成功即清除）。与状态条/toast「事件时刻取值」同口径 | Task 8 §10.3、§11 M-2（维持记档） |
| ⑥ | core 缺省值英文 | 注入缝包内缺省 `'Render failed'` / `'Read cancelled'` / `'S3 request failed…'` 等为英文——包独立消费者拿英文缺省为中性变化；apps/web 恒注入故实际渲染恒 zh。core 测试锚英文缺省、app 测试锚注入链 zh 渲染，双面契约双侧锁 | Task 7 裁决 3（errors.test.ts 锚）；Task 8 §4（directS3/directDav 测试锚） |
| ⑦ | 源行 treeitem `aria-expanded` 悬空 | `.vv-tree-src[role=treeitem]` 的展开组 `.vv-tree-group` 是 **DOM 兄弟**（非子元素）——AT 无法把 owned group 关联到 treeitem，aria-expanded 语义悬空。取舍：保全 e2e 兄弟选择器锚（`.vv-tree-src:has-text(…) + .vv-tree-group`，t-workspace.spec.ts:294/304）与折叠渲染结构，不为 ARIA 完美改 DOM。折叠态经行内 toggle 钮自身的 aria-expanded 双表达 | Task 2 §2.5/§3；FileTree.svelte:74-97 现值 |
| ⑧ | tablist `tabindex="-1"` 仅为过 lint | `.vv-tabbar-tabs[role=tablist]` 的 tabindex=-1 满足 svelte `a11y_interactive_supports_focus`，不参与 tab 序（焦点在 `.vv-tab-hit[tabindex=0]`，APG tab 惯例）；空条态由 axe `reviewEmpty` 判 needs-review 非 violation | Task 2 §2.4；TabBar.svelte:537-538、:548-553 注释 |
| ⑨ | errorRenderer 内联样式与 app.css 双源同值并存 | `errorRenderer.ts:22-30` 动作钮区 `style.cssText` 与 app.css:163-164 `.vv-error-actions`/`.vv-error-action` 同值并存——包侧内联因「app.css 归属其他修复包，卡片按钮需开箱可见」（包被独立消费时无 app.css）；类名保留语义钩子。收敛候选（如 CSS 注入或包内样式表）记档待需求出现时立项 | 实态 rg（本会话核对）；errorRenderer.ts:22 注释原文 |
| ⑩ | 组名 init 期 `t()` 不就地重渲 | SettingsCenter 组名注册表（groups 常量数组）在 init 期取值——会话内切语言组名滞后一拍、节内容（模板 `t()`）即时时，**reload 后生效**（I18N-03/04 以重载后翻英锁持久化路径）。如需就地重渲可把 groups 改 `$derived`（行为增强，未做） | Task 6 §12.2；Task 3 languageA11y 先例；Task 4 §5 en 冒烟口径 |

## 6. 评审必查清单（PR 逐条核对，违规即驳回）

### A 组：a11y（aelrova §2.4 八条移植，本地化）

1. **动效/过渡落白名单且被门控承接**：只动 opacity/transform/背景色/边框色/文字色（ui-design-system §11）；CSS transition/animation 由 app.css 全局双块自动压制，**JS 驱动的动画/样式写入**（无 transition 属性可压的面，如逐帧 style 写入）手工核 reduceMotion 语义。
2. **异步结果读屏可达**：进度/校验/对账/导出反馈等异步结果经 `role="status"` 或 aria-live 通道（现状 23 处：`role="status"` 21 + `aria-live="polite"` 2，成员 file:line 穷举在册于交互清单文档），不只视觉反馈——axe 不扫动态注入时机，新增点逐条核。
3. **新浮层先登记后使用**：新建交互件/浮层/菜单前 grep `semantic-components.md`；命中即复用，不命中先登记（OVERLAY_SELECTOR 入册、z-index 按档位、关闭通道、e2e 锚命名、机检锚五要素）再写码。
4. **壳 landmark 与窄视口**：单一 `<main>` 与 app.html `<title>` 兜底不删；新增顶层区块用 landmark 元素；新面板 ≤900/≤600 断点与 mobile 375 视口不横向断裂不丢内容（axe 双 project 扫描覆盖 aria 面，布局行为本条核对）。
5. **表单/校验错误关联 + 判别符非显示串**：错误提示经 `aria-describedby` 或紧邻 `role="status"` 关联到输入框（设置中心 JSON 错误/挂载表单先例）；`data-*` 判别、each key、比较逻辑一律稳定标识符（data-mode 显示串判别已拆除，防回退锚在案）。
6. **图标按钮有可读名称**：可见文字或 `aria-label`，文案走 `t()`；aria-label 必须包含可见文本词形（label-content-name-mismatch 两处真违规前科）。
7. **焦点可见 + 颜色非唯一载体**：禁裸 `outline: none`/`outline-hidden` 抹焦点（无机检，本条承接）；hover 才显现的控件补 `:focus-within`/`:focus-visible` 键盘等价；状态/语义不得仅以颜色区分（附文字或字形）。
8. **svelte-ignore 豁免随附依据**：`<!-- svelte-ignore a11y-* -->` 必须随附理由注释（WAI-ARIA APG 模式名或结构理由）；僵尸豁免由 `no-unused-svelte-ignore` 机检兜底，依据质量本条核对（现仓五处全带理由）。

### B 组：结构、i18n 与 e2e 补充（无机检面条款）

- **B1 新组件落三层形态**：props 注入/回调上行，不直触网络与持久化（§1）。
- **B2 回调 props 命名 `onXxx`**（`svelte/require-event-prefix` 未启用的承接，eslint.config.js 注释同源）。
- **B3 i18n key 语义命名**：`button1`/`msg2` 类即驳回（存在性/首段机检拦不住语义贫瘠）；新增文案先查目录既有键——同动作同文案复用同键，防同义双键漂移。
- **B4 each key 稳定标识符**：`svelte/require-each-key` 机检 key 在场；key 是否由文案/label 派生本条核（registry label-keyed each 曾致 Svelte 5 prod 整页 500）。
- **B5 展示层无手工拼接格式化串**：日期/数字展示一律 `i18n/format.ts`（lint 拦裸 Intl 调用；手工拼 `/`-`:` 日期形态本条核，aelrova 3.6② 同款）。
- **B6 e2e 装置入口带应用就绪锚**：装置打开菜单/面板前必须经 `openMenu`/`primeUiInteractive` 等含应用就绪锚的装置入口，禁止裸 click 触发钮（goto 后立即点击落在 Svelte 5 委托监听挂载前的竞态窗内，T13b 根因实证）。

## 7. 强制力总表（规则 → 落点 → 载体）

| 规则 | 落点 | 机检载体 / 评审必查 |
|---|---|---|
| 全局 runes，不得关闭 | vite.config.ts compilerOptions + eslint svelteConfig | valid-compile error（legacy 即编译错）+ runesOptOut no-restricted-syntax + 自检样例 |
| 编译器 a11y 警告硬门槛 | eslint.config.js | `svelte/valid-compile: 'error'` + lint-config a11y 必命中样例 |
| 僵尸豁免指令禁令 | eslint.config.js | no-unused-svelte-ignore + svelte/comment-directive + reportUnusedDisableDirectives |
| CJK 字面量禁令（四形态） | eslint.config.js 块 A（apps/web/src/lib） | no-restricted-syntax ×4 + stdin 虚拟路径自检 |
| 禁裸 Intl/toLocale* | eslint.config.js 块 A/A2/B | no-restricted-syntax + format.ts 豁免双向探针 |
| 禁直读 catalogs | eslint.config.js 块 A | no-restricted-imports + 门面导入对照断言 |
| 目录聚合一致性（键数/首段/en 全覆盖/占位符） | catalogs.aggregate.test.ts | Vitest 四断言 |
| en 缺键回落 / 未知 key 抛错 / 占位符保留 | i18n/core.ts | core.test.ts（回落经注入目录直测） |
| Intl 唯一通道 | i18n/format.ts | format.test.ts + bareIntl lint |
| 对比度 AA（配对穷举 + 三块同写 + 豁免登记） | tools/design-tokens/test/contrast.test.ts | Vitest 152 用例（含清单穷举与对拍锚） |
| axe 全页零违规（9 态 × 双 project） | apps/web/e2e/b-a11y-axe.spec.ts | Playwright 硬断言（D9：真修不豁免） |
| console 纪律（禁 log/info，warn/error/debug 合法） | eslint.config.js | `no-console: ['error', { allow: ['warn','error','debug'] }]` |
| 失效 disable 指令必红 | eslint.config.js | reportUnusedDisableDirectives: 'error'（JS 面与模板面成对） |
| lint 规则自身被机检 | tools/lint-selfcheck/* | lint-config.test.ts 12 用例（--no-ignore/--stdin 驱动真实 eslint） |
| reduceMotion 双块门控 + selector list 纪律 | app.css:107-130 + AppShell applyLocaleAndReduceMotion | CSS 落点核对归 §6 A1；门控形态由计划 Errata 勘误记档 |
| svelte:boundary 渲染兜底 | AppShell.svelte:1264-1548 | 行为面：渲染异常→错误卡视觉+重载（boundary 留痕 console.error） |
| Worker 错误码化 | gitWorker.ts / gitClient.ts | CODED_ERROR_CODES satisfies 编译期白名单 + isWorkerErrorCode 运行时守卫 + git 域目录键 |
| core 注入缝三处（恒注入） | dispatch/errors.ts + directS3.ts + mountsSync.ts | 双面测试锚（core 英文缺省 / app 注入链 zh 渲染逐字节） |
| 分层/无副作用/回调命名/焦点环/outline/z-index 档位/新浮层登记 | §1、semantic-components.md | §6 A3/A7 + B1/B2（评审必查） |

## 附：门禁速查

- `pnpm lint`（eslint 全仓，0 错）；`pnpm typecheck`（tsc -b + svelte-check，0E0W）；`pnpm vitest run`（含 lint 自检/聚合机检/对比度机检/i18n 单测）；`pnpm --filter web build:e2e` + playwright（含 A11Y- 域）。CI 步骤序见 spec §4.5（lint 置于最前 fast-fail）。

## 附：证据清单

- 实读：`eslint.config.js`（全文）、`apps/web/src/lib/i18n/{core.ts,index.svelte.ts,format.ts,catalogs.aggregate.test.ts}`、`tools/lint-selfcheck/{test/lint-config.test.ts,lint-fixtures/}`、`tools/design-tokens/test/contrast.test.ts`、`apps/web/e2e/b-a11y-axe.spec.ts`、`apps/web/src/app.css:104-130`、`AppShell.svelte:1249-1273/1264-1548`、`packages/vviewer-core/src/dispatch/errorRenderer.ts`、`packages/vviewer-core/src/tree/directS3.ts:112-140`、`gitWorker.ts`、`gitClient.ts`、`FileTree.svelte:74-97`、`TabBar.svelte:497-588`、`TabBarMenu.svelte:246-262`、`mountsManagerUi.test.ts:26-154`。
- 历任务报告出处：`.superpowers/sdd/2026-11-11-frontend-conventions/task-{1,2,3,4,6,7,8,10,11}-report.md`（边界逐条标注见 §5）。
