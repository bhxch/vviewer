# 壳层布局批：zen 目录入口 + 左栏目录 tab + 折叠按钮固定 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机

三项壳层诉求（用户 2026-11-12 提出，已拍板）：

1. **zen 模式下看目录**：当前 zen 把整个右栏（目录/属性/Git 三视图所在 aside）整体隐藏且无任何入口可达——这是 2026-10-19 layout-zen spec 的拍板语义（「双栏仅留内容」），但对阅读长文档的场景，zen 下失去目录导航是真实痛点。
2. **左栏加目录 tab**：目录视图只挂右栏；左栏（FileTree）无 tab 形态。用户要求左栏像右栏一样可切目录。
3. **折叠按钮固定**：两个折叠按钮随列表滚动（视觉上「在列表顶部而非侧栏固定位置」），滚动后失联。

## 2. 现状锚点（侦察实测）

- zen 覆盖语义：`chromeVisible(l)` zen 下 `{tabBar:false,left:false,right:false}`（`apps/web/src/lib/layout.ts:91-98`）；`enterZen/exitZen` 只翻 `zen` 字段（:71-78）。实际隐藏走 CSS：`.vv-shell.zen` 下 `.vv-side/.vv-right/.vv-strip/.vv-colhandle/.vv-collapse-btn/.vv-drawer-toggle/.vv-right-toggle` 全 `display:none`（`apps/web/src/app.css:426-431`）；TabBar 经 `vv-chrome-off` 平移出视口 + 顶边 8px 热区唤回（app.css:391-395/:418-419，AppShell:1281-1296）。
- 右栏视图互斥：`rightView: 'toc'|'meta'|'git'`（AppShell.svelte:159）+ `rightViewTouched` 台账旗标（:161）；默认落位 effect「有目录数据→toc 否则 meta」（:244-247）；切换器 `.vv-right-switch`（:1413-1448）；渲染互斥 `outlineDefinitions.length>0 → OutlineView，否则 tocEntries>0 → Toc，否则 MetaPanel`，git 单独分支（:1450-1481）。会话态不持久化（注释 :152-158）。
- toc 数据面：md TOC 经 `getToc()`（packages/vviewer-markdown/src/markdownRenderer.ts:649）→ ViewerPane `ontoc` 上行（ViewerPane.svelte:1019-1021）→ AppShell `tocEntries`（:146）；code outline 经 tags.scm → `getOutline()`（renderCode.ts:634）→ ViewerPane 250ms 轮询（:434-449）→ `outlineEntries`（:151）→ 引用过滤 `outlineDefinitions`（:190）。两者实例互斥不同时有数据。滚动跟随两条独立通道（Toc 内 IO / metaStore 总线二分，AppShell:267-299）。
- 左栏结构：`<aside class="vv-side">`（AppShell:1327-1357）只有抽屉头（≤900px）、折叠钮、FileTree 或空态引导区；**无 tab 形态**。
- 折叠按钮「随列表滚动」根因：左钮 AppShell:1335-1336、右钮 :1403-1404 均为 aside 直接子元素；CSS `position:absolute; top:6px; right:6px`（app.css:362-367）；而两个 aside 自身就是滚动容器（`.vv-side{overflow:auto}` AppShell:1566、`.vv-right{overflow:auto}` :1582）——overflow 容器内 absolute 子元素随内容滚动。既有让位逻辑：FileTree 源行 `padding-right:34px`（FileTree.svelte:110-121）、右栏切换器 `padding: 6px 34px`（app.css:728-735）。
- 折叠竖条：`leftCollapsed/rightCollapsed` → 28px `.vv-strip`（AppShell:1318-1326，app.css:353-358）。
- 断点显隐分段：基类隐藏，≥601px 放开右钮、≥901px 放开全部（app.css:349/:369-383）；≤600px 右栏进抽屉、左栏抽屉化。

## 3. 拍板（用户 2026-11-12）

- **zen 目录**：「增加按钮，可打开左侧或者右侧栏，但是只保留目录」——zen 下新增入口按钮，点击可打开左栏或右栏，打开的栏**只显示目录视图**（左栏不显示文件树、右栏不显示属性/Git）。
- **左栏目录 tab**：「左侧栏也可以像右侧栏一样有 toc tab」。

## 4. 设计

### 4.1 左栏 tab 化（非 zen 常态功能）

- 左栏头部新增切换器，形态对齐右栏 `.vv-right-switch`（segmented 两钮：树 | 目录），`leftView: 'tree'|'toc'` 会话态（不持久化、不进快照，镜像 `rightView` 语义：未 touched 时默认 'tree'）。
- 目录钮显隐门与右栏同源：`tocEntries.length>0 || outlineDefinitions.length>0`；无目录数据时不显示目录钮（左栏保持纯树）。
- 目录视图渲染**抽共享组件**（现 Toc/OutlineView 的装配逻辑从 AppShell 右栏分支提出，左右两处复用同一组件入参：tocEntries/outlineDefinitions/跳转回调）。目录视图内互斥规则与右栏一致（outlineDefinitions 优先）。
- FileTree 仅在 `leftView==='tree'` 渲染；切到 'toc' 时 FileTree 可保留 DOM 但隐藏（裁量：保 scroll 位置，倾向 `hidden` 保留实例——快照/滚动恢复面改动最小）。
- ≤900px 抽屉形态下同样可用（抽屉头下方挂切换器）；右栏不动。

