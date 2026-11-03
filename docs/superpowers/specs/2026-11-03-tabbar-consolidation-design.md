# 标签栏收敛设计：融合全局菜单 × tab 条优雅滚动 × 管理钮图标化

- 日期：2026-11-03
- 状态：待用户审阅
- 设计过程：brainstorm 两轮视觉稿确认（`.superpowers/brainstorm/`，菜单结构选 B 子菜单收纳、tab 箭头选 A 悬浮式；用户拍板不留 ＋ 快捷钮，彻底单入口）+ builder check 一轮（5 问：子菜单形态歧义/浮层超高/commit 红窗/快捷键提示与面板条目/单测清单补漏，处置见 §3.2、§3.3、§7、§3.1、§6.1）

## 1. 背景与动机

用户两点诉求（2026-11-03）：

1. 文件 tab 多了之后标签条出现横向滚动条，不优雅——要求隐藏滚动条，用左右方向箭头表达可滚方向，滚轮/触控可横移。
2. 顶栏（退役后即 TabBar）左侧动作簇 `[工作区名 ▾][＋][↻][⋯]` 占空间过大——全部管理功能融合进一个按钮；右端「管理」两字太长，改向下箭头。

现状（HEAD 3d4ef6c）：`.vv-tabbar` 三段式——左 `.vv-tabbar-actions`（WorkspaceSwitcher + TabBarActions 四件）、中 `.vv-tabbar-tabs`（`overflow-x:auto` 裸滚动条）、右 `.vv-tabbar-manage`（「管理」文字钮）。375px 窄窗下左簇约 174px（≈46vw），挤压 tabs 滚动区。

## 2. 目标 / 非目标 / 反目标

**目标**

- 左端收敛为单按钮「工作区名 ▾」，点开融合菜单承载全部全局功能。
- tab 条滚动条隐藏；溢出方向以悬浮箭头+渐隐遮罩表达；滚轮/触控/激活滚入/按住连滚/拖拽边缘自动滚。
- 右端「管理」改 ▾ 图标钮，触发机制（WorkspaceTabsPanel / Alt+W / `data-vv-wspanel-trigger`）不变。
- 既有 e2e 锚体系随迁不放宽：能力面零回退（工作区切换/重命名/删除/新建、打开三通道、刷新、连接服务器、主题、目录管理、设置、专注全保留）。

**非目标**

- 不做 tab 溢出下拉列表（「»」overflow menu）、不做 tab 条多行换行。
- 不动 WorkspaceTabsPanel（管理面板）本体与 Alt+W。
- 不做命令面板/菜单搜索；桌面不做 hover 子菜单（点击展开统一，见 §3.2）。
- 不动 zen / chrome 隐藏 / 边缘热区机制（TabBar temp 条形态自动继承新设计）。

**反目标（做了即失败）**

- 菜单条目 aria-label/title 文案随性变更破坏锚红线（设置/目录管理/刷新当前文件/zen 随态文案/文件 URL 五处逐字沿用）。
- 为箭头/菜单引入新图标字体或 emoji 字形；只用现有文本字形（▾ ▸ ✓ ✎ ✕ ＋ 之中取用，▾ ▸ 均已在用）。

## 3. 议题一：左端融合全局菜单

### 3.1 组件结构

| 现组件 | 处置 | 新组件 |
|---|---|---|
| `TabBarActions.svelte` | **退役**（＋/⋯ 双触发钮 + 双浮层结构随之消失） | `TabBarMenu.svelte`（单触发钮 + 单浮层 + 子菜单） |
| `WorkspaceSwitcher.svelte` | **退役**（触发钮/narrow 重锚/独立浮层机制随之消失） | 工作区管理 UI 抽取为 `WorkspaceList.svelte`（列表 + 行内重命名 + 删除 + ＋新建入口 + WorkspaceCreateModal 挂载随迁） |
| — | — | `manualRefresh`（tabStore 直连）迁入 TabBarMenu；hidden file input 常驻挂载语义保留（菜单收合不丢） |

TabBar props 变更：`oncycletheme` → `onsettheme(mode: Settings['themeMode'])`（主题改三显式项子菜单，轮换语义退役）；`themeMode/onsettings/onmounts/zen/onToggleZen` 原样透传。

