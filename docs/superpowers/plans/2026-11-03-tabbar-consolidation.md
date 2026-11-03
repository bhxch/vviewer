# TabBar 收敛实施计划（融合菜单 × 悬浮箭头滚动 × 管理 ▾ 化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TabBar 左端四钮收敛为「工作区名 ▾」单按钮融合菜单（子菜单就地手风琴），tab 条隐藏滚动条改悬浮箭头+滚轮横移，右端「管理」文字改 ▾ 字形。

**Architecture:** 新建 `TabBarMenu.svelte`（单触发钮+单浮层+手风琴子菜单）与 `WorkspaceList.svelte`（工作区管理 UI 抽取），退役 `TabBarActions.svelte`/`WorkspaceSwitcher.svelte`；tab 条滚动逻辑抽纯函数 `tabScroll.ts` + 组件内悬浮箭头；e2e helper 重写为 `tabbar-menu.ts`，存量子集随迁前移 commit 1（原子迁移域）。

**Tech Stack:** Svelte 5 runes / app.css 设计令牌（docs/design/ui-design-system.md）/ Playwright 双 project / vitest（仓库根跑）。

**Spec:** docs/superpowers/specs/2026-11-03-tabbar-consolidation-design.md（裁决与理由在 spec，本计划只带实现决策）

## Global Constraints

- aria/title 逐字红线（随迁不得改一字）：`切换工作区`、`管理标签`、`管理所有工作区的标签（Alt+W）`、`刷新当前文件`、`目录管理`（title 含 Ctrl+Alt+M）、`设置`（title 含 Ctrl+,）、专注随态文案（`进入专注模式`/`退出专注模式`）、`文件 URL`。
- 菜单条目 accessible name 与可见文本一致（chevron ▸ 放 `aria-hidden` span，不进 name）。
- 字形只用 `▾ ▸ ◂ ✓ ✎ ✕ ＋ ↻`，无 emoji / 新图标字体。
- 颜色/间距/圆角/阴影一律走 ui-design-system 令牌（`--ui-*` / `--vv-*`），禁止硬编码色值。
- e2e 前必须 `pnpm --filter web build:e2e`（H11 铁律：vite preview 伺服旧包，不重建=白跑）；vitest 必须仓库根跑（包目录缺 jsdom）。
- 每 commit 终态绿：仓库根 `pnpm typecheck` + `pnpm test` + 受影响 playwright 套件；收尾 `git status --porcelain` 必须为空（B6 教训硬门）。
- mobile project（≤600px）触控目标 ≥32px：触发钮 `padding-block: 8px` 档保留。

## Review Focus

1. **浮层触顶**：667px 高 mobile 展开工作区列表+连接服务器表单叠加，浮层必须内部滚动且 top 不越视口（Task 4 MOB 用例 + Task 1 重收敛 effect 承担）。
2. **wheel 被动监听吞 preventDefault**：竖向滚轮必须横移 tab 条而非滚动页面——wheel 监听须 `{passive:false}`（Task 2 SCRL-04 + tabScroll 单测承担）。
3. **箭头可见性陈旧**：新开/关闭 tab、徽标出现使 scrollWidth 变化后箭头不刷新——`$effect` 必须读 `tabs` 触发重算（Task 2 SCRL-01 内含「新开 tab 箭头出现」断言）。
4. **合成 Esc 被兜底守卫挡下**：移动端返回键 closeTopOverlayForZen 派发目标恰是浮层本体，window 兜底 contains 守卫会放走——容器 `onkeydown` Esc 通道必须实装（Task 1 ZenEsc 源码正则锚 + Task 4 合成 Esc 用例承担）。
5. **激活滚入与拖拽竞态**：拖拽重排中途 `scrollIntoView` 抢滚动——effect 须在 `dragFromId !== null` 时跳过（Task 2 实现步 + t-tab-actions 既有拖拽用例回归承担）。

---

### Task 1: 原子迁移域——融合菜单组件 + 全量锚随迁

