# 设计：VSCode Dark/Light Modern 主题集成与主题导入（JSON/VSIX）

- 日期：2026-10-11
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-06-vviewer-design.md`（M2 代码主题体系）、`packages/highlight/src/theme.ts`（ThemeTable/CSS 变量注入）、Markpad 参考实现（`markpad-aio/Markpad` 主题导入与 scope→capture 映射）

## 1. 背景与目标

现状：UI 配色为 `app.css` 硬编码的亮/暗两组色值（8 个 `--ui-*` 语义 token）；代码主题已有完整体系（helix `themes.json` 214 主题、`ThemeTable`、`<style id="vv-code-theme">` 注入、`codeThemeLight/Dark` 双槽）。无任何主题导入能力。

用户需求：集成 VSCode Dark Modern / Light Modern；若有许可证障碍则退而提供导入（Markpad 式）。**许可证结论：vscode 仓库为 MIT**，两主题即 `extensions/theme-defaults/themes/{dark_modern,light_modern}.json`，无障碍可直接集成（THIRD_PARTY_NOTICES 署名）。

用户拍板范围：**内置两主题 + VSCode 主题 JSON 导入 + VSIX 扩展包导入**（全量，Markpad 对齐）。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 主题实体 | 新增「外观主题（appearance theme）」：`default` 型（现硬编码 UI + 独立代码主题槽，行为不变）与 `vscode` 型（`colors`→UI token + `tokenColors`→代码配色，一物两用，Markpad 同语义） |
| 槽位模型 | `settings` 新增 `appearanceLight` / `appearanceDark` 双槽（对齐 `codeThemeLight/Dark` 模式），默认均 `'default'`；`themeMode` 三态语义不变，system 时按 `effectiveMode` 取槽 |
| 代码主题联动 | appearance 为 vscode/imported 型时代码配色由 `tokenColors` 映射接管；`codeThemeLight/Dark` 选择器仅对 `default` 槽生效（UI 上将两者分区展示，避免歧义） |
| 内置来源 | 两主题 JSON vendor 进仓库（KB 级，不依赖构建期网络），文件头注释记录来源 commit，实施时取 vscode 最新 stable tag；THIRD_PARTY_NOTICES 增加 MIT 署名条目 |
| UI token 扩展 | 8 个 `--ui-*` 扩至 ~20 个（状态栏/输入框/hover/选中/语义色/accent 前景等），default 主题给现值，既有组件观感零变化 |
| 存储 | 导入主题存 IndexedDB（现有库 `vviewer` 新 store `themes`，规避 localStorage 5MB 上限）；管理界面支持删除 |
| 导入入口 | 仅设置面板（按钮 + 文件选择器，`.json`/`.vsix` 可多选）；**不做全局拖拽导入**（避免与「打开文件」语义冲突） |

### 非目标

- 不做主题市场/在线下载（VSIX 仅本地文件导入）。
- 不做 helix 代码主题升格为外观主题（214 个 helix 主题保持代码侧）。
- 不追求 TextMate scope 映射 100% 保真（近似映射，见 §4）。
- 不改 TopBar 快速循环按钮语义（仍 system→light→dark 三态）。

## 2. 设计

### 2.1 UI token 扩展与注入管线

- `app.css` 的 token 集从 8 个扩至约 20 个（新增示例：`--ui-statusbar-bg`、`--ui-input-bg`、`--ui-hover-bg`、`--ui-selection-bg`、`--ui-accent-fg`、`--ui-error`、`--ui-warning`、`--ui-success`、`--ui-badge-bg` 等；最终清单实施时随映射表定稿）；default 亮/暗值 = 现硬编码色的等价拆分，**既有视觉零变化**。
- 注入机制沿用代码主题的 style 注入：`applyAppearance(name, mode)` 将所选主题的 UI token + 代码 token 一次性写入 `<style id="vv-code-theme">`（该节点职责扩展为「外观主题变量」）；`THEME_ROOT_SELECTOR` 提权、`onSystemModeChange` 重应用等既有设施直接复用。

### 2.2 VSCode 主题映射

- **colors → UI token**：静态映射表（`editor.background→--ui-bg`、`sideBar.background→--ui-side-bg`、`tab.activeBackground→--ui-tab-active-bg`、`editorWidget.background→--ui-tab-bg`、`statusBar.background→--ui-statusbar-bg`、`input.background→--ui-input-bg`、`list.hoverBackground→--ui-hover-bg`、`editor.selectionBackground→--ui-selection-bg`、`focusBorder→--ui-accent`、`editorError.foreground→--ui-error` 等约 20 条）；未映射的 UI token 走 fallback（亮暗基色取 `editor.background/foreground` 推导，再退 default 值）。
- **tokenColors → 代码 capture**：TS 模块移植 Markpad `vscode.rs` 的映射思路：TextMate scope selector 简化匹配（去 `#id`/伪元素，前缀段匹配， specificity=段数，最长者胜），输出目标 capture 集 = `theme.ts` 的 `CODE_CAPTURES`（53 个 `--vv-ts-*`）；hljs 兜底沿用既有 `HLJS_CAPTURE_TO_VAR` 桥自动跟随。
- 生成产物即 `ThemeTable` 同构数据 → 复用 `themeToCssVars` 管线，切换零重解析。

