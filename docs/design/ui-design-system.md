# vviewer UI 设计系统规范

版本：2026-10-30（首版）。
适用范围：`apps/web`（Svelte 5 + 原生 CSS 变量，无 CSS 框架）。
规范基线：`apps/web/src/app.css`（约 658 行，全站唯一全局样式表）+ `apps/web/src/lib/theme.ts`（运行时注入）。所有「现状」断言均来自本仓库代码实读与 node 实测（对比度），标注为 `文件:行号`。

---

## 0. 实施红线（先于一切规则）

任何样式重构不得违反以下红线；与本文其他条款冲突时，红线优先。

1. **不改 DOM 结构与既有类名**。`.vv-*` / `.meta-*` / `.md-*` / `.vv-sc-*` 等类名是 e2e 主锚点，只允许改样式规则本身，不得改名、删除、合并元素。高频锚（rg 实测）：`.vv-code-pre`、`.vv-tab`、`.vv-error-card`、`.vv-tree-row`、`.vv-markdown`、`.vv-statusbar`、`.vv-topbar`、`.vv-search-count`、`.vv-shell.zen` 等。
2. **overlay 根类名是运行时行为通道**：`AppShell.svelte:413-425` 的 `OVERLAY_SELECTOR`（`.vv-settings-center` / `.vv-mounts-manager` / `.vv-gsearch` / `.vv-quickopen` / `.vv-wspanel` / `.vv-search-panel` / `.vv-wscreate` / `.vv-remotesrc` / `.vv-tabctx` / `.vv-ws-pop` / `.vv-status-picker`）被 Esc 优先级与 zen 返回键判定实读 DOM 消费，改名破坏功能。
3. **data-\* 锚点不可动**：`data-theme-mode`（e2e 38 处亮暗断言）、`data-pinned` + `.vv-tab-pinned` 双锚点（app.css:497-499 注释约定）、`data-drop-before`（tab 拖拽插入线方向）、`data-side`/`data-edge`（折叠三件套几何，b-layout-zen boundingBox 断言）、`data-line`（代码行定位）。
4. **抽屉实现语义被 e2e 反向依赖**：`apps/web/e2e/drawer.ts:28-33` 以 `.vv-side` 的 computed `transform === 'none'` 判开合；`drawer.ts:19` 的 `DRAWER_MEDIA_QUERY = '(max-width: 900px)'` 与 AppShell `@media` 同一条件。**≤900 / ≤600 断点冻结**；确需调整须 JS（AppShell/TopBar matchMedia）+ CSS + e2e 三处同步。
5. **字号/字体联动链路不可断**：`--vv-ui-font-size` / `--vv-code-font-size` / `--vv-code-font` / `--vv-code-line-height` 由 `theme.ts applyFonts`（theme.ts:420-432）经 `style#vv-font` 注入，优先级高于 app.css；j/k 滚动步长经 `codeLineHeight(codeSize)` 联动（AppShell.svelte:795-797）。新字阶**必须 calc 派生自这两个变量**，禁止新增第三套硬编码 px 字号。
6. **default 外观零漂移**：token 增量（§12.1）的默认值必须等于现状渲染值；`style#vv-code-theme` 注入体（`THEME_ROOT_SELECTOR` 四形态选择器，theme.ts:121-122）、`applyAppearance` / `applyFonts` 签名 diff 机制一律不触碰。痛点修复带来的**明示视觉变更**（如硬编码色换令牌、孤值收敛）不算漂移，但必须在 §12.2 逐项声明「变更」。
7. **双端同步段不可单边修改**：app.css:107-110 明示 `.vv-markdown` 基础排版 / `.md-code-bar` / `.md-code-lang` / `.markdown-alert` 与 `render-text` 侧 `exportBaseCss` 是运行时复制关系（markdownExport.test.ts / export.test.ts 双向校验）；app.css:58-60 `.hljs-*` 段同；`.ts-*` 类清单与 `theme.ts CODE_CAPTURES` 一一对齐（theme.test.ts 校验）。动这些段落须双端同步。
8. **丢失类以「新增全局类定义」补回**：`.vv-settings-label/hint/warn/empty/add/remove/toggle/patterns/pattern/presets` 被十个设置节组件模板引用、e2e 按现 DOM 断言（SearchSection preset 按钮的 aria-label 等），在 app.css 增补定义即可全量生效，**不得改为 scoped、不得改名迁移**（痛点审计 G4 红线）。
9. **tab 定位语义**：`apps/web/e2e/helpers.ts:54-60` `tabNamed` 以 `.vv-tab-name` 子元素文本精确匹配定位 tab。换关闭字形、调 DOM 时不得让 `.vv-tab-name` 文本语义变化，不得把关闭钮并进 `.vv-tab-name`。
10. **不改测试与依赖**；不引入外部 CSS 框架、CSS-in-JS、样式依赖。
11. **`__vv*` 运行时探针通道不可删**（`__vvHighlightClient` / `__vvPaintProbe` / `__vvCopied` 等，e2e 与单测注入观测点）。

---

## 1. 设计原则与参照案例取舍

vviewer 是「只读文件查看器」：阅读面积最大化、chrome 极薄、密度高于通用 Web 产品。参照三套成熟体系，各取一段并裁剪：

| 参照 | 采纳 | 不采纳（及原因） |
| --- | --- | --- |
| **VS Code** | chrome 字号阶梯（状态栏/tab/菜单 = 小号一档）、面板浮层层级模型（面板 30 < 条 50 < 菜单 90）、tab 形态（背景色切换激活、来源徽标、pinned 斜体）、设置页「标签行 + 弱化 hint」表单排版 | 编辑器花色（minimap/面包屑）、命令面板模糊高亮结构——超出只读器范围 |
| **GitHub Primer** | 色板基色（现有 8+6 token 即 Primer 亮色系，实测对比度全过 AA）、functional 色语义（accent/danger/warning/success）、callout（markdown-alert）七色语义、`fg-muted` 次级文本的用法 | Primer 的按钮实心填充档（vviewer 主钮走描边形态，见 §8，保持现状零漂移） |
| **Linear** | 密度纪律（列表行 22-26px 高）、克制动效（120/200ms 两档、只动 transform/opacity）、同构面板同规格（三搜索面板行密度统一） | Linear 的暗色玻璃拟态阴影——vviewer 浮层阴影保持不透明投影 |

三条自有原则：

1. **令牌优先，但令牌必须可被主题接管或声明不接管**。每个色 token 归入三种供给模式之一（§2.4），禁止出现第五种「无主」硬编码。
2. **用户设置是最高级联层**。界面字号、代码字号、字体族、亮暗模式都是用户资产；任何组件层样式不得绕过 `--vv-ui-font-size` / `--vv-code-font-size` 钉死 px。
3. **收敛先于创造**。本轮全部规则都是从现状归一（九档圆角→四档、五种 disabled→一种、三套行密度→一套），不发明新视觉语言；default 外观零漂移。

---

## 2. 色彩系统

### 2.1 令牌分层与命名（沿用现状惯例）

四层前缀不变：

| 层 | 前缀 | 供给方 | 可否被外观主题接管 |
| --- | --- | --- | --- |
| 字体组 | `--vv-ui-font*` / `--vv-code-font*` / `--vv-code-line-height` | `style#vv-font`（theme.ts:420-432），app.css:2-10 为 fallback | 否（字体独立注入） |
| UI 主题组 | `--ui-*`（8 基础 + 6 扩展） | app.css:12-16 亮色默认 + :22-30 暗色 + :31-41 system 媒体块；外观型注入可覆盖（白名单见 §2.4） | 白名单内可 |
| 代码主题组 | `--code-bg/fg/gutter` + `--hljs-*` | app.css:17-20 默认；`style#vv-code-theme` 注入（theme.ts:174-215） | 可（default 与外观型均注入） |
| tree-sitter 捕获组 | `--vv-ts-*`（53 捕获，默认未定义回落 inherit） | 仅 JS 注入命中时生效（app.css:69-97） | 可 |

**新增 token 一律落到 `--ui-*`（跨亮暗的主题语义色）或 `--vv-*`（与主题无关的固定效果色，如命中高亮、阴影）**，不得再开新前缀。元素级取色一律 `var()` 间接，禁止硬编码主题色（既有例外仅：灯箱黑底 app.css:153、ArtPlayer 16:9 黑底 app.css:103、PDF 纸白 app.css:208/211——物理媒介色，不随主题）。

### 2.2 亮暗双主题与级联