**Files:**
- Create: `apps/web/src/lib/WorkspaceList.svelte`、`apps/web/src/lib/TabBarMenu.svelte`、`apps/web/e2e/tabbar-menu.ts`
- Delete: `apps/web/src/lib/TabBarActions.svelte`、`apps/web/src/lib/WorkspaceSwitcher.svelte`、`apps/web/e2e/tabbar-actions.ts`
- Modify: `apps/web/src/lib/TabBar.svelte`（:11 import、:25-57 props、:262-264 容器）、`apps/web/src/lib/AppShell.svelte`（:1226-1235 props、:618-631 OVERLAY_SELECTOR、:322-331 cycleTheme）、`apps/web/src/app.css`（:364-370 删 .vv-ws/.vv-ws-trigger/.vv-ws-pop(.narrow)；:456-479 与 :483-485 簇样式替换）
- Migrate（单测）: `src/lib/appShellZenEsc.test.ts`、`appShellZenToast.test.ts:56-57`、`settingsCenter.test.ts:331,352`、`mountsManagerUi.test.ts:135-136`
- Migrate（e2e，helper 消费 28 文件 + 直接锚点分布见映射表）

**Interfaces:**
- Produces `TabBarMenu.svelte` props：`{ themeMode: Settings['themeMode']; onsettheme(mode: Settings['themeMode']): void; onsettings(): void; onmounts(): void; zen: boolean; onToggleZen(): void }`
- Produces `WorkspaceList.svelte`：无 props 自持（workspacesView/tabStore/closeTab 直连，随迁 WorkspaceCreateModal 挂载）；列表条目类名零变更（`.vv-ws-item/.vv-ws-name/.vv-ws-actions/.vv-ws-act/.vv-ws-rename/.vv-ws-new`）
- Produces `apps/web/e2e/tabbar-menu.ts`：`TABBAR_MENU='.vv-tabbar-menu'`、`MENU_POP='.vv-tbmenu-pop'`、`openMenu(page)`、`openSubmenu(page, '工作区'|'打开'|'主题')`、`menuOpenFile(page, files)`、`menuOpenFolder(page)`、`menuOpenUrl(page, url)`、`menuConnectServer(page): Promise<Locator>`（返回 `.vv-server-form` 作用域，语义同旧 `overflowConnectServer`）
- Produces AppShell `setThemeMode(mode)`（替换 cycleTheme，写入路径三行逐字：settings 副本赋值 → `saveSettings(settings)` → `document.documentElement.dataset.themeMode = mode`）

- [ ] **Step 1: 迁移 4 个源码契约单测到新组件锚（RED 源）**

`appShellZenEsc.test.ts` I-2 正则锚改为读 `src/lib/TabBarMenu.svelte`，形态逐字对应：

```
/class="vv-tbmenu-pop"[\s\S]{0,400}onkeydown=\{\(e\) => \{\s*if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*menuOpen = false;\s*\}\s*\}\}/
```

（浮层状态名必须叫 `menuOpen`、浮层 class 必须是 `vv-tbmenu-pop`——实现侧与正则两侧由本计划钉死。）`appShellZenToast.test.ts`（专注随态文案+onToggleZen）、`settingsCenter.test.ts`（onsettings props 声明+设置项 onclick 体内 `menuOpen = false` 后回调）、`mountsManagerUi.test.ts`（目录管理 aria/title/onmounts）同样改读 TabBarMenu，断言语义不变。

Run: `pnpm test -- appShellZenEsc appShellZenToast settingsCenter mountsManagerUi`
Expected: FAIL（TabBarMenu.svelte 不存在 / readSrc 抛错）

- [ ] **Step 2: 新建 WorkspaceList.svelte**

自 WorkspaceSwitcher.svelte :180-233 迁列表体（rename 表单/删除 confirm 文案逐字/:228 新建钮），`createOpen` + `WorkspaceCreateModal` 挂载随迁（模态在浮层 `{#if}` 之外挂载——放浮层内会被「新建先关菜单」连带卸载）；删触发钮/narrow mq 监听/wsPopStyle 重锚/独立外点与 window Esc effect（关闭通道归 TabBarMenu 浮层）。重命名 input Esc `stopPropagation` 语义保留（仅取消重命名，不关菜单）。

- [ ] **Step 3: 新建 TabBarMenu.svelte**

结构契约（实现者按此写，外观对齐 `.vv-tabctx` chrome 菜单令牌）：

