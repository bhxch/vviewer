# 设计：统一设置中心（全屏设置页、UI/JSON 双视图、导入导出）

- 日期：2026-10-19
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-19-font-system-design.md`（fonts schema）、`2026-10-19-markdown-markpad-alignment-design.md`（diagrams schema）、`2026-10-19-layout-zen-design.md`（layout schema）、`2026-10-12-appearance-subscription-design.md`（设置订阅链）、目录挂载 spec（前端挂载管理独立成页，不入设置中心）

## 1. 背景与目标

现状：设置分散两处——TopBar ⚙ 弹层 `SettingsPanel.svelte`（排除规则/自动刷新/界面主题）与 TopBar 直控件（亮暗三态/代码主题下拉/计算策略下拉）。spec 1/2/3 落地后 settings schema 将新增 diagrams/fonts/layout 三节，弹层形态不可持续。

目标：统一全屏设置页，容纳全部设置分组；UI 表单视图与 JSON 文本视图可切换（共享草稿）；设置 JSON 导入/导出。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 形态 | **全屏设置页**：左侧分组导航 + 右侧表单；TopBar ⚙ 与 `Ctrl+,` 均指向它；弹层 SettingsPanel 退役 |
| JSON 视图 | **共享草稿+校验**：与表单视图同一草稿模型，切视图携带未应用修改；非法 JSON/未知字段标红不落盘；「应用」统一提交 |
| 导入导出 | 导出=带 `schemaVersion`+`exportedAt` 的完整 settings JSON 下载；**导入时二选一**：字段级合并（缺省保留现状）或整体替换，对话框内逐次选择 |

### 非目标

- 不做设置搜索框（VSCode 式 filter，未来项）。
- 不做 per-workspace 设置分层（全局单层）。
- 不做服务端配置文件/远端同步（settings 仍为 localStorage 单源）。
- 不做多标签页实时同步增强（沿用既有 in-tab notify 语义，storage 事件同步列为未来项）。
- 目录挂载管理不入设置中心（spec 5 独立目录管理页）。

## 2. 设置页结构

- **载体**：全屏 overlay（与工作区面板/全局搜索同交互模型），`Ctrl+,` 切换、Esc 关闭；不引入路由/深链。
- **左导航分组**（自上而下）：外观（亮暗模式/亮暗双槽外观主题/代码主题）、字体（spec 2 组件整体迁入）、图表（spec 1：krokiHost/按语言渲染模式）、布局（spec 3：折叠/宽度/TopBar/TabBar/zen 重置）、搜索与排除（excludedPatterns 等）、自动刷新、计算（computePolicy）、关于（应用版本/服务端 health 摘要/开源致谢链接）。
- **TopBar 迁移**：代码主题下拉与计算策略下拉迁入设置页（低频项）；亮暗快切保留 TopBar（高频）；TopBar 精简为 ⚙ + 亮暗 + 其余既有件。
- 分组导航键盘可达（↑↓ 切组），右表单滚动跟随高亮。

## 3. 草稿模型与双视图

- 打开设置页时深拷贝生效 settings 为 draft；表单编辑与 JSON 编辑都只改 draft，右上角「应用」经 `saveSettings` 统一提交（集中订阅链——appearance/fonts/layout 响应——自然生效）。
- 视图切换：表单→JSON 即格式化序列化 draft；JSON→表单先 parse+校验，非法则停留 JSON 视图并标错（错误含行号提示），不丢已编辑文本。
- 校验规则复用 `loadSettings` 字段白名单语义：未知字段标红警告（不静默丢弃）、类型不符标红、clamp 类字段越界标红提示将截断。
- 脏态守卫：draft 有未应用修改时关闭/Esc 弹确认（应用/放弃）；「应用」成功自动关闭脏态不清页。
- JSON 视图编辑器：等宽 textarea + 行号栏；不引入代码编辑器依赖。

## 4. 导入/导出

- **导出**：`{ schemaVersion: 1, exportedAt: ISO, settings }` 下载为 `vviewer-settings-YYYYMMDD.json`。
- **导入**：文件选择 → parse → 按 schemaVersion 兼容检查（更高版本警告并尝试尽力合并，注记风险）→ 字段白名单校验 → 对话框展示变更摘要（逐组新增/修改计数，关键字段 diff 列表）→ 用户选**合并**（白名单字段级覆盖，导入缺项保留现状）或**替换**（校验通过后整体覆盖为导入规范化结果）→ 应用走同一 saveSettings 链。
- 导入不携带 themes/fonts 等内容资产（各自已有导入通道），对话框注记。
- 校验失败的导入：明确报错不部分应用。

## 5. 测试

- 单测：草稿模型（脏态追踪/表单↔JSON 往返等价/校验错误分类）、导入合并与替换语义（含缺项保留/未知字段/版本不匹配）、导出文件结构。
- e2e：打开/导航/Esc/`Ctrl+,`、表单改动反映到 JSON 视图、非法 JSON 阻断、应用后订阅链生效（外观+字体+布局一次提交三链路）、导入合并/替换两路径、TopBar 精简回归（亮暗快切/⚙ 入口）、脏态确认弹窗。
