# 顶栏退役：全局动作迁移 TabBar 左端按钮簇 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 TopBar 整行，其 11 类全局动作迁入 TabBar 左端按钮簇 `[工作区▾][＋][⟳][⋯]`；布局设置 `topBarVisible` 字段与顶边热区退役。

**Architecture:** 四步走：①WorkspaceSwitcher 从 TopBar 内联抽取为独立组件（DOM 不变，先行降耦）；②新建 TabBarActions 按钮簇组件并改 TabBar 为「簇 + 可滚 tabs + 管理」嵌套滚动结构（TopBar 暂存的双入口过渡态）；③TopBar 退役（AppShell 接管订阅链与 cycleTheme、chrome 菜单收敛 tab-only、layout 字段删除、TopBar.svelte 删除）；④e2e 全量迁移与门禁。所有迁移按钮 **aria-label/text 原样保留**——e2e 选中器锚不变，只有容器作用域要迁。

**Tech Stack:** Svelte 5 runes、playwright 双 project、vitest（layout 纯函数单测既有）。

**Spec:** `docs/superpowers/specs/2026-10-31-topbar-retirement-design.md`

## Global Constraints

- 迁移按钮的 `aria-label` 与可见文案逐字保留：`button[aria-label="设置"]`、`button[aria-label="目录管理"]`、`button[aria-label="刷新当前文件"]`、`aria-label="文件 URL"`、连接服务器钮文本「连接服务器」——e2e 锚稳定性红线。
- 按钮簇固定不随 tabs 横向滚动：TabBar 改嵌套结构（`.vv-tabbar` overflow:visible；`.vv-tabbar-tabs` 承接 `overflow-x:auto; flex:1; min-width:0`；`.vv-tabbar-actions` `flex:none`）。`.vv-tab` 仍是 `.vv-tabbar` 后代，既有锚不破坏。
- `ServerConnectForm` 复用侧栏 spec 产物（props `{onconnected?}` 不变）；⋯ 菜单内展开形态沿用「常驻挂载 + hidden 控制」（未提交输入跨收起保留）。
- 菜单浮层关闭通道 = 外点 pointerdown + Esc（chrome 菜单同款），**不做 scroll-close**（⋯ 菜单内嵌连接表单，滚动误关丢输入）。
- `layout.topBarVisible` 删除依赖 sanitizeLayout 白名单静默丢弃旧值——localStorage 旧快照零迁移；`settingsDraft` 若有字段枚举面（rg 确认）同步。
- zen 退出通道收敛后仍齐全：Esc / Ctrl+Alt+Z / 移动端浮钮 / 标签栏（含临时条）右键菜单 zen 项。顶栏临时条右键退出通道随 TopBar 消失，属设计内收敛。
- tempBar.ts 模块与其单测不动（通用状态机）；AppShell 只删 top 实例。
- 工作树可能存在并行会话在途修改（当前：server/core/build.rs）——提交一律 scoped add，勿纳入。

## Review Focus

- 双入口过渡态（Task 2 后 TopBar 与按钮簇并存）不得进入任何提交后的 e2e 断言——过渡态只要求 typecheck/vitest 绿；e2e 在 Task 4 新形态上收敛。
- `.vv-ws-pop.narrow` 的 `top:44px` 硬编码锚（旧顶栏高度）失效：窄屏浮层改由触发钮 `getBoundingClientRect().bottom + 4px` 计算内联 top（Task 1 内随抽取一并修）。
- AppShell 接管订阅链后 `applyAppearanceFromSettings`/`applyFontsFromSettings` 必须仍恰好一份订阅（与 AppShell 既有 onSettingsChanged 副本合并，防双订阅双注入——注入幂等但 touchActiveTab 翻转非幂等）。
- zen 下按钮簇随 TabBar 隐藏、临时条唤出后按钮可点——zen 临时条上的「退出专注」钮是退出通道之一（Task 3 验证点）。
- 移动端 ≤600px：按钮簇触控目标 ≥32px（TopBar scoped 的 padding-block:8px 媒体查询迁为 TabBarActions 内类选择器规则）。

---

### Task 1: WorkspaceSwitcher.svelte 抽取（DOM 等价重构）