- 三态 `data-theme-mode`（light/dark/system）写在 `<html>`，app.html:7-25 内联脚本首帧前预置（BUG-51 防 FOUC）；app.css 以 `:root` 默认（:2-21）、`:root[data-theme-mode="dark"]`（:22-30）、`@media (prefers-color-scheme: dark)` 内 `:root[data-theme-mode="system"]`（:31-41）三块级联。
- **新增 `--ui-*` token 必须三块同写**（亮默认 + 暗 + system 媒体块内同暗值），漏一块即复现 `.vv-pdf-page-label` 事故（app.css:210-211 固定亮色 chip，暗色下刺眼白块——本轮必修）。
- **新增 `--vv-*` 效果色默认双主题同值**（现状命中黄系即如此）；若暗色下确需不同值，允许在暗色两块内显式覆盖，并在 §12.1/§12.2 声明理由与实测依据（先例：`--vv-hit-active`，见 §2.3 高亮组合表），不必强行升级为 `--ui-*`。
- 修复：`.vv-pdf-page-label` 改 `color: var(--ui-fg-muted); background: color-mix(in srgb, var(--ui-bg) 80%, transparent)`（变更：暗色下不再白块）；`.vv-html-frame` 的 `background: #fff`（app.css:197）保留——沙箱内文档自身多为白底，属物理媒介色，但补 `outline` 由 `--ui-border` 承担边界的可见性。

### 2.3 WCAG AA 对比度底线

口径声明：本规范对比度一律按 **WCAG 2.1 AA**（正文/控件文本 4.5:1；≥18.66px 粗体或 ≥24px 文本 3:1；边框/焦点环/图标等非文本 3:1；disabled 豁免）；触控目标口径见 §6.4（以 WCAG 2.2 AA 2.5.8 为底线）。**高亮背景 × 其上文字同属文本组合**，受 4.5:1 约束，实测见下方第二张表。

**现有令牌实测（node 脚本，本会话运行）——全部达标，构成「安全底色板」：**

| 前景/背景 | 亮色 | 暗色 |
| --- | --- | --- |
| `--ui-fg` / `--ui-bg` | 15.80:1 | 16.02:1 |
| `--ui-fg-muted` / `--ui-bg` | 5.25:1 | 6.15:1 |
| `--ui-fg-muted` / `--ui-side-bg` | 4.93:1 | 5.62:1 |
| `--ui-accent` / `--ui-bg` | 5.19:1 | 5.05:1 |
| `--ui-danger` / `--ui-bg` | 5.36:1 | 5.65:1 |
| `--ui-warning` / `--ui-bg` | 4.87:1 | 7.50:1 |

**违规硬编码实测（本轮必须消除）：**

| 位置 | 现值 | 实测 | 修法 |
| --- | --- | --- | --- |
| GlobalSearchPanel.svelte:342-344 `.vv-gsearch-hint` | `#b58900` | 白上 3.21:1、side-bg 上 3.01:1（12px 文字） | → `var(--ui-warning)`（变更：色相微调换合规） |
| MountsManager.svelte:800/809/848 `.vv-mm-error` 等 | `#b91c1c` | 暗色 bg 上 2.92:1 | → `var(--ui-danger)` |
| MountsManager.svelte:748/786 `.vv-mm-state[pending]` / `.vv-mm-warning` | `#b45309` | 暗色 bg 上 3.77:1 | → `var(--ui-warning)` |
| MountsManager.svelte:751 `.vv-mm-state[offsite]` | `#6b7280` | 暗色 bg 上 3.91:1 | → `var(--ui-fg-muted)` |
| 全库 `var(--ui-danger, #d33)` 死回退（rg 全量 14 处声明：app.css:397/462/573/578/585/655/657、SettingsCenter.svelte:688/693、StorageSection.svelte:299/300/310/317、RemoteSourceModal.svelte:436） | `#d33` | 白上 4.57:1 过、暗色上 4.14:1 不过 | `--ui-danger` 在亮暗两块恒被定义（app.css:16/26/36），回退永不生效——统一清掉 `#d33` 回退，裸写 `var(--ui-danger)` |

**高亮背景 × 其上文字组合实测（node 脚本，单层混入代码底后再对比 code-fg；本会话运行）：**

| 组合 | 亮色 | 暗色 | 处置 |
| --- | --- | --- | --- |
| `mark.vv-search-hit-active`（rgb(255 160 0 / 80%)，app.css:313）× code-fg | 8.84:1 ✓ | **2.58:1 ✗** | 待处置：暗色两块覆盖 `--vv-hit-active: rgb(255 160 0 / 35%)`（实测 7.63:1 ✓）+ 1px inset 描边保「当前命中」区分度；mark 叠在 hit-line 之上为双层合成，实施后按叠加值复测 |
| `.vv-gsearch-preview mark`（rgb(255 213 0 / 55%)，GlobalSearchPanel.svelte:394）× code-fg | — | **3.44:1 ✗** | 收敛为 `--vv-hit-bg` 45%（实测 4.61:1 ✓；§12.2-G3 变更） |
| `mark.vv-search-hit` 45% / 行级 18% / 行级 active 35% × code-fg | 13.26 / 14.65 / 12.23:1 ✓ | 4.61 / 10.61 / 7.63:1 ✓ | 保留 |

**规则**：新写任何 `color`，候选只允许令牌；确需新色先入 §12.1 增量表。opacity 弱化（`opacity: .6/.7/.75`）禁止用于文本弱化（混合底色后对比度不可控）——一律 `color: var(--ui-fg-muted)`（MountsManager.svelte:680/738/754/758/791/795 六处待改）。

### 2.4 与 `colorsToUiVars` 映射的兼容策略

映射本体在 `packages/highlight/src/vscode.ts:287-300`：`COLORS_TO_UI_VARS` 12 键白名单（editor.background→`--ui-bg`、editor.foreground→`--ui-fg`、sideBar.background→`--ui-side-bg`、editorWidget.background→`--ui-tab-bg`、tab.activeBackground→`--ui-tab-active-bg`、input.background→`--ui-input-bg`、list.hoverBackground→`--ui-hover-bg`、editor.selectionBackground→`--ui-selection-bg`、statusBar.background→`--ui-statusbar-bg`、focusBorder→`--ui-accent`、editorError.foreground→`--ui-danger`、editorWarning.foreground→`--ui-warning`），`colorsToUiVars`（vscode.ts:302-310）经 `COLOR_VALUE_RE` 校验非法值不落文本。

策略三条：

1. **12 键白名单冻结**。新增 token 不进映射（改 `vscode.ts` 属跨包变更且牵动双端校验，本轮不做）。新增 `--ui-success` / `--ui-accent-2`（§12.1）为**恒默认 token**：外观主题接管时保持默认值，与现状 `--ui-border` / `--ui-fg-muted` 不在白名单、恒为 app.css 默认值（现状盘点已明示）是同级知情简化。
2. **优先从既有令牌派生**：需要「danger 的浅背景」「hover 的加深」这类衍生色时用 `color-mix(in srgb, var(--ui-*) N%, transparent)` 现算（MountsManager 已有同款用法 MountsManager.svelte:725/781），自动跟随亮暗与外观注入，不新增 token。
3. **未来扩映射（独立立项，非本轮）**：候选键 `descriptionForeground→--ui-fg-muted`、`editorWidget.border→--ui-border`、`testing.iconPassed→--ui-success`；届时须同步扩 `COLORS_TO_UI_VARS`、核对 `COLOR_VALUE_RE` 与两侧测试，并在 §2.1 表把对应 token 的「可否接管」改真。

**markdown-alert 七色归一**（app.css:178-183 硬编码，与令牌同值不同源）：`note/info/faq/question→var(--ui-accent)`、`caution→var(--ui-danger)`、`warning→var(--ui-warning)`、`tip→var(--ui-success)`（新）、`important/example→var(--ui-accent-2)`（新）、`todo→var(--ui-fg-muted)`。亮色默认值全部等于现值（#0969da/#cf222e/#9a6700/#1a7f37/#8250df/#57606a）→ 亮色零漂移，暗色下 callout 跟随暗色令牌（变更，属 §2.2 暗色补漏）。**注意此段在导出复制域内（app.css:107-110），改须双端同步。**

---

## 3. 字体与字阶

### 3.1 字体族

