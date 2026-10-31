# 顶栏退役：全局动作迁移 TabBar 左端按钮簇设计

- 日期：2026-10-31
- 状态：已批准（brainstorming 六需求批量立项之一）
- 上游：`2026-10-19-layout-zen-design.md`（chrome 显隐/边缘热区/临时条机制）

## 1. 背景与动机

TopBar（`apps/web/src/lib/TopBar.svelte`，414 行）承载 11 类全局元素：品牌字样、打开文件、打开文件夹、工作区切换器（含重命名/删除/新建）、URL 表单、连接服务器（含内联表单）、手动刷新、主题循环、设置、目录管理、zen 切换。spec 布局（2026-10-19）已给顶栏做了「右键隐藏 + 边缘热区唤出临时条」，但用户拍板更进一步：**消灭顶栏整行，全部动作转为按钮**。

关键布局事实：**TabBar 在零 tab 时也渲染**（`TabBar.svelte:291-298`「管理」按钮无条件渲染），是唯一常驻的全局按钮宿主；状态栏随活动 tab 消失（`ViewerPane.svelte:554-562` 条件渲染），不能独立兜底。用户拍板：**TabBar 左端固定按钮簇**。

## 2. 按钮簇布局（已定）

TabBar 左端新增固定按钮簇（不随横向滚动，与 tab 区分离）：

```
[工作区▾] [＋] [⟳] [⋯] │ ○a.md ●b.ts ○c.rs │      [管理]
```

- **`[工作区▾]`**：工作区切换器整块迁移。`.vv-ws` 现为 TopBar.svelte 内联实现（`:266-345` markup，`:48-56` 状态，`:76-113` 动作，`:147-180` 外点/Esc effect，`:132-139` ≤600px narrow 断点），**抽独立组件 `WorkspaceSwitcher.svelte`** 后挂 TabBar。依赖随行（侦察已核清单）：`openFlow.svelte` 的 `tabStore/closeTab/workspacesView`、`workspaceStore`（setActive/rename/remove/ensureNonEmpty）、`WorkspaceCreateModal` 挂载、narrow 断点与两个 effect（自包含，无 AppShell props 耦合）。弹层内容（切换/✎ 重命名/✕ 删除/＋ 新建）一字不动。
- **`[＋]`**：弹小菜单「打开文件 / 打开文件夹 / 粘贴 URL」。打开文件复用既有 hidden input 模式（TopBar `:263-264` 迁移 → `openFiles`）；打开文件夹 → `openDirectoryViaPicker`（`openFlow.svelte.ts:70`）；「粘贴 URL」选中后菜单内展开单行输入框（原 URL 表单 `:346-348` 收编）→ `openUrl`。浮层实现模式取 TabContextMenu 先例（fixed 定位 + 外点/Esc/滚动关闭收敛）。
- **`[⟳]`**：`manualRefresh()`（TopBar `:202-206` 迁移）。
- **`[⋯]`**：溢出菜单——连接服务器、目录管理（`onmounts`）、设置（`onsettings`）、主题循环（system/light/dark，`:371-373` 形态等价迁移）、专注/退出专注（zen，`:386-394` 文案随态）。其中**连接服务器**选中后菜单内展开既有表单（`.vv-server-form` `:351-370` 迁移为 `ServerConnectForm.svelte` 共享组件——**抽取归属侧栏 spec**（实施顺序先行者建组件，builder check 时序收敛），本 spec 仅消费同一组件，见 `2026-10-31-sidebar-roots-design.md` §2.3）。
- 品牌字样（`span.vv-brand`，`:262`）删除。
- 按钮簇视觉遵循 `docs/design/ui-design-system.md`（按钮体系/交互状态/4-8 栅格）；窄屏 ≤600px 各浮层沿用 narrow 形态惯例。

## 3. 顶栏机制退役清单

| 退役项 | 位置 | 处置 |
|---|---|---|
| TopBar 组件与渲染点 | `AppShell.svelte:974-979` | 组件删除 |
| 顶边热区 `data-edge=top` | `AppShell.svelte:960-965`（10px） | 删除（tab 条自身热区 8px 保留） |
| chrome 菜单「隐藏/显示顶栏」项 | `AppShell.svelte:1121-1141` | 菜单只剩 tabbar 项 + zen 项 |
| `layout.topBarVisible` 字段 | `layout.ts:10-18`（类型/默认值）、`:97`（chromeVisible）、`LayoutSection.svelte:46-55`（开关）、`AppShell:381-382`（翻转）、`:950/:969/:1133`（消费） | 字段删除；`sanitizeLayout`（`layout.ts:52-64`）白名单外静默丢弃 → 旧 localStorage 快照零迁移 |
| temp 通道顶栏槽位 | `AppShell:213-238` 接线、`tempBar.ts` 的 top 语义 | `TempBarVisibility` 机制保留但收敛为 TabBar 单槽（四象限组合矩阵收缩为 tab 条一维；`tempBar.ts` 槽位实现按实况收敛） |
| `.vv-topbar` 系样式 | `app.css:339`（flex）、`:301-311`（chrome-off/temp 形态的顶栏部分）、`:441`（brand） | chrome-off/temp 样式本身保留（tabbar 继续消费），仅删 topbar 专属段 |
| zen 对顶栏的覆盖语义 | AppShell zen 各处 | zen 覆盖全部 chrome 不变；zen 期间临时条通道对 TabBar 照旧（Esc 退出 + 右键退出） |
| 移动端窄屏 TopBar 形态 | TopBar `:407-413` scoped 样式、narrow 收敛 | 随组件退役；移动菜单/抽屉既有通道不动 |

- `applyAppearanceFromSettings` 订阅现挂 TopBar（`TopBar.svelte:116/120-131`）——迁移到 TabBar 或 AppShell 层（builder 裁决，语义不变：settings 变更 → 外观重应用）。
- `WorkspaceCreateModal` 条件挂载随 WorkspaceSwitcher 走。

## 4. 连带文案与锚点

- `ViewerPane.svelte:533` 空态文案「拖入文件/文件夹，或使用顶栏打开」→「拖入文件/文件夹，或用标签栏 ＋ 打开」。
- 设置中心布局组的「显示顶栏」开关行删除（§3 表）。
- 文档面：README 操作说明中顶栏相关表述、`docs/design/ui-design-system.md` 涉顶栏组件的分组要点（若有）同步。

## 5. e2e 影响面（本 spec 最大工作量项）

全仓 e2e 大量锚点引用 TopBar 入口（打开文件/文件夹、连接服务器、工作区切换、设置、主题、zen），涉及 TAX/WSX/SC/LZ/HL/QO/MM 等多域。**计划期任务**：`rg 'vv-topbar|vv-ws|vv-server-form|vv-chromemenu' apps/web/e2e` 全量盘点，逐锚迁移到按钮簇新入口（选择器换 `.vv-tabbar-actions` 系新类名，动作语义不变）。新增锚：按钮簇零 tab 可用性、`[＋]`/`[⋯]` 菜单开合、连接服务器表单在新宿主工作、布局设置不再有顶栏开关。

## 6. 实施顺序

建议在 spec 侧栏（`2026-10-31-sidebar-roots-design.md`）之后实施：两者同域文件（AppShell/TabBar/app.css），侧栏 spec 更小先行可减少并行冲突面。`ServerConnectForm.svelte` 的抽取随**侧栏 spec** 落地（builder check 收敛：避免侧栏先行时组件尚不存在的循环依赖），本 spec `[⋯]` 菜单仅消费。
