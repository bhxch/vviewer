# 侧栏多根与壳层动作 e2e — 场景（SRC 域：源头行/空态引导/徽标消歧）

> 来源：spec `docs/superpowers/specs/2026-10-31-sidebar-roots-design.md`（§2.1 源头行统一形态 / §2.2 重叠修复 / §2.3 空态引导区 / §2.4 tab 徽标消歧）+ plan `docs/superpowers/plans/2026-10-31-sidebar-roots.md`（Task 4 SRC-01..04）。本文档为该域收册文档：既有 SRC-01..04 与 FTSRC-01..04 转录现状脚本，SRC-05..08 为测绘差距新增锚（徽标消歧四态 / 大小写敏感 / 单源统一形态 / hover 揭示完整链）。

## 1. 目的与来源

- **现状 e2e 文件**：`apps/web/e2e/b-sidebar-roots.spec.ts`（SRC-01 折叠 / SRC-02 键盘可达 / SRC-03 几何不重叠 / SRC-04 空态引导三入口）、`apps/web/e2e/b-filetree-src-remove.spec.ts`（FTSRC-01..04 源级移除全链 + hover 揭示显式锚 `:55-60`）、域文档 `docs/e2e/filetree-src-remove.md`。TabBar 右键菜单域另收 `docs/e2e/tab-actions-enrichment.md`（TA/TAX 系），空态引导与融合菜单同名条目同屏的定位隔离已由 SRC-04 备案（`b-sidebar-roots.spec.ts:116-118`：空态「连接服务器」与融合菜单「连接服务器」同名同屏，定位一律限定 `.vv-side-empty` 容器）——本域不再为 TabBar 按钮簇另立编号（原左端 `[工作区名 ▾][＋][↻][⋯]` 动作簇已随标签栏收敛退役为单触发钮融合菜单 `.vv-tabbar-menu`/`.vv-tbmenu-pop`，其域锚收册 `docs/e2e/tabbar-menu.md`）。
- **实现锚**：消歧纯函数 `apps/web/src/lib/tabBadge.ts:18-29`（`badgeOf(sources, tabs, tab)`：同名跨源才显 + remote 单文件例外抑制 + 大小写敏感严格 `===`）；徽标渲染 `apps/web/src/lib/TabBar.svelte:313`（`.vv-tab-src` 文本=storeLabel、`title={badge}`）；源头行三段式 `apps/web/src/lib/FileTree.svelte`（`.vv-tree-src-toggle` aria-expanded + label + `.vv-tree-src-remove` hover 揭示 `:144-148`、触屏 `@media(hover:none)` 恒显 `:152`）。
- **测绘差距**（本文档新增面）：SRC-01..04 零覆盖徽标消歧（spec §2.4 核心面，SRC-05/06）；单源形态与折叠收敛未布（SRC-01 只布双源，SRC-07）；hover 揭示只有「移除前 hover 显 1」半链（FTSRC 装置内断言，移出回 0 与触屏形态零锚，SRC-08）。

## 2. 场景清单

### 2.1 既有面（现状脚本已锚）

| 编号 | 落点 | 锚要 |
| --- | --- | --- |
| SRC-01 | `b-sidebar-roots.spec.ts:43` | 双源源头行 chevron 折叠——aria-expanded 翻转、该源 `.vv-tree-group` 收敛、他源不受影响 |
| SRC-02 | `b-sidebar-roots.spec.ts:72` | 移除钮键盘可达——行内 Tab 聚焦后 `:focus-within` 揭示（computed opacity=1） |
| SRC-03 | `b-sidebar-roots.spec.ts:88` | 桌面视口 `.vv-collapse-left` 与首个移除钮 boundingBox 手写相交判定不相交（行右让位 34px）；抽屉断点 skip |
| SRC-04 | `b-sidebar-roots.spec.ts:105` | 0 目录空态引导区：三入口可见可用、「连接服务器」就地展开 `.vv-server-form`、URL 行可见（不含真实连接） |
| FTSRC-01..04 | `b-filetree-src-remove.spec.ts` | 源级移除 confirm 接受/取消全链 + 同 label 二次注入路由回原组（裁决记档见 `docs/e2e/filetree-src-remove.md` §4） |

### 2.2 新增面（测绘差距锚）

