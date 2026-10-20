# 统一设置中心 Implementation Plan（spec 2026-10-19-settings-center-design.md）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全屏设置页（分组导航+UI/JSON 共享草稿双视图+导入导出）取代 SettingsPanel 弹层；存储与数据管理七分类删除+恢复出厂；关于分节（项目信息/存储用量/持久化申请）。

**Architecture:** 新 `SettingsCenter.svelte` 全屏 overlay（分组导航+右表单）；草稿模型纯函数集 `settingsDraft.ts`（深拷贝/JSON 往返/校验/脏态）；既有 SettingsPanel 的五个既有节（排除规则/自动刷新/界面主题/图表/字体）组件级迁入；存储管理与关于为新增分节（复用 spec §2.1/§2.2 设计）；TopBar 精简（保留亮暗快切+⚙）。

**Tech Stack:** Svelte 5 runes、DOMPurify 既有、fake-indexeddb/vitest、playwright。

**Spec:** `docs/superpowers/specs/2026-10-19-settings-center-design.md`（§2.1 关于/§2.2 存储管理为权威细节）

## Global Constraints

- 分组序：外观/字体/图表/布局/搜索与排除/自动刷新/计算/存储与数据/关于（spec §2 定稿序——存储与数据先于关于）。
- 草稿语义：打开深拷贝；两视图共享 draft；非法 JSON 停留 JSON 视图标错不丢文本；应用统一走 saveSettings；脏态关闭确认。
- JSON 校验=loadSettings 白名单语义镜像（未知字段警告、类型不符标红、clamp 提示截断）。
- 导出 `{ schemaVersion: 1, exportedAt, settings }`；导入二选一（合并=白名单字段级覆盖/替换=校验后整体覆盖）；校验失败不部分应用。
- 存储管理七分类语义与确认弹窗（spec §2.2 表格逐行）；恢复出厂=全部分类+注销 SW+清全部 Cache+重载（最高危确认）。
- 关于分节：estimate() 聚合+usageDetails 细分（存在时）+localStorage UTF-16 估算+IndexedDB 分 store 计数（进节加载+手动刷新）；persist 状态+按钮+字体上传钩子静默尝试。
- settings schema 不新增字段（layout/diagrams/fonts 均已在库）；storage 事件同步/auto 清理策略为非目标。
- 每任务原子提交；测试在仓库根跑（runes 组件源码契约+e2e 先例形态）。

---

### Task 1: 设置页骨架与既有节迁移

**Files:**
- Create: `apps/web/src/lib/SettingsCenter.svelte`（全屏 overlay：左导航分组+右表单插槽）
- Modify: `apps/web/src/lib/SettingsPanel.svelte`（既有节抽为可搬迁子组件或整段迁移——取改动最小者：抽出 排除规则/自动刷新/界面主题/图表/字体 五节为 SettingsCenter 消费的片段组件）
- Modify: `apps/web/src/lib/AppShell.svelte`（Ctrl+, 指向新页；SettingsPanel 挂点退役）
- Modify: `apps/web/src/lib/TopBar.svelte`（⚙ 指向新页；代码主题下拉与计算策略下拉迁入设置页——本任务先迁 UI 控件，计算策略在「计算」组、代码主题在「外观」组；亮暗快切保留）
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: SettingsCenter 分组注册表形态（`{ id, label, content }` 数组驱动——Task 2/3/4 新分组以注册项插入，零骨架改动）。

- [ ] **Step 1: 写失败测试**（分组注册表形状/既有五节迁移后的功能等价——源码契约+既有 SettingsPanel 测试迁移）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（TopBar 代码主题/计算策略控件的迁移动语义=同 schema 字段同绑定；`Ctrl+,` 与 ⚙ 双入口；旧 SettingsPanel.svelte 退役删除）。
- [ ] **Step 4: 跑测试 + typecheck + build:e2e**
- [ ] **Step 5: Commit** `feat(settings): 设置中心骨架与既有节迁移——弹层退役`

---

### Task 2: 草稿模型与 UI/JSON 双视图

**Files:**
- Create: `apps/web/src/lib/settingsDraft.ts`（深拷贝/序列化/parse+校验/脏态/合并与替换纯函数）
- Modify: `apps/web/src/lib/SettingsCenter.svelte`（draft 注入既有节+JSON 视图 textarea+应用/放弃）
- Test: settingsDraft.test.ts

**Interfaces:**
- Produces: `openDraft(settings): Draft`、`draftToJson(draft): string`、`applyJson(draft, text): { ok: true } | { ok: false; errors: [{ field, message }] }`（白名单镜像校验）、`isDirty(draft, settings): boolean`、`commit(draft): void`（saveSettings）、`mergeImported(current, imported): Settings` / `replaceImported(imported): Settings`（Task 3 消费）。

