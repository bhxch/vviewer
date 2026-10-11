# 浏览器式 tab 管理动作 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右键菜单六动作（关闭/关闭其他/关闭右侧/固定/复制标签页/重新打开已关闭）、pinned 豁免语义、组内拖拽排序、Alt+Shift+T 撤销栈、中键关闭——全部作用于 workspace 组内。

**Architecture:** `TabCollection` 动作层（closeOthers/closeRight/pin/unpin/duplicate/dragReorder/reopenClosed + closedStack 内存栈）；`TabBar.svelte` 拖拽与右键/中键接线 + 自绘 `TabContextMenu.svelte`；E 项 workspace 模型之上——所有动作以 `tab.workspaceId` 限组。快照增 `pinned?`（数组序即组内序，恢复保序）。

**Tech Stack:** Svelte 5 runes（TabBar/菜单组件）、HTML5 drag & drop（桌面）、vitest（TabCollection 纯逻辑经既有测试模式）、Playwright（dragTo）。

**Spec:** `docs/superpowers/specs/2026-10-11-browser-tab-actions-design.md`

## Global Constraints

- **组内语义**：全部动作（含拖拽、撤销恢复落点）以 `tab.workspaceId === 当前活动组` 限定；跨组不泄漏。
- **pinned 语义**（VSCode 风格）：pinned 恒靠左成固定区（区内保持相对序）；普通 tab 不可拖入固定区（dragReorder 跨区拒绝）；**批量关闭（关闭其他/右侧）豁免 pinned**；单个关闭动作对 pinned 仍有效。
- **撤销栈**：内存 LIFO 容量 10（淘汰最旧）；**不持久化**（刷新即清）；恢复时若 tab 所属 workspace 已删除则落回当前活动组；`Alt+Shift+T`（`Ctrl+Shift+T` 被浏览器占用不可靠）。所有 close 路径（单个/批量/面板快捷关闭）统一经 `pushClosed` 入栈。
- **中键**：`onauxclick` button 1 = 关闭。
- **复制标签页**：同 source 新 tab 插入原 tab 右侧并激活（重新 read）；unrestorable 占位 tab 的「复制」置灰。
- **移动端（≤600px）**：不做拖拽（HTML5 dnd 无触屏支持）；右键菜单与 pinned 仍可用。
- **既有语义保持**：close 后组内邻位激活（E 项实现）；`add` 返回 $state 代理（BUG-69）；快照数组序 = 组内序。
- DOM 锚点：pinned tab `data-pinned` 属性 + `.vv-tab-pinned` 类（斜体/锁形图标）；菜单 `.vv-tabctx`（项 `.vv-tabctx-item`，禁用态 `[aria-disabled]`）；拖拽占位指示 `.vv-tab-dragover`。
- 中文注释讲 why；TDD；每任务独立 commit（Angular 中文 message）。
- 门禁：`pnpm test`、`pnpm typecheck`、svelte-check 基线不新增；e2e `t-shell.spec.ts` 回归 + 新增 `t-tab-actions.spec.ts`。

---

### Task 1: TabCollection 动作层（纯逻辑）

**Files:**
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（Tab.pinned、TabCollection 新方法、closedStack）
- Create: `apps/web/src/lib/tabActions.test.ts`（TabCollection 经 `.svelte.ts` 不可根 vitest 直测——**落点改为把可纯测的动作数学抽出**：见下）