- UI：`var(--vv-ui-font)`（默认 `system-ui, -apple-system, sans-serif`，与 theme.ts:343 `DEFAULT_UI_FONT_STACK` 同源，theme.fonts.test 校验）。
- 代码：`var(--vv-code-font)`（默认 ui-monospace 栈，theme.ts:345-346）。**凡等宽语义一律消费 `var(--vv-code-font)`**，禁写裸 `ui-monospace`：SettingsCenter.svelte:663/677（JSON 行号/文本域）、:761（导入 diff）、StorageSection.svelte:288（缓存名）四处待改——用户代码字体设置对设置页生效（痛点：等宽令牌绕过）。
- **基础层修复**：app.css:43-45 的 `button`/`input`/`select` 全局规则补 `font-family: inherit; font-size: var(--vv-fs-sm);`（现状无 font 声明，控件回落 UA 13.33px 且不继承字体族；各组件被迫零散补 `font: inherit`，rg 实测 app.css 16 处 + 组件 15 处 `background:none` 同源的零散重置问题）。已有显式 `font-size:12px` 的组件小钮（如 `.vv-search-btn` app.css:311）以类选择器特异性 (0,1,0) 压过全局 `button` 的 (0,0,1)，不受影响（scoped 样式带属性选择器，特异性更高，同理）。此为收敛变更（13.33→13px，0.33px 级）。

### 3.2 字阶（全部 calc 派生自 `--vv-ui-font-size`，记 U）

| Token | 定义 | U=16px 时 | 用途（现状对位） |
| --- | --- | --- | --- |
| `--vv-fs-2xs` | `calc(var(--vv-ui-font-size) * 0.6875)` | 11px | 徽标（`.vv-tab-src` app.css:490-492、`.vv-wspanel-badge` :453-455、`.vv-settings-theme-src` :608-609）、角标（pinned 锁形字号 app.css:500 现硬 10px，随 §6.1 🔒 退役一并消除，不并入本档） |
| `--vv-fs-xs` | `calc(var(--vv-ui-font-size) * 0.75)` | 12px | 状态栏（:473）、次级文本/hint/count/empty、表单控件小钮、`.meta-list`（12px）、`.vv-server-error`（:397） |
| `--vv-fs-sm` | `calc(var(--vv-ui-font-size) * 0.8125)` | 13px | 菜单项（:379/511/533）、tab 名、nav 项（SettingsCenter.svelte:601）、表单标签、TOC 项（:560） |
| `--vv-fs-md` | `calc(var(--vv-ui-font-size) * 0.875)` | 14px | 面板标题（`.vv-sc-title` 现 15px SettingsCenter.svelte:526 → 收敛 14px；`.vv-sc-modaltitle` 现 14px :742 → 对位） |
| 正文 | `var(--vv-ui-font-size)` | 16px | body 继承面（app.css:42） |
| 代码 | `var(--vv-code-font-size)` + `var(--vv-code-line-height)` | 13px/20px | `.vv-code-pre`（:52-53）、`.vv-hex-dump`（:218）、`.vv-jsonl-body`（:581-583） |

规则：

1. 全库硬编码 px 字号（rg 实测 114 处声明：12px×73、13px×23、11px×9、16px×3、15px×2、14px×2、18px×1、10px×1）**只允许收敛到上表 token**，逐一映射：12px→`--vv-fs-xs`、13px→`--vv-fs-sm`、11px→`--vv-fs-2xs`、15/14px 标题→`--vv-fs-md`。
2. 孤值处置（rg 复核：15px×2、14px×2，各含一处非 chrome 语义）：SettingsCenter.svelte:526 `15px`（`.vv-sc-title`）与 :742 `14px`（`.vv-sc-modaltitle`）并入 `--vv-fs-md`；app.css:258 `15px` 是 `.vv-docx-content` 渲染器文档正文字号，**不入 chrome 字阶**——改 `0.9375em` 相对继承字号，U=16px 时 15px 等值零漂移，且与 `.vv-markdown` 正文口径归一（同随用户字号联动）；app.css:330 `14px` 是 `.vv-strip-icon` 图形字形，归 §6 图标字号档。18px（zen 退出钮字形 AppShell.svelte:1316）与 16px（`.vv-sc-close` :573、灯箱钮 app.css:171）同为图形字形尺寸。
3. 代码语义的 13px 硬编码改 `var(--vv-code-font-size, 13px)`：`.md-diagram-error`（app.css:147）、`.md-diagram-source code`（:152）、`.vv-hex-struct`（:227）、`.vv-xlsx-tab`（:271）、`.vv-xlsx-sheet`（:274）——代码面跟随用户代码字号，与 `.vv-hex-dump`（:218 已是变量）同法。**其中 `.md-diagram-error` 与 `.md-diagram-source code` 两规则位于 app.css:107-110 声明的导出复制域（图表段；packages/render-text/src/markdown/export.ts:111/114 逐字含同段），属双端同步义务：改须同步 render-text 侧 exportBaseCss，并跑 markdownExport.test.ts / export.test.ts（与 §2.4 markdown-alert 标注口径一致）。**
4. **禁止**在组件 scoped style 再写裸 px 字号；e2e 若断言字号（现无）应锚 token 消费而非 px 值。

### 3.3 行高

- UI 文本：控件/列表行 `line-height: 1.4`；`.vv-markdown` 正文保持 1.6（app.css:111，导出复制域勿动）。
- 代码：恒 `var(--vv-code-line-height)`（= max(16, round(codeSize×1.5))，theme.ts:349-351），禁另设。

---

## 4. 排版布局

### 4.1 间距体系（4/8 栅格 + 2px 基单位）

现状间距值收敛为 7 档枚举 token（值=名，零记忆负担）：`--vv-sp-2` 2px、`--vv-sp-4` 4px、`--vv-sp-6` 6px、`--vv-sp-8` 8px、`--vv-sp-10` 10px、`--vv-sp-12` 12px、`--vv-sp-16` 16px。

- 10px 不在 4/8 栅格上但是现状高频横向留白（tab `padding: 6px 10px` app.css:480、状态栏 `2px 10px` :473、三浮层搜索行 `8px 10px`）——**保留为半档**，不强行归 8/12（避免大面积视觉漂移）。栅格口径：**2px 基单位，偶数递增；语义档为 4/8，微调档为 2/6/10**。
- 面板留白基准：主内容面板（`.vv-sc-content` 12px 16px SettingsCenter.svelte:642、`.vv-archive` `.75rem 1rem` app.css:250）横向 16px 档、纵向 12px 档；窄侧栏（`.meta-panel` .65rem .75rem app.css:544）横向 12px 档、纵向 10px 档。新面板对号入座，不发明新值。
- 列表行内边距统一（见 §4.3 密度）；`gap` 一律用上表档位，禁止 3px/5px/7px 碎 gap。

### 4.2 断点行为（冻结）

| 断点 | 行为 | 依据 |
| --- | --- | --- |
| >901px 桌面 | 三栏 + 折叠三件套（`.vv-strip`/`.vv-colhandle`/`.vv-collapse-btn`，app.css:322-345 仅 `min-width:901px` 放开） | AppShell.svelte:1186-1191 |
| ≤900px 平板 | 文件树收左抽屉（`.vv-side` fixed `translateX(-100%)`，`.vv-shell.drawer` 控制；transition transform 0.2s AppShell.svelte:1206）；右栏保留流内 | AppShell.svelte:1200-1220 |
| ≤600px 手机 | 右栏再收右抽屉（`.vv-right` + `.vv-right-toggle` 浮钮 AppShell.svelte:1226-1247）；`.vv-ws-actions`/`.vv-wspanel-close` 常显（app.css:415/463）；diagram 网格降单列（:629-631）；设置 nav 收窄 116px（SettingsCenter.svelte:779-783）；MountsManager 表单纵排（:857-868） | 同左 |

改动断点须 JS + CSS + e2e 三处同步（§0 红线 4）。触控目标另见 §7。

### 4.3 密度分级

| 密度 | 行高 | 适用 | 规格 |
| --- | --- | --- | --- |
| 紧凑（列表行） | 22-24px | 树行、三搜索面板结果行、tab | padding-block 2-3px；结果行统一 `padding: 3px 10px`（§10 G3）；树行保持 `2px 6px`（app.css:538-539，树缩进自成一系） |
| 标准（表单行） | ≥28px | 设置节表单行、meta 行 | `--vv-sp-6` 纵向 gap，控件高 ≈ fs-sm + 2×4px |
| 宽松（文档正文） | 1.6 | markdown/docx | 现状，勿动 |