### 4.2 zen 目录入口

- zen 下内容区显示两枚浮钮（左缘/右缘中部，44px 触达，视觉对齐 `.vv-zen-exit` 半透明浮钮先例，app.css:1768-1789），左钮开左栏、右钮开右栏；再点或 Esc 关闭。
- 打开的栏**锁定目录视图**：zen 打开左栏 → 左栏强制 'toc'（FileTree 隐藏、切换器隐藏）；zen 打开右栏 → 右栏强制 'toc'（属性/Git/切换器隐藏）。关闭后回到原 zen 覆盖态。
- 实现形态（裁量）：zen 打开态是 **UI 会话态不入 settings**（推荐放 AppShell 内 `$state`，如 `zenSide: 'none'|'left'|'right'`；不进 layout.ts/快照）。CSS 侧 zen 隐藏规则按 `zenSide` 条件放行对应 aside（如 `.vv-shell.zen[data-zen-side="right"] .vv-right { display:flex }`），对应栏内的属性/Git/切换器/树单独隐藏。
- Esc 优先级接线：`zenEscAction`（layout.ts:110-114）状态机扩展一档——先关 zen 打开的栏，再退 zen；移动端返回键 `zenPopAction`（:126-131）同步。
- zen 打开态下该栏不参与宽度拖拽（把手维持隐藏）；打开的栏为固定舒适宽度或沿用各自 clamp 现值（裁量）。

### 4.3 折叠按钮固定

两 aside 改结构为「固定 header 行 + 滚动体」：

```
aside (flex column, 不滚动)
├─ header 行（不滚动）：折叠钮 + （右栏）目录|属性|Git 切换器
└─ 滚动体 div（overflow:auto）：FileTree / Toc / MetaPanel / …
```

- 左栏 header：桌面=折叠钮（+可选 leftView 切换器同行，裁量）；≤900px=抽屉头（含专注模式钮）与折叠钮同行。
- 右栏 header：切换器 + 折叠钮同行（现切换器 `padding-right:34px` 让位与 FileTree 源行 `padding-right:34px` 让位**随之退役**，回归常规 padding）。
- 备选方案（sticky）不采用的理由：sticky 在 overflow 容器内依赖流内位置，需保持按钮为滚动体首子元素，边界情况（空态引导区、视图互斥切换）更脆；header 行改动面虽大一次到位。
- 断点显隐分段、`.vv-strip` 折叠竖条、拖拽把手（`.vv-colhandle` 挂 aside 外缘，不动）维持现状。

## 5. 目标 / 非目标 / 反目标

- 目标：zen 下可达目录；左栏可切目录；折叠钮不随滚动；既有让位 padding 退役。
- 非目标：zen 覆盖语义本身不变（`chromeVisible` 不回退）；右栏/左栏宽度设置项不变；快照恢复不含 leftView/zenSide；不新增设置字段。
- 反目标：为 zen 目录引入持久化状态或新的全局快捷键层（浮钮+Esc 足够）；把切换器做成下拉/浮层形态（保持 segmented 与右栏对称）。

## 6. 验收锚点

- e2e 新增：①左栏切 树|目录 且两侧数据互斥正确（打开 code 文件 outline 优先）；②zen 开左/右栏（栏内仅目录、Esc 两段退出）；③滚动 FileTree/右栏列表后折叠钮包围盒不变（SRC-03 式断言）；④切换器与折叠钮不重叠。
- 既有锚不翻转：b-layout-zen（LZ-01~15）、SRC-03 包围盒、右栏切换器既有用例（padding 断言如涉及 34px 需随之更新）。
- 单测：layout.ts zenEscAction 新档状态机；无 settings/schema 改动。

## 7. 留给 builder 的裁量

- 左栏 header 行内切换器与折叠钮的排布；zen 浮钮具体视觉与位置（避开 `.vv-zen-exit` 与状态栏）；zen 打开栏的宽度策略；FileTree 隐藏 vs 卸载；共享目录组件的拆出形态（新组件文件 vs 复用现有 Toc/OutlineView 直挂）。

## 8. builder check 订正与落定（2026-11-13）

- **移动端（≤900px）zen 目录入口**（builder check 提出，落定）：复用抽屉状态机通道——zen 下浮钮点击=打开对应侧抽屉，抽屉内锁定目录视图（树/属性/Git 隐藏）；`zenPopAction` 新档=先关抽屉再退 zen，zenGuard 在抽屉关闭后重新 arm。桌面通道（§4.2 flex 放行）与移动通道按既有断点分流。
- **zen 浮钮显隐门**（落定）：与右栏切换器目录钮同语义——`tocEntries/outlineDefinitions` 皆空时两侧浮钮都不显示（无目录数据不开空栏）。
- **zen 打开的栏内折叠钮**（落定）：隐藏——避免 zen 临时栏触发 `leftCollapsed/rightCollapsed` 持久化写入造成退出 zen 后栏不可达。