**Interfaces:**
- Produces:
  - `Tab.pinned?: boolean`（不进 rev 机制）
  - `TabCollection` 新方法（全部组内、全部 persist、返回代理元素遵循 BUG-69 惯例）：
    - `closeOthers(tabId)`——组内除自身与 pinned 外全关（关闭动作统一经 `pushClosed`）；激活落点 = 原活动 tab 的最近存活邻位（组内）。
    - `closeRight(tabId)`——组内该 tab **右侧**的非 pinned 全关。
    - `pin(tabId)` / `unpin(tabId)`——置位 + 组内重排（pinned 区靠左、区内保持相对序；unpin 落普通区首位）。
    - `duplicate(tabId)`——同 source 新 tab 插入原 tab 右侧并激活（`add` 后把新 tab 从组尾 splice 到原位 +1；source 不可重建（unrestorable）时返回 null 不动作）。
    - `dragReorder(fromId, toId)`——组内重排；`toId` 落点按「插入到 toId 之前/之后」由 UI 传 `before: boolean`；跨 pinned 区边界拒绝（普通 → pinned 区内插入点截断到 pinned 区首之后的第一个普通位）。
  - 撤销栈（模块级，容量常量 `CLOSED_STACK_MAX = 10`）：
    - `pushClosed(snapshot: TabSnapshot & { workspaceId })`——所有 close 路径调用（单关/批量/面板）。
    - `reopenClosed(): Tab | null`——出栈：目标 workspace 存在 → 落回原组尾；已删除 → 当前活动组；unrestorable 占位也走此路径（与刷新恢复同语义：`addPlaceholderTab` 等价——openFlow 内已有该通道）。栈空返回 null。
  - **可纯测抽离**：重排/截断数学抽 `apps/web/src/lib/tabOrder.ts`（纯函数）：`reorderIds(ids: string[], fromId, toId, before, pinnedSet): string[] | null`（跨区拒绝返回 null）、`splitPinned(ids, pinnedSet): { pinnedIds, normalIds }`——vitest 直测；TabCollection 方法调用它再落 $state。

- [ ] **Step 1: 写失败测试**（tabActions.test.ts 针对纯函数 + workspaceStore 交互模拟）：

```ts
// tabOrder.test.ts 关键用例（语义锚）：
// - reorderIds 组内换位：[a,b,c] from=b to=c after → [a,c,b]
// - pinned 区边界：[p1,p2,n1,n2]（p=pinned）from=n1 to=p1 before → null（拒绝）
//   from=n1 to=n2 before → [p1,p2,n1,n2]？不——n1 插到 n2 前 = 原序；用 from=n2 to=n1 before → [p1,p2,n2,n1]
// - pinned 排序不变式：重排后 splitPinned 顺序 = pinnedIds(相对序) + normalIds(相对序)
// - 撤销栈（经 fake store 或直接测 openFlow 导出的栈辅助若可抽）：容量 10 淘汰、LIFO
//   （栈逻辑若在 .svelte.ts 内则抽 tabOrder.ts 同文件或独立 closedStack.ts 纯模块——实施者选最简并报告）
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（tabOrder.ts 纯函数 + TabCollection 方法接线；closeOthers/closeRight 遍历组内 `close` 或批量 splice + 逐个 pushClosed——**注意批量关闭时 releaseStoreIfLast 语义与逐个关一致**，复用现有 close 实现循环即可，性能非问题）
- [ ] **Step 4: 跑测试确认通过 + `pnpm test && pnpm typecheck`**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/tabOrder.ts apps/web/src/lib/tabActions.test.ts apps/web/src/lib/openFlow.svelte.ts
git commit -m "feat(web): tab 动作层——批量关闭/固定/复制/重排与撤销栈

why: 浏览器式 tab 管理动作的模型层（spec F §2.1）。
what: closeOthers/closeRight（pinned 豁免）/pin/unpin/duplicate/
dragReorder（跨区拒绝）+ closedStack（10 容量 LIFO）+ tabOrder 纯函数。"
```

---

### Task 2: TabBar 右键菜单/中键/pinned/drag 接线 + TabContextMenu 组件

**Files:**
- Create: `apps/web/src/lib/TabContextMenu.svelte`
- Modify: `apps/web/src/lib/TabBar.svelte`（draggable/oncontextmenu/onauxclick/pinned 态/拖拽占位指示）
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Consumes: Task 1 动作层。
- Produces:
  - TabContextMenu：props `{ x, y, tab, actions }`（actions = 六项闭包数组，由 TabBar 组装并传 disabled 态）；自绘浮层 `.vv-tabctx`——定位视口内收敛、Esc/外点/滚动关闭、`aria-disabled` 置灰；菜单项动态：已固定显示「取消固定」；「重新打开已关闭标签」栈空置灰；「复制标签页」unrestorable 置灰。
  - TabBar：`oncontextmenu` preventDefault + 菜单开；中键 `onauxclick` button 1 关闭（含 pushClosed）；`draggable` + `dragstart`（置源 id）/`dragover`（计算 before/after 插入点 + `.vv-tab-dragover` 指示；pinned 区边界 hard 约束 = 普通 tab 拖到 pinned 区显示禁止光标）/`drop` 调 `dragReorder`/`dragend` 清理；pinned 态样式（`data-pinned` + 锁形字符图标）。
  - 行 keydown 的 target 检查（E-T7 已修，保持）。

