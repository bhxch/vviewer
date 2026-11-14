# 壳层布局批（zen 目录入口 + 左栏目录 tab + 折叠按钮固定）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三项壳层诉求一次落地：①折叠按钮固定——两 aside 改「固定 header 行 + 滚动体」结构，折叠钮不随列表滚动（FileTree 源行与右栏切换器的 34px 让位 padding 随之退役）；②左栏目录 tab——左栏头部新增「树 | 目录」segmented 切换器（形态对齐右栏 `.vv-right-switch`），目录视图装配抽共享组件 TocView 左右两处复用；③zen 目录入口——zen 下内容区左右缘两枚浮钮打开左/右栏并锁定目录视图（移动端复用抽屉通道），Esc/返回键状态机扩一档先关栏再退 zen。

**Architecture:** 结构面一次重排（aside = flex column 不滚动，header 行收纳折叠钮+切换器，滚动体 div 承接 FileTree/Toc/MetaPanel）→ 目录装配三分支（OutlineView 优先 > Toc > MetaPanel 兜底）提为新组件 `TocView.svelte`，右栏分支先行换挂（行为零变化）→ 左栏 `leftView` 会话态消费 TocView（无目录数据不出目录钮 + 空态校正 effect）→ zen 侧 `zenSide: 'none'|'left'|'right'` 纯组件 `$state`（不进 settings/快照/layout.ts），CSS 按 `data-zen-side` 条件放行对应 aside、栏内树/切换器/属性/Git 单独隐藏；有效视图以派生计算不改写既有会话态（退侧零污染）；`zenEscAction`/`zenPopAction` 纯函数各扩 `closeZenSide` 一档，移动端复用抽屉状态机（浮钮开抽屉 + zenGuard 关侧后重 arm）。

**Tech Stack:** Svelte 5 runes（全局强制）、vitest（仓库根 jsdom）、Playwright 双 project、Conventional Commits。