挂载结构约束（builder check 核实项）：WorkspaceCreateModal 须挂在**浮层 `{#if}` 之外**（随组件体常驻 `createOpen` 条件挂载，WorkspaceSwitcher 现行为同构）——放浮层内会因「新建工作区先关菜单」把模态连带卸载；快捷键提示维持 title 承载（设置 Ctrl+, / 目录管理 Ctrl+Alt+M / 专注 Ctrl+Alt+Z 五处红线 title 本就带），菜单条目不加可见快捷键后缀；**「管理面板」不进融合菜单**（右端 ▾ 专职，Alt+W 不变；视觉稿「共同默认」句中的「管理面板 Alt+W」不构成菜单条目要求）。

### 3.2 菜单数据面与交互（B 方案：首层 8 行 + 点击展开子菜单）

首层条目（序固定）：

1. **工作区 ▸**——子菜单：工作区列表（点击切换；行尾 ✎ 重命名行内表单 / ✕ 删除带 confirm，现有交互逐字保留）+「＋ 新建工作区…」（关菜单 → 开 WorkspaceCreateModal，现行为同款）。
2. **打开 ▸**——子菜单：打开文件…（filechooser）/ 打开文件夹…（showDirectoryPicker + 既有 fallback）/ 粘贴 URL…（行内单行表单就地展开，提交后展开行收起、菜单保持开）。
3. **↻ 刷新当前文件**——直动作，aria-label/title 逐字沿用。
4. **连接服务器…**——直展开行内 `ServerConnectForm`（连接成功收起整个菜单，现行为同款）。
5. **主题 ▸**——子菜单三显式项「跟随系统 / 亮 / 暗」，当前项 ✓ 前缀（TabContextMenu ✓ 先例），选择即应用并收菜单。
6. **目录管理**——title/aria 逐字沿用。
7. **设置**——title/aria 逐字沿用。
8. **专注模式**——文案随 zen 态（专注 / 退出专注），title/aria 逐字沿用。

子菜单机制：**就地手风琴（用户拍板，builder check 后复核）**——点击父项在菜单体内就地展开/收起子项区（菜单体随之变高），父项 `aria-expanded` 翻转、字形 ▸→▾ 随态；同刻至多一个子菜单展开（组件内单状态 `sub: 'ws'|'open'|'theme'|null`）。点击展开语义沿用 TabContextMenu children 先例（非 hover），但**渲染不取其飞出面板**（`.vv-tabctx-sub` 定位飞出不适用：子项含表单——粘贴 URL 行、工作区重命名行内表单——窄飞出面板局促，且 375px 视口需溢出翻转数学；手风琴子项享全宽，移动端友好）。鼠标/触屏同一交互，无双轨。

### 3.3 浮层机制（关闭通道 / 互斥 / 覆盖层注册）

- 定位沿用 `.vv-tbact-pop` 的 chrome 菜单模式：fixed + 开合时从触发钮 rect 一次估算收敛（POP_EST 思路随迁，按新内容重估尺寸）。
- 关闭通道：外点 `pointerdown` + **容器 `onkeydown` Esc**（`.vv-tbmenu-pop` 上，appShellZenEsc I-2 合成 Esc 契约形态逐字保留）+ window 兜底（target 在浮层外的 Esc）。无 scroll-close（fixed 不随横滚失锚，现行裁决）。
- 与 `.vv-tabctx`（tab 右键菜单）同刻至多一个：由双方外点 pointerdown 关闭器自然合成（TAX-14 语义不变，仅类名随迁）。
- AppShell `OVERLAY_SELECTOR`（AppShell.svelte ≈L618-631）：`.vv-tbact-pop` → `.vv-tbmenu-pop`；`.vv-ws-pop` 条目删除（子菜单随宿主浮层同生命周期，无独立关闭态）。
- 浮层 `oncontextmenu` stopPropagation + 非输入元素 preventDefault 守卫随迁（壳层布局菜单防叠入；重命名框/URL 框保留原生粘贴菜单）。
- **浮层超高策略**：`.vv-tbmenu-pop` 设 `max-height: min(视口高 − top − 8px, 内容高)` + 内部 `overflow-y:auto`（该内部滚动条不隐藏，属面板滚动非 tab 条）；子菜单展开/收起时重估高度并重新收敛 top（`$effect` 依赖 `sub` 状态）。移动端 667px 高、矮窗下工作区列表 + 行内表单叠加展开必然触顶，此路径必须实装并进 e2e（mobile project 触达流依赖它稳定）。

