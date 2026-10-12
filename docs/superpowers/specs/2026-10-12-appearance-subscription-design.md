# applyAppearance 订阅中心化设计

- 日期：2026-10-12
- 状态：已评审（brainstorm 确认，待实施）
- 来源：交接文档 §2.1 跨项架构债（B 项 T5 评审 + 终审清单）；现状探查（theme.ts / TopBar.svelte / SettingsPanel.svelte / stores/settings.ts）

## 1. 问题陈述

VSCode 主题双槽（`appearanceLight`/`appearanceDark`）的注入函数 `applyAppearance`（theme.ts）目前靠每个写入方**自觉直调**，共 5 处：

| 调用方 | 触发 | 位置 |
| --- | --- | --- |
| TopBar `applyCurrentAppearance` | onMount 初始化 | TopBar.svelte:102 |
| TopBar `cycleTheme` | themeMode 循环（saveSettings 后直调） | TopBar.svelte:171 |
| TopBar `onCodeThemeChange` | 代码主题下拉（saveSettings 后直调） | TopBar.svelte:181 |
| TopBar `onSystemModeChange` 回调 | system 亮暗切换（不经 saveSettings） | TopBar.svelte:109-116 |
| SettingsPanel `reapplyAppearance` | 槽 select change / 删除导入主题 | SettingsPanel.svelte:147, 196 |

派生问题四项：

1. **T4 计划口径未归还**：计划（2026-10-11-vscode-themes.md T4 Interfaces）声称「槽切换 → saveSettings → TopBar 的 onSettingsChanged 订阅触发 applyAppearance」，实际 TopBar 订阅只刷新响应式副本、不触发注入，面板被迫直调（SettingsPanel.svelte:6-9 注释即对此偏差的解释）。
2. **并发覆写竞态**：`applyAppearance` 含两处 await（`resolveAppearance` 的动态 import / IndexedDB `listImportedThemes`；`injectCodeTheme` 内 `loadTables`），无序号 token——快速连续切槽时 last-**resolved** 胜：慢的旧调用恢复后把 `style#vv-code-theme` 的 textContent（含 `dataset.mode`）整体覆写为旧槽，且无后续触发点自愈，UI 下拉与实际生效主题不一致。
3. **无关设置变更无法感知**：`onSettingsChanged` 全量广播无 diff，订阅方无法区分「槽相关变化」与「excludedPatterns 等无关变化」——这是当年不敢单订阅触发的原因。
4. **appearance 字段无校验**：`loadSettings` 仅校验 `computePolicy`；`appearanceLight/Dark` 从 localStorage 读出任意字符串直达注入，只能靠注入期 warn+回退兜底。

## 2. 设计

### 2.1 订阅归属与 diff 口径

注入职责收敛到 **TopBar 既有订阅**（它已拥有 `onSystemModeChange` 订阅与 onMount 初始化，是注入的天然归属）。

theme.ts 新增统一入口：

```ts
/** 订阅触发入口：按 settings 计算生效四元组，与上次注入签名 diff，变化才注入。 */
export function applyAppearanceFromSettings(settings: Settings): void
```

- 内部计算 `mode = effectiveMode(settings.themeMode)`、`appearance = mode === 'dark' ? settings.appearanceDark : settings.appearanceLight`、`codeTheme = mode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight`。
- **diff 四元组 `(mode, appearance, codeTheme)`**——交接文档口径为三元组 `(mode, appearanceLight, appearanceDark)`，漏了 codeTheme：`injectCodeTheme` 的 hljs 变量同样依赖代码主题，若 diff 排除它，代码主题下拉切换仍需直调（中心化不彻底）。本设计改为对「生效值」而非「原始槽值」diff，system 切换（effectiveMode 变化）天然命中，无需特判。
- 签名存 theme.ts 模块级 `lastAppliedAppearance: string | null`（初 null = 首次必注入，onMount 初始化直调亦并入本入口）。
- 备选否决：theme.ts 模块级自动订阅（import 副作用，测试污染、双实例漂移）。

### 2.2 并发串行化：monotonic token 弃单（last-INITIATED 胜）

`applyAppearance` 包上自增 token：

