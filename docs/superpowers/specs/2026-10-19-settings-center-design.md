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
- 不做自动清理策略（LRU 逐出/容量水位自动删——存储紧张走人工清理，自动化列为未来项）。
- 目录挂载管理不入设置中心（spec 5 独立目录管理页）。

## 2. 设置页结构

- **载体**：全屏 overlay（与工作区面板/全局搜索同交互模型），`Ctrl+,` 切换、Esc 关闭；不引入路由/深链。
- **左导航分组**（自上而下）：外观（亮暗模式/亮暗双槽外观主题/代码主题）、字体（spec 2 组件整体迁入）、图表（spec 1：krokiHost/按语言渲染模式）、布局（spec 3：折叠/宽度/TopBar/TabBar/zen 重置）、搜索与排除（excludedPatterns 等）、自动刷新、计算（computePolicy）、存储与数据（见 §2.2，分类清除）、关于（见 §2.1，项目信息+存储用量+持久化存储）。
- **TopBar 迁移**：代码主题下拉与计算策略下拉迁入设置页（低频项）；亮暗快切保留 TopBar（高频）；TopBar 精简为 ⚙ + 亮暗 + 其余既有件。
- 分组导航键盘可达（↑↓ 切组），右表单滚动跟随高亮。〔勘误（2026-10-19 终审 I3，以实现为准）：右表单实态为「一次一节渲染」——注册表驱动激活组整体切换，非长列表滚动跟随高亮；键盘通道即 ↑↓ 切组本身（JSON 视图下仅移动高亮不触发解析）〕

### 2.1 关于分节（项目信息、存储用量、持久化存储）

**项目信息**（审阅反馈轮扩容）：

- 应用名/版本：前端构建版本（package.json version 构建期注入）与服务端版本（health `version`）并列显示，双端不一致时注记；仓库链接、Apache-2.0 许可、第三方致谢（`THIRD_PARTY_NOTICES.md` 内容入口）。〔勘误（2026-10-19 终审 I3，以实现为准）：第三方致谢以指向 GitHub 上 `THIRD_PARTY_NOTICES.md` 的外部链接呈现——离线内嵌文件内容为简化未做〕
- 服务端 health 摘要：version/capabilities/searchEngine/roots（原文案并入）。

**存储用量与配额**：

- **聚合面**：`navigator.storage.estimate()` 的 `quota`/`usage` 为主显示；Chromium 的 `usageDetails` 存在时展示细分（indexedDB/caches/serviceWorker 等），不存在则隐藏细分行。配额标注「浏览器估算值」（Chrome 粒度粗、Firefox 按磁盘 10% 报告）。
- **localStorage 估算**：全键值 `byteLength` 求和（UTF-16 ×2），仅 settings 与少量键，成本可忽略。
- **IndexedDB 分 store**：`kv`/`themes`/`fonts`/`mounts` 四 store 各显示记录数；体积显示策略——fonts 用记录内已存 `size` 字段求和（spec 2 契约）、themes/kv 以序列化长度估算、mounts 略（微小）。计数走 `openKeyCursor` 一次性遍历，进入分节时加载并缓存，手动「刷新」重算（不实时轮询）。
- 不支持 `estimate()` 的浏览器（老 WebView）隐藏配额区，仅显示本地估算行。

**持久化存储**（`navigator.storage.persist`，**origin 级**——一次申请保护全源：字体/主题/会话快照/离线缓存不再被磁盘压力驱逐）：

- 状态行：`navigator.storage.persisted()` 显示「已持久化 / 未持久化（best-effort，磁盘紧张时可能被清除）」。
- 操作：「申请持久化存储」按钮（用户手势内调用 `persist()`，返回 false 时解释常见原因——Chromium 启发式未达标/已装 PWA 通常自动授予，注记引导装 PWA 即大概率自动持久化）。
- **自动静默尝试**：字体新增成功回调处追加一次 `persist()` 尝试（数据投入时刻申请是浏览器推荐姿势；若 spec 2 已先落地则本 spec 补挂该钩子）；失败静默不打扰，仅状态行反映。
- Safari/Firefox 支持差异注记（均支持 estimate/persist，授予策略不同），不做逐浏览器特调。

### 2.2 存储与数据管理（分类级精细化删除）

动机：浏览器「清除站点数据」是 origin 级一刀切——清一次设置、字体、主题、会话全没，无法只清部分。应用内提供分类级删除后，用户可按需释放空间（如仅删大体积字体保留设置），配合 §2.1 用量显示形成「查看→定位→清除」闭环；持久化被拒时也是唯一的自助清理出路。

**分类清单**（每行：名称+说明+占用估算[复用 §2.1 计算，共享模块]+「清除」钮）：