**Files:**
- Create: `apps/web/src/lib/WorkspaceSwitcher.svelte`
- Modify: `apps/web/src/lib/TopBar.svelte`（删 ws 块改消费组件）

**Interfaces:**
- Produces: `WorkspaceSwitcher` 无 props（自持全部 ws 逻辑：workspacesView/tabStore/closeTab/workspaceStore 直连 façade，与 TopBar 现行为同源）。DOM 契约逐字保留：`.vv-ws`/`.vv-ws-trigger`/`.vv-ws-pop`(.narrow)/`.vv-ws-item/.vv-ws-name/.vv-ws-actions/.vv-ws-act/.vv-ws-rename/.vv-ws-new`、`aria-label="切换工作区"`、`aria-expanded`；`WorkspaceCreateModal` 挂载随组件走。

- [ ] **Step 1: 抽取**——迁移动清单：state（`wsMenuOpen/createOpen/renamingId/renameDraft/wsAnchorEl/wsPopEl/narrow`，TopBar:48-55）、`activeWorkspace` derived（:69-71）、ws 函数五枚（:75-110）、两个 effect（:144-177）、onMount 的 matchMedia narrow 段（:129-141，含 cleanup）、`.vv-ws` 整块 markup（:232-311）、`WorkspaceCreateModal` 挂载（:349-351）。imports 随行：`closeTab/tabStore/workspacesView`（openFlow façade）、`workspaceStore`、`WorkspaceCreateModal`、`onMount`。
- [ ] **Step 2: narrow 浮层重锚**——`.vv-ws-pop.narrow` 的 `top:44px`（app.css:364）改为组件内联计算：打开下拉时若 narrow，`wsPopStyle = top:${wsAnchorEl.getBoundingClientRect().bottom + 4}px`，markup `style={wsPopStyle}`；app.css:364 删 top 行（保留 fixed/right:8px）。桌面 absolute 定位不变。
- [ ] **Step 3: TopBar 消费**——删上述迁移物，原位留 `<WorkspaceSwitcher />`；TopBar 余部（settings 订阅链/cycleTheme/打开文件/URL/连接服务器/刷新/主题/设置/目录/zen）不动。
- [ ] **Step 4: 验证**——`pnpm typecheck` 0E + 定向 `pnpm --filter web exec playwright test t-workspace b-wsx-recovery`（ws 全部锚不翻转，DOM 等价的证明）。
- [ ] **Step 5: Commit**——`refactor(topbar): WorkspaceSwitcher 从顶栏内联抽取为独立组件——顶栏退役第一步降耦`

### Task 2: TabBarActions 按钮簇 + TabBar 嵌套滚动结构

**Files:**
- Create: `apps/web/src/lib/TabBarActions.svelte`
- Modify: `apps/web/src/lib/TabBar.svelte`（嵌套结构 + props 扩展 + 簇挂载）
- Modify: `apps/web/src/lib/AppShell.svelte`（TabBar 新 props 传值 + cycleTheme 函数迁入）
- Modify: `apps/web/src/app.css`（.vv-tabbar 结构样式 + 簇样式）