- 触发钮：`class="vv-tbmenu-trigger"`、`aria-label="切换工作区"`（逐字）、`aria-expanded={menuOpen}`、`title="工作区与全局功能菜单"`、文本 `` `${activeWorkspace?.name ?? '工作区'} ▾` ``（读 `workspacesView`；无 narrow 分支）；hidden file input 常驻挂载 + `manualRefresh` 函数自 TabBarActions :118-126 逐字迁入。
- 浮层 `{#if menuOpen}`：`class="vv-tbmenu-pop"`，fixed + POP_EST `{ w: 220, h: 400 }` 开合时从触发钮 rect 一次 clamp；`max-height` 内部滚动 + `$effect([menuOpen, sub, urlOpen, srvOpen])` 用 `pop.offsetHeight` 实测重收敛 top（spec §3.3 超高策略）；容器 `onkeydown` Esc（Step 1 正则形态）+ 外点 pointerdown + window 兜底 + `oncontextmenu` 守卫（TabBarActions :169-172 同款）。
- 首层 8 行（序固定，accessible name=可见文本，chevron 用 aria-hidden span）：`工作区`▸（`sub='ws'`：渲染 WorkspaceList）、`打开`▸（`sub='open'`：打开文件…/打开文件夹…/粘贴 URL…行内 urlOpen 表单，input `aria-label="文件 URL"` 逐字）、`刷新当前文件`（aria-label/title 逐字）、`连接服务器…`（srvOpen 行内 ServerConnectForm，onconnected → `menuOpen=false`）、`主题`▸（`sub='theme'`：跟随系统/亮/暗 三钮，当前项 `✓ ` 前缀，onClick `onsettheme(mode)` 后收菜单）、`目录管理`、`设置`、专注模式（aria-label 随态/title 逐字，文案 `专注`/`退出专注`）。`sub` 单状态 `'ws'|'open'|'theme'|null`，同刻至多一个展开；`aria-expanded` 在三个父项上。
- `{#if createOpen}` 挂 WorkspaceCreateModal 的职责在 WorkspaceList 内（Step 2），本组件不含。

- [ ] **Step 4: 接线 TabBar / AppShell / app.css，退役旧组件**

TabBar:import TabBarMenu 替 TabBarActions，容器 `.vv-tabbar-actions`→`.vv-tabbar-menu`，props `oncycletheme`→`onsettheme`（类型 `Settings['themeMode']` 入参透传）。AppShell：cycleTheme 替换为 `setThemeMode(mode)`（Interfaces 三行写入路径），:1231 改 `onsettheme={setThemeMode}`；OVERLAY_SELECTOR 删 `'.vv-ws-pop'` 行、`'.vv-tbact-pop'`→`'.vv-tbmenu-pop'`。app.css：删 :364-370 三段（.vv-ws/.vv-ws-trigger/.vv-ws-pop(.narrow)），:371-388 ws 条目段零改动；:456 容器改名；:457-479 簇样式替换为 `.vv-tbmenu-trigger`（borderless 基座+nowrap+ellipsis+`max-width: min(40vw, 16em)`）、`.vv-tbmenu-pop`（原 .vv-tbact-pop 令牌 + `max-height`/`overflow-y:auto`）、`.vv-tbmenu-item/.vv-tbmenu-row` 同名换族、新增 `.vv-tbmenu-sub`（缩进区）；:483-485 触控 padding 规则改挂 `.vv-tabbar-menu .vv-tbmenu-trigger`。删除 TabBarActions.svelte、WorkspaceSwitcher.svelte。

- [ ] **Step 5: 单测转绿**

Run: `pnpm test -- appShellZenEsc appShellZenToast settingsCenter mountsManagerUi`
Expected: PASS

- [ ] **Step 6: 重写 e2e helper + 存量随迁**

`tabbar-menu.ts` 按 Interfaces 落 API（openMenu 点 `[aria-label="切换工作区"]` scope TABBAR_MENU；openSubmenu 多点一行父项；menu* 三函数=旧 plus* 流 + 先 `openSubmenu(page,'打开')`；menuConnectServer=旧 overflowConnectServer 流改 `openMenu`）。机械映射（rg 逐模式定位，逐文件应用）：