**三面板行密度统一**（痛点：quickopen `3px 10px` QuickOpenPanel.svelte:225-236 / gsearch `2px 10px 2px 18px` GlobalSearchPanel.svelte:366-377 / wspanel `3px 10px 3px 20px` app.css:449）：统一为 `padding: 3px 10px`；缩进一律由**既有元素或纯 CSS 手段**承担，不新增 DOM（红线 1 无「装饰元素」豁免）——gsearch 已有固定宽前缀列 `.vv-gsearch-lncol`（84px，GlobalSearchPanel.svelte:381-387）可承接其 18px；wspanel 的 20px 缩进用伪元素定宽占位承接（`.vv-wspanel-row` 为 `display: flex`，app.css:449，`text-indent` 对 flex 容器无效不可选）。hover 底统一 `var(--ui-hover-bg)`——现状 side-bg 与 hover-bg 亮暗同值（#f6f8fa/#161b22，app.css:13-15 与 23-25），纯语义写法归一，**零视觉漂移**。

### 4.4 z-index 惯例（现状实测，冻结为表）

| 层 | 值 | 成员 |
| --- | --- | --- |
| 抽屉 | 10 | `.vv-side` / `.vv-right`（抽屉态） |
| 抽屉/右栏浮钮 | 20 | `.vv-drawer-toggle` / `.vv-right-toggle` |
| zen 退出钮 | 25 | `.vv-zen-exit`（AppShell.svelte:1309） |
| 面板层 | 30/31/32 | overlay 族 30（`.vv-settings-center`/`.vv-mounts-manager`/`.vv-gsearch`/`.vv-quickopen`/`.vv-wspanel`/`.vv-wscreate-panel`/`.vv-ws-pop`/`.vv-status-picker`）；`.vv-sc-confirm` 31；`.vv-sc-modal` 32 |
| chrome 条 | 50 | `.vv-chrome-off` / `.vv-chrome-temp`（app.css:352-359） |
| toast/搜索浮层 | 60 | `.vv-toast`（AppShell.svelte:1263）/ `.vv-search-panel`（app.css:306） |
| 菜单 | 90 | `.vv-tabctx` / `.vv-chromemenu`（app.css:507/375） |
| 灯箱 | 100 | `.md-lightbox-overlay`（app.css:153） |

新浮层按表取值，禁止新开档位；fixed 同位浮层 `top: 44px` 假设是 b-\* spec 隐式依赖（app.css:406/426/433），不得改。

---

## 5. 圆角、边框、阴影、分割线

### 5.1 圆角（现状 rg 实测十档 → 收敛四档）

| Token | 值 | 用途 | 现状归并 |
| --- | --- | --- | --- |
| `--vv-radius-sm` | 4px | 内嵌小件：菜单项、tree-row、chip 内钮、mark | 4px×15 直用；2px/3px/5px 全部并入（pdf 页码 chip 3px app.css:211、MountsManager 钮 5px :773/842、gsearch mark 2px :396） |
| `--vv-radius-md` | 6px | 按钮输入框、卡片、代码块、对话框小浮层（tabctx/chromemenu/status-picker） | 6px×26 直用；10px 并入（`.vv-sc-modalbox` SettingsCenter.svelte:732） |
| `--vv-radius-lg` | 8px | 同位大面板（ws-pop/wscreate/wspanel/gsearch/quickopen/sc-modalbox/sc-confirm/zen-exit 钮/toast） | 8px×14 直用 |
| `--vv-radius-full` | 999px | 徽标/chip pill | `.vv-mm-badge`（MountsManager.svelte:719 现唯一 999px）；`.vv-tab-src`/`.vv-wspanel-badge`/`.vv-settings-theme-src`/`.vv-jsonl-badge` 四种 8px/4px 徽标**统一并入 pill**（变更：同语义四档圆角是痛点审计点名项） |
| 0 / 50% | — | 贴边融合（tab、tabbar-manage、ws-new）与圆形钮（zen-exit）保留 | 非档位，按元素语义 |

### 5.2 边框

- 常规边框：`1px solid var(--ui-border)`（全局唯一描边色；亮 #d0d7de 暗 #30363d）。
- 强调边框：`1px solid var(--ui-accent/danger/warning)`，用于 active 控件（`.vv-html-toolbar button.active` app.css:195、`.vv-search-btn.active` :318、`.vv-gsearch-btn.active`）与危险确认框（`.vv-storage-confirm`）。
- 虚线：`1px dashed var(--ui-border)` 仅用于「截断提示」语义（`.vv-xlsx-truncated` app.css:278、`.vv-pptx-notice` :283、`.md-wikilink-dead` :191）与外域图占位（:303，色改 `var(--ui-warning)`，见 §2.3）。
- **分割线**：面板分界一律 `1px solid var(--ui-border)` 单边（border-bottom/left/right），禁止双线叠加；sticky 分组行自带底边即可（`.vv-wspanel-group` app.css:440-443 现以 side-bg 底色分层，保留）。

### 5.3 阴影（现状七式 → 收敛三档 token + 两个特例）

| Token | 值 | 用途（现状对位） |
| --- | --- | --- |
| `--vv-shadow-1` | `0 2px 8px rgb(0 0 0 / 15%)` | 小浮出件：`.vv-search-panel`（app.css:308） |
| `--vv-shadow-2` | `0 4px 16px rgb(0 0 0 / 18%)` | 菜单/status-picker（:377/509/531）、toast（AppShell.svelte:1271）、temp 条（app.css:359 现 `0 2px 12px`，并入，变更 4px 级模糊差） |
| `--vv-shadow-3` | `0 8px 28px rgb(0 0 0 / 22%)` | 同位面板族：ws-pop/wscreate/wspanel/gsearch/quickopen/sc-confirm |
| 特例·抽屉泛光 | `0 0 12px rgb(0 0 0 / 25%)`（AppShell.svelte:1209/1235） | 无偏移四周泛光，语义独立，就地保留 |
| 特例·纸张 | `0 1px 4px rgb(0 0 0 / 30%)`（app.css:208） | PDF 页物理投影，保留 |
| 退役 | `0 12px 36px rgb(0 0 0 / 30%)`（SettingsCenter.svelte:733） | 并入 `--vv-shadow-3`（变更） |

阴影只用黑基色（暗色下同样成立）；禁止彩色阴影。

---

## 6. 图标

**现状勘误（据实修正任务简报）**：`tools/gen-icons.mjs` 生成的是 **PWA 启动图标 PNG**（192/512 + maskable，底 #0d1117 前景 #e6edf3，gen-icons.mjs:1-18），**不产出 UI SVG**。当前 UI 内「图标」全部是文本字形与 emoji：⚙/📁/↻（TopBar.svelte:374-394/350）、☰/ℹ（AppShell.svelte:1089-1090）、🌳/ℹ（折叠竖条 AppShell.svelte:1010/1085）、🔒（WorkspaceTabsPanel.svelte:243 span + app.css:500 `::before content '🔒 '`）、✕/×/✎/✓/＋/▸/▾。

规范（在不改 DOM 结构的红线内执行）：