**Spec:** `docs/superpowers/specs/2026-11-12-shell-toc-and-collapse-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 拍板、§4 设计、§7 裁量与 §8 builder check 订正节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `0e51b8a`（main；工作树 clean——spec C/E 已全部落地，最近五 commit 即 E 批实现与 ENG 域锚）。spec A 此前零落地；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6，**严格串行**。理由：T1 的 header 行结构是 T3 切换器与 T4 zen 栏内隐藏的挂载面（切换器必须落在非滚动区，先定结构后挂功能）；T2 的 TocView 是 T3 左栏目录视图与 T4 zen 目录视图的共享消费件（先抽组件、后扩两个消费点，保每 commit 行为可独立验证）；T3 的 `leftViewEff`/`rightViewEff` 派生与 T4 的 zen 覆盖共用同一有效视图通道（T3 先以恒等派生落接线，T4 只加 zen 项）；T4 触及 layout.ts 状态机与 AppShell zen 面多处（晚于结构/组件就位，diff 面最小）；T5 e2e 锚批依赖 T1–T4 运行时行为全部就位；T6 收尾。
- **grammar 构建链（spec F）条件核查**：本计划触及面为 AppShell.svelte、app.css、FileTree.svelte、layout.ts、i18n catalogs、e2e 装置——**不触及** `tools/grammar-builder`、`build.mjs`、gen-sources 与任何 cargo 生成物，**无需 gen-sources 与 build.mjs --fetch 先行步骤**（无 cargo 依赖；`pnpm gen:grammars` 既有产物已在 apps/web/static/grammars/，code outline e2e 直接消费）。
- **不触及 server/（Rust）**：本计划零 server/ 改动（纯前端壳层）。

## Global Constraints

- **拍板项不得偏离**（spec §3/§4/§8）：
  - zen 目录：入口为浮钮（无新全局快捷键、无持久化）；打开的栏**只显示目录视图**（左栏不显树、右栏不显属性/Git，切换器一并隐藏）；再点或 Esc 关闭。
  - 左栏目录 tab：segmented 两钮（树 | 目录），形态对齐右栏 `.vv-right-switch`；`leftView: 'tree'|'toc'` 会话态不持久化、不进快照、**不进 layout.ts/LayoutSettings**（无 settings/schema 改动——spec §6 红线）；目录钮显隐门与右栏同源 `tocEntries.length>0 || outlineDefinitions.length>0`。
  - 目录视图互斥规则与右栏一致：`outlineDefinitions` 优先（code 大纲在场渲染 OutlineView，否则 md TOC）。
  - 折叠按钮固定走「固定 header 行 + 滚动体」方案（sticky 备选不采用——spec §4.3 已拍板）；FileTree 源行 `padding-right:34px`（FileTree.svelte:118）与右栏切换器 `padding: 6px 34px 6px 10px`（app.css:730）的 34px 让位**随之退役**。
  - builder check 三落定（spec §8）：①移动端 zen 入口复用抽屉状态机通道（≤900px 左抽屉 / ≤600px 右抽屉，抽屉内锁目录视图），`zenPopAction` 新档先关抽屉再退 zen、zenGuard 关侧后重 arm；②zen 浮钮显隐门=`tocEntries/outlineDefinitions` 皆空时两侧浮钮都不显示（无目录数据不开空栏）；③zen 打开的栏内折叠钮隐藏（避免触发 `leftCollapsed/rightCollapsed` 持久化写入）——`.vv-shell.zen .vv-collapse-btn` 既有 zen 隐藏规则（app.css:429-431）天然承担，放行规则只放行 aside 本体不放行钮。
  - 非目标红线：`chromeVisible` zen 覆盖语义不回退；宽度设置项不变；快照恢复不含 leftView/zenSide；不新增设置字段；切换器不做下拉/浮层形态。
- **runes 纪律**：`.svelte`/`.svelte.ts` 一律 runes 写法（`$state`/`$derived`/`$props`/`$effect`），legacy 语法编译报错；AppShell 模板表达式禁写 state（校正/落位一律 effect 承载——AppShell:245-259 既有同族先例）。
- **i18n 纪律**：新文案键落 `catalogs/{zh-CN,en}/shell.ts`（域=shell），key 三段 `{域}.{模块}.{语义}`；en 键集==zh 键集由聚合机检硬断言（catalogs.aggregate.test.ts）；全部为新增键，无既有字面量迁移（D7 逐字节等价职责不适用）。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入致 grammar 域假红）；playwright 一律 `pnpm --filter web exec playwright test …`（根 package.json 无 playwright devDep）。
- **commit 纪律**：Conventional Commits（feat/fix/refactor/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **UI 文案/交互组件/a11y 任务前置阅读**（Task 1/3/4 开工前全文加载，不凭记忆转述）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（§2 z-index 档位表——**登记表与代码同步是义务**：`.vv-collapse-btn` 档 5 行随改流内同步、zen 浮钮新成员入档 25（与 `.vv-zen-exit` 语义同层，禁新开档位）；§6 交互件与 e2e 锚关系；§7 新条目登记模板）、`docs/design/ui-design-system.md`（间距/字阶/圆角 token——新 header 行与浮钮样式一律取 token）。
- **e2e 装置既有先例**（Task 5 直接复用，不新造）：目录注入 `openLocalDir`（b-sidebar-roots.spec.ts:37，`__vvOpenDirImpl` 通道）/ `injectDir`+`openTreeFile`（b-markdown-html-docs-helpers，b-code-outline 同消费）；抽屉开合 `openDrawerIfNarrow`/`ensureRightDrawer`（e2e/drawer.ts，断点同引擎判定）；chrome 菜单/zen 进出装置沿 b-layout-zen（`chromeMenuItem`/`enterZenViaDrawer` 先例 :354）；code outline 载体 PY_OUTLINE 页内构造（b-code-outline.spec.ts:56 起）。
- **AppShell 不可 vitest 直测**：根 vitest 无 svelte 插件——AppShell 行为面由源码契约测试（appShellZenEsc/appShellZenMobile 先例）+ e2e 收口；layout.ts 纯函数 layout.test.ts 直测。

## Review Focus

1. **右栏渲染分支零回归**（T1/T2 最大风险）：`.vv-right` 当前 `display:flex; flex-direction:column; overflow:auto`（AppShell:1598-1607），一组 flex 子项语义依赖 aside 为 flex 容器——GitSection（app.css:740 `.vv-git` flex:none）、MetaPanel 根（app.css:701 `.meta-panel` flex:none；MetaPanel.svelte:331 的 flex column 是内部 `.meta-list` 非根）、md TOC（app.css:714 `.toc` flex:1; min-height:0; overflow:auto）、OutlineView（app.css:810 `.vv-outline` flex:1; min-height:0; overflow:auto，与 .toc 同位同款）——重排后**滚动体必须是 flex column 容器**（`display:flex; flex-direction:column; flex:1; min-height:0; overflow:auto`），否则 Git diff 滚动区/TOC/大纲滚动区/MetaPanel 布局静默变形。回归锚=b-git-panel + b-code-outline + mobile.spec 定向全绿。
2. **SRC-03 族几何锚不翻转**：b-sidebar-roots.spec.ts:98 SRC-03 断言折叠钮与 `.vv-tree-src-remove` 包围盒不相交——结构重排后两元素垂直分离（header 行 vs 滚动体），应**更易满足**；但折叠钮 absolute→入流后 `app.css:362-367` 的 `position:absolute; top:6px`/`right:6px` 退役，semantic-components.md §2 档 5 成员行必须同步（登记表与代码同步是义务）。TOC-07 新锚左右两栏都断。
3. **zen 有效视图不改写会话态**：zenSide 打开期间若直接写 `rightView='toc'`/`leftView='toc'`，关闭侧后视图被污染（违背 spec「关闭后回到原 zen 覆盖态」的精神——栏虽隐、内态残留）。必须走派生 `rightViewEff/leftViewEff`（T3 恒等、T4 加 zen 项），写点只在用户切换器点击与校正 effect。`gitRepoDir` 透传（AppShell:1404）与滚动跟随门（AppShell:276 `rightView !== 'toc'`）两处消费点同步换 eff 值。
4. **zen 隐藏规则的条件放行面**：既有 `.vv-shell.zen .vv-side/.vv-right/…{ display:none }`（app.css:429-431，特异性 0,3,0）压过抽屉断点 transform 与竖条断点规则——放行规则 `.vv-shell.zen[data-zen-side='…'] .vv-side/.vv-right { display:… }` 特异性 0,4,0 必须成立；移动端放行后抽屉滑入仍靠既有 `.vv-shell.drawer .vv-side{transform:none}`（AppShell:1682）/`.vv-shell.rightopen .vv-right`（:1716）——**浮钮通道必须同步置 drawers 对应侧 open**（仅加 zenSide 不开抽屉 = 移动端栏停在屏外，可见不可达）。`data-zen-side` 属性挂在 `.vv-shell`（AppShell:1298 class 绑定行），关闭态置 undefined 不出属性。
5. **Esc/popstate 分档次序**：新档 `closeZenSide` 插在 closeOverlay 与 exitZen 之间（overlay 优先级不变——LZ-05/LZ-12 锚依赖「面板在场先关面板」）；桌面 Esc 分支（AppShell:1174-1185）与移动 onPopstate（:580-597）同步扩展，popstate 的 closeZenSide 分支关侧抽屉后必须 `zenGuard.arm()` 重压（镜像 closeOverlay 分支 :593-596 语义，否则下一次返回键直接离页）。toggleZen 退出分支必须重置 `zenSide='none'`（✕/菜单/Ctrl+Alt+Z 可在侧开时直退 zen，残留 zenSide 会让非 zen 态命中放行规则），**且只重置 zenSide 不关抽屉**（混合场景落定见 Task 4 Interfaces——退出是中性动作，不回滚任何抽屉开合位）。
6. **mLZ-04 与 34px 退役的连锁**：mLZ-04 断言 zen 隐抽屉本体（`.vv-side` computed display 'none'）+ 退出还原进入前开合态——enterZen 仍只翻 zen 字段、drawers 不被进 zen 改写（浮钮在 zen 期开抽屉属用户显式动作，退出 zen 不回滚 drawers，见 Task 4 记档）；FileTree 34px 退役后 `.vv-tree-src-remove` 与折叠钮的重叠防护改由 header 行承担，SRC-01/02（hover 揭示/键盘可达）不受影响但需定向回归。

---

### Task 1: 折叠按钮固定——aside 固定 header 行 + 滚动体重排，34px 让位退役

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（§2 z-index 档位表 + §6 交互件与 e2e 锚关系）、`docs/design/ui-design-system.md`（间距/字阶 token）。

**Files:**
- Modify: `apps/web/src/lib/AppShell.svelte`（左右两 aside 模板重排 + 组件内 scoped style：`.vv-side`/`.vv-right` 改不滚动、新增 header 行与滚动体样式；`.vv-drawer-head` 移挂 header 内——基类 display:none（:1735-1738）与 ≤900px 展示（:1772）机制原样保留）
- Modify: `apps/web/src/app.css`（`.vv-collapse-btn` absolute→流内按钮：`:349` 基类显隐分段保留、`:362-363` `position:absolute; top:6px` 与 `:367` `right:6px` 退役、opacity hover/focus-visible 行为保留（:364-366）；`.vv-right-switch` padding `6px 34px 6px 10px`→`6px 6px 6px 10px`（:730））
- Modify: `apps/web/src/lib/FileTree.svelte`（`.vv-tree-src` `padding-right:34px` 退役→常规 `var(--vv-sp-6)`，:110-121 注释同步改写为「让位由 header 行承担」）
- Modify: `docs/design/semantic-components.md`（§2 z-index 表档 5 行 `.vv-collapse-btn` 成员注记同步：流内后 z-index 声明退役、行号订正）

**Interfaces:**
- 目标结构（spec §4.3 拍板形态，左右同构）：
  ```
  aside.vv-side / aside.vv-right   （flex column；overflow 改 hidden——不再滚动）
  ├─ header 行（flex:none，不滚动；position 语义不需 relative——钮已入流）
  │    左栏桌面 = .vv-left-switch 占位（本 task 预留结构、Task 3 挂内容）+ .vv-collapse-left
  │    左栏 ≤900px = .vv-drawer-head（专注模式钮）+ 切换器行（Task 3）
  │    右栏      = .vv-right-switch + .vv-collapse-right
  └─ 滚动体 .vv-side-scroll / .vv-right-scroll（flex:1; min-height:0; overflow:auto;
       display:flex; flex-direction:column——Review Focus 1 的 GitSection/MetaPanel
       flex 子项语义承载）：FileTree/空态引导区/Toc/OutlineView/MetaPanel/GitSection
  ```
- **裁量落定**（spec §7 授权范围内）：
  1. 折叠钮**入流**（flex 槽位承担右上角位置惯例），不再 absolute——34px 让位退役的逻辑前提；`min-height: 36px` 撑住 header（无切换器时——左栏无目录数据/右栏纯属性态——折叠钮仍不与滚动体首行重叠，SRC-03/TOC-07 锚依赖）。
  2. `.vv-side-blank` 空态居中类**移挂滚动体**（`.vv-side-empty` flex:1 撑满余高语义不变，AppShell:1622-1641 注释同步）。
  3. `{#key treeKey}` 重建通道原样保留（包裹 FileTree，BUG-05 通道零改动）。
  4. ≤900px 左栏 header：抽屉头与切换器纵向堆叠（header 内两行），折叠钮维持断点显隐现状（≤900px 不显示——移动端无折叠语义，AppShell:1608-1611 既有口径；spec §4.3「抽屉头与折叠钮同行」按「断点显隐分段维持现状」（spec §4.3 末条）解读，不新增移动折叠钮）。
- **验收锚**：既有 e2e 定向全绿——b-sidebar-roots（SRC-01/02/03/04）、b-layout-zen（LZ-01 折叠展开/LZ-02 拖拽调宽）、t-shell（SHELL-10 两断点段）、b-code-outline（切换器/目录视图）、b-git-panel（Git 卡布局）、mobile.spec（右抽屉切换器）；typecheck+lint 绿；无新增 i18n 键。所触 e2e 锚文件=上述既有文件（本 task 不新增 spec 文件）。

- [ ] **Step 1: 左 aside 重排**

AppShell:1349-1378 改 header+滚动体两段：`.vv-side-head`（flex:none）收纳折叠钮（`.vv-collapse-left`）与抽屉头（`.vv-drawer-head` 移入，基础 display:none 机制不动）；`.vv-side-scroll` 承接 `{#key treeKey}` FileTree 与空态引导区（`.vv-side-blank` 移挂）。scoped style：`.vv-side` 改 `display:flex; flex-direction:column; overflow:hidden`（:1583-1591），新增 `.vv-side-head`/`.vv-side-scroll` 规则。

- [ ] **Step 2: 右 aside 重排 + 折叠钮入流**

AppShell:1424-1503 同构重排：`.vv-right-head` 收纳切换器与折叠钮；`.vv-right-scroll` 承接目录视图分支/MetaPanel/GitSection（分支体逐字节平移，T2 才抽组件）。app.css `.vv-collapse-btn` 入流化（退役 absolute/top/right，保留尺寸 24×24 与 opacity 揭示）；`.vv-right-switch` padding 退役 34px。FileTree `.vv-tree-src` padding-right 退役。semantic-components.md §2 档 5 行同步。

- [ ] **Step 3: 门禁与定向回归**

Run: `pnpm run typecheck && pnpm lint`（仓库根）→ `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-sidebar-roots b-layout-zen t-shell b-code-outline b-git-panel mobile` → 全绿（SRC-03/LZ-01/SHELL-10/OUT 域/Git 卡/移动右抽屉零翻转）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/AppShell.svelte apps/web/src/app.css apps/web/src/lib/FileTree.svelte docs/design/semantic-components.md && git commit -m "feat(layout): 折叠按钮固定——aside 改固定 header 行+滚动体，折叠钮入流，FileTree/切换器 34px 让位退役"
```

---

### Task 2: 目录视图装配抽共享组件 TocView（右栏分支先行换挂，行为零变化）

**Files:**
- Create: `apps/web/src/lib/TocView.svelte`（目录视图装配组件）
- Modify: `apps/web/src/lib/AppShell.svelte`（右栏 'toc' 分支（:1472-1489）换挂 `<TocView …/>`；装配注释（:1473-1476）随迁）

**Interfaces:**
```svelte
let {
  tocEntries,        // TocEntry[]：md TOC 全量（AppShell:147 上行值直传）
  outlineDisplayed,  // OutlineEntry[]：引用已过滤+门限切片后的显示集（AppShell:213 直传）
  activeLine,        // number | undefined：跟随高亮行（AppShell:171）
  onOutlineJump,     // (line: number) => void：大纲点击跳转（AppShell onOutlineJump :233）
  outlineTruncated,  // boolean：截断态旗标（AppShell:216）
  onExpandAll        // () => void：全部展开动作（AppShell :219）
}: { … } = $props();
```
- 组件内三分支与现右栏分支（AppShell:1477-1489）逐字节等价：`outlineDisplayed.length > 0` → `<OutlineView entries={outlineDisplayed} activeLine onclick={onOutlineJump} truncated={outlineTruncated} onexpandall={onExpandAll} />`；`:else if tocEntries.length > 0` → `<Toc entries={tocEntries} />`；`:else` → `<MetaPanel />`（兜底空态保留——右栏 touched 后无数据路径仍可达；左栏消费点数据被门控，兜底仅瞬时态无害）。
- **裁量落定**（spec §7「共享目录组件的拆出形态」）：新组件文件 TocView.svelte（命名避让既有 Toc.svelte——md TOC 列表组件）；OutlineView/Toc 传参面（entries/activeLine/onclick/truncated/onexpandall）与滚动跟随数据流（outlineDisplayed 在 AppShell 计算后下行）**零改动**——深度重算/截断/跟随二分仍单点在 AppShell 侧派生与 effect（TocView 不触 metaStore 总线）。
- **验收锚**：typecheck+lint 绿 + Task 1 同批定向 e2e 复跑全绿（b-code-outline OUT 域 + b-markdown-html-docs-md07-09 的 nav.toc 断言面（:28-41，`nav.toc li button` ×9 + `.active` 跟随高亮——md TOC 装配等价性最强的行为锚）；b-md-corpus-markpad **不在清单**——其文件头（:8-17）为 MC-01~36 真实语料渲染稳定域，断言只锚 `.vv-markdown` 可见与无 pageerror，`rg -n -i "toc" b-md-corpus-markpad.spec.ts` 零命中实查，全程不触 TOC）；无新 e2e 锚文件（纯重构，spec §6 ①的 e2e 由 Task 5 落）。

- [ ] **Step 1: 建 TocView.svelte**

按 Interfaces 落组件（runes `$props`；根元素不引入新容器——三分支组件原样输出，避免多包一层 div 改变 `.vv-right` 直接子元素布局语义）。

- [ ] **Step 2: 右栏分支换挂**

AppShell 右栏 `{#if rightView === 'toc'}` 体内三分支替换为单 `<TocView …/>`，props 一一对应现值。

- [ ] **Step 3: 门禁与定向回归**

Run: `pnpm run typecheck && pnpm lint && pnpm vitest run apps/web/src/lib`（仓库根）→ **`pnpm --filter web build:e2e`**（先重建——playwright webServer 是 `pnpm vite preview --port 4173` 纯静态服务 dist（apps/web/playwright.config.ts:26），无 build 步骤；不重建则被测 bundle 仍是上一 task 产物，本 task 换挂零收益假绿）→ `pnpm --filter web exec playwright test b-code-outline b-markdown-html-docs-md07-09 t-shell mobile` → 全绿。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/TocView.svelte apps/web/src/lib/AppShell.svelte && git commit -m "refactor(shell): 目录视图装配抽共享组件 TocView——右栏分支先行换挂（OutlineView>Toc>MetaPanel 三分支逐字节等价）"
```

---

### Task 3: 左栏目录 tab——leftView 会话态 + header 切换器 + 显隐门与空态校正

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（§6 交互件与 e2e 锚关系——segmented 切换器对齐 `.vv-right-switch` 既有形态，非浮层不入 OVERLAY 册）、`docs/design/ui-design-system.md`。

**Files:**
- Modify: `apps/web/src/lib/AppShell.svelte`（`leftView` 会话态 + 左栏 header 挂切换器 + TocView 左栏消费 + 空态校正 effect + 滚动跟随门扩 eff + i18n 消费）
- Modify: `apps/web/src/lib/i18n/catalogs/zh-CN/shell.ts`、`apps/web/src/lib/i18n/catalogs/en/shell.ts`（3 新键）

**Interfaces:**
- 会话态（AppShell 组件内，rightView 同款注释风格）：
  ```ts
  /** 左栏视图（spec A §4.1）：'tree'=文件树（默认），'toc'=目录视图（TocView 共享件）。
   * 会话态不持久化、不进快照、不进 layout.ts（零 settings/schema）。 */
  let leftView = $state<'tree' | 'toc'>('tree');
  /** 有效视图派生：本 task 恒等（zen 覆盖项 Task 4 加入）——右栏同款命名（rightViewEff
   *  同步以恒等派生引入），消费点三处：左栏渲染分支 / 滚动跟随门（AppShell:276）/
   *  gitRepoDir 透传门（:1404，右值）。 */
  const leftViewEff = $derived(leftView);
  const rightViewEff = $derived(rightView);
  ```
- 切换器（左栏 header 内，门控渲染）：`tocEntries.length > 0 || outlineDefinitions.length > 0` 时渲染 `.vv-left-switch`（`role="group"` `aria-label=t('shell.left.switchAria')`），两钮 `.vv-left-switch-btn`（形态类名对齐 `.vv-right-switch-btn`，样式复用其规则或镜像同款）：树钮 `aria-pressed={leftView==='tree'}` → `leftView='tree'`；目录钮（`{#if}` 门内）`aria-pressed={leftView==='toc'}` → `leftView='toc'`。
- 空态校正 effect（镜像右栏校正 AppShell:255-259 同族，不置 touched 台账——**记档**：spec「镜像 rightView 语义」取会话态+不持久化本体；rightView 的 touched/默认落位机制服务于「有数据默认目录」落位，左栏默认恒 'tree'、无落位 effect，touched 旗标无消费面故不设）：
  ```ts
  $effect(() => {
    if (leftViewEff !== 'toc') return;
    if (tocEntries.length > 0 || outlineDefinitions.length > 0) return;
    leftView = 'tree'; // 数据消失归位（写值即出条件，无自读自写环）
  });
  ```
- 左栏渲染分支（`.vv-side-scroll` 内）：`sources.length > 0` 时 FileTree 容器 `hidden={leftViewEff !== 'tree'}`（**裁量落定：hidden 保留实例**——spec §4.1 倾向采纳，保树滚动位置/展开态，快照与 `{#key treeKey}` 面零改动）；`{#if leftViewEff === 'toc'}` 挂 `<TocView …/>`（入参与右栏同源同值：tocEntries/outlineDisplayed/activeLine/onOutlineJump/outlineTruncated/expandOutlineAll）。
- 滚动跟随门扩展：AppShell:276 `if (rightView !== 'toc') return;` → `if (rightViewEff !== 'toc' && leftViewEff !== 'toc') return;`（左右任一目录视图在场即跟随——activeLine 为共享单值，双视图同显时同高亮，无害）。
- i18n（zh 定稿 → en 对译；en 键集==zh 键集聚合机检自动覆盖）：
  - `shell.left.switchAria`：zh `左栏视图切换`；en `Left panel view switch`
  - `shell.left.tree`：zh `树`；en `Tree`
  - `shell.left.toc`：zh `目录`；en `TOC`
- **验收锚**：typecheck+lint+聚合机检绿（新键 en==zh）；左栏切换行为 e2e 由 Task 5 TOC-01/02/03 钉（本 task 先行接线）；右栏零回归（Task 2 同批定向 e2e 复跑）。所触 e2e 锚文件=`apps/web/e2e/b-shell-toc.spec.ts`（Task 5 落）。

- [ ] **Step 1: 会话态 + eff 派生 + 校正 effect + 跟随门/git 门换 eff**

按 Interfaces 落地四件（含右栏 eff 恒等派生与两处消费点换名——语义零变化）。

- [ ] **Step 2: 左栏 header 切换器 + TocView 消费 + hidden FileTree**

按 Interfaces 落模板与 `.vv-left-switch` 样式（桌面行内 flex:1；≤900px 抽屉头下方独立行——Task 1 预留结构挂内容）；i18n 双目录逐键落（zh 先定稿 → en 翻译）。

- [ ] **Step 3: 门禁**

Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿（聚合机检含新键）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/AppShell.svelte apps/web/src/lib/i18n && git commit -m "feat(shell): 左栏目录 tab——leftView 会话态+header 树|目录切换器（显隐门与右栏同源）+TocView 左栏消费+空态校正"
```

---

### Task 4: zen 目录入口——双浮钮 + zenSide 会话态 + Esc/返回键状态机新档 + 移动抽屉通道

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线（44px 触控/aria 形态/减少动效）+ §6 评审必查清单）、`docs/design/semantic-components.md`（§2 z-index 档位——浮钮入档 25 与 `.vv-zen-exit` 语义同层；**非面板形态不入 OVERLAY 册**——开关浮钮同 `.vv-zen-exit` 先例，无 Esc 自理面，分派走 AppShell 状态机）、`docs/design/ui-design-system.md`。

**Files:**
- Modify: `apps/web/src/lib/layout.ts`（`ZenEscAction`/`ZenPopAction` 各扩 `'closeZenSide'` + 两纯函数入参扩 `zenSideOpen`）
- Modify: `apps/web/src/lib/layout.test.ts`（新档用例扩展，:133-148 既有三态/等价性用例旁）
- Modify: `apps/web/src/lib/AppShell.svelte`（zenSide 态 + 双浮钮 + `data-zen-side` 属性 + 有效视图 zen 项 + toggleZen 重置 + Esc/onPopstate 分支 + 浮钮样式 + i18n 消费）
- Modify: `apps/web/src/lib/app.css`（zen 条件放行规则 + 栏内切换器隐藏规则，:426-431 zen 块旁）
- Test: `apps/web/src/lib/appShellZenEsc.test.ts`、`apps/web/src/lib/appShellZenMobile.test.ts`（源码契约扩展：浮钮接线/data-zen-side/重 arm/退出重置）
- Modify: `apps/web/src/lib/i18n/catalogs/zh-CN/shell.ts`、`apps/web/src/lib/i18n/catalogs/en/shell.ts`（2 新键）
- Modify: `docs/design/semantic-components.md`（§2 z-index 表档 25 行追加 zen 目录浮钮成员；**顺手订正同档既有成员过期行号**——`.vv-zen-exit` 行注记 AppShell.svelte:1773 → :1790 实查，登记表与代码同步是义务）

**Interfaces:**
- layout.ts（纯函数，spec §4.2「状态机扩展一档」+ §8 移动通道落定）：
  ```ts
  export type ZenEscAction = 'closeOverlay' | 'closeZenSide' | 'exitZen' | 'none';
  export function zenEscAction(state: { overlaysOpen: boolean; zenSideOpen: boolean; zen: boolean }): ZenEscAction {
    if (state.overlaysOpen) return 'closeOverlay';   // 面板优先不变（LZ-05/LZ-12 锚）
    if (state.zenSideOpen) return 'closeZenSide';    // 新档：先关 zen 打开的栏
    if (state.zen) return 'exitZen';
    return 'none';
  }
  export type ZenPopAction = 'closeOverlay' | 'closeZenSide' | 'exitZen' | 'ignore';
  export function zenPopAction(state: { guardArmed: boolean; overlaysOpen: boolean; zenSideOpen: boolean; zen: boolean }): ZenPopAction {
    if (!state.guardArmed) return 'ignore';
    if (state.overlaysOpen) return 'closeOverlay';
    if (state.zenSideOpen) return 'closeZenSide';
    if (state.zen) return 'exitZen';
    return 'ignore';
  }
  ```
- AppShell：
  - `let zenSide = $state<'none' | 'left' | 'right'>('none');`（UI 会话态不入 settings/快照/layout.ts——spec §4.2 拍板形态）；`data-zen-side={zenSide !== 'none' ? zenSide : undefined}` 挂 `.vv-shell`（:1298 class 绑定行同位）。
  - 浮钮显隐门（spec §8 落定 2）：`{#if layout.zen && (tocEntries.length > 0 || outlineDefinitions.length > 0)}` 渲染两枚 `.vv-zen-toc-btn`（`.vv-zen-toc-left`/`.vv-zen-toc-right`），`aria-label=t('shell.zen.tocLeftAria'/'tocRightAria')`、`aria-pressed={zenSide === 'left'/'right'}`、`onclick={() => toggleZenSide('left'/'right')}`。
  - `toggleZenSide(side)`：同侧再点=关（`closeZenSide()`）；异侧=关旧开新（zenSide 单值天然单开语义）；开=置 `zenSide=side` 且**按断点分流**（spec §8 落定 1）——左栏 `isDrawerBreakpoint()`（≤900px）→ `drawers = { …drawers, leftOpen: true }`（复用抽屉状态机，shell `.drawer` 类既有通道）；右栏 `matchMedia('(max-width: 600px)')` → `rightOpen: true`；桌面断点仅置 zenSide（flex 放行通道）。
  - `closeZenSide()`：`zenSide='none'` + 抽屉断点下关对应侧抽屉（`leftOpen/rightOpen=false`）。**记档（混合场景，规划评审 F4 落定）**：closeZenSide 不做开合来源（provenance）区分——「再点浮钮/返回键」是对目录栏的**显式关闭动作**，抽屉是该动作链的载体，随之关闭与 ☰ toggle 翻转语义同族（toggleLeftDrawer 本就翻转用户既开状态）；进 zen 前抽屉已开的场景下用户再点浮钮关闭，抽屉被关属显式请求，不视为回滚。
  - Esc 分支（:1174-1185）：`action === 'closeZenSide'` → `closeZenSide()`（无 history 面）；onPopstate（:580-597）：`closeZenSide` 分支 → `closeZenSide()` 后 **`zenGuard.arm()` 重压**（镜像 closeOverlay 分支 :593-596——本次回退已消费守卫项，关侧后重压维持「zen 在场即守卫在顶」不变式）。
  - toggleZen 退出分支（:521-524）：**只 `zenSide = 'none'`，不关抽屉**（Review Focus 5——✕/菜单/Ctrl+Alt+Z 可在侧开时直退 zen，残留 zenSide 会让非 zen 态命中放行规则）。**记档（混合场景，规划评审 F4 落定）**：退出 zen 是中性动作不回滚任何 drawers 开合位——进 zen 前左抽屉已开（mLZ-04 场景）→ zen 期点左浮钮（zenSide='left'，抽屉本已开）→ ✕ 直退 zen：按「退出关抽屉」实现会关掉进 zen 前就开着的抽屉，违反 mLZ-04「进入前开态还原」语义；改为退出只重置 zenSide，抽屉保持当前开合现状（无论开合位来源是进 zen 前状态还是 zen 期浮钮/用户动作），mLZ-04 与「浮钮开的抽屉退出后保持」两个语义面天然同时成立，且免 provenance 追踪（实现上无法区分开合来源，本落定绕开该不可行面）。
  - 有效视图 zen 项（Task 3 恒等派生处）：`const leftViewEff = $derived(layout.zen && zenSide === 'left' ? 'toc' : leftView);`、`const rightViewEff = $derived(layout.zen && zenSide === 'right' ? 'toc' : rightView);`——右栏渲染分支（git 条件 :1490 同步换 `rightViewEff`）、左栏渲染分支、跟随门、gitRepoDir 门全部自动获得 zen 锁定（零散写点为零）。
  - 浮钮样式（scoped style，全断点通用——**裁量落定**：左右缘垂直居中 `top:50%; transform:translateY(-50%)`，左 `left:12px`/右 `right:12px`，44×44 触控标准，视觉对齐 `.vv-zen-exit` 先例（半透 0.55、hover/focus-visible 提亮 1、圆角 50%、边框/背景 token 同款，AppShell:1790-1811 镜像），`z-index:25`（档 25 与 zen 退出钮同层——面板层 30 之下，面板在场时浮钮被压住的「面板优先」视觉一致）；中部边缘天然避开 `.vv-zen-exit`（右下 bottom:34px）与状态栏（底部）。
- app.css（zen 块 :426-431 旁追加；特异性 0,4,0 压过 0,3,0 隐藏规则——Review Focus 4）：
  ```css
  .vv-shell.zen[data-zen-side='left'] .vv-side { display: flex; }
  .vv-shell.zen[data-zen-side='right'] .vv-right { display: flex; }
  .vv-shell.zen[data-zen-side='left'] .vv-left-switch { display: none; }
  .vv-shell.zen[data-zen-side='right'] .vv-right-switch { display: none; }
  ```
  （折叠钮由既有 `.vv-shell.zen .vv-collapse-btn` 隐藏规则天然覆盖——spec §8 落定 3；移动端放行后抽屉滑入复用既有 `.vv-shell.drawer .vv-side{transform:none}`/`.rightopen .vv-right` 通道。）
- i18n（zh 定稿 → en 对译）：
  - `shell.zen.tocLeftAria`：zh `打开左栏目录`；en `Open TOC in left panel`
  - `shell.zen.tocRightAria`：zh `打开右栏目录`；en `Open TOC in right panel`
- **验收锚**：layout.test.ts 新档全绿（closeZenSide 三态插位 + 双触发源等价性 :145 扩展 + guardArmed=false ignore 不变）+ appShellZenEsc/appShellZenMobile 源码契约扩展绿 + 聚合机检绿 + **本 task Step 3 定向 Run 兑现**既有 b-layout-zen/b-layout-zen-deep 全量零翻转（LZ-05/06/12/15、mLZ-01~06——zen 覆盖语义不回退的直接锚；本 task 动的正是 Esc 分支/onPopstate/zen 放行 CSS，回归必须随 commit 兑现，不推迟到 Task 5——规划评审 F3 落定）。所触 e2e 锚文件=`apps/web/e2e/b-shell-toc.spec.ts`（TOC-04/05/mTOC-02/03，Task 5 落）、`apps/web/e2e/b-layout-zen*.spec.ts`（本 task Step 3 定向回归）。

- [ ] **Step 1: TDD layout.ts 新档（RED→GREEN）**

layout.test.ts 扩展：①`zenEscAction` zenSideOpen=true → 'closeZenSide'（zenSideOpen 优先于 zen、次于 overlay——三态插位断言）；②`zenPopAction` guardArmed+zenSideOpen → 'closeZenSide'、`!guardArmed` → 'ignore' 不变；③双触发源等价性用例（:145）扩 closeZenSide 态。Run: `pnpm vitest run apps/web/src/lib/layout` → RED → 实装两纯函数 → GREEN。

- [ ] **Step 2: AppShell zenSide 态 + 浮钮 + 有效视图 + toggleZen 重置**

按 Interfaces 落地（zenSide/浮钮/toggleZenSide/closeZenSide/eff zen 项/toggleZen 退出重置/i18n 双目录）。

- [ ] **Step 3: Esc/onPopstate 分支 + CSS 放行 + 源码契约扩展 + 登记**

Esc 分支与 onPopstate 分支接线；app.css 四条放行/隐藏规则；appShellZenEsc.test.ts（closeZenSide 分支在场、浮钮 aria-pressed 接线）、appShellZenMobile.test.ts（data-zen-side 属性绑定、onPopstate closeZenSide 后 zenGuard.arm() 重压、toggleZen 退出只重置 zenSide 不关抽屉）源码契约扩展；semantic-components.md §2 档 25 追加成员行 + `.vv-zen-exit` 行号订正。Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint`（仓库根）→ **`pnpm --filter web build:e2e`**（先重建——webServer 为纯 preview 静态服务）→ `pnpm --filter web exec playwright test b-layout-zen b-layout-zen-deep` → 全绿（LZ-05/06/12/15、mLZ-01~06 零翻转——本 task 直接命中面的回归随 commit 兑现）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib apps/web/src/app.css docs/design/semantic-components.md && git commit -m "feat(zen): zen 目录入口——双浮钮+zenSide 会话态（data-zen-side 条件放行）+Esc/返回键 closeZenSide 新档+移动抽屉通道（zenGuard 关侧重压）"
```

---

### Task 5: e2e 锚批 b-shell-toc（spec §6 ①~④ + 移动通道）

**Files:**
- Create: `apps/web/e2e/b-shell-toc.spec.ts`（TOC- 域）

**验收锚 / e2e**：本任务即 e2e 锚批——`pnpm --filter web build:e2e` 后本域全绿 + 定向回归（b-layout-zen / b-layout-zen-deep / b-sidebar-roots / b-code-outline / t-shell / mobile）零翻转。装置复用：`openLocalDir`（b-sidebar-roots.spec.ts:37 先例）/`injectDir`+`openTreeFile`（b-markdown-html-docs-helpers）/`openDrawerIfNarrow`（e2e/drawer.ts）；code 大纲载体 PY_OUTLINE 页内构造（b-code-outline.spec.ts:56 先例）；SRC-03 式手写相交判定（b-sidebar-roots.spec.ts:106-112 先例）。

- [ ] **Step 1: TOC-01/02/03——左栏 tab（桌面）**

TOC-01：注入含 md 文件的目录 → 左栏 `.vv-left-switch` 可见（目录钮在场门）→ 点目录钮 → `.vv-side .toc` 可见且 FileTree `hidden`（locator toBeHidden 但存在性保留——`await expect(tree).toBeHidden()` + count 1）→ aria-pressed 翻转 → 点树钮还原。TOC-02：注入 .py（PY_OUTLINE 载体）→ 左栏切目录 → `.vv-side .vv-outline` 可见（outline 优先互斥）且右栏 `.vv-right .vv-outline` 同源同显（两侧数据互斥/同源锚）。TOC-03：注入 .txt（无目录数据）→ `.vv-left-switch` count 0（左栏保持纯树）。

- [ ] **Step 2: TOC-04/05——zen 目录入口（桌面）**

TOC-04：md 文件在场 → Ctrl+Alt+Z 进 zen → `.vv-zen-toc-right` 可见（显隐门有数据面）→ 点开 → `.vv-right` 可见且栏内 `.vv-right-switch` count 0（切换器隐藏）、`.vv-right .toc` 可见、`.vv-right .vv-collapse-right` toBeHidden（落定 3）→ Esc 第一段：栏隐、`.vv-shell.zen` 仍在（两段退出）→ Esc 第二段：退 zen。TOC-05：同构走左浮钮（`.vv-side` 放行 + `.vv-left-switch` 隐藏 + FileTree hidden + `.toc` 可见）；**显隐门空态面**：.txt 文件 zen 下两浮钮 count 0（落定 2）。

- [ ] **Step 3: TOC-06/07——折叠钮几何（SRC-03 式）**

TOC-06：注入多文件目录+长 TOC md → `.vv-collapse-left` boundingBox 记存 → 滚动 `.vv-side-scroll` 至中部 → 包围盒逐值相等（x/y/width/height）；右栏同构（滚动 `.vv-right-scroll`，`.vv-collapse-right` 包围盒不变）——spec §6 ③。TOC-07：左右两栏 header 内切换器与折叠钮包围盒手写相交判定不相交（SRC-03 先例 :106-112 同款判定式）——spec §6 ④。

- [ ] **Step 4: mTOC-01/02/03——移动通道（mobile project）**

mTOC-01：≤900px 抽屉态注入 md → 开抽屉 → 抽屉头下方 `.vv-left-switch` 可见可切（spec §4.1 抽屉形态可用）。mTOC-02：zen（抽屉头「专注模式」进入）→ 左浮钮可见 → 点开 → `.vv-side` 滑入（transform none，drawer 通道）且栏内仅目录（FileTree hidden/切换器隐）→ `page.goBack()` 一次：抽屉关、zen 保持、`history.state.vvZen===1`（zenGuard 重压锚）→ 再 goBack：退 zen。mTOC-03：≤600px 右浮钮 → `.rightopen` 抽屉滑入仅目录 → Esc 不可用（移动无 Esc）→ goBack 两段同 mTOC-02。

- [ ] **Step 5: 定向回归 + 提交**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-shell-toc b-layout-zen b-layout-zen-deep b-sidebar-roots b-code-outline t-shell mobile` → 全绿（LZ/mLZ/SRC/OUT/SHELL 域零翻转）。
```bash
git add apps/web/e2e/b-shell-toc.spec.ts && git commit -m "test(e2e): 壳层目录批 TOC 域锚——左栏 tab/zen 双侧目录入口/Esc 两段/折叠钮几何/移动抽屉通道"
```

---

### Task 6: 全量门禁与收尾（控制器执行）

- [ ] `node tools/fetch-e2e-corpus.mjs`（语料）→ `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`；对比基线：新增 b-shell-toc TOC/mTOC 域外零回归）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转）→ `git status --porcelain` 净空。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。
- [ ] 台账汇总（实施期记档项随任务报告归集；本计划规划期记档项四条——①leftView 不设 touched 旗标/落位 effect（Task 3 Interfaces）；②zen 退出不回滚 drawers 进前开合态（Task 4 Interfaces）；③spec §4.3「≤900px 抽屉头与折叠钮同行」按断点显隐现状解读：移动端不新增折叠钮（Task 1 Interfaces 裁量 4）；④T2 组件提取无独立单测（AppShell 不可直测，行为面由既有 OUT 域 e2e + Task 5 新锚承接））。

## Errata（执行期勘误）

- 2026-11-14 初版（规划师 A 基于 HEAD 0e51b8a 编写；规划期关键实查已内联：zen 隐藏规则 app.css:429-431 / 折叠钮 absolute 位 app.css:362-367 / 34px 让位两处 FileTree.svelte:118 + app.css:730 / aside 滚动容器 AppShell.svelte:1588/:1604 / shell class 绑定行 :1298 / 切换器与渲染分支 :1435-1503 / zenEscAction:layout.ts:110-114、zenPopAction:116-131 / Esc 分支 :1174-1185、onPopstate :580-597、toggleZen :512-526 / zenGuard 重压先例 :593-596 / gitRepoDir 门 :1404 / 跟随门 :276 / SRC-03 锚 b-sidebar-roots.spec.ts:98-113 / drawer 通道 shellDrawers.ts + e2e/drawer.ts / zen 浮钮先例 .vv-zen-exit AppShell:1790-1811、z-index 档 25 / 抽屉头基隐 AppShell:1736-1739）。
- 规划期裁量五项全部内联落定于上文 Interfaces（左栏 header 排布=切换器 flex:1 左+折叠钮入流右；zen 浮钮=双缘垂直居中 44px 半透档 25；zen 打开栏宽=沿用各自 clamp 现值（内联 CSS 变量原样生效，把手经既有 zen 规则维持隐藏，零新增样式通道）；FileTree=hidden 保留实例；共享组件=新文件 TocView.svelte），无 deferred 项。
- 2026-11-14 计划评审修订（5 条意见，规划师 A 逐条实查复现后同文件落定，修订基于 HEAD 7e3293d=本计划文档 commit，代码基线 0e51b8a 不变）：①【高】Task 2 Step 3 playwright 缺 build:e2e 属门禁假绿——webServer 实读 `pnpm vite preview --host 127.0.0.1 --port 4173 --strictPort`（apps/web/playwright.config.ts:26，纯静态服务 dist 无 build，reuseExistingServer 非 CI 复用 :28），Task 2 只改源码不重建则被测 bundle 仍是上一 task 产物；已补 `pnpm --filter web build:e2e` 前置并注明缘由。②【中】Task 2 验收锚「b-md-corpus-markpad 的 nav.toc 路径」不成立——`rg -n -i "toc" apps/web/e2e/b-md-corpus-markpad.spec.ts` 零命中、其文件头（:8-17）为 MC-01~36 渲染稳定域不触 TOC；已换为 b-markdown-html-docs-md07-09（:28-41 `nav.toc li button` ×9 + `.active` 跟随，md TOC 装配等价性最强断言面），Step 3 Run 同步。③【中】Task 4 验收锚承诺 b-layout-zen 全量回归但全 task 无 playwright Run，回归推迟到 Task 5 违背「每 commit 行为可独立验证」；已选补运行方案——Task 4 Step 3 补 build:e2e + `playwright test b-layout-zen b-layout-zen-deep`，验收锚明写「由本 task Step 3 兑现」。④【低】toggleZen 退出分支与「不回滚 drawers」记档在混合场景冲突（进 zen 前抽屉已开→zen 期浮钮开侧→直退 zen，按原句字面会关掉本已开着的抽屉，且实现上无法区分开合来源）；已写死：退出只重置 zenSide 不关抽屉（中性动作零回滚，mLZ-04 与浮钮开抽屉保持两面同时成立），closeZenSide 保持关抽屉（显式关闭动作，翻转语义与 ☰ 同族）——两处记档落定于 Task 4 Interfaces 与 Review Focus 5。⑤【低·记录性】行号订正四处：PY_OUTLINE b-code-outline.spec.ts:58→:56（Global Constraints/Task 5 两处）；.vv-drawer-head 基隐块 AppShell:1736-1739→:1735-1738（Task 1）；Review Focus 1 的 MetaPanel 引用改归属（app.css:701 `.meta-panel` flex:none 为根依赖，MetaPanel.svelte:331 是内部 .meta-list）并补 .toc（app.css:714）/.vv-outline（app.css:810）同族 flex:1; min-height:0 依赖；semantic-components.md 档 25 行 `.vv-zen-exit` 行号 :1773→:1790 随 Task 4 顺手订正。spec §4.2 自引 app.css:1768-1789 超 961 行属 spec 侧过期锚，本计划已自行纠正为 AppShell:1790-1811，无传导。