| 旧 | 新 |
|---|---|
| `from './tabbar-actions'` | `from './tabbar-menu'` |
| `openPlusMenu(page)` / `openOverflowMenu(page)` | `openMenu(page)` |
| `plusOpenFile/plusOpenFolder/plusOpenUrl` | `menuOpenFile/menuOpenFolder/menuOpenUrl` |
| `overflowConnectServer` | `menuConnectServer` |
| `TABBAR_ACTIONS` / `PLUS_ITEMS` / `OVERFLOW_POP` | `TABBAR_MENU` / `MENU_POP` / `MENU_POP` |
| `.vv-ws-trigger` / `.vv-ws `（触发钮 scope）/ `.vv-tabbar-actions` | `.vv-tabbar-menu .vv-tbmenu-trigger` / `.vv-tabbar-menu` |
| `.vv-ws-pop`（浮层 scope） | `.vv-tbmenu-pop` |
| `.vv-tbact-pop` | `.vv-tbmenu-pop` |
| `主题：跟随系统` 等 toHaveText/name `/主题：/` 行锚 | 点「主题」行 → 子菜单项 `getByRole('button',{name:/跟随系统\|亮\|暗/})`（✓ 前缀容忍） |
| 「管理」可见文本锚 | （已核无精确锚；「管理标签/目录管理」aria 不受影响，零改动） |

narrow 浮层专属断言（b-wsx-recovery 的 rect 重锚用例）随 narrow 退役：改断言统一 fixed 浮层存在与定位，删 narrow 分支特有期望。涉及文件清单（rg 已核实）：b-app-shell-sources / b-filetree-src-remove / b-git-panel / b-io-streaming / b-jsonl-degrade-chain / b-layout-zen(-deep) / b-md-diagrams-deep / b-md-lightbox-export-deep / b-mounts-deep / b-mounts-manager / b-quickopen-multisource / b-settings-center / b-sidebar-roots / b-stream-resilience-helpers / b-tab-actions-enrichment / b-theme-system / b-wscreate-outside-close / b-wsx-recovery / m5 / m6 / mobile / settings-center.ts / t-hl / t-md / t-pwa / t-shell / t-tab-actions / t-theme / t-workspace（仅列命中文件，逐文件 rg 确认实际改动面；只 import 未用旧名的零改动）。

- [ ] **Step 7: 门禁**

