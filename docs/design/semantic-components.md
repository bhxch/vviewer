# vviewer 语义交互复用清单

版本：2026-11-12（首版，Task 12 成文）。
适用范围：`apps/web`（Svelte 5 runes）与消费 `packages/vviewer-core` 错误通道的渲染包。
规范基线：`apps/web/src/lib/AppShell.svelte`（OVERLAY_SELECTOR）、`apps/web/src/app.css`（z-index/焦点环/通道视觉类）。所有「现状」断言均来自本仓库代码实读与 rg 实测，标注为 `文件:行号`。

成文纪律（aelrova SEMANTIC-COMPONENTS 同款）：**每条规则要么有机检载体（编译器/ESLint/Vitest/e2e axe），要么落在 frontend-conventions.md 的 PR 必查清单，二者皆无不写入**。本清单是交互形态的**唯一登记处**——条款正文不复抄进 AGENTS.md 或其他文档（单源防漂移）。

---

## 0. 机械规则（先于一切规则）

1. **新建任何交互组件/浮层/菜单/确认/提示之前，必须先 grep 本清单**（类名锚、通道名、档位名），命中即复用既有形态，不得裸写同义实现。
2. **新增条目先登记后使用**：清单里没有的形态，先在本文补登记（形态锚/z-index/关闭通道/机检锚五要素，见 §7 模板），再写代码。评审按「登记先于实现」核对。
3. 红线冲突时以 `ui-design-system.md` §0 实施红线优先（OVERLAY_SELECTOR 入册类名、`.vv-*` e2e 锚、data-\* 锚不可动——本清单的类名全部同时是红线锚）。

**载体**：规则 1/2 无通用机检（属「新建动作是否发生」的语义判断），落在 frontend-conventions.md PR 必查清单第 3 条；规则 3 的消费面行为有既有 e2e/单测机检（§2 逐条列载）。

---

## 1. 浮层注册表（OVERLAY_SELECTOR）

**现值**（`AppShell.svelte:649-664`，11 类，join(', ') 后被 `anyOverlayOpen()` 实读 DOM 消费）：

| # | 类名 | 宿主组件 | 挂载形态 | 关闭通道 |
|---|---|---|---|---|
| 1 | `.vv-settings-center` | SettingsCenter.svelte | AppShell `{#if}` 条件挂载 | Esc / 关闭钮 / 应用并关闭 |
| 2 | `.vv-mounts-manager` | MountsManager.svelte | 同上（Ctrl+Alt+M） | 容器 keydown + window 兜底双 Esc（表单在场先关表单） |
| 3 | `.vv-gsearch` | GlobalSearchPanel.svelte | 同上（Ctrl+Shift+F） | Esc |
| 4 | `.vv-quickopen` | QuickOpenPanel.svelte | 同上（Ctrl+P） | Esc |
| 5 | `.vv-wspanel` | WorkspaceTabsPanel.svelte | 同上（Alt+W） | Esc |
| 6 | `.vv-search-panel` | SearchPanel.svelte（文件内搜索条） | ViewerPane 内 absolute | Esc |
| 7 | `.vv-wscreate` | WorkspaceCreateModal.svelte | `.vv-wscreate-panel` fixed 浮层（app.css:407-415 visibility 通道） | 外点关闭（JS 层）+ Esc |
| 8 | `.vv-remotesrc` | RemoteSourceModal.svelte | WorkspaceCreateModal 内嵌 | Esc |
| 9 | `.vv-tabctx` | TabContextMenu.svelte | fixed（指针坐标） | Esc / 外点 |
| 10 | `.vv-tbmenu-pop` | TabBarMenu.svelte | fixed（触发钮 rect clamp，AppShell ≤600px 档同源） | Esc / 外点 / 移动端返回键 |
| 11 | `.vv-status-picker` | ViewerPane.svelte（状态栏打开方式浮层） | absolute（状态栏上方） | Esc / 外点 |

**规则与理由**：