1. **单色字形白名单**（唯一允许集）：`✕`(U+2715 关闭) `✎`(U+270E 重命名) `✓`(U+2713 确认) `＋`(U+FF0B 新建) `↻`(U+21BB 刷新) `☰`(U+2630 抽屉) `ℹ`(U+2139 信息) `▸▾`(U+25B8/25BE 折叠) `⚙`(U+2699 设置)。**禁用彩色 emoji**：`🌳`（多数平台彩色渲染，与单色字形混排漂移）→ 折叠竖条文件树项改用白名单内 `▾`/`▸` 不合适，改用文本「树」（`.vv-strip-icon` 14px、竖条 28px 宽内可容纳 2 字）；`📁`（TopBar.svelte:382）同理改「目录」。`🔒` 退役：pinned 语义由斜体（TabBar `.vv-tab-pinned .vv-tab-name`）+ title 承担，app.css `::before` 的 `'🔒 '` content 置空（现 app.css:563，公共层归属）、WorkspaceTabsPanel.svelte span 内字符删除（改模板文本，非结构变更）。**修订（G3 复核裁决，2026-10-30）**：原文「e2e 锚定的是 `data-pinned`/`.vv-tab-pinned`，不锚字符」只对 TabBar 侧成立；wspanel 侧 e2e `t-tab-actions.spec.ts:517-518` 对 `.vv-wspanel-pin` 元素本身断言 `toBeVisible()`（Playwright 可见 = 非 empty bounding box，playwright-core@1.64 types.d.ts:17391），故 wspanel 的 span 保留为 **1×1 可见性钩子**（锚元素存在、不锚字符；e2e 不可改），pinned 行名斜体由 scoped 兄弟选择器 `.vv-wspanel-pin ~ .vv-wspanel-name` 提供（与 TabBar 同态；不用 `:has()`，兼容 Tauri/webkit2gtk 老内核）。
2. **字形统一**：TabBar.svelte:287 的关闭钮 `×`(U+00D7) → `✕`(U+2715)，与全库其余 12 处关闭钮同码位（变更：宽度与视觉重量归一；`.vv-tab-name` 文本语义不变，红线 9 满足）。
3. **尺寸与对齐**：图标字形所在元素 `line-height: 1`、`display: inline-flex; align-items: center`；字号三档——内联随文 12px、独立小钮 14px、浮钮 16px（zen 退出钮现 18px AppShell.svelte:1316 → 16px，44px 触控面不变）。纯图标钮必须带 `aria-label`（现状已合规，保持）。
4. **触控目标**（口径：以 WCAG 2.2 AA 2.5.8 的 24px 为底线，32/44px 为内部增强档）：指针环境 ≥24px（`.vv-collapse-btn` 现 22px app.css:341-342 → 补足 24px，变更）；触屏断点（≤900px）≥32px（灯箱钮现 32px app.css:169-171 ✓）。**44px 现值仅 `.vv-zen-exit` 成立**（AppShell.svelte:1310-1311，冻结）——`.vv-drawer-toggle`/`.vv-right-toggle` 无任何宽高/padding 声明（AppShell.svelte:1214-1220 实测读码），触控面=全局 button 默认约 24px 高，未达移动端入口标准：≤900px 断点内补 `min-width/min-height: 32px`（变更：~24→32px，§12.2-G1）。TopBar ⚙/📁/↻ 字形钮以 padding 补足 ≥32px 高（≤600px 档，变更）。
5. **未来项（本轮不做）**：若立项真 SVG 图标，须满足——单色 `currentColor`、16×16 viewBox 网格、线宽 1.5px、圆帽、经 `<symbol>` sprite 内联（零依赖）；届时 gen-icons.mjs 之外新建 `apps/web/src/lib/icons.ts` 单点管理，逐步替换字形白名单。

**边界（packages 渲染产物）**：以上白名单与禁用 emoji 仅适用 `apps/web` 模板与 app.css；packages 渲染产物中的既有彩色 emoji 为登记在案的既有项，本轮不处置——render-archive 以 `🔒 ${label}` 渲染加密条目（packages/render-archive/src/archive.ts:102，落在红线 1 锚点 `.vv-tree-row` 内），被 zip 单测（packages/render-archive/test/zip.test.ts:302 断言 `toContain('🔒')`）与 e2e BIN-08（apps/web/e2e/b-binary-hex-archive.spec.ts:116/130 断言 `toContainText('🔒')`）双重锁定，清理须随上游独立立项。

---

## 7. 交互状态

状态全集与统一写法（现状 rg 实测：transition/animation 全前端仅 5 处、`:focus-visible` 仅 2 处 app.css:450 与 AppShell.svelte:1322、hover 专属揭示多处无键盘等价——本轮补齐）：

| 状态 | 规则 | 备注 |
| --- | --- | --- |
| hover | 可点行/菜单项 `background: var(--ui-hover-bg)`；文字钮 `color: var(--ui-fg)` 或 `--ui-accent`；**不得只动 opacity** | 补 `.vv-tab:hover { background: color-mix(in srgb, var(--ui-hover-bg) 60%, var(--ui-border)); }`——**直用 hover-bg 无效**：`--ui-tab-bg` 与 `--ui-hover-bg` 亮暗各为同值（#f6f8fa/#161b22，app.css:13,15 与 24,25 实测读码），须 color-mix 向 border 方向派生一档可感知差异（亮色变深、暗色变浅）。非激活 tab 现零响应（app.css:479-488 实证无 hover 规则），激活 tab 由 `.active` 底色覆盖无需 hover；变更声明 §12.2-G1 |
| active（按下） | 不做位移/缩放（保持零漂移）；列表选中态用 `.active` 类：文字 `--ui-accent` + 可选 600 字重（`.vv-ws-item.active .vv-ws-name` app.css:409 现法） | — |
| focus-visible | **全局统一焦点环**（新增至 app.css 基础层）：`:where(button, input, select, summary, [tabindex], a[href]):focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -1px; }`（offset 负值防浮层贴边裁剪；`a[href]` 为走查补档——链接此前仅 UA auto 环，暗色上不可辨识，含 markdown 标题锚点）；已显式处理的（AppShell.svelte:1322 zen-exit）保留 | 键盘可达性的兜底保障；`:focus`（鼠标按下）不触发环 |
| 专属揭示的键盘等价 | hover 才显现的控件必须同时被 `:focus-within`/`:focus-visible` 显现：`.vv-ws-actions`（app.css:413-414 已有 focus-within ✓）、`.vv-wspanel-close`（:461 ✓）、`.vv-collapse-btn` opacity .35 → 补 `.vv-collapse-btn:focus-visible { opacity: 1 }`（现 hover 提亮 app.css:343，键盘聚焦恒 0.35 近乎不可见）、`.vv-tab-close` 同法（:486-488） | — |
| disabled | 统一 `opacity: .5; cursor: default;`，且抑制 hover 变化；五套口径归一：`.4`（pdf 工具条 app.css:203）、`.55`+弱化色（tabctx :513）→ `.5`（变更） | `aria-disabled`（tabctx 保持可聚焦语义）与 `[disabled]` 同观感；MountsManager 表单控件补齐禁用态（MountsManager.svelte:534 现无） |
| loading | 文本即态（「连接中…」TopBar.svelte:365、「加载更多」gsearch）+ 可选 disabled；不引入 spinner 组件 | 只读器场景足够 |
| 选中（列表项） | `color: var(--ui-accent); font-weight: 600;` 或 `background: var(--ui-hover-bg)` + accent 文字（`.vv-status-picker-item[aria-current='true']` app.css:535 现法） | 同构面板用同一法（§10 G3） |
| 拖拽落点 | `.vv-tab.vv-tab-dragover` 内嵌 2px accent 线（app.css:503-504 现法，data-drop-before 定向） | 冻结 |
| 触控目标 | 见 §6.4 | — |

---

## 8. 按钮体系与输入框

### 8.1 按钮 variant（现状「三种强调钮三套写法」→ 单点化）

| Variant | 形态（CSS 要点） | 现状对位 | 用于 |
| --- | --- | --- | --- |
| **primary** | 全局 button 底上覆：`color: var(--ui-accent); border-color: var(--ui-accent);`，hover `background: var(--ui-hover-bg)` | `.vv-wscreate-primary`（WorkspaceCreateModal.svelte:251-254 现法）——**以此为准** | 每浮层/每表单唯一主操作：新建工作区「创建」、设置中心「应用」（`.vv-sc-apply` 现与放弃同款灰钮 SettingsCenter.svelte:556-563，**改挂 primary**，痛点点名）、导入弹层确认 |
| **default** | app.css:43 全局规则原样（side-bg 底 + border） | — | 次要操作 |
| **ghost** | `background: none; border: none;` + hover `--ui-hover-bg` 或提色 | tabctx-item（app.css:510-512）、ws-act（:416-417）、status-picker-item | 菜单项、行内微操作；`background:none` 零散重置（rg 实测 31 处）不再新增——ghost 形态由全局 `.vv-btn-ghost`? **否**：红线禁新增类名体系，继续就地写，但值按本表 |
| **danger** | `color: var(--ui-danger); border-color: var(--ui-danger); background: none;` | `.vv-storage-danger`（StorageSection.svelte:297-301 现法） | 删除/清空类终钮 |
| **linklike** | `background:none; border:0; padding:0; color: var(--ui-accent); text-decoration: underline;` | `.vv-sc-linklike`（AboutSection.svelte:205-214 现法） | 设置页内链式动作 |

尺寸两档：md = 全局 `padding: 4px 10px`（app.css:43 现值）；sm = `padding: 2px 8px; font-size: var(--vv-fs-xs)`（12px 小钮现值群）。禁第三档。

### 8.2 输入框

- 文本输入/下拉：app.css:44-45 全局规则原样（`--ui-bg`/`--ui-side-bg` 底 + `--ui-border` + 6px 圆角 + `4px 8px` padding）；字体修复见 §3.1 基础层。
- focus：走 §7 全局焦点环；**不**加 box-shadow 环（与拖拽内嵌线机制冲突）。
- 宽度纪律：面板内输入 `flex: 1; min-width: 0`（现状惯例）；定宽输入须给收窄理由注释（`.vv-server-form input` 220/150px app.css:395-396 有 BUG-62 注释，保留）。
- checkbox：`accent-color: var(--ui-accent);`（基础层一行，全站 checkbox 统一着色，零 DOM 变更）。