- [ ] **Step 1: 写失败测试**（往返等价/校验错误分类【未知字段/类型/clamp】/脏态/合并保留缺项/替换整体覆盖/JSON 格式错误保文本）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（JSON 视图行号栏 textarea；表单→JSON 序列化即格式化；JSON→表单 parse 失败标错停留）。
- [ ] **Step 4: 跑测试确认通过 + 回归**
- [ ] **Step 5: Commit** `feat(settings): 草稿模型与 UI/JSON 双视图`

---

### Task 3: 导入导出

**Files:**
- Modify: `apps/web/src/lib/SettingsCenter.svelte`（关于前各分组外的「导入/导出」动作区——或放左导航底部动作区，取实现简者）
- Modify: `apps/web/src/lib/settingsDraft.ts`（exportSettingsFile/importSettingsFile 纯函数补齐）
- Test: settingsDraft.test.ts 追加

**Interfaces:**
- Consumes: Task 2 merge/replace。
- Produces: 导出 Blob 下载（`vviewer-settings-YYYYMMDD.json`）；导入 file input→parse→schemaVersion 检查（更高版本警告）→白名单校验→变更摘要对话框→合并/替换二选一→应用。

- [ ] **Step 1: 写失败测试**（导出结构/导入合并缺项保留/替换/未知字段警告/版本不匹配警告/校验失败不部分应用）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（下载 a[download]；导入对话框展示变更摘要+radio 二选一+确认执行）。
- [ ] **Step 4: 跑测试确认通过 + 回归**
- [ ] **Step 5: Commit** `feat(settings): 导入导出——schemaVersion 文件与二选一语义`

---

### Task 4: 存储与数据管理 + 关于分节

**Files:**
- Create: `apps/web/src/lib/storageHealth.ts`（用量计算共享模块：estimate 聚合/localStorage UTF-16 估算/IndexedDB 分 store 计数与体积/persist 封装）
- Modify: `apps/web/src/lib/SettingsCenter.svelte`（「存储与数据」节七分类+「关于」节）
- Test: storageHealth.test.ts + 相关单测

**Interfaces:**
- Produces: `collectStorageInfo(): Promise<StorageInfo>`（§2.1 口径）、`purgeCategory(cat): Promise<PurgeResult>`（七分类删除语义 spec §2.2 表格逐行）、`requestPersistent(): Promise<boolean>`、`persistedState()`。

- [ ] **Step 1: 写失败测试**（estimate 缺失降级/localStorage 估算求和/分 store 计数 fake-indexeddb/七分类删除语义逐行【快照键保留 dirHandle/字体 document.fonts 注销/代理挂载 DELETE 尝试/运行时缓存清保留 precache】/恢复出厂全序列【SW 注销 mock】/persist granted-denied-异常）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（删除即时生效项走既有订阅链；恢复出厂后 location.reload；配额错误文案附「设置→存储与数据」引导——fonts/mounts 写入路径补挂；字体上传 persist 静默钩子【Task 4 fonts store 的 add 成功回调处，spec §2.1 预授权】）。
- [ ] **Step 4: 跑测试确认通过 + 回归**
- [ ] **Step 5: Commit** `feat(settings): 存储与数据管理七分类+关于分节与持久化申请`

---

### Task 5: e2e + 门禁 + 文档

**Files:**
- Create: `apps/web/e2e/b-settings-center.spec.ts`；Modify: `README.md`

- [ ] **Step 1: e2e**：①打开/导航/Esc/Ctrl+, 双入口 ②表单改动反映 JSON 视图、非法 JSON 阻断 ③应用后订阅链生效（外观+字体+布局一次提交）④导入合并/替换两路径 ⑤脏态确认弹窗 ⑥存储管理分类清除（设置重载回落默认/字体清除 UI 回退）⑦关于分节用量显示与刷新（estimate mock）⑧TopBar 精简回归（亮暗快切/⚙）。
- [ ] **Step 2: 门禁**：typecheck + 全仓 vitest + build:e2e + b-settings-center 定向 + 既有 b-fonts/b-md-syntax 回归核对（SettingsPanel 退役的波及面）。
- [ ] **Step 3: README 设置行 + Commit** `test(e2e): 设置中心冒烟+README 同步`

---

### 实施风险与裁决预留

- SettingsPanel 五节迁移的组件抽取形态（片段组件 vs 整段复制）——取改动最小者，报告记录；迁移后既有 SettingsPanel 测试文件迁移或退役。
- StorageManager API 在 jsdom 的缺失——storageHealth 测试以 mock navigator.storage（先例：persist 状态机 mock）。
- 恢复出厂的 SW 注销在 e2e 会破坏后续用例——e2e 中恢复出厂用例放最后或独立 project 顺序保证。
- 七分类中「挂载配置」依赖 Spec 5 未落地（mounts store 不存在）——**本任务按 spec §2.2 实现分类骨架但该行以「目录挂载（即将推出）」禁用态渲染，Spec 5 落地后启用**（裁决：跨 spec 顺序依赖的前向兼容，报告记录）。
- runes 组件不可 vitest 直测——组件层走源码契约+e2e（先例形态）。