### 2.3 导入

- **JSON**：`file.text()` → 校验（`name` 必填；`type ∈ {dark, light, hc-black, hc-light}`（hc 归 dark）；`colors`/`tokenColors` 至少其一非空；体积上限 1MB）→ 存 IndexedDB，id `imported:<随机8>`。
- **VSIX**：zip 解析复用 `render-archive` 已引入的 zip 读取依赖（在 render-archive 导出只读清单/按名读取的小 API，避免 apps/web 直依赖 zip 库）；读 `package.json` 的 `contributes.themes`（label + path），解析各主题 JSON 后列出多选 → 用户勾选导入。损坏包/无 themes 声明给出明确错误。
- **管理 UI**：设置面板新增「界面主题」区：亮色槽/暗色槽两个 select（候选 = 默认、Dark Modern、Light Modern、已导入列表）+ 导入按钮 + 已导入主题删除。VSCode 型主题条目按 `type` 标注亮/暗徽标；槽位与主题亮暗不匹配时显示提醒不阻止。

## 3. 测试

- 单测：colors/tokenColors 映射表（样例主题快照）；JSON/VSIX 校验（坏 JSON、缺 contributes、hc 归类、体积超限）；IndexedDB 主题存取往返；`applyAppearance` 切换后变量断言（default↔Dark Modern）。
- e2e：切换 Dark Modern 后 `--ui-bg` 等变量值变化且代码高亮随 tokenColors 变化；导入 JSON 主题并应用；导入含多主题的 VSIX 勾选部分导入；刷新后槽位恢复（IndexedDB 读取）。
- 许可：THIRD_PARTY_NOTICES 增加 vscode MIT 条目（仓库当前无自动许可检查，人工核对项）。

## 4. 风险与已知限制

- scope→capture 为近似映射：VSCode 主题语义（TextMate scope 树）与 helix capture 语义非一一对应，冷门语言着色可能不及原生 VSCode 精准（与 Markpad 同级保真）。
- 高对比（hc-*）主题映射后观感可能欠佳：不阻止导入，文档注明。
- VSCode colors 键位持续演进：映射表按实施时 stable 语义对齐，未识别键静默忽略。

## 5. 验收

| 项 | 标准 |
| --- | --- |
| 内置 | Dark/Light Modern 开箱可选，UI+代码配色一体生效，既有 default 观感零变化 |
| 导入 | 合法 JSON/VSIX 导入可用、持久化、可删除；非法输入明确报错 |
| 联动 | appearance 与 codeTheme 的接管/回退边界符合 §1 决策表 |
| 回归 | vitest / typecheck / playwright 全绿 |

交付顺序：①token 扩展 + vendor 两主题 + 映射/注入管线；②导入（JSON/VSIX/存储/管理 UI）。各一 commit，TDD。