---

## 9. 表单排版（设置节为主）

行模型（对齐 `.vv-settings-theme-row` app.css:595-598 现法）：**标签行 + 控件行上下排，行间 `--vv-sp-6`；短表单可单行 flex（label 左、控件右）但同节内二选一不混用**。

| 成分 | 规则 | 现状对位 |
| --- | --- | --- |
| 标签 `.vv-settings-label` | `font-weight: 600; font-size: var(--vv-fs-sm);`（13px） | 旧稿 `git show 8e32a43~1:apps/web/src/lib/SettingsPanel.svelte`（style :856-859）原样 |
| 帮助 `.vv-settings-hint` | `color: var(--ui-fg-muted); font-size: var(--vv-fs-xs);`（12px） | 旧稿 :860-863 |
| 警示 `.vv-settings-warn` | `color: var(--ui-warning); font-size: var(--vv-fs-xs);` | 旧稿 :931-934 |
| 空态 `.vv-settings-empty` | `color: var(--ui-fg-muted); font-size: var(--vv-fs-xs);` | 旧稿 :886-889 |
| 删除钮 `.vv-settings-remove` | `border:0; background:none; padding:0 3px; color: var(--ui-fg-muted);` hover `color: var(--ui-fg);` | 旧稿 :872-885（保持旧稿 hover 提亮，不危险化——危险化另立项） |
| 添加表单 `.vv-settings-add` | `display:flex; gap:6px;` input `flex:1; min-width:0;` | 旧稿 :890-895 |
| 预设钮 `.vv-settings-presets` | `display:flex; gap:6px;` button `font-size: var(--vv-fs-xs);` disabled opacity .5 | 旧稿 :896-906 |
| chip 列表 `.vv-settings-patterns`/`.vv-settings-pattern` | ul：`list-style:none; margin:0; padding:0; flex-wrap:wrap; gap:6px;` chip：`inline-flex; align-items:center; gap:4px; border:1px solid var(--ui-border); border-radius: var(--vv-radius-full); padding:1px 4px 1px 8px; font-size: var(--vv-fs-xs);` | 旧稿 :864-871（radius 12px→token pill，同视觉）；chip 内 `<code>` 继承等宽 `var(--vv-code-font)` |
| 开关 `.vv-settings-toggle` | `display:flex; align-items:center; gap:6px; font-size: var(--vv-fs-sm); cursor:pointer;` | 旧稿 :907-912——自动刷新节（AutoRefreshSection.svelte:17-23）随之脱离 UA 裸排 |
| 错误态 | 输入错误文本：`color: var(--ui-danger); font-size: var(--vv-fs-xs);`（`.vv-server-error` app.css:397、`.vv-sc-jsonerrors` SettingsCenter.svelte:684-691 现法对齐）；控件本身不加红框（现无此语义，不发明） | — |
| 标签列宽（dl 表） | dt 定宽按最长标签校准：`.meta-row dt` 现 `2.6em`（MetaPanel.svelte:334-338，12px 下 31px，「打开方式」4 字需 48px 被迫折行）→ **`width: 4em`**（48px@fs-xs）；数据检查器复用同表自动修复 | 变更：列宽放宽 |

间距：节容器 `.vv-sc-section`（app.css:591 现 gap 6px）升为 `gap: var(--vv-sp-6)`；节与节之间依赖 nav 分组，不加额外分隔线。

---

## 10. 组件规范（按实施分组）

### G1 壳层与导航条（AppShell / TopBar / TabBar / TabContextMenu / +page.svelte）

- **Tab hover 补齐**：`.vv-tab:hover { background: color-mix(in srgb, var(--ui-hover-bg) 60%, var(--ui-border)); }`（app.css:479 后插入；`--ui-tab-bg` 与 `--ui-hover-bg` 亮暗同值，直用 hover-bg 零视觉响应——必须 color-mix 派生，见 §7；`.active` 规则已在后靠序覆盖，激活 tab 不受影响；变更声明 §12.2-G1）。
- **关闭字形** ×→✕（TabBar.svelte:287）；**pinned 🔒 退役**（§6.1）。
- **焦点态**：全局 focus-visible 环（§7）落地后，`.vv-collapse-btn`/`.vv-tab-close` 补 `:focus-visible { opacity: 1 }`。
- **图标字形**：⚙ 保留，📁→「目录」、🌳→「树」、🔒 退役；↻/☰/ℹ 保留（§6）。
- **抽屉过渡**：`transition: transform 0.2s`（AppShell.svelte:1206/1232）改 `var(--vv-dur-med) ease-out`（200ms 等值零漂移）；toast `0.18s`（:1272）并入 `var(--vv-dur-med)`（变更 20ms 级）；`.vv-ws-actions` opacity `.12s`（app.css:413）改 `var(--vv-dur-fast)`。
- **chrome temp 条阴影** `0 2px 12px`→`--vv-shadow-2`（app.css:359）。
- **zen 退出钮**：44px/浮钮规格冻结（AppShell.svelte:1304-1324）；focus-visible 已有保留。抽屉/右栏开关钮（`.vv-drawer-toggle`/`.vv-right-toggle`，无宽高声明现 ~24px 高）在 ≤900px 断点内补 `min-width/min-height: 32px`（§6.4，变更）。
- +page.svelte 拖拽壳无样式改动，仅随组 review。

### G2 阅读区与侧栏面板（ViewerPane / SearchPanel / MetaPanel / Toc / FileTree / TreeNodeRow）

- **MetaPanel dt 列宽** `2.6em→4em`（§9 标签列宽行）。
- **字号 token 化**：状态栏（app.css:473-474 12px→`--vv-fs-xs`）、搜索面板 count/btn（:310-311）、TOC（:560 13px→`--vv-fs-sm`）、`.meta-list`（MetaPanel.svelte:327 12px→`--vv-fs-xs`）、`.meta-title`/`.meta-export-title` 11px（app.css:545-546/551-552→`--vv-fs-2xs`）。
- **树行/源行一致化**：树行 hover 用 `--ui-hover-bg`（app.css:540 现 side-bg，同值语义归一）；源行 `.vv-tree-src` 非整行交互，仅 remove 钮保持现状。
- `.vv-search-panel` 阴影→`--vv-shadow-1`；`.vv-status-picker` 阴影→`--vv-shadow-2`（值不变）。
- 状态栏渲染器指示器 `.vv-status-openwith`（:526-528）形态保留（融入文本段），仅字号随状态栏 token 化。

### G3 检索与工作区浮层（GlobalSearchPanel / QuickOpenPanel / WorkspaceTabsPanel / WorkspaceCreateModal / RemoteSourceModal）

- **行密度统一** `padding: 3px 10px`，缩进由既有前缀列（`.vv-gsearch-lncol`）或伪元素定宽占位（wspanel 行为 flex，`text-indent` 不可用）承接、不新增 DOM（§4.3，红线 1）；hover/active 统一 `--ui-hover-bg` + accent 文字。
- **`.vv-gsearch-hint`** `#b58900`→`var(--ui-warning)`（§2.3）。
- **主钮单点化**：三面板内主操作按 §8.1 primary 形态挂（gsearch/wspanel 无表单主钮则不动；wscreate「创建」已有 `.vv-wscreate-primary` 对齐基准）。
- **wscreate 交互补齐**：保持同位浮层形态（与 ws-pop/tabctx 同族，**不加背板**——模态背板是 sc-modal 专属语义）；补**外点关闭**（JS 事件层，宿主已有 pointerdown 关闭通道模式，不改 DOM 结构）；面板阴影已是 `--vv-shadow-3` 档。
- `.vv-wspanel-badge` 圆角 8px→`--vv-radius-full`；`.vv-tab-src`（app.css:492）同步 pill 化。
- 浮层 root 类名/OVERLAY_SELECTOR 在册成员一概不动（§0 红线 2）。

### G4 设置中心（SettingsCenter + 九节，最高优先级）

