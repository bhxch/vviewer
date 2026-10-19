# 设计：布局自由化与 Zen mode（侧栏折叠/调宽/全件可隐、zen、渲染器自选入口）

- 日期：2026-10-19
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-11-workspace-tabs-design.md`（AppShell 结构）、`2026-10-11-format-coverage-open-with-design.md`（overrideRenderer/openWithOf 机制）、`2026-10-11-browser-tab-actions-design.md`（TabContextMenu）、后续 `设置中心` spec（layout 配置迁移）

## 1. 背景与目标

现状：桌面端左右栏固定宽（`.vv-side` 260px / `.vv-right` 230px，AppShell.svelte:530/542）无折叠；TopBar/TabBar 恒显；无 zen mode；渲染器手选仅有 MetaPanel 下拉单入口（对「txt 实为代码文件」场景路径太深）。

目标：左右栏可折叠+可拖拽调宽、TopBar/TabBar 可隐藏（全件可隐）、zen mode、渲染器自选增加状态栏与 Tab 右键双便捷入口。移动端（≤900/600px 断点）抽屉机制不动。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 布局自由度 | **全件可隐**：左右栏折叠钮+中缝拖拽调宽（持久化、clamp），TopBar/TabBar 各自可隐藏 |
| zen mode | 快捷键 `Ctrl+Alt+Z` 进入（隐全部 chrome 只留内容）；Esc 退出；顶部边缘悬停唤出半透退出条；状态持久化（重启保持） |
| 渲染器入口 | **状态栏指示器 + Tab 右键「打开方式」子菜单**，两入口复用同一候选集（`openWithOf`）与同一 override 机制 |

### 非目标

- 不做布局多方案预设（如「专注/分屏」布局包）。
- 不做栏位拖拽重排（左栏搬右侧之类）。
- 不做每 workspace 独立布局（布局是全局设备级配置）。
- 移动端不引入折叠/调宽（抽屉现状保留）。

## 2. 布局状态模型

```ts
layout: {
  leftCollapsed: boolean;   rightCollapsed: boolean;
  leftWidth: number;        rightWidth: number;   // px；left clamp 180–480，right clamp 160–420
  topBarVisible: boolean;   tabBarVisible: boolean;
  zen: boolean;
}
```

- settings schema 新增 `layout` 节（settings.ts 白名单同步），spec 6 落地后仅迁移 UI。
- 折叠态：栏宽归零，残留 ~28px 竖条（展开钮 + 所属面板图标：左树/右信息），点击展开。
- 拖拽调宽：中缝 6px 热区把手，拖动实时预览、松手落盘；双击把手重置默认宽。
- **隐藏 chrome 的唤出**：TopBar/TabBar 隐藏后，对应边缘（顶部/标签区）悬停唤出半透临时条（同 zen 退出条交互），移开 1.5s 后再隐；临时条上右键可重新勾选显示。隐藏入口=各自右键菜单「隐藏」项（VSCode 活动栏同交互）。
- 折叠/宽度/可见性变更均即时持久化（settings 落盘既有链路）。

## 3. Zen mode

- 进入：`Ctrl+Alt+Z` 或 TopBar 布局菜单项；隐 TopBar/TabBar/双栏，仅留内容区。
- 退出：Esc（**优先级低于面板类 Esc**——设置/搜索/快速打开等 overlay 打开时 Esc 只关 overlay，二次 Esc 才退 zen）或顶部边缘悬停退出条。
- zen 与显式布局配置正交：zen 只做视觉覆盖，不改动 `layout` 其余字段；退出后恢复进入前各件可见性。
- 状态栏在 zen 下保留（含渲染器指示器与退出钮），保证功能可达。
- 快捷键与既有 j/k/gg/G 滚动键、Ctrl+, 等无冲突（`Ctrl+Alt+Z` 未被占用，实施时以实际键位表复核）。

## 4. 渲染器自选入口

- **状态栏指示器**：显示激活 tab 当前生效渲染器 label（无 override 时「自动 · label」）+ 语言/扩展名；点击弹出候选菜单。
- **Tab 右键「打开方式」子菜单**：同候选集。
- 候选集与选中语义**完全复用现有机制**：`openWithOf`（自动 + 生效渲染器 ∪ 扩展名注册 ∪ code/hex，registry.byId 守卫）+ `tabStore.setRendererOverride`（rev++ 重渲染+快照持久化）；菜单加「自动」项=清除 override。
- 新建共享组件 `RendererPickerMenu`（候选收集/高亮当前/选择回调），状态栏与右键菜单各自壳内复用，杜绝两份候选逻辑漂移。
- 错误卡片「以纯文本/hex 打开」的临时 override 语义不变（不落持久 override，ViewerPane 既有注释契约）。

## 5. 测试

- 单测：layout clamp/persist、zen 覆盖语义（不改底层字段/退出还原）、RendererPickerMenu 候选与 openWithOf 等价性、Esc 优先级状态机。
- e2e：折叠/展开+重启恢复、拖拽调宽+clamp、TopBar 隐藏→边缘唤出→重显、zen 进入/overlay Esc 优先/边缘条退出/重启保持、txt 文件经状态栏与右键两入口切 jsonl/code 并持久化、移动端抽屉回归（断点内无折叠钮）。