1. **新浮层（同位面板/菜单/拾取器形态）必须入册**。OVERLAY_SELECTOR 是运行时行为通道，不是装饰清单：`anyOverlayOpen()` 决定桌面 Esc 的优先级（面板在场先关面板再退 zen）与移动端返回键判定（`closeTopOverlayForZen`，history 守卫）。漏入册 = zen 态下 Esc/返回键行为破损。`ui-design-system.md` §0 红线 2 同款：入册类名改名即破坏功能。
2. **退役条目随宿主删除**：`.vv-ws-pop` 已随标签栏收敛删除（工作区子菜单随融合菜单宿主浮层同生命周期）、`.vv-tbact-pop` 随迁 `.vv-tbmenu-pop`。登记表与代码同步是义务。
3. `.vv-settings-center` 曾有「AppShell 平级挂载不入册」的历史注释（app.css:412-414），现值已在册（AppShell.svelte:650）——以 AppShell 源码为权威。

**机检载体**：单测源码锚先例 `mountsManagerUi.test.ts:143-147`（断言 OVERLAY_SELECTOR 数组体含 `.vv-mounts-manager`）；zen Esc 分层行为 e2e（b-layout-zen / b-layout-zen-deep）；axe 面板态扫描（b-a11y-axe A11Y-04~09 覆盖 1/2/3/4/10 五类浮层）。新浮层入册核对本身落 PR 必查清单第 3 条。

---

## 2. z-index 档位（现状实测，rg 全仓盘点）

取现值口径：`rg "z-index" apps/web packages`（2026-11-12 实测，`node_modules`/构建产物除外）。**新浮层按表取值，禁止新开档位**；同档新成员须与既有成员语义同层（面板配面板、菜单配菜单）。

| 档 | 值 | 成员（文件:行） | 语义 |
|---|---|---|---|
| 行内盖 | 1 | `.vv-tabbar-arrow`（app.css:552）；tab 滚动渐隐上的箭头（app.css:549-552） | 容器内局部盖序 |
| 竖条钮 | 5 | `.vv-collapse-btn`（app.css:362） | 折叠竖条展开钮 |
| 抽屉带 | 20 | `.vv-side` 抽屉态（AppShell.svelte:1656）、`.vv-right` ≤600px 抽屉态（:1690）、`.vv-drawer-toggle`（:1668）、`.vv-right-toggle`（:1702）、`.vv-dl-progress` / `.vv-dl-confirm`（app.css:168/195，查看器内 absolute） | 压过 ArtPlayer `.art-video`（上游 absolute z-index:10）——PWA-09/2、MEDIA-11 修复口径 |
| zen 退出钮 | 25 | `.vv-zen-exit`（AppShell.svelte:1773） | 刻意低于面板层 30：面板在场时返回键先关面板的视觉一致 |
| 面板层 | 30 | overlay 族：`.vv-settings-center`（SettingsCenter.svelte:520）、`.vv-mounts-manager`（MountsManager.svelte:657）、`.vv-gsearch`（GlobalSearchPanel.svelte:325）、`.vv-quickopen`（QuickOpenPanel.svelte:208）、`.vv-wscreate-panel`（app.css:474-477）、`.vv-wspanel`（app.css:484）、`.vv-status-picker`（app.css:680）、`.vv-git-blame-pop`（app.css:799） | 同位面板/浮层/拾取器基准档 |
| 确认/模态 | 31 / 32 | `.vv-sc-confirm` 31（SettingsCenter.svelte:727）、`.vv-sc-modal` 32（:745） | 面板层之上的次级弹层 |
| chrome 条 | 50 | `.vv-chrome-off` / `.vv-chrome-temp`（app.css:392/397） | 标签栏隐藏后的临时条 |
| 通知/搜索 | 60 | `.vv-toast`（AppShell.svelte:1724）、`.vv-search-panel`（app.css:329） | 瞬态告知与搜索条 |
| 菜单 | 90 | `.vv-tabctx`（app.css:650）、`.vv-chromemenu`（app.css:420）、`.vv-tbmenu-pop`（app.css:579） | 瞬态操作面，不被任何浮层压住 |
| 灯箱 | 100 | `.md-lightbox-overlay`（packages/vviewer-markdown/src/markdown.css:78；`css.ts` `RUNTIME_LIGHTBOX_CSS` 运行时同值） | markdown 包承载，全站最高 |

**勘误注记**：`ui-design-system.md` §4.4 表载抽屉档 10——已过时；现值为 20（ArtPlayer 上游 z 10 会盖抽屉的命中测试修复，见 AppShell.svelte:1652-1656 注释）。本表为现值权威；§4.4 以「面板 30 < 条 50 < 菜单 90」的核心序仍成立。