- **补回丢失的全局类**（app.css 增补，底稿 `git show 8e32a43~1:apps/web/src/lib/SettingsPanel.svelte` style :837-938，token 化改写为 §9 表逐行值）：`.vv-settings-label / -hint / -warn / -empty / -add / -remove / -toggle / -patterns / -pattern / -presets` 十类。**形态=新增全局类定义，不得 scoped/改名**（§0 红线 8）。恢复后十个节组件（SearchSection.svelte:37-76、AutoRefreshSection.svelte:17-23 等）全量脱离 UA 默认渲染。
- **字号孤岛收敛**：`.vv-sc-title` 15px→`--vv-fs-md`（SettingsCenter.svelte:526）、弹层标题 14px→同 token（:742）；nav/菜单/正文对位 fs-sm/fs-xs。
- **等宽令牌**：JSON 行号/文本域/导入 diff/StorageSection 缓存名裸 `ui-monospace`→`var(--vv-code-font)`（SettingsCenter.svelte:663/677/761、StorageSection.svelte:288）。
- **主钮**：`.vv-sc-apply` 挂 primary 形态；「放弃」保持 default；disabled 统一 opacity .5（:559-563 现 .5 ✓ 对齐）。
- **弹层阴影**：`.vv-sc-modalbox` `0 12px 36px/30%`→`--vv-shadow-3`，圆角 10px→`--vv-radius-lg`。
- `.vv-sc-confirm` 边框 `var(--ui-warning)` 保留（脏态警示语义正确）。
- 回归口径：`apps/web/e2e/settings-center.ts:17-39` 装置（`button[aria-label="设置"]` / `.vv-sc-navitem` 九组文案 / `.vv-sc-apply` disabled 复位信号 / Esc + toHaveCount(0) 守卫）与 `.vv-sc-dirty`「未应用」文案（b-settings-center.spec.ts:135/227）不得受样式改动影响。

### G5 目录管理页（MountsManager.svelte）

- **硬编码色换令牌**（§2.3 表）：#b91c1c→`--ui-danger`、#b45309→`--ui-warning`、#6b7280→`--ui-fg-muted`；`--ui-text` 误写改正为 `var(--ui-fg)`（MountsManager.svelte:659）。
- **opacity 弱化换令牌色**：.vv-mm-sub .65（:680）、.vv-mm-meta .7（:738）、.vv-mm-state[unregistered] .6（:754）、.vv-mm-caps .55（:758）、.vv-mm-hint .75（:791）、.vv-mm-empty .6（:795）→ `color: var(--ui-fg-muted)`、删 opacity。
- **em 碎阶收敛**（rg 实测 17 处 → px token，按 U=16px 实测值就近归档）：1.15em(18.4px 标题)→600 字重 + `--vv-fs-md`；0.95em(15.2px，MountsManager.svelte:820-823 `.vv-mm-form h3`)→`--vv-fs-sm` 600（例外注明：几何就近应为 fs-md，此处按语义档位优先——表单框内节标题对齐 `.vv-settings-label` 的 fs-sm+600 档）；0.85em(13.6)/0.82em(13.1)→`--vv-fs-sm`；0.8em(12.8)/0.78em(12.5)/0.75em(12)→`--vv-fs-xs`；0.72em(11.5 徽标/caps)→`--vv-fs-2xs`；`1em` 组名→`--vv-fs-sm` 600。同行距 `em` gap（.4/.5/.6em）换 `--vv-sp-*` 对应档。
- **徽标圆角**：`.vv-mm-badge` 999px→`--vv-radius-full`（已是值，改引 token）；按钮 5px 圆角→`--vv-radius-md`。
- 表单控件禁用态补齐（§7 disabled）；hover `color-mix(border 35%)` 保留（§2.4 派生法范本）。
- 回归口径：`.vv-mm-item/.vv-mm-form/.vv-mm-state`（e2e 26/20/8 处）为锚点类，不动名。

---

## 11. 动效与过渡

原则：**克制、只有状态反馈、绝不做装饰动画**；全库动效仅允许两类——透明度/颜色渐变（状态切换）与 transform（抽屉/toast 进出）。

| Token | 值 | 用途 |
| --- | --- | --- |
| `--vv-dur-fast` | 120ms | hover 显隐（`.vv-ws-actions` app.css:413 现 .12s）、小态渐变 |
| `--vv-dur-med` | 200ms | 抽屉 transform（AppShell.svelte:1206/1232 现 0.2s）、toast 出场（现 0.18s 并入）、hex 跳转闪衰减保持 1s（功能性，不入档，keyframes app.css:237-241 冻结） |

- 缓动：入场 `ease-out`，位移类 `ease`（现状默认）即可；禁止 spring/回弹。
- 可动属性白名单：`opacity` / `transform` / `background-color` / `border-color` / `color`；禁 `width`/`height`/`top`/`left`（回流）。
- **`prefers-reduced-motion` 全局适配**（rg 实测现零适配）——新增至 app.css 基础层：

```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

（reduced-motion 下 hex 跳转辅助闪烁被压至瞬时且恒为终态透明——**完全省略**而非瞬显瞬隐，跳转仅剩滚动定位表达；toast 入场瞬显。定位功能不受影响，辅助性动效的降级可接受。）

- 不新增 loading spinner/骨架屏动画；面板开合（overlay 族）保持瞬显（现状），不引入进出动画——浮层高频开关，动效成本大于收益（Linear 取舍项）。

---

## 12. 落地清单

### 12.1 令牌增量表（30 项；默认值=现状视觉，零漂移）

**色——主题语义（`--ui-*`，进三块级联：亮默认/暗/system 块）：**

| # | 名称 | 亮默认 | 暗默认 | 用途 | 供给模式 |
| --- | --- | --- | --- | --- | --- |
| 1 | `--ui-success` | `#1a7f37` | `#3fb950` | markdown-alert-tip 边、成功语义（暗值=GitHub dark green，新定） | 恒默认（白名单外，未来候选键 testing.iconPassed） |
| 2 | `--ui-accent-2` | `#8250df` | `#a371f7` | markdown-alert-important/example 边 | 恒默认（白名单外） |

**色——固定效果（`--vv-*`，双主题同值=现状）：**

| # | 名称 | 默认值（亮=暗） | 用途 |
| --- | --- | --- | --- |
| 3 | `--vv-hit-bg` | `rgb(255 213 0 / 45%)`（暗同值） | 搜索字符命中 mark（app.css:312 现 45%；GlobalSearchPanel.svelte:394 现 55% → 收敛本值，变更；修复暗色 3.44→4.61:1，见 §2.3） |
| 4 | `--vv-hit-active` | 亮 `rgb(255 160 0 / 80%)`；**暗色两块覆盖 `rgb(255 160 0 / 35%)`** | 当前命中（app.css:313）。全表唯一分值 token：80% 暗色对 code-fg 仅 2.58:1（§2.3 实测 FAIL），35% 达 7.63:1；「当前命中」区分度由 1px inset 描边补足 |
| 5 | `--vv-hit-line` | `rgb(255 213 0 / 18%)` | 命中行底（app.css:314） |
| 6 | `--vv-hit-line-active` | `rgb(255 160 0 / 35%)` | 当前命中行底（app.css:316） |
| 7 | `--vv-hex-hit` | `rgba(255, 176, 0, .22)` | hex 命中（app.css:234） |
| 8 | `--vv-hex-hit-active` | `rgba(255, 120, 0, .55)` | hex 当前命中（app.css:235） |
| 9 | `--vv-hex-flash` | `rgba(255, 176, 0, .4)` | hex 跳转闪 keyframes from（app.css:238） |
| 10 | `--vv-scrim` | `rgb(0 0 0 / 35%)` | 模态背板（SettingsCenter.svelte:723 现值）；灯箱 70% 黑（app.css:153）为物理遮罩特例保留 |

**浮层阴影：**

| # | 名称 | 默认值（亮=暗） | 用途 |
| --- | --- | --- | --- |
| 11 | `--vv-shadow-1` | `0 2px 8px rgb(0 0 0 / 15%)` | 小浮出件（search-panel） |
| 12 | `--vv-shadow-2` | `0 4px 16px rgb(0 0 0 / 18%)` | 菜单/status-picker/toast/temp 条 |
| 13 | `--vv-shadow-3` | `0 8px 28px rgb(0 0 0 / 22%)` | 同位面板族 + sc-modalbox（退役 0 12px 36px 档） |

**几何：**

| # | 名称 | 默认值 | 用途 |
| --- | --- | --- | --- |
| 14 | `--vv-radius-sm` | `4px` | 内嵌小件（并 2/3/5px） |
| 15 | `--vv-radius-md` | `6px` | 按钮/输入框/卡片/小浮层（并 10px） |
| 16 | `--vv-radius-lg` | `8px` | 大面板/模态 |
| 17 | `--vv-radius-full` | `999px` | 徽标/chip pill |
| 18-24 | `--vv-sp-2 / -4 / -6 / -8 / -10 / -12 / -16` | `2/4/6/8/10/12/16px` | 间距枚举（值=名） |