### 3.4 触发钮与 DOM 契约

- 触发钮：class `.vv-tbmenu-trigger`，**aria-label=「切换工作区」逐字保留**（e2e 直点面最宽，裁决：按钮首要内容仍是工作区名，语义不撒谎）；`aria-expanded` 随菜单态；title 改「工作区与全局功能菜单」（实现期盘点直点 title 的锚，若存在则随迁）。
- 按钮文本恒为 `${activeWorkspace?.name ?? '工作区'} ▾`（**narrow「工作区 ▾」分支退役**——单按钮形态下工作区名不再让位）；宽度上限 `min(40vw, 16em)` + ellipsis（原 16vw 上限是四件共存的历史值）。
- 容器：`.vv-tabbar-actions` → **`.vv-tabbar-menu`**（`flex:none` + `border-right` 分隔语义不变）。
- 工作区列表条目类名**零变更**：`.vv-ws-item/.vv-ws-name/.vv-ws-actions/.vv-ws-act/.vv-ws-rename/.vv-ws-new` 原样保留（t-workspace/b-wsx-recovery 消费）；退役类仅 `.vv-ws/.vv-ws-trigger/.vv-ws-pop(.narrow)`。
- `.vv-wscreate` 的 `visibility:visible` 逃生门规则继续生效（Modal 新宿主仍在 chrome-off 潜在继承域内，机制不变）。
- 浮层/条目新类：`.vv-tbmenu-pop` / `.vv-tbmenu-item` / 行内表单行 `.vv-tbmenu-row` / 子菜单容器 `.vv-tbmenu-sub`；样式全部走 `docs/design/ui-design-system.md` 令牌（chrome 菜单观感对齐 `.vv-tabctx`/`.vv-chromemenu`）。

### 3.5 触控目标（≤600px 档）

菜单条目 padding 使触控高 ≥32px（§6.4/§10-G1 惯例，随 `--vv-ui-font-size` 联动恒过线）；触发钮 padding-block 8px 档随迁（原 `.vv-tabbar-actions .vv-tbact` 规则改挂新类）。

## 4. 议题二：tab 条优雅滚动

### 4.1 滚动条隐藏