**机检载体**：无通用机检（CSS 值盘点性规则）；档位核对落 PR 必查清单第 3 条。既有档位间关系有行为面机检：zen 返回键分层（b-layout-zen-deep LZ-12）、灯箱画廊（markdown e2e）。

---

## 3. 菜单 / 下拉模式

**先例：TabBarMenu（融合菜单，`.vv-tbmenu-pop`）**：

1. **瞬态菜单不用 `role="menu"`**：条目均为原生 `button`（键盘天然可达、Tab 序可达），menu 角色反而要求 roving tabindex/方向键管理（svelte `a11y_interactive_supports_focus` 警告面）。展开态经触发钮 `aria-expanded` 表达（TabBarMenu.svelte:246-249 注释原文口径）。
2. **触发钮 aria-label 与可见文本必须包含**（axe `label-content-name-mismatch` 曾真违规真修）：现形态 `工作区：{name}`（可见文本 `{name} ▾`，chevron 为 aria-hidden 不进 name）。
3. **右键菜单三件同款**：`.vv-tabctx` / `.vv-chromemenu` / `.vv-tbmenu-pop` 共用「fixed + min-width 11em/10em + 4px padding + 纵向 flex + `--vv-shadow-2` + z 90」形态（app.css:420-425/579/650）。
4. **role=menu 仅用于无可见表单语义的纯拾取浮层**：`.vv-status-picker`（role=menu + aria-label「打开方式」，无可见文本故无 mismatch 面——ViewerPane.svelte 状态栏浮层）。
5. 就地手风琴子菜单（TabBarMenu sub 单槽同刻至多展开、父项 aria-expanded）——新增多级导航沿用该形态，不引入 flyout 定位层。

**机检载体**：`svelte/valid-compile`（编译器 a11y 警告 → lint error）；axe 全页扫描 A11Y-08（TabBarMenu 展开态）与 A11Y-05~07（各浮层态）零违规断言；`svelte/require-each-key`（菜单条目 each key 稳定标识符）。

## 4. 确认卡 / 错误卡 / 状态条通道（反馈三通道）

信息按性质择通道，不发明第四条：

| 通道 | 形态锚 | 适用 | 现状成员 |
|---|---|---|---|
| **错误卡** | `.vv-error-card`（title/detail/meta/actions 四段，app.css:154-164） | 渲染失败/加载失败等阻断性错误 | core dispatcher `showErrorCard`（packages/vviewer-core/src/dispatch/errorRenderer.ts:41-52）+ `errorRenderer` 兜底渲染器（:71-82）+ svelte:boundary failed 片段（AppShell.svelte:1264-1273 复用 `.vv-error-*` 视觉 + 「重载」） |
| **确认卡** | `.vv-dl-confirm`（role=alertdialog，DownloadConfirmCard.svelte:33）；`.vv-sc-confirm`（设置中心脏态条，z 31）；`.vv-storage-confirm`（危险确认，accent/danger 描边） | 不可逆/大代价动作前置确认 | 下载确认门（远端 >阈值 MB）；设置脏态关闭确认；存储清除/恢复出厂；`window.confirm` 轻确认五处（WorkspaceList 删除/重命名族、主题删除族——轻量删除类沿原生 confirm 形态） |
| **状态条** | `.vv-statusbar`（role=status，ViewerPane.svelte:1263）；`.vv-toast`（zen 进入提示，z 60）；各面板内 `role="status"` 行 | 一次性非阻断反馈 | `showStatusNotice`（AppShell/serverConnect 出口）、`showZenToast`（AppShell.svelte:494-498）、gsearch `aria-live="polite"` 计数（GlobalSearchPanel.svelte:252）、下载进度卡（role=status 双态）、MountsManager 探测回显（role=status）、设置脏态提示（SettingsCenter.svelte:362） |

**规则**：

1. 阻断性错误走错误卡；一次性告知走状态条/toast；危险动作走确认卡——三类不得互相替代（错误不得静默降级为 toast，确认不得降级为 toast）。
2. 状态条/toast 文案为**事件时刻取值**（历史提示不随 locale 回写，见 frontend-conventions.md 已知边界 ③⑤）。
3. 异步结果必须对读屏可达：容器 `role="status"` 或 aria-live（现状九处先例）；下载进度另经 `aria-label` 双通道（DownloadProgressCard.svelte:39/53/60 注释）。