| 分类 | 载体 | 清除动作与语义 |
| --- | --- | --- |
| 设置 | localStorage `vviewer:settings` | 删除键并重载，回落 DEFAULTS（订阅链重初始化） |
| 会话快照 | IndexedDB kv 的 `tabs`/`workspaces` 键 | 仅删快照：当前内存会话不受影响，下次启动为空会话；确认弹窗明示 |
| 目录授权句柄 | IndexedDB kv 的 `dirHandle` 键 | 删除后 localfs 来源不再自动恢复（需重新授权）；快照恢复失败降级链照旧 |
| 导入主题 | themes store | `clear()`；**引用联动**：settings 中 appearance 引用了 imported 主题的槽位回落 default（订阅链生效），内置主题不受影响 |
| 网络字体 | fonts store | `clear()` + `document.fonts` 逐个注销；**引用联动**：uiFamily/codeFamily 引用已删字体的槽位回落默认栈（spec 2 单项删除语义扩到批量） |
| 挂载配置 | mounts store | `clear()`；代理挂载逐个尝试 `DELETE /api/mounts` 清服务端运行时注册（失败静默，重启即失效）〔勘误（2026-10-19 终审 I3，以实现为准）：mounts store 未落地（Spec 5 前向兼容）——实态为分类行禁用态 + 清除 no-op，「代理挂载 DELETE 尝试」不实现，Spec 5 落地后启用〕 |
| 运行时缓存 | Cache Storage 非 precache 项 | `caches.delete` 逐个清除（grammar wasm/媒体等运行时缓存）；**precache 保留**（清了破坏离线，无自助重建时机）；显示缓存名清单（不显示体积——Response 尺寸遍历成本不成比例） |

- 交互纪律：全部带确认弹窗（红色危险调+列明后果）；删除即时生效项（主题/字体）走既有订阅链实时回退，无需重载；「恢复出厂」独立于分类清单放分节底部——二次确认后执行**全部分类 + 注销 SW + 清全部 Cache Storage + 重载**（最高危，弹窗措辞最强）。
- **单项细粒度不在此重复**：字体单项删除在「字体」节、主题单项在「外观」节、挂载单项在目录管理页、工作区单项在工作区面板——本节只做分类级与兜底，各节入口在分类行内以链接提示。
- 配额错误引导：fonts/mounts 等 IndexedDB 写入路径捕获 `QuotaExceededError` 时，错误文案附「前往 设置→存储与数据 清理空间」（spec 2/5 若已先落地其错误路径则本 spec 补挂引导）。
- 与 §2.1 的关系：关于=只读健康视图（用量/配额/持久化），本节=操作面；两节共享用量计算模块，互链跳转。

## 3. 草稿模型与双视图

- 打开设置页时深拷贝生效 settings 为 draft；表单编辑与 JSON 编辑都只改 draft，右上角「应用」经 `saveSettings` 统一提交（集中订阅链——appearance/fonts/layout 响应——自然生效）。
- 视图切换：表单→JSON 即格式化序列化 draft；JSON→表单先 parse+校验，非法则停留 JSON 视图并标错（错误含行号提示），不丢已编辑文本。
- 校验规则复用 `loadSettings` 字段白名单语义：未知字段标红警告（不静默丢弃）、类型不符标红、clamp 类字段越界标红提示将截断。
- 脏态守卫：draft 有未应用修改时关闭/Esc 弹确认（应用/放弃）；「应用」成功自动关闭脏态不清页。
- JSON 视图编辑器：等宽 textarea + 行号栏；不引入代码编辑器依赖。

## 4. 导入/导出

- **导出**：`{ schemaVersion: 1, exportedAt: ISO, settings }` 下载为 `vviewer-settings-YYYYMMDD.json`。
- **导入**：文件选择 → parse → 按 schemaVersion 兼容检查（更高版本警告并尝试尽力合并，注记风险）→ 字段白名单校验 → 对话框展示变更摘要（逐组新增/修改计数，关键字段 diff 列表）→ 用户选**合并**（白名单字段级覆盖，导入缺项保留现状）或**替换**（校验通过后整体覆盖为导入规范化结果）→ 应用走同一 saveSettings 链。〔勘误（2026-10-19 终审 I1，以实现为准）：「字段级覆盖」落地为**节内字段级**而非节整体——对象节（diagrams/fonts/layout）内递归一层至 `diagrams.modes`（键级合并），数组（excludedPatterns）整组覆盖，标量直接覆盖，导入缺项保留 current；变更摘要与该合并路径同源计算〕
- 导入不携带 themes/fonts 等内容资产（各自已有导入通道），对话框注记。
- 校验失败的导入：明确报错不部分应用。

## 5. 测试

- 单测：草稿模型（脏态追踪/表单↔JSON 往返等价/校验错误分类）、导入合并与替换语义（含缺项保留/未知字段/版本不匹配）、导出文件结构。
- 关于分节单测：localStorage 估算求和、IndexedDB 分 store 计数（fake-indexeddb 既有基建）、usageDetails 缺失降级渲染、persist() 状态机（granted/denied/异常）与字体上传钩子触发（mock navigator.storage）。
- 存储管理单测：七分类删除动作各自语义（快照键保留 dirHandle/引用联动回落/字体 document.fonts 注销/代理挂载服务端清理尝试）、恢复出厂全序列（含 SW 注销 mock）、确认弹窗门。
- e2e：打开/导航/Esc/`Ctrl+,`、表单改动反映到 JSON 视图、非法 JSON 阻断、应用后订阅链生效（外观+字体+布局一次提交三链路）、导入合并/替换两路径、TopBar 精简回归（亮暗快切/⚙ 入口）、脏态确认弹窗、关于分节用量显示与刷新钮（配额断言以 estimate mock 注入）、存储管理分类清除（设置重载回落默认/字体清除后 UI 回退/恢复出厂后全新会话）。