`.vv-tabbar-tabs` 增 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`；`overflow-x:auto` 保持（触屏原生滑动/动量不受影响）。

### 4.2 滚轮横移

- `onwheel`：`|deltaY| > |deltaX|` 时 `scrollLeft += 归一(deltaY)` 并 `preventDefault`（横向分量放行原生）；`deltaMode===1`（行）按 ~16px/行归一。
- 监听须可 `preventDefault`（元素级非被动；若走 Svelte 委托路径需核实可阻断，不可则手动 `addEventListener(..., {passive:false})`）。

### 4.3 悬浮箭头（A 方案：不占布局空间）

- 形态：24×24 圆钮（背景 `--ui-tab-bg`、1px 边框、`--vv-shadow-2`、字形 ◂/▸）absolute 定位居中于滚动区两端，z 于 tab 之上；同侧 48px 渐隐遮罩（`linear-gradient` → `--ui-tab-bg`，`pointer-events:none`）。
- **结构约束**：箭头/遮罩的 absolute 锚不得置于 `.vv-tabbar-tabs`（滚动容器）内部——会随 `scrollLeft` 位移。外包一层 `position:relative` 容器（如 `.vv-tabbar-tabs-wrap`）包住滚动容器与两组箭头/遮罩。
- 可见性：左钮 `scrollLeft > 1`；右钮 `scrollLeft + clientWidth < scrollWidth - 1`。不可滚方向整钮+遮罩不渲染（`{#if}`）。
- 重算触发面：scroll 事件（passive）+ ResizeObserver（容器）+ `$effect` 依赖 `tabs`（长度/徽标/图标态变更即重算）+ window resize。
- 行为：**单击** = `scrollBy({left: ±clientWidth*0.8, behavior:'smooth'})`；**按住** = 350ms 延迟后进入 ~80ms 步进连滚（小步 `auto`），pointerup/pointercancel/leave 即停；连滚已发生时抑制随后的 click 补滚。
- a11y：aria-label「向左滚动标签」「向右滚动标签」；title 同文；出现时 Tab 可达（focus-visible 全局环生效）。

### 4.4 激活 tab 自动滚入

`$effect` 跟踪激活 tab id：容器内 `[role=tab].active` → `scrollIntoView({ inline:'nearest', block:'nearest', behavior:'auto' })`（instant 裁决：避免平滑动画与连续点击/拖拽重排竞态，e2e 稳定优先）。树/快 открывание等一切 `activateTab` 通道自动获益。

### 4.5 拖拽边缘自动滚（native-first）

先以探针核实浏览器对 `overflow-x:auto` 容器的原生 dnd 自动滚（Chromium 通常自带）；不足处补手工实现（`ondragover` 内 36px 边缘带判定 + rAF 步进，dragleave/leave/drop/dragend 清理）。**计划期先验证再决定是否写码**，避免冗余机制。

## 5. 议题三：管理钮 ▾ 化

- `.vv-tabbar-manage` 类名/槽位/`data-vv-wspanel-trigger`/`aria-label="管理标签"`/`title="管理所有工作区的标签（Alt+W）"` 全部不变；**仅可见文本「管理」→ 字形「▾」**，font-size 对齐簇内图标钮档。
- 实现期盘点 `getByText('管理')` 精确文本锚（区别于「目录管理/管理标签」等子串）并随迁。

## 6. 测试与验收锚

### 6.1 存量迁移清单（rg 盘点基线，命中数为选择器/文案出现次数）

| 文件 | 处置要点 |
|---|---|
| `e2e/tabbar-actions.ts`（helper，5） | **重写为 `tabbar-menu.ts`**：`openMenu`（点触发钮）+ `openSubmenu('ws'\|'open'\|'theme')` 两步流；`plusOpenFile/Folder/Url`、`overflowConnectServer` 改经新流；导出名保持语义对应，import 行机械随迁 |
| `b-wsx-recovery.spec.ts`（10） | `.vv-ws-pop` → 子菜单容器；触发钮作用域 `.vv-tabbar-actions .vv-ws-trigger` → `.vv-tabbar-menu .vv-tbmenu-trigger`；列表条目类名零迁移 |
| `t-workspace.spec.ts`（7） | 同上；新建/重命名/删除流经子菜单两步点击 |
| `t-shell.spec.ts`（6） | ＋/⋯ 触发流 → 单菜单流；「主题：跟随系统」行 → 主题子菜单项断言 |
| `b-layout-zen.spec.ts` / `b-layout-zen-deep.spec.ts`（6+2） | temp 条内菜单触达；ZenEsc 合成 Esc 通道类名随迁 |
| `t-tab-actions.spec.ts`（5）/ `b-tab-actions-enrichment.spec.ts`（3） | TAX-14 互斥锚 `.vv-tbact-pop` → `.vv-tbmenu-pop`，语义不变 |
| `t-theme.spec.ts`（4）/ `b-theme-system.spec.ts`（1） | 主题三态经子菜单 |
| `b-filetree-src-remove.spec.ts`（4）/ `b-settings-center.spec.ts`（3）/ `settings-center.ts`（1） | 打开/设置触达流随迁 |
| `b-wscreate-outside-close.spec.ts`（2） | 新建模态外点关闭（宿主组件变更，机制不变） |
| `mobile.spec.ts` / `b-sidebar-roots.spec.ts` / `b-md-lightbox-export-deep.spec.ts` / `b-md-diagrams-deep.spec.ts`（各 1） | 触达点随迁 |
| `src/lib/appShellZenEsc.test.ts`（单测） | I-2 源码正则锚：`WorkspaceSwitcher.svelte` 的 `.vv-ws-pop` 容器 Esc → `TabBarMenu.svelte` 的 `.vv-tbmenu-pop` 容器 Esc（形态逐字对应）；`readSrc` 路径随迁 |
| `src/lib/settingsCenter.test.ts` / `appShellZenToast.test.ts` / `mountsManagerUi.test.ts`（单测） | 三者同样 `readSrc('src/lib/TabBarActions.svelte')` 断源码契约（设置接线 / zen 专注入口文案 / 目录管理锚，builder check 补漏）——退役即红，随迁读 `TabBarMenu.svelte` 并按新形态改锚正则 |

### 6.2 新增覆盖（新域 `b-tabbar-menu`，域文档 `docs/e2e/tabbar-menu.md`）

- 融合菜单全条目触达矩阵（8 首层 + 3 子菜单 + 行内表单两处）。
- 子菜单点击展开/收起/同刻至多一个；Esc（物理+合成）/外点关闭零残留。
- 箭头可见性随滚动翻转（seed 足量 tab）、单击滚动位移、按住连滚、滚轮横移（mouse.wheel）、激活远端 tab 自动滚入可视区、触屏滑动（mobile project 抽查）。
- 管理 ▾ 触发面板（aria 锚，形态变更回归）。
- TAX-14 互斥随迁用例双绿。

### 6.3 门禁

typecheck 0E（仓库根 tsc -b + apps/web svelte-check）/ vitest 全绿 / playwright 默认 + mobile 双 project 全量零翻转 / 新域绿。`git status --porcelain` 收尾必须为空（B6 教训：门禁前硬核未提交残留）。

## 7. 实现顺序与 commit 划分

存量子集随迁**前移进 commit 1**（builder check Q3 裁决：commit 1 退役 TabBarActions/WorkspaceSwitcher 并改 OVERLAY_SELECTOR 的瞬间，约 40+ 存量用例即锚死变红——「随迁留到 commit 4」会出现中间 commit e2e 红窗，违反仓库每步门禁绿文化）：

1. `feat(web)` **原子迁移域**：TabBarMenu + WorkspaceList 抽取，TabBarActions/WorkspaceSwitcher 退役，类名/OVERLAY_SELECTOR 随迁，helper `tabbar-menu.ts` 重写，全部存量受影响 e2e（§6.1 清单）与四个源码契约单测随迁（语义等价迁移，不放宽断言）。commit 终态全量绿。
2. `feat(web)` tab 条滚动三件：滚动条隐藏 + wheel + 悬浮箭头 + 连滚 + 激活滚入（含 wrapper 结构）；配套用例随本 commit 加入；drag native 探针在此步验证，不足再补手工实现。
3. `feat(web)` 管理 ▾ 化（小步；`getByText('管理')` 类文本锚随迁，如无则零测试变更）。
4. `test(e2e)` 新域 b-tabbar-menu 全量场景 + 域文档 `docs/e2e/tabbar-menu.md` + 受影响 docs/e2e 场景行随迁（tab-actions-enrichment.md TAX-14 行、sidebar-shell-actions.md 提及簇的行）。

每 commit 终态定向+受影响域门禁绿（typecheck + 定向 vitest/e2e），终局全量门禁（§6.3）。

## 8. 已定裁决（用户拍板 / 我的裁量）与留给实现者的空间

**用户拍板**：按钮显示「工作区名 ▾」；菜单 = B 子菜单收纳；**子菜单 = 就地手风琴**（builder check 揭出飞出/就地歧义后复核拍板）；tab 箭头 = A 悬浮式；不留 ＋ 快捷钮。

**我的裁量（可在实现期以更优方案推翻，需在 plan 中记档理由）**：aria-label 保留「切换工作区」；narrow 分支退役、宽度上限 40vw；激活滚入用 instant；主题轮换退役改三显式项；连滚参数（350ms/80ms/80% 视宽）；浮层超高 = max-height+内部滚动+展开重收敛；存量子集随迁前移 commit 1；快捷键提示维持 title 承载；管理面板不进菜单。

**留给实现者**：POP_EST 新尺寸估算值；连滚参数微调；子菜单展开动画（默认无动画，可加 ≤120ms 高度过渡，不得引入布局抖动）；drag autoscroll 是否需要手工补（探针结论）；`getByText('管理')`/title 锚的个案处置。