Run: `pnpm typecheck && pnpm test && pnpm --filter web build:e2e && pnpm --filter web exec playwright test`
Expected: typecheck 0 错 / vitest 全绿 / playwright 双 project 全量 0 failed（与基线同 skip 数；已存 flaky 以重试绿计）

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): TabBar 左端收敛融合菜单——TabBarMenu/WorkspaceList 抽取，TabBarActions/WorkspaceSwitcher 退役，e2e 锚全量随迁"
```

### Task 2: tab 条悬浮箭头滚动

**Files:**
- Create: `apps/web/src/lib/tabScroll.ts`、`apps/web/src/lib/tabScroll.test.ts`、`apps/web/e2e/b-tabbar-scroll.spec.ts`
- Modify: `apps/web/src/lib/TabBar.svelte`、`apps/web/src/app.css`（.vv-tabbar-tabs 段）

**Interfaces:**
- Produces `tabScroll.ts`：

```ts
export const SCROLL_EPS = 1;
export function arrowVisibility(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean };
export function dominantWheelDelta(e: { deltaMode: number; deltaX: number; deltaY: number }): number; // px；横向占优时 0
```

- Produces e2e 新域 `b-tabbar-scroll.spec.ts`（SCRL-01..07，见 Step 4；箭头/滚动用例独立成文件于本 commit 落地，Task 4 域文档 tabbar-menu.md 统一收册两文件——对 spec §6.2「新域 b-tabbar-menu」的结构性落地拆分，编号体系不变）

- [ ] **Step 1: 写 tabScroll 失败单测**

`tabScroll.test.ts`：①可见性三态——scrollLeft=0 → `{left:false,right:true}`；居中 → 双 true；滚到底 → `{left:true,right:false}`；clientWidth≥scrollWidth → 双 false；eps 边界（恰差 1px 内为 false）。②wheel 归一——`deltaMode 0` 原值、`deltaMode 1` ×16/行、`|deltaX|>|deltaY|` → 0、负值保号。

Run: `pnpm test -- tabScroll`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现 tabScroll.ts**

Run: `pnpm test -- tabScroll`
Expected: PASS

- [ ] **Step 3: TabBar 组件接线 + CSS**

结构：`.vv-tabbar-tabs` 外包 `.vv-tabbar-tabs-wrap`（`position:relative` + 原有 flex/min-width 迁至 wrapper）；箭头/渐隐对放 wrapper 内（**不得在滚动容器内**，防随 scrollLeft 位移）：

```
{#if vis.left}  <button class="vv-tabbar-arrow" data-side="left"  aria-label="向左滚动标签" title="向左滚动标签">◂</button><div class="vv-tabbar-fade" data-side="left" />  {/if}
{#if vis.right} <button class="vv-tabbar-arrow" data-side="right" aria-label="向右滚动标签" title="向右滚动标签">▸</button><div class="vv-tabbar-fade" data-side="right" /> {/if}
```

组件逻辑：`vis` 经 `arrowVisibility(scroller.scrollLeft, …)` 计算；重算触发面 = scroll 事件（passive）+ `ResizeObserver(scroller)` + window resize + `$effect` 读 `tabs`（Task 1 后仍为 props 数组）后调 update。行为常数：单击 `scrollBy({left: ±clientWidth*0.8, behavior:'smooth'})`；按住 `HOLD_DELAY_MS=350` 后 `REPEAT_INTERVAL_MS=80` 步进 `REPEAT_STEP_PX=64`（`behavior:'auto'`），pointerup/pointercancel/pointerleave 清理，连滚发生置 held 旗标抑制随后 click 补滚。滚轮：`$effect` 内手动 `el.addEventListener('wheel', onWheel, { passive:false })`（Svelte 委托路径不可靠 preventDefault，评审焦点 2），`onWheel` 用 `dominantWheelDelta`，非 0 时 `preventDefault + scrollLeft += d`。激活滚入：`$effect` 跟踪激活 tab id → `scroller.querySelector('[role=tab].active')?.scrollIntoView({inline:'nearest',block:'nearest',behavior:'auto'})`；**`dragFromId !== null` 时跳过**（评审焦点 5）。CSS：`.vv-tabbar-tabs { scrollbar-width:none }` + `::-webkit-scrollbar{display:none}`；`.vv-tabbar-arrow` 24×24 圆钮（`--ui-tab-bg` 底、1px `--ui-border`、`--vv-shadow-2`、absolute 居中、left/right:4px、z-index:1）；`.vv-tabbar-fade` 48px 宽 `linear-gradient` → `--ui-tab-bg`、`pointer-events:none`。

Run: `pnpm typecheck && pnpm test -- tabScroll`
Expected: 0 错 / PASS

- [ ] **Step 4: e2e `b-tabbar-scroll.spec.ts`（先 RED 后 GREEN）**

夹具：本地来源连开 ~15 个 tab（直开流或 filechooser）。用例：
- SCRL-01 可见性翻转+随 tab 数刷新：初态右钮可见左钮不可见；滚到底右隐左显；关闭若干 tab 至不溢出 → 双钮皆隐；**新开 tab 右钮复现**（评审焦点 3）。
- SCRL-02 单击滚动：点右钮 `expect.poll` scrollLeft 增量 ≥ 0.5×clientWidth。
- SCRL-03 按住连滚：pointerdown 按住 600ms 释放，位移显著大于单击档且释放后停止。
- SCRL-04 滚轮横移：tabbar 上 `mouse.wheel(0, 240)` → scrollLeft ≈ +240，页面未竖滚（评审焦点 2）。
- SCRL-05 激活滚入：滚到最左后经 quick open（Ctrl+P，QO 通道）激活最右 tab → 该 `.vv-tab.active` 进入滚动区可视范围（包围盒断言）。
- SCRL-06 滚动条隐藏：`.vv-tabbar-tabs` computed `scrollbar-width: none`。
- SCRL-07 拖拽边缘自动滚（native-first 探针）：dragover 右缘带 36px 悬置 ≥1s → scrollLeft 自增。**若 Chromium headless 原生已满足 → 用例直接钉死原生行为、零实现**；若红 → TabBar 补手工实现（ondragover 边缘带判定 + rAF 步进 ±10px/帧，dragleave/leave/drop/dragend 清理）直至绿。

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-tabbar-scroll`
Expected: 全绿（SCRL-07 允许「探针实证原生可用后钉死」或「补实现后绿」两终态，记档取哪条）

- [ ] **Step 5: 回归 + Commit**

Run: `pnpm --filter web exec playwright test t-tab-actions b-layout-zen`（拖拽重排/zen temp 条与 tab 条交互最近邻）
Expected: 零翻转

```bash
git add -A
git commit -m "feat(web): tab 条优雅滚动——滚动条隐藏+悬浮箭头/渐隐+滚轮横移+按住连滚+激活滚入"
```

### Task 3: 管理 ▾ 化

**Files:**
- Modify: `apps/web/src/lib/TabBar.svelte`（:328-334 manage 钮）、`apps/web/src/app.css`（.vv-tabbar-manage）

**Interfaces:** 无新接口（aria-label/title/data-vv-wspanel-trigger/onclick 全不动）。

- [ ] **Step 1: 改标记与样式**

按钮文本「管理」→「▾」（aria-label="管理标签" 已存在承担可达名）；CSS `.vv-tabbar-manage` 删 `font-size: var(--vv-fs-xs)` 覆写（回落全局 button 基座字号，与簇内图标钮同档）。已核 e2e 无「管理」精确文本锚（rg 复核一次确认），零测试变更。

- [ ] **Step 2: 门禁 + Commit**

Run: `pnpm typecheck && pnpm --filter web build:e2e && pnpm --filter web exec playwright test t-shell t-tab-actions b-tab-actions-enrichment`
Expected: 零翻转

```bash
git add -A
git commit -m "feat(web): 管理钮 ▾ 图标化——aria 锚不变仅缩形态"
```

### Task 4: 新域 b-tabbar-menu + 域文档

**Files:**
- Create: `apps/web/e2e/b-tabbar-menu.spec.ts`、`docs/e2e/tabbar-menu.md`
- Modify: `docs/e2e/tab-actions-enrichment.md`（TAX-14 场景行类名随迁）、`docs/e2e/sidebar-shell-actions.md`（提及左端动作簇的行改融合菜单口径）

**Interfaces:** 消费 Task 1 helper 全部导出。

- [ ] **Step 1: 用例落盘（编号对应域文档场景行，一一对应门）**

- MEN-01 全条目触达矩阵：8 首层行逐一点开断言（打开文件 filechooser/打开文件夹 picker 通道/粘贴 URL 行内表单提交 openUrl 生效/刷新触发 rev 自增/连接服务器表单开合+连接成功收菜单/主题三态切换生效/目录管理开管理页/设置开设置中心/专注进出 zen 类翻转）。
- MEN-02 子菜单手风琴：三父项点击展开/再点收起/展开 A 后点 B 仅 A 收；`aria-expanded` 翻转断言。
- MEN-03 关闭通道：物理 Esc（焦点在浮层内）、合成 Esc（`closeTopOverlayForZen` 同款派发目标=pop 本体，评审焦点 4）、外点 pointerdown，三通道各自零残留。
- MEN-04 互斥（TAX-14 随迁口径）：融合菜单开 → tab 右键开菜单 → 菜单收；反向同刻至多一个。
- MEN-05 管理 ▾ 触发：`[aria-label="管理标签"]` 点击 → wspanel 开（`data-vv-wspanel-trigger` 面板可见），Esc 收。
- MOB-01 浮层触顶（mobile project）：新建 5 个工作区（modal 循环）→ 开菜单+展开工作区子菜单+展开连接服务器表单 → 断言 pop `scrollHeight > clientHeight` 且内部可滚、top 未越视口（评审焦点 1）。

- [ ] **Step 2: 域文档 + 两处 docs 随迁**

`docs/e2e/tabbar-menu.md` 场景表（编号/通道/锚点与 spec §6.2 一致）；`tab-actions-enrichment.md` TAX-14 行 `.vv-tbact-pop`→`.vv-tbmenu-pop`；`sidebar-shell-actions.md` 左簇描述改「融合菜单」口径。

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-tabbar-menu`
Expected: 全绿（MOB-01 仅 mobile project 断言滚动，chromium 断言收合路径）

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(e2e): b-tabbar-menu 新域——融合菜单触达矩阵/手风琴/三关闭通道/互斥/触顶滚动+域文档"
```

### Task 5: 终局门禁

- [ ] **Step 1: 全量门禁**

Run: `pnpm typecheck && pnpm test && pnpm --filter web build:e2e && pnpm --filter web exec playwright test`
Expected: typecheck 0 错 / vitest 全绿 / playwright 双 project 全量 0 failed / 既有 flaky 计数与基线一致

- [ ] **Step 2: 工作树硬门**

Run: `git status --porcelain`
Expected: 输出为空（B6 教训：门禁前核查未提交残留；非空则补提交后复跑受影响门禁）