**Interfaces:**
- `TabBarActions` props：`{ themeMode: Settings['themeMode']; oncycletheme(): void; onsettings(): void; onmounts(): void; zen: boolean; onToggleZen(): void }`（themeMode/回调由 AppShell 持有——订阅链所有权在壳层）。
- TabBar props 扩展：现有基础上增 `themeMode/oncycletheme/onsettings/onmounts/zen/onToggleZen` 六项透传。
- DOM 契约：`.vv-tabbar-actions`（簇容器）、`.vv-tabbar-tabs`（tabs 滚动容器，{#each tabs} 移入）、`.vv-tbact`（簇内图标钮基类）；既有 `.vv-tabbar-manage`/`.vv-tab`/`.vv-tabctx` 不变。

- [ ] **Step 1: TabBarActions 组件**——内容四件：
  1. `<WorkspaceSwitcher />`（首列）。
  2. `[＋]`：hidden file input（onPick 逻辑从 TopBar 复制）+ 浮层菜单「打开文件 / 打开文件夹 / 粘贴 URL」——粘贴 URL 选中就地在菜单内展开单行 input（aria-label="文件 URL"）+ 打开钮（openUrl 后清空收起）；浮层通道 = 外点 pointerdown + Esc + fixed 视口收敛（chrome 菜单模式）。
  3. `[⟳]`：`manualRefresh()`（从 TopBar :199-203 原样迁，tabStore 直连）。
  4. `[⋯]`：浮层菜单——「连接服务器」项切换内联 `<div hidden={!srvOpen}><ServerConnectForm onconnected={收起浮层} /></div>`；「主题：X」项（文案同 TopBar :324-326，onclick=oncycletheme 后不收浮层可不收——裁决：主题项点击即收，简化）；「目录管理」「设置」「专注/退出专注」项（点击即收后回调）。
  全部按钮 aria-label/title 沿用 TopBar 原文（含 zen 文案随态、刷新 tooltip 全文）。
- [ ] **Step 2: TabBar 嵌套结构**——`.vv-tabbar` 内包三层：`<div class="vv-tabbar-actions"><TabBarActions …/></div>` + `<div class="vv-tabbar-tabs">{#each tabs…}{/each}</div>` + 既有管理钮。props 六项新增并透传。
- [ ] **Step 3: CSS**——`.vv-tabbar { overflow: visible }`；新增 `.vv-tabbar-tabs { display:flex; overflow-x:auto; flex:1; min-width:0 }`、`.vv-tabbar-actions { flex:none; display:flex; align-items:center; gap:2px; border-right:1px solid var(--ui-border); padding:0 4px }`、`.vv-tbact`（borderless 图标钮，复用全局 button 基座）+ ≤600px 触控加高媒体查询（从 TopBar scoped 迁来，改类选择器 `.vv-tabbar-actions .vv-tbact`）。`.vv-ws-trigger` 的 `max-width:22vw` 复核（簇内改 `max-width:16vw` 防挤爆——实测调，记录值）。
- [ ] **Step 4: AppShell 接线**——`cycleTheme` 函数从 TopBar 迁入（settings 副本/saveSettings/dataset 打标，AppShell 既有 settings 状态上操作）；TabBar 传六 props；TopBar 暂保留（双入口过渡态，本任务不删）。
- [ ] **Step 5: 验证**——`pnpm typecheck` 0E + `pnpm test`（既有单测全绿）。
- [ ] **Step 6: Commit**——`feat(topbar): TabBar 左端按钮簇（工作区/＋/刷新/更多）——全局动作新宿主`

### Task 3: TopBar 退役

**Files:**
- Delete: `apps/web/src/lib/TopBar.svelte`
- Modify: `apps/web/src/lib/AppShell.svelte`（摘 TopBar/热区/temp-top；订阅链与 cycleTheme 落壳层；chrome 菜单收敛）
- Modify: `apps/web/src/lib/layout.ts` + `apps/web/src/lib/layout.test.ts`（删 topBarVisible 全链）
- Modify: `apps/web/src/lib/settings/LayoutSection.svelte`（删显示顶栏行）
- Modify: `apps/web/src/lib/ViewerPane.svelte:533`（空态文案）
- Modify: `apps/web/src/app.css`（删 .vv-topbar 专属段：:339 基线、:301-311 中 topbar 部分、:441 brand；chrome-off/temp 保留 tabbar 份）

- [ ] **Step 1: AppShell 摘除与接管**——删 `<TopBar …>` 挂载块与 `{#if !vis.topBar}` 顶边热区、`topTemp/topTempBar` 及 summonTemp/scheduleHideTemp/dismissTemp 的 'top' 分支（tab 份保留）；TopBar 的 onMount 订阅链（applyAppearanceFromSettings 首注入 + onSettingsChanged 内 applyAppearanceFromSettings/reactToFontsChange + onSystemModeChange）并入 AppShell 既有 onMount/onSettingsChanged（**合并为单订阅**，rg 确认 AppShell 既有 onSettingsChanged 位置，防双订阅）；cycleTheme 已在 Task 2 迁入。
- [ ] **Step 2: chrome 菜单收敛**——`chromeMenu` 状态去 `bar` 字段（类型 `{x,y}`）；onShellContextMenu 删 `.vv-topbar` 分支（无 tab-row 时仍弹）；menuToggleVisible 无参化（只翻 tabBarVisible）；菜单条目=「隐藏/显示标签栏」+ zen 项（markup 两处 bar 三元删）。
- [ ] **Step 3: layout 字段删除**——layout.ts 四处（interface/default/sanitizeLayout/chromeVisible+ChromeVisibility）；layout.test.ts 既有 topBarVisible 用例删除/改写（rg 定位）；LayoutSection 删「显示顶栏」label 块；rg 全仓 `topBarVisible` 清零（settingsDraft 若有枚举面一并）。
- [ ] **Step 4: 删 TopBar.svelte + 文案**——ViewerPane:533 空态文案改「拖入文件/文件夹，或用标签栏 ＋ 打开」；rg `vv-topbar|vv-brand` 清零（app.css 删段）。
- [ ] **Step 5: 验证**——`pnpm typecheck && pnpm test` 0E 全绿。
- [ ] **Step 6: Commit**——`feat(topbar): 顶栏整行退役——布局设置 topBarVisible 与顶边热区随迁，全局动作归 TabBar 按钮簇`

### Task 4: e2e 全量迁移 + 门禁

**Files:**
- Modify: e2e 全域受影响 spec（rg 定位）+ 共享 helper
- Create: `apps/web/e2e/helpers/tabbar-actions.ts`（若仓库 helper 目录形态不同则随现行惯例落位）

- [ ] **Step 1: 盘点**——`rg -n '\.vv-topbar|打开文件|打开文件夹|连接服务器|文件 URL|隐藏顶栏|显示顶栏|vv-chromemenu|topBarVisible' apps/web/e2e apps/web/e2e-server` 全量清单（写入报告）。
- [ ] **Step 2: helper**——`openPlusMenu(page)`（点簇内 ＋）、`plusOpenFile(page, files)` / `plusOpenFolder(page)`、`openOverflowMenu(page)`、`overflowConnectServer(page)`（⋯→连接服务器，返回表单作用域）；选择器作用域统一 `.vv-tabbar-actions`。
- [ ] **Step 3: 机械迁移**——①`.vv-topbar` 作用域（含 7f539ff 的 49 点）改 `.vv-tabbar`/`.vv-tabbar-actions`；②打开文件/文件夹流改走 ＋ 菜单 helper；③连接服务器流改走 ⋯ helper；④chrome 菜单「隐藏顶栏」用例删除或改标签栏项；⑤设置中心布局组「显示顶栏」锚删除；⑥zen 顶栏临时条右键退出用例改 Esc/标签栏通道；⑦`aria-label="文件 URL"` 作用域同步。
- [ ] **Step 4: 门禁**——`node tools/fetch-e2e-corpus.mjs` + `pnpm --filter web build:e2e` + `pnpm typecheck && pnpm test` + `pnpm --filter web exec playwright test`（双 project 全量，计时型 flaky 复跑定性）+ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 套件全量）。
- [ ] **Step 5: Commit**——`test(e2e): 全局动作锚迁 TabBar 按钮簇——顶栏退役收官`（如改动面大，按 helper/机械迁移/设置中心锚拆 2-3 个原子 commit）

## Self-Review 记录

- 规格覆盖：spec §2 按钮簇四件（Task 2）、品牌删除（Task 3 Step 4）、§3 退役清单表逐行（Task 3 各步：TopBar 挂载/顶边热区/菜单项/字段/temp 槽位/样式/zen 文案/移动端）、§4 文案（Task 3 Step 4）、§5 e2e（Task 4）——全覆盖。
- 类型一致：TabBarActions props 六项在 Task 2 定义、Task 3 消费一致；WorkspaceSwitcher 无 props 两任务一致。
- Review Focus 五条：过渡态纪律（Task 2 Step 5 只跑 typecheck/vitest）、narrow 重锚（Task 1 Step 2）、单订阅（Task 3 Step 1）、zen 临时条通道（Task 3 验证 + Task 4 ⑥）、触控目标（Task 2 Step 3）。
- 风险最大的既有面：tab 拖拽排序（TAX 域）在嵌套滚动结构下的 dragover/drop 语义——Task 4 全量门禁覆盖，翻转则修 TabBar 事件挂点（tabs 容器与拖拽监听对齐）。