| 编号 | 前置条件 | 步骤 | 期望 |
| --- | --- | --- | --- |
| SRC-05 | 双本地源注入：src-a 与 src-b 各含同名 `readme.md` 与异名文件；两组树行各开同名文件 tab | ① 读两 tab 的 `.vv-tab-src`；② 对照面：另一对异名 tab（a1.txt/b1.txt）读 `.vv-tab-src` 计数 | ① 双源同名 tab **都显**徽标：文本=各自 storeLabel（src-a / src-b）、`title` 属性=同值（来源 label，`TabBar.svelte:313`）；② 异名对 `.vv-tab-src` 计数 0（消歧语义：仅同名冲突才显，`tabBadge.ts:21-24`） |
| SRC-05/remote | SRC-05 装置 + 一条 remote 单文件来源（openUrl 通道打开与本地同名的 `readme.md`，空态引导区 URL 行或既有 openUrl 先例装置）；remote tab 与本地同名 tab 同屏 | 读两 tab 徽标 | **不对称抑制**（`tabBadge.ts:27`：remote 且 `path!==''` 且 label===name）：remote 单文件 tab 无徽标、本地同名 tab 徽标在场（对手冲突计数仍成立）。机制实况注（终审补记）：openUrl → `addTab(createUrlStore(url),…)` 不登记 workspace 来源（TabCollection.add 无 addSource 面，`tabsModel.svelte.ts:136`），url tab 经名册外 `src?.storeLabel ?? null`（`tabBadge.ts:25-26`）无徽标——`:27` 的 kind==='remote' 分支为**同象异因**，本锚未覆盖；真 remote 单文件源须 RemoteSourceModal「将此文件作为来源」通道（kind==='remote' 抑制分支 SRC 域零锚，另立项），防按本文措辞误判锚已覆盖 `:27` |
| SRC-05/dir | 本地源 `doc` 注入 + 假服务 remote **根目录源**同 label（FTSRC 装置/fake-file-server 同 label 构造）——两目录 tab（`path===''`，name=displayName）同名同屏 | 读两目录 tab 徽标 | 同名目录 tab 跨源同样消歧：双方均显徽标（remote 抑制仅文件 tab 形态，目录 tab `path===''` 不抑制——`tabBadge.ts:11-14` 注释口径） |
| SRC-06 | 双源注入：src-a 含 `A.md`、src-b 含 `a.md`（大小写异名）各开 tab | 读两 tab 徽标 | 双 tab 均**无**徽标（`.vv-tab-src` 计数 0）：消歧基准名 = `tab.source.name` 原样严格 `===` 比较（大小写敏感，spec §2.4 + `tabBadge.ts:22`），不构冲突 |
| SRC-07 | 单源注入（仅 src-a，含 1 文件） | ① 读源行结构；② 点击 `.vv-tree-src-toggle` 折叠 → 复点展开 | 单目录与多目录**统一形态**（spec §2.1）：单源源行同样有 chevron（aria-expanded='true' 初值）+ hover ✕（`opacity` 可揭示）；折叠后该源 `.vv-tree-group` 收敛（相邻兄弟组合器锚定，SRC-01 同款选择器）、aria-expanded 翻 'false'，复点恢复 |
| SRC-08 | 单源注入；桌面视口 | ① hover 源行 → 读 `.vv-tree-src-remove` computed opacity；② `page.mouse.move` 移出到树外空白 → 再读；③ 触屏形态备案 | ① hover 揭示 opacity '1'（`FileTree.svelte:147-148`）；② 移出回 '0'（`.12s` transition 后，`transition: opacity .12s` 容差 poll）；③ `@media(hover:none)` 恒显（`:152`）——desktop chromium 默认 hover:hover 环境断言不到该形态：`page.emulateMedia` 无 hover/pointer 特征位不可实现，CDP `setEmulatedMedia` 同类特征模拟经探针实证对 Blink 静默无效（matchMedia 不翻转），落脚本走 CDP `setTouchEmulationEnabled` 触屏模拟通道（matchMedia 自证翻转后断言恒显），不支持环境 skip 备案——skip 判定置 ①② 揭示/回零主链后（真 skip 先例 SRC-03 `b-sidebar-roots.spec.ts:100`；FTSRC `:55-56` 为注释口径无 skip 实装） |

## 3. 验收行为

- **SRC-05 消歧四态**是 spec §2.4 的行为级验收基准：恒显→同名冲突才显的翻转已有 `tabBadge.test.ts` 单测面（plan Task 1 用例集 1-8），e2e 面锁「真实 TabBar 渲染层」——徽标文本、title 属性、对手对称性、remote 抑制不对称、目录 tab 参与五点逐锚。回归护栏：`t-workspace` / `b-wsx-recovery` 的 WSX 徽标锚按消歧新语义零翻转（plan Task 4 Step 3 已随翻转逐锚更新）。
- **SRC-06**：大小写敏感为有意语义（消歧基准名原样比较），落锚防未来误改 casefold；回归护栏：SRC-05 同名面零翻转。
- **SRC-07**：单源统一形态防「多源专用 UI 漏单源分支」；折叠生命周期备案（`{#key treeKey}` 整树重建折叠态重置，spec §2.1 知情接受）不在锚内。
- **SRC-08**：揭示是 hover 门控完整链（显 1 / 移出回 0）；移除点击路径已由 FTSRC-01 覆盖，本锚不重复点击。键盘等价面归 SRC-02（既有）。
- **空态引导区回归护栏**：SRC-04 三入口面零翻转；「打开文件夹」恒可用（无禁用态，spec §2.3 拍板）不做负路径锚（headless 无法驱动 FS Access 原生对话框，`docs/e2e/README.md` §3.1 受限项；fallback 通道为 `openDirectoryViaInputFallback`，spec §2.3）。

## 4. 环境与数据

- **通道**：default 套件双 project；本地源注入 `__vvOpenDirImpl`（`b-sidebar-roots.spec.ts:27-40` openLocalDir 同构，label 决定 `localfiles:<label>` storeId）；空态用 Playwright 每用例新 context 零来源天然形态；remote 源走共享单根假服务 `fake-file-server`（FTSRC 装置），url 单文件来源走 openUrl 通道（quickopen/error-card 域既有装置）。
- **同 label 跨源构造**（SRC-05/dir）：localfiles 同 label 二次注入会路由回原组（FTSRC-04 裁决，`docs/e2e/filetree-src-remove.md` §4）——同名目录 tab 须 **local + remote 异 storeId 同 label** 构造，不能用双本地同 label；落脚本时以 fake-file-server 实际暴露的来源 label 为准核对 storeLabel 相等性。
- **移动端形态**：375px 树区在抽屉内——树行点击与徽标断言前 `openDrawerIfNarrow`/断言后 `closeDrawerIfOpened`（SRC-01..04 同款适配）；SRC-03 几何锚在抽屉断点 skip 既有口径不变。
- **数据清单**：src-a/src-b 两组最小目录（同名 readme.md + 异名 a1.txt/b1.txt + 大小写对 A.md/a.md），内容任意非空文本；无预置仓库资产依赖，构建前置仅 `pnpm --filter web build:e2e`。
