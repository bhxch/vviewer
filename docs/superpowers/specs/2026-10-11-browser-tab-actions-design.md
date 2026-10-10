# 设计：浏览器式 tab 管理动作（右键菜单/固定/拖拽/撤销关闭）

- 日期：2026-10-11
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-11-workspace-tabs-design.md`（workspace/tab 分组模型——本设计动作均作用于 workspace 组内，实施顺序在 E 之后）

## 1. 背景与目标

现状：`TabBar.svelte` 仅有点击激活与单个关闭（38 行简单组件）；`TabCollection` 只有 `add/close/activate/persistScroll/refreshPaths`。无右键菜单、无固定、无批量关闭、无拖拽排序、无撤销关闭。

目标：补齐浏览器/编辑器惯例的 tab 管理动作，语义落在 E 项的 workspace 组内。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 右键菜单动作 | 关闭 / 关闭其他 / 关闭右侧 / 固定（已固定显示「取消固定」）/ 复制标签页 / 重新打开已关闭标签（栈空禁用） |
| 固定语义 | VSCode 风格：pinned 恒靠左成固定区、普通 tab 不可拖入固定区、**批量关闭（关闭其他/右侧）豁免 pinned**、单个关闭动作对 pinned 仍有效 |
| 拖拽排序 | HTML5 drag & drop，仅同 workspace 内；移动端（≤600px 触屏）不做拖拽（HTML5 dnd 无触屏支持），排序需求由 E 项管理面板承接（后续项） |
| 撤销关闭 | 内存栈（容量 10，LIFO），`Alt+Shift+T` + 右键菜单/管理面板入口；**不持久化**（刷新即清，与浏览器一致）；恢复时若 workspace 已删除则落回活动 workspace |
| 关闭后激活 | 维持现状语义（激活相邻 tab，组内） |
| 中键 | 中键点击 tab = 关闭（`auxclick` button 1） |
| 快捷键 | `Alt+Shift+T` 撤销关闭（`Ctrl+Shift+T` 被浏览器占用不可靠）；其余动作无快捷键，走菜单 |

### 非目标

- 不做跨 workspace 拖拽、tab 分裂视图、tab 静音/多选批量操作。
- 不做「关闭左侧」（浏览器无此惯例，需求出现再加）。
- 不改 E 项管理面板的结构（仅为其 tab 条目补 pinned 徽标显示）。

## 2. 设计

### 2.1 TabCollection 动作 API

```
closeOthers(tabId)      // 组内除自身与 pinned 外全关
closeRight(tabId)       // 组内该 tab 右侧的非 pinned 全关
pin(tabId) / unpin(tabId) // pinned 标记 + 组内重排（pinned 区靠左，区内保持相对序）
duplicate(tabId)        // 同 source 新 tab 插入原 tab 右侧并激活（重新 read）
dragReorder(fromId, toId) // 组内重排；跨 pinned 区边界拒绝（普通→pinned 区前的插入点截断到 pinned 区首）
pushClosed(snapshot)    // 关闭动作统一经此入栈（容量 10 淘汰）
reopenClosed()          // 出栈恢复（unrestorable 类占位 tab 也走此路径，与刷新恢复同语义）
```

- `close` 现有实现统一改为先 `pushClosed` 再关闭；pinned 不阻止单关。
- 批量关闭的激活落点：关闭后激活原活动 tab 的最近存活邻位（组内）。

### 2.2 TabBar 与右键菜单

- `Tab.svelte` 增加 `draggable`、`oncontextmenu`、中键 `onauxclick`；pinned 态样式（斜体/锁形图标，对齐 VSCode 惯例）。
- 右键菜单为自绘浮层组件 `TabContextMenu.svelte`（`contextmenu` preventDefault；按触发位置定位、视口内收敛；Esc/外点/滚动关闭；菜单项随目标 tab 状态增删——首个 tab 无「关闭右侧」灰置逻辑按「右侧无普通 tab」判定）。
- 拖拽：`dragstart` 置源 id，`dragover` 计算插入点（pinned 区边界硬约束）并给占位指示，`drop` 调 `dragReorder`；`dragend` 清理。

### 2.3 持久化

- `TabSnapshot` 新增可选 `pinned?: boolean`；数组序即组内序（快照写出现在顺序，恢复保序）；撤销栈不进快照。
- 旧快照缺 `pinned` 兼容（缺省 false）。

## 3. 测试

- 单测：`closeOthers/closeRight` 的 pinned 豁免与激活落点；`pin/unpin` 重排与边界；`dragReorder` 跨区拒绝；`reopenClosed` 栈容量淘汰、workspace 已删回落；快照往返含 pinned。
- e2e：右键菜单全动作（关闭其他/右侧/固定/复制/撤销）；中键关闭；pinned 后批量关闭被豁免；拖拽换位与固定区边界（`dragTo`）；`Alt+Shift+T` 撤销；刷新后 pinned 与顺序保持。

## 4. 风险与已知限制

- headless 拖拽稳定性：以 `dragTo` + 占位指示类名断言；若计时型 flaky 则按既有惯例标注并做对照记录。
- HTML5 dnd 移动端不可用为已知限制（§1 决策表）；触屏排序延后。
- 复制 tab 依赖 source 可重读（File 对象存活/URL 重拉/remote 重读），unrestorable 占位 tab 的「复制」置灰。

## 5. 验收

| 项 | 标准 |
| --- | --- |
| 动作 | 右键菜单六动作、中键、拖拽、撤销全部可用且语义符合 §1 决策表 |
| 分组 | 全部动作严格作用于当前 workspace 组内 |
| 持久化 | pinned 与顺序经刷新恢复；撤销栈不跨刷新（预期行为） |
| 回归 | vitest / typecheck / playwright 全绿 |

交付顺序：TabCollection 动作（TDD）→ TabBar UI 与菜单 → e2e；两到三个 commit。
