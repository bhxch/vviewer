# 布局自由化与 Zen mode Implementation Plan（spec 2026-10-19-layout-zen-design.md）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左右栏折叠+拖拽调宽、TopBar/TabBar 各自可隐藏（右键隐藏+边缘悬停唤出）、zen mode（桌面 Ctrl+Alt+Z / 移动端菜单入口+浮钮退出+Android 返回键拦截）、渲染器自选状态栏指示器+Tab 右键子菜单。

**Architecture:** settings 增 `layout` 节（collapsed/width/visible/zen 七字段）→ AppShell 按状态渲染（折叠竖条/拖拽把手/隐藏 chrome 的边缘悬停临时条）；zen 为覆盖层语义（不改底层字段，退出还原）；RendererPickerMenu 共享组件双壳复用 openWithOf/setRendererOverride 单机制；移动端 zen 经 history.pushState 拦截返回键。

**Tech Stack:** Svelte 5 runes、pointer 事件拖拽、history API、vitest/playwright（含 mobile project）。

**Spec:** `docs/superpowers/plans/` 同名 spec `docs/superpowers/specs/2026-10-19-layout-zen-design.md`（§2/§3+§3.1/§4 已拍板细节以 spec 为权威）

## Global Constraints

- layout 节：`{ leftCollapsed, rightCollapsed, leftWidth, rightWidth, topBarVisible, tabBarVisible, zen: boolean }`；left clamp 180–480、right clamp 160–420；折叠态残留 ~28px 竖条。
- 隐藏 chrome 唤出：隐藏后对应边缘悬停（桌面 hover/移动无此语义——TopBar/TabBar 隐藏为桌面能力）显半透临时条，移开 1.5s 再隐；隐藏入口=各自右键菜单「隐藏」项。
- zen 正交性：zen 只做视觉覆盖不改 layout 其余字段；退出恢复进入前各件可见性；Esc 优先级=面板类 overlay 先关、二次 Esc 退 zen；移动端返回键承接同一状态机（面板开→关面板，无面板→退 zen）。
- zen 持久化（layout.zen）；移动端 reload 落 zen 浮钮在场无困死。
- 渲染器入口复用 `openWithOf`+`setRendererOverride` 单机制（含「自动」清除 override）；错误卡片临时 override 语义不变。
- 折叠/调宽仅桌面断点（>900px）；移动端抽屉机制不动（zen 为唯一例外，§3.1）。
- 快捷键 Ctrl+Alt+Z（实施时以实际键位表复核无冲突）；zen 下状态栏保留。
- 每任务原子提交；测试在仓库根跑（AppShell/zen 状态机纯函数化可测，runes 组件按源码契约+e2e 先例形态）。

---

### Task 1: layout settings 节 + 折叠/调宽（桌面）

**Files:**
- Modify: `apps/web/src/lib/stores/settings.ts`（layout 节白名单/clamp）+ 测试
- Modify: `apps/web/src/lib/layout.ts`（新建：layout 状态纯函数——clampWidth/折叠语义/持久化字段校验，可单测）
- Modify: `apps/web/src/lib/AppShell.svelte`（折叠竖条 28px+展开钮、中缝 6px 拖拽把手实时预览松手落盘、双击把手重置默认宽）
- Modify: `apps/web/src/app.css`（竖条/把手/折叠态样式）
- Test: layout.test.ts + settings 测试追加

**Interfaces:**
- Produces: `Settings.layout: LayoutSettings`；`clampWidth(side, w): number`、`DEFAULT_LAYOUT`——Task 2/3 消费。

- [ ] **Step 1: 写失败测试**（layout 纯函数：clamp 边界/默认值/白名单脏值归位；settings 持久化往返）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（AppShell 桌面断点内按 layout.leftCollapsed/leftWidth 渲染；拖拽 pointer 事件实时预览+松手 persist；折叠竖条含展开钮与所属面板图标）。
- [ ] **Step 4: 跑测试 + typecheck + build:e2e**
- [ ] **Step 5: Commit** `feat(layout): 折叠与拖拽调宽——layout 节与桌面断点`

---

### Task 2: TopBar/TabBar 隐藏与边缘唤出 + zen 桌面

**Files:**
- Modify: `apps/web/src/lib/layout.ts`（zen 覆盖语义纯函数：enterZen/exitZen 快照还原、Esc 优先级状态机）
- Modify: `apps/web/src/lib/AppShell.svelte`（chrome 隐藏渲染、边缘悬停临时条、zen 类切换、Ctrl+Alt+Z、Esc 状态机）
- Modify: `apps/web/src/lib/TopBar.svelte` + TabBar 所在组件（右键「隐藏」菜单项）
- Modify: `apps/web/src/app.css`（zen 态/临时条样式）
- Test: layout.test.ts 追加（zen 覆盖/退出还原/Esc 优先级状态机）

**Interfaces:**
- Produces: zen 状态机纯函数 `zenEscAction(state: { overlaysOpen: boolean; zen: boolean }): 'closeOverlay' | 'exitZen' | 'none'`；`vv:zen-changed` 文档事件（detail {zen}——Task 3 移动端消费）。