**动效：**

| # | 名称 | 默认值 | 用途 |
| --- | --- | --- | --- |
| 25 | `--vv-dur-fast` | `120ms` | hover 显隐（现 .12s） |
| 26 | `--vv-dur-med` | `200ms` | 抽屉/浮层过渡（现 0.2s；toast 0.18s 并入） |

**字阶（calc 派生，随用户字号联动）：**

| # | 名称 | 定义 | U=16px | 用途 |
| --- | --- | --- | --- | --- |
| 27 | `--vv-fs-2xs` | `calc(var(--vv-ui-font-size) * 0.6875)` | 11px | 徽标/角标 |
| 28 | `--vv-fs-xs` | `calc(var(--vv-ui-font-size) * 0.75)` | 12px | 状态栏/次级文本 |
| 29 | `--vv-fs-sm` | `calc(var(--vv-ui-font-size) * 0.8125)` | 13px | 菜单/tab/表单标签 |
| 30 | `--vv-fs-md` | `calc(var(--vv-ui-font-size) * 0.875)` | 14px | 面板标题（并 15/14px 孤值） |

放置位置：色/几何/动效/字阶全部进 app.css `:root` 亮色块 + 暗色两块（`--ui-success`/`--ui-accent-2`）；`--vv-*` 固定效果**默认只进 `:root`，表内声明暗色覆盖者（现唯一 `--vv-hit-active`，#4 行）须同写暗色两块**——漏写即丢失暗覆盖、暗色 2.58:1 回归（纯 app.css 级联变化，防漂移测试不拦）。字阶 token 必须放在 `--vv-ui-font-size` 声明可见处（同 `:root`，calc 运行时解析，`style#vv-font` 注入值自动生效）。

### 12.2 分组实施要点（可执行项速览）

- **G1**：tab hover；✕ 统一；🔒/🌳/📁 字形处置；focus-visible 环 + opacity 揭示键盘等价；抽屉/toast 时长 token 化。变更声明：×→✕、字形替换（⚙ 保留，📁→「目录」、🌳→「树」、🔒 退役）、temp 条阴影归档 `--vv-shadow-2`、**tab hover 零响应→color-mix 可感知底色**、**disabled 归一（pdf 工具条 .4→.5 app.css:203、tabctx .55→.5 app.css:513）**、**抽屉/右栏 toggle 钮 ≤900px 补 32px（~24→32）**、TopBar 字形钮 ≤600px 补 ≥32px 高、zen 退出钮字形 18→16px（AppShell.svelte:1316，§6.3）、toast 0.18s→200ms。
- **G2**：dt 4em；状态栏/搜索/TOC/meta 字号 token 化；hover 语义归一（零漂移）；阴影 token 化（值不变）。
- **G3**：三面板行 `3px 10px` + hover/active 统一（视觉变更：gsearch 行 2px→3px、缩进改纯 CSS 承接）；gsearch-hint 换 `--ui-warning`；badge pill 化；**gsearch mark 55%→`--vv-hit-bg` 45%（修复暗色 3.44→4.61:1）**；wscreate 补外点关闭（JS 层）。
- **G4**：十类全局类恢复（§9 表即实施文案）；fs-md 收敛（15→14px 变更）；`var(--vv-code-font)` 四处替换；`.vv-sc-apply` primary 化（灰→accent 描边变更）；modalbox 阴影/圆角归档。
- **G5**：色/弱化/em/圆角四张映射表照 §10-G5 执行；`--ui-text`→`--ui-fg`。
- **基础层（随组先行，一次到位）**：§12.1 token 块；`button,input,select` 补 `font-family: inherit; font-size: var(--vv-fs-sm);`；全局 focus-visible 规则；`checkbox accent-color`；`prefers-reduced-motion` 块；`#d33` 死回退清理；`.vv-pdf-page-label` 暗色修复；markdown-alert 七色→令牌（**双端同步段，须同步 exportBaseCss**）；`--vv-hit-active` 暗色覆盖（修复 2.58→7.63:1）；`.vv-collapse-btn` 22→24px；`.vv-docx-content` 15px→`0.9375em`（U=16 等值零漂移）；小圆角并档（pdf 页码 chip 3px app.css:211、gsearch mark 2px GlobalSearchPanel.svelte:396 → `--vv-radius-sm`；G5 按钮 5px → `--vv-radius-md`）。

### 12.3 回归检查单

1. `default` 外观 + U=16px 下，亮/暗两模式逐面板目检（TopBar/TabBar/树/代码/markdown/hex/jsonl/设置中心九节/挂载管理/四浮层/灯箱）——除 §12.2「变更声明」项外应零差异。
2. 字号联动：设置中心把 UI 字号调至 20px、代码字号 18px，验证 chrome 字阶随动（fs token 生效）且 `--vv-code-line-height` 联动（j/k 步长不破）。
3. e2e 全量（mobile project 375px 视口跑全套为既有口径）；重点盯 b-settings-center（脏态文案/九组导航）、b-layout-zen（几何 boundingBox：colhandle 6px 热区、edge 10/8px、zen-exit 44px）、drawer（transform 判定）。
4. theme.test.ts / theme.fonts.test.ts / markdownExport.test.ts / export.test.ts 四个防漂移测试必须全绿（任何红灯=踩了双端同步段或注入格式）。
5. 对比度抽检：替换后的 G5/G3 文本色**与 mark×前景组合**（hit-active 暗、gsearch mark 暗，含 mark 叠在 hit-line 之上的双层叠加值）在暗色下重跑 §2.3 node 脚本，全部 ≥4.5:1。
6. **wscreate 外点关闭回归**：该行为为 G3 新增（JS 层）。rg 实测既有引用面 5 个 spec 共 10 处 `.vv-wscreate`（t-tab-actions 1 / t-workspace 3 / b-wsx-recovery 4 / b-layout-zen 1 / b-filetree-src-remove 1，均为面板内操作路径）——回归确认外点关闭不误伤面板内点击；为新行为补一条 e2e 用例（新增用例不触碰既有断言，符合红线 10 的「不改测试」）。

---

### 附：本规范的证据清单

- 实读：`apps/web/src/app.css`（全文 658 行）、`apps/web/src/lib/theme.ts`（全文 452 行）、`tools/gen-icons.mjs`、`packages/highlight/src/vscode.ts:270-310`、`apps/web/e2e/helpers.ts` / `drawer.ts` / `settings-center.ts`、`MountsManager.svelte:640-869`、`SettingsCenter.svelte:502-784`、`GlobalSearchPanel.svelte:296-405`、`QuickOpenPanel.svelte:182-254`、`MetaPanel.svelte:221-363`、`AppShell.svelte:1148-1326`、`TopBar.svelte:259-398`、`TabBar.svelte:276-309`、`SearchSection.svelte`、`AutoRefreshSection.svelte`、`WorkspaceCreateModal.svelte:195-275`、`StorageSection.svelte:251-344`、`AboutSection.svelte:186-215`、`FileTree.svelte:79-110`、`ViewerPane.svelte:554-578`；旧底稿 `git show 8e32a43~1:apps/web/src/lib/SettingsPanel.svelte`（style 837-938 行）。
- 实测（本会话运行）：WCAG 对比度 node 脚本（§2.3 两张表全部数值，含 mark×前景组合：hit-active 80% 暗 2.58:1、gsearch 55% 暗 3.44:1、45% 4.61:1、暗覆盖候选 35% 7.63:1）；rg 统计——硬编码 px 字号 114 处分布（含 15px/14px 逐处定位：app.css:258/330 与 SettingsCenter.svelte:526/742）、MountsManager em 字号 17 处、border-radius 十档分布、box-shadow 七式、transition/animation 5 处、focus-visible 2 处、`background:none` 31 处、关闭字形 ×/✕ 分布、`#d33` 死回退 14 处声明全量定位、`.vv-settings-*` 十类零 CSS 定义、`.vv-tab` 无 hover 规则、`--ui-text` 误写唯一处、wscreate e2e 引用分布（5 spec 共 10 处）；e2e 行号复核（drawer.ts:19/:28-33、helpers.ts:54-60）；export.ts:111/114 图表段复核；archive.ts:102 + zip.test.ts:302 + b-binary-hex-archive.spec.ts:116/130 锁形字符断言复核；AppShell.svelte:1214-1220 抽屉钮无宽高声明复核。