- [ ] **Step 1: 实现**（组件层无单测——typecheck + T3 e2e 兜底；菜单关闭时机：action 执行后必关）
- [ ] **Step 2: 门禁** `pnpm test && pnpm typecheck` + svelte-check 基线不新增
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/TabContextMenu.svelte apps/web/src/lib/TabBar.svelte apps/web/src/app.css
git commit -m "feat(web): tab 右键菜单、中键关闭、固定态与拖拽接线

why: 动作层的用户入口（spec F §2.2）。
what: TabContextMenu（六动作/视口收敛/置灰语义）+ TabBar 中键/
拖拽插入点指示/pinned 锁形态。"
```

---

### Task 3: 撤销快捷键 + WorkspaceTabsPanel 联动 + 快照 pinned + e2e

**Files:**
- Modify: `apps/web/src/lib/AppShell.svelte`（Alt+Shift+T 全局键）
- Modify: `apps/web/src/lib/WorkspaceTabsPanel.svelte`（行 pinned 徽标显示 + 可选右键入口——选最简：仅徽标显示）
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（snapshot 增 pinned 透传；restore 读回 + 组内保序）
- Modify: `apps/web/e2e/t-tab-actions.spec.ts`（新建）
- Modify: `docs/deploy.md` 或 README 如需（无——纯前端特性，跳过并在报告说明）

**Interfaces:**
- Produces:
  - 快照：`TabSnapshot.pinned?: boolean`（旧快照缺省 false）；restore 组内按数组序重建（现状即保序，验证即可）。
  - e2e 用例（t-tab-actions.spec.ts；dragTo 手法 + dialog handler；注入通道沿用 t-shell dropFile）：
    1. 右键菜单六动作逐一（含置灰态断言）。
    2. pinned：固定后批量关闭豁免（关闭其他 → pinned 幸存）；拖拽跨区拒绝（dragTo 到 pinned 区，断言序不变）。
    3. 中键关闭；Alt+Shift+T 撤销（关 2 个 → 两次撤销按 LIFO 恢复）。
    4. 复制标签页（新 tab 激活且内容渲染）。
    5. 刷新恢复：pinned + 顺序保持；撤销栈清空（预期行为）。
    6. 组内语义：双 workspace 下动作不泄漏到他组。

- [ ] **Step 1: 实现**（快照字段 + 键盘 + 面板徽标）
- [ ] **Step 2: e2e**（重建 build 后跑 t-tab-actions + t-shell 回归）
- [ ] **Step 3: 全量门禁**：`pnpm test && pnpm typecheck` + playwright（t-tab-actions/t-shell/t-open-with/t-workspace 最低集；全量视时长）
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/AppShell.svelte apps/web/src/lib/WorkspaceTabsPanel.svelte apps/web/src/lib/openFlow.svelte.ts apps/web/e2e/t-tab-actions.spec.ts
git commit -m "feat(web,e2e): 撤销快捷键、pinned 快照与 tab 动作端到端

why: 动作闭环与持久化（spec F §2.3）。
what: Alt+Shift+T、快照 pinned 保序恢复、面板 pinned 徽标 +
t-tab-actions 六用例（菜单/豁免/拖拽/中键/撤销/组内语义）。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 动作 API→T1；§2.2 TabBar/菜单/拖拽→T2；§2.3 持久化→T3；§3 测试→各任务；§5 验收→T3。无缺口。
- **占位扫描**：撤销栈落点（.svelte.ts 内 vs 独立纯模块）由实施者选并报告；面板右键入口裁剪为徽标显示（spec 非目标区，已声明）；e2e dragTo 手法与 dialog handler 有先例锚点。
- **类型一致性**：closeOthers/closeRight/pin/unpin/duplicate/dragReorder/reopenClosed/pushClosed/tabOrder 前后一致；pinned 数据面（Tab.pinned/TabSnapshot.pinned/splitPinned）一致。
- **前置依赖**：E 项 workspace 模型（tabsOf/activeWorkspaceId/组内 close）与 E-T7 的行 keydown target 修复——F 在 E 之后实施（既定顺序）。