**机检载体**：role/aria 结构经 axe 面板态扫描（A11Y-02~09）与 valid-compile；文案经 CJK 三形态 lint（静态属性值臂拦非 t() 的 aria）；`role="status"` 的**新增点核对**落 PR 必查清单第 2 条（axe 不扫动态注入时机）。

## 5. 焦点环 token

1. **全局统一焦点环**（app.css:104）：`:where(button, input, select, summary, [tabindex], a[href]):focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -1px; }`——`:where` 零特异性（显式处理者可覆盖），offset 负值防浮层贴边裁剪，`a[href]` 补档覆盖 markdown 链接。新交互件**不另写焦点样式**，缺焦点环即全局规则缺 `:focus-visible` 路径（如改用非五类元素承载交互）——先修元素形态再谈环。
2. **禁裸 `outline: none` / `outline-hidden` 抹焦点**（含 `::-moz-focus-inner` 类重置）。本仓未借 aelrova 的 outline 禁令 lint 规则（v1 不做 prettier/规则面扩张），该禁令落 PR 必查清单第 7 条。
3. hover 才显现的控件必须同时被 `:focus-within`/`:focus-visible` 显现（ui-design-system §7 既有规则；现状成员：`.vv-ws-actions`/`.vv-wspanel-close`/`.vv-collapse-btn`/`.vv-tab-close` 族）。
4. 焦点环色的可见性由对比度机检承接：`--ui-accent`/`--ui-bg` 非文本 ≥3:1 配对在测（tools/design-tokens/test/contrast.test.ts）。

**机检载体**：焦点环色值 = contrast.test.ts 非文本配对机检；`svelte/valid-compile`（交互元素的编译器 a11y 面）；裸 outline 抹焦点与 hover 键盘等价**新增点**落 PR 必查清单第 7 条。

---

## 6. 交互件与 e2e 锚关系（改前必读）

- 本清单全部类名（`.vv-error-*`、`.vv-tabctx`、`.vv-tbmenu-pop`、`.vv-status-picker`、`.vv-dl-confirm` 等）同时是 e2e 主锚点：**只允许改样式规则本身，不得改名/删除/合并元素**（ui-design-system §0 红线 1 同源）。
- 抽屉开合判定的 computed transform 通道（e2e/drawer.ts）、断点冻结（≤900/≤600）见 ui-design-system §0 红线 4，本清单不重复载。
- 新交互件的 e2e 锚命名沿用 `.vv-<域>-<件>` 惯例；注册进本清单时在「机检载体」列写明锚名。

---

## 7. 新条目登记模板

```
| 类名/通道 | 宿主组件 | z-index 档 | OVERLAY 入册(是/否) | 关闭通道 | 机检载体 |
```

登记位置：浮层/菜单入 §1/§2 对应表行；新通道类型（第四类反馈面等）先在 §4 增节、再补行为规格与机检锚。登记 PR 与实现 PR 同笔提交（「先登记后使用」可 diff 核对）。

---

## 附：证据清单

- 实读：`apps/web/src/lib/AppShell.svelte:649-664`（OVERLAY_SELECTOR 现值 11 类）、`:1264-1273`（boundary failed 片段）、`:1652-1773`（抽屉/toast/zen-exit z 值）、`apps/web/src/app.css:104/154-164/168/195/329/362/392-397/420-425/474-484/549-552/579/650/680/799`、`packages/vviewer-core/src/dispatch/errorRenderer.ts`（全文，内联样式 :22-30）、`DownloadConfirmCard.svelte:33`、`TabBarMenu.svelte:246-262`、`GlobalSearchPanel.svelte:252`、`DownloadProgressCard.svelte:39-60`、`packages/vviewer-markdown/src/markdown.css:78`。
- rg 实测（本会话运行）：`z-index` 全仓（apps/web/src + packages，值域 1/5/20/25/30/31/32/50/60/90/100 全档定位）、`aria-live|role="status"` 九处、`svelte-ignore` 依据注释五处、`OVERLAY_SELECTOR` 消费面（mountsManagerUi.test.ts:143-147 源码锚）。
