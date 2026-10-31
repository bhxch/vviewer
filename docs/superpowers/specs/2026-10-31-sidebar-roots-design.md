# 侧栏多根形态统一 + 重叠 bug 修复 + tab 徽标消歧设计

- 日期：2026-10-31
- 状态：已批准（brainstorming 六需求批量立项之一）
- 上游：`2026-10-11-workspace-tabs-design.md`（workspace 多根模型）、`2026-10-19-layout-zen-design.md`（折叠钮）

## 1. 背景与动机

侧栏（FileTree）对「工作区含 0/1/多个目录」三种状态的处理均有缺口：

1. **源头行**：每根目录一行 `label + ✕`（`FileTree.svelte:60-76`），无折叠、✕ 恒显。
2. **重叠 bug**（用户报）：第一个目录打开后，删除按钮与侧栏折叠按钮重叠。根因已定位——左栏折叠钮 `.vv-collapse-btn.vv-collapse-left`（`AppShell.svelte:1021-1022` 渲染，`app.css:286-295`）是 `position:absolute; top:6px; right:6px; width/height:24px` 的命中区，而侧栏内容流第一行就是源头行、其 ✕ 靠行尾右缘（`FileTree.svelte:98-108`），恰好落在折叠钮命中区之下；桌面断点下 `.vv-drawer-head` 隐藏（`AppShell` style 块 L117-119）不垫高首行，重叠必现。
3. **0 目录空态**：仅一句纯文案「未打开文件夹」（`AppShell.svelte:1028-1030`），无任何引导入口。
4. **tab 徽标拥挤**（用户报）：现行规则「当前工作区登记来源 ≥2 即显示来源徽标」（`tabBadge.ts:14-20` `badgeOf`，文本 = 匹配 storeId 的 `src.storeLabel`），不看是否真有歧义。

用户拍板：单/多目录统一保留源头行；空态做引导区；徽标只在同名冲突时显示。

## 2. 设计

### 2.1 源头行统一形态（单/多目录一致，已定）

`.vv-tree-src` 升级为三段式：**chevron + label + hover ✕**

- chevron（▾/▸）：折叠/展开该源整棵树（`.vv-tree-group` 隐藏）。折叠状态为 FileTree 组件局部 state（per storeId，Map），**不持久化**（会话快照零新增）。生命周期注记（builder check 收敛）：FileTree 处于 `{#key treeKey}` 内（AppShell `:485-487`、`:1025`），任一所涉源刷新即整树重建、折叠态随之重置——与 TreeNodeRow 行展开态丢失为同一生命周期（有先例的现状），知情接受。
- ✕ 改 hover 显（`opacity: 0→1`，`.vv-ws-actions` hover 先例 `app.css:368-370`）；confirm 语义不变。键盘可达性：hover 显隐不得移除可聚焦性（`:focus-visible` 强制显 + focus-within 豁免）。
- 源头行加 folder 图标位（spec 图标主题的 tree 消费点之一，`2026-10-31-icon-themes-design.md` §3.3；无主题时占位零宽）。
- 树行 `TreeNodeRow.svelte` 不动（折叠仍为行级 caret 逻辑）。

### 2.2 重叠修复（builder 裁决方向已定）

修法取**行右让位**：`.vv-tree-src`（或 `.vv-side` 首个子元素）`padding-right: 34px`（24px 折叠钮 + 10px 间隙），✕ 不再进入折叠钮命中区。备选（折叠钮改位/源行改结构）留实施者权衡，验收锚 = 桌面断点下首个源头行的 ✕ 与折叠钮命中区无几何重叠（playwright 元素包围盒断言）。移动端 ≤900px 折叠钮不渲染（既有 `@media (min-width:901px)` 门控），无此问题。

### 2.3 0 目录空态引导区（已定）

`AppShell.svelte:1028-1030` 纯文案升级为引导区：

```
未打开文件夹
[ 打开文件夹 ]     ← openDirectoryViaPicker
[ 连接服务器 ]     ← ServerConnectForm 内联展开（spec 顶栏退役抽取的共享组件）
[ 粘贴 URL    ]    ← 内联单行输入行 → openUrl
提示：也可直接拖入文件/文件夹
```

- 动作与 TabBar `[＋]`/`[⋯]` 完全同源（同一批 façade 函数：`openDirectoryViaPicker`/`connectServer`/`openUrl`）；「连接服务器」点击就地展开 `ServerConnectForm.svelte`——**共享组件在本 spec 落地抽取**（builder check 时序收敛：本 spec 先行，顶栏 spec 消费同一组件，见其 §2/§6）。
- 视觉遵循 ui-design-system（空态区居中、按钮体系、提示用 hint 层级）。
- 「打开文件夹」**不做禁用态**（builder check 收敛：`openDirectoryViaPicker` 已内建自动 fallback——`showDirectoryPicker` 不可用/被拒即走 `openDirectoryViaInputFallback`（`openFlow.svelte.ts:70-75` → `:135`），webkitdirectory 通道全环境可用；探测禁用反而构成功能回退），按钮恒可用。

### 2.4 tab 徽标消歧（已定，含对用户原话的解读）

`badgeOf`（`tabBadge.ts:14-20`）规则改为：**仅当「同名文件」同时存在于当前工作区的 ≥2 个不同来源时**，才为这些同名 tab 显示来源徽标（文本仍为 `storeLabel`）。

- 消歧域 = **工作区内多来源**（不是跨工作区）：tab 永远只属于一个工作区、TabBar 按 workspaceId 过滤显示，跨工作区同名不会同屏，无歧义可言。这是对用户原话「同名文件不同工作区」的解读，brainstorm 中已明示未被推翻。
- 判定输入需要全 tab 名册：`badgeOf(sources, tab)` 签名扩展（新增当前工作区全部 tab 的 `source.name` 列表或整个 tab 集合，从 TabCollection 取）。纯函数，单测覆盖：无冲突不显示 / 两源同名都显示 / 同源同名（不可能，storeId 去重）/ 目录 tab 参与消歧（同名目录跨源同样算冲突，一并消歧）。
- 例外抑制保留：remote 单文件来源且 label === 文件名时不显示（防同文重复，现行 `:18-20` 语义）。
- `title` 属性同步：显示徽标时 title = 来源 label（现状保持）；不显示时无 title 变化。
- 消歧基准名 = `tab.source.name` 原样比较（大小写敏感；路径不参与——同名同路径跨源时 storeLabel 本就不同）。

## 3. 触达面

`FileTree.svelte`（源头行/折叠）、`TreeNodeRow.svelte`（无改或微调）、`AppShell.svelte`（空态/折叠钮相关样式）、`tabBadge.ts` + `tabBadge.test`、app.css（源行/空态/hover 样式）、`TabBar.svelte`（badgeOf 调用点传参）。e2e：WSX 系徽标锚更新（来源 ≥2 不再恒显）+ 新锚（同名冲突显、折叠展开、空态引导三入口、重叠几何断言）。

## 4. 实施顺序

六 spec 中最小，建议**第一个**实施（先清 bug、减少与顶栏 spec 的 AppShell/TabBar 同域并行冲突）。