- [ ] **Step 1: 写失败测试**（zenEscAction 状态机三态；zen 进入不改底层字段/退出还原快照）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（TopBar/TabBar 右键「隐藏」项→layout 字段 false；隐藏后边缘悬停半透临时条（移开 1.5s 再隐，定时器清理）；临时条右键可恢复显示；Ctrl+Alt+Z 进出 zen；Esc 处理器按 zenEscAction 分派——overlay 关闭判定复用既有面板开合状态的查询）。
- [ ] **Step 4: 跑测试 + 回归**
- [ ] **Step 5: Commit** `feat(layout): chrome 隐藏与边缘唤出+zen 桌面`

---

### Task 3: 渲染器自选双入口

**Files:**
- Create: `apps/web/src/lib/RendererPickerMenu.ts`（候选收集/当前高亮/选择回调的共享逻辑）或 .svelte（按 TabContextMenu 形态取）
- Modify: 状态栏组件（rg '状态栏|StatusBar|searchEngine' 定位文件——加渲染器指示器+点击弹候选）
- Modify: `apps/web/src/lib/TabContextMenu.svelte`（「打开方式」子菜单）
- Test: RendererPickerMenu 候选集与 openWithOf 等价性单测

**Interfaces:**
- Consumes: 既有 `openWithOf(tab)`/`tabStore.setRendererOverride`/registry。
- Produces: `rendererCandidates(tab): { id: string; label: string; current: boolean }[]`（含「自动」首位=清除 override）——两壳共用。

- [ ] **Step 1: 写失败测试**（候选集与 openWithOf 输出等价；「自动」项语义=override 清除；错误渲染器 id 过滤）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（状态栏指示器显示生效渲染器 label+语言/扩展名；两壳选择均走 setRendererOverride——持久 override；错误卡片临时 override 不经此路径不变）。
- [ ] **Step 4: 跑测试 + typecheck**
- [ ] **Step 5: Commit** `feat(layout): 渲染器自选状态栏指示器+右键子菜单`

---

### Task 4: zen 移动端适配（§3.1）

**Files:**
- Modify: 移动端菜单载体组件（rg TopBar mobile/抽屉头部定位挂点）
- Modify: `apps/web/src/lib/layout.ts`（history 拦截状态机：pushZenState/popState 分派——与桌面 Esc 同一 zenEscAction）
- Modify: `apps/web/src/lib/AppShell.svelte`（浮钮渲染[≥44px 半透]、抽屉 toggles 随 zen 隐藏、popstate 处理）
- Test: layout.test.ts 追加（返回键状态机双触发源等价性）

**Interfaces:**
- Consumes: Task 2 zen 状态机/vv:zen-changed 事件。
- Produces: 移动端 zen 全交互（入口菜单项/浮钮/popstate 拦截/面板优先承接）。

- [ ] **Step 1: 写失败测试**（popstate→面板开=关面板/无面板=退 zen；面板关闭不经 zen 时不误退）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（进入 zen pushState({vvZen:1})；popstate 时按状态机分派，退 zen 时再 history.back 归位或 state 消费——实现细节以不劫持正常导航为准，报告记录方案；浮钮右下角半透；抽屉 toggles 随 zen 隐藏）。
- [ ] **Step 4: 跑测试 + 回归**
- [ ] **Step 5: Commit** `feat(layout): zen 移动端——菜单入口/浮钮/返回键拦截`

---

### Task 5: e2e + 门禁 + 文档

**Files:**
- Create: `apps/web/e2e/b-layout.spec.ts` + `b-zen.spec.ts`（或合并 b-layout-zen.spec.ts）；Modify: `README.md`

- [ ] **Step 1: e2e**（桌面：折叠/展开+重启恢复/拖拽调宽+clamp/TopBar 隐藏→边缘唤出→重显/渲染器双入口切 jsonl 并持久化。移动 project：zen 菜单入口/浮钮退出/返回键先关面板再退 zen/抽屉 toggles 隐藏恢复/reload 落 zen 浮钮在场。）
- [ ] **Step 2: 门禁**：typecheck + 全仓 vitest + build:e2e + 新 e2e 定向 + 既有 b-app-shell-sources/m3 回归核对（AppShell 大改面）。
- [ ] **Step 3: README 布局/zen 行 + Commit** `test(e2e): 布局与 zen 冒烟+README 同步`

---

### 实施风险与裁决预留

- AppShell.svelte 体量大（布局+抽屉+滚动键+快捷键集中）——实现者改动保持增量、不重构无关段。
- 边缘悬停临时条与 zen 退出条可共用一个组件形态（半透条+定时隐藏）——允许抽取共享。
- history 拦截与 PWA/浏览器导航的边界（不劫持正常前进后退）——实现细节报告记录。
- 状态栏组件形态未实读（rg 定位后跟随既有结构）。
- Esc 优先级的「overlay 打开」判定来源=既有面板开合状态（rg GlobalSearchPanel/QuickOpenPanel/SettingsPanel 的开合存储）——实现者实读取最准信号。