```ts
let appearanceCallSeq = 0;
export async function applyAppearance(...): Promise<void> {
  const token = ++appearanceCallSeq;
  /* await 点之后：if (token !== appearanceCallSeq) return; // 已被更新调用超越，弃单 */
}
```

- 每个 `await` 恢复后（`resolveAppearance` 与 `loadTables` 处）比对 token，被超越即静默返回——不写 style 节点、不落 lastApplied。
- 语义：**最后发起**的调用胜（而非最后 resolve 胜），快速连切槽时旧调用的慢 IO 不再覆写终态；且新调用无需等待旧调用（对比 promise 链式串行：保序但逐个等慢 IO，最终主题延迟呈现——否决）。
- `lastAppliedAppearance` 仅由**未被弃单、真正完成注入**的调用写入（弃单者不得写）；token 比对与 lastApplied 写入在同一同步段完成，无交错窗口。

### 2.3 字段白名单校验

`loadSettings` 增加外观槽格式校验（与 `computePolicy` 同模式）：值必须为 `'default'` 或 `'vscode:'`/`'imported:'` 前缀字符串，违规归位 `'default'`。存在性校验（vscode 名单/imported id 是否真实存在）仍由注入期 warn+回退兜底（theme.ts applyAppearance 既有行为），本层只做**格式**白名单。

### 2.4 调用方落地

| 调用方 | 改造 |
| --- | --- |
| TopBar onSettingsChanged 订阅 | `(s) => { settings = s; applyAppearanceFromSettings(s); }` |
| TopBar onMount 初始化 | 改调 `applyAppearanceFromSettings(settings)`（diff 初值 null 必注入），删除 `applyCurrentAppearance` |
| TopBar cycleTheme | 删直调——saveSettings → 订阅 → effectiveMode 变化 → diff 命中；`dataset.themeMode` 直写保留（CSS 侧即时性） |
| TopBar onCodeThemeChange | 删直调——saveSettings → 订阅 → codeTheme 变化 → diff 命中 |
| TopBar onSystemModeChange 回调 | 保留订阅，回调改调 `applyAppearanceFromSettings(settings)`（system 切换 → effectiveMode 变化 → diff 命中；不经 saveSettings 的口径不变） |
| SettingsPanel `reapplyAppearance` | 整体删除（含 onAppearanceChange / removeImported 两处直调）；文件头注释（6-9 行「直调原因」）同步改写 |

TopBar 的 `$derived`（mode/currentAppearance/currentCodeTheme）保留——下拉 UI 状态仍需展示值，与注入入口解耦。

## 3. 测试

- **theme.test.ts 新增三组**（现有 388 行注入断言不动）：
  1. token 弃单：桩 IndexedDB 慢（fake-indexeddb + 延迟包装），首发 imported 慢调用 → 后发 default 快调用 → 终态 textContent = 后者；旧调用恢复后不覆写（断言终态 + 无第二次 textContent 变化）。
  2. diff 跳过：`applyAppearanceFromSettings` 以仅 excludedPatterns 不同的 settings 连调 → `style#vv-code-theme` textContent 不变（无注入）；改槽值 → 变化。
  3. 白名单：loadSettings 对 `appearanceLight: 'javascript:'` 之类非法格式归位 `'default'`（localStorage 预置脏值）。
- **回归**：t-theme.spec.ts（B-THEME-1..4）与 b-theme-system e2e 断言不变——UI 行为不变，仅触发路径收敛。

## 4. 不做的事

- 不改注入机制本身（`style#vv-code-theme` 单节点整体替换、`dataset.mode`）。
- 不动 codeTheme 双槽语义与 app.css 的 `@media (prefers-color-scheme: dark)` 联动。
- 不做跨组件主题状态提升（settings 仍是唯一事实源，TopBar 仍是唯一注入方）。
- e2e 断言零变更。

## 5. 验收

1. `pnpm test` 全绿（新增 ≥5 用例）。
2. `npx svelte-check` 0E/0W（新门禁）。
3. 全仓 rg `applyAppearance(` 直调仅剩 theme.ts 内部与 applyAppearanceFromSettings；`reapplyAppearance` 不复存在。
4. e2e t-theme / b-theme-system 通过（默认 playwright 通道）。
