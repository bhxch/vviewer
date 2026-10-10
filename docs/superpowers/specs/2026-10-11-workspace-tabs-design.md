# 设计：workspace 多根工作区、tab 分组与 tab 管理面板（含服务端多 root）

- 日期：2026-10-11
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-06-vviewer-design.md`（单根约束的原始裁决，本设计将其拆除）、`2026-10-11-browser-tab-actions-design.md`（tab 动作在本模型之上实施）

## 1. 背景与目标

现状：无 workspace 概念；「目录 tab + TreeStore」事实上是唯一工作区，且**单根约束写死**（`addDirStoreTab` 打开新目录前先关闭全部既有目录 tab，原 spec 明示「不做多根工作区」）；tab 平铺无分组；无 tab 总览入口。服务端 root 由启动参数固定为单值，`guard::resolve` 只对单 root 做越界防护，watcher 单根挂载。

目标：引入 workspace 实体——命名、多来源根、自有 tab 组，可切换；创建 workspace 可从浏览器添加文件/文件夹，有后端时可从服务器路径添加；提供覆盖层 tab 管理面板，按 workspace 分组总览全部 tab。为支撑「从后端选路径」，服务端 `--root` 升级为可多值。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 管理页形态 | **覆盖层面板**（非独立路由/侧栏视图）：TabBar 右端按钮 + 快捷键 `Alt+W` 唤起，按 workspace 分组列出全部 tab，支持搜索、跨组点击激活、快捷关闭 |
| 根构成 | **workspace 多根**：命名容器，可陆续添加多个来源（本地文件夹/本地文件/后端路径），tab 归属 workspace |
| 后端路径范围 | **限各 `--root` 子树内**，但 `--root` 支持重复传参形成多根；不做任意路径浏览 |
| 远端来源粒度 | 仅「目录」或「单文件」可作为远端源（不做远端多选文件集） |
| 单根兼容 | 服务端单 `--root` 语义与 API 形状完全不变（新参数全部可选、缺省 0 号根）；旧前端快照一次性迁移为单 workspace |
| tab 动作 | pin/关闭其他/拖拽等浏览器式动作**不在本设计**，见 F 项（在本模型组内语义之上实施） |

### 非目标

- 不做 workspace 级独立排除规则（沿用全局 `excludedPatterns`）。
- 不做 workspace 导入导出、跨设备同步、拖拽排序 workspace。
- 不做云端/多用户；server 仍单用户 Bearer 模型。

## 2. 设计

### 2.1 服务端多 root（阶段 1）

- **CLI**：`--root <PATH>` 可重复（≥1 必填语义不变）；`main` 逐个校验目录存在并 canonicalize。
- **AppState**：`roots: Vec<RootSpec { raw: PathBuf, canonical: PathBuf }>`；`root`/`root_canonical` 字段保留为「默认根 = roots[0]」兼容视图（`AppState::new` 签名不变，既有测试零改动）；新增 `with_roots(Vec<PathBuf>)`。
- **guard**：`resolve(state, raw, root_idx)`——`clean_relative` 以所选根为基准，canonicalize 后越界校验对所选根；`root_idx` 越界 → 400。
- **API**：`/api/tree`、`/api/file`、`/api/compute/*` 增加可选 `root`（0-based 索引，缺省 0）；`POST /api/search` 的 `root` 语义：缺省 = **跨全部根**搜索（rg/grep 均支持多目录参数，此时 `path` 必须缺省，传了报 400）；指定 `root` = 限定该根，`path` 相对该根解析。多根跨根搜索时命中帧新增 `"root": <index>` 字段，单根或限定单根时省略（与现状帧形状兼容）。
- **watch/SSE**：每根一个 notify watcher 实例聚合进现有 `ChangeHub`；SSE 事件帧新增 `root` 字段（单根省略）。ticket 机制不变。
- **health**：新增 `roots: Option<usize>`（=1 省略）——前端「从后端选路径」据此决定是否先展示根选择。
- 文档：deploy.md 更新多根示例与语义（各根独立越界防护；搜索跨全部根）。

### 2.2 前端模型与来源（阶段 2）

```ts
interface Workspace { id: `w${number}`; name: string; sources: WorkspaceSource[]; createdAt: number; }
interface WorkspaceSource {
  kind: 'localfs' | 'localfiles' | 'remote' | 'single' | 'url';
  storeId: string; storeLabel: string; storeBase?: string; // remote 重连用
}
// Tab 新增 workspaceId；TabCollection 增加 activeWorkspaceId
```

- **TreeStore 复用**：source 即既有 5 类 TreeStore 的注册描述；workspace 持有多个 store，同 store 多次添加去重（按 storeId）。
- **RemoteStore 扩展**：新增可选 `rootIndex`（默认 0）与 `basePath`（根内子路径，远端「子目录作源」用）；树/文件读取时拼接；storeId 编码为 `remote:<hash(base:label)>:r<n>[:<hash(basePath)>]`，旧格式解析缺省 `r0` 无 basePath（旧快照兼容）。
- **单根约束拆除**：废除 `addDirStoreTab` 的「先关全部目录 tab」替换语义；打开文件夹/文件一律加入**当前 workspace**（重复添加去重）；删除目录 tab 仅移除该 tab，不动 source。
- **文件树多根**：`FileTree` 接收当前 workspace 的 source 列表，逐源渲染顶层节点（源名 + 现有单树组件复用）；源级操作：折叠/移除源（移除确认：将关闭该源下全部 tab）。
- **QuickOpen（Ctrl+P）**：扫描范围从「当前 store」扩为「当前 workspace 全部源」，结果带源名前缀。
- **持久化**：IndexedDB 新 key `workspaces`：

```ts
interface WorkspacesSnapshot {
  version: 2;
  workspaces: { id; name; sources: WorkspaceSource[];
                tabs: TabSnapshot[] /* TabSnapshot 增 workspaceId, 兼容旧字段 */ ;
                activeTabId?: string }[];
  activeWorkspaceId: string;
}
```

  迁移：读不到 `workspaces` 而存在旧 `tabs` key → 构造单 workspace「默认」收纳全部旧 tab 与已打开目录 source，写新 key；此后只读写 `workspaces`。恢复语义沿用现状三态（localfs 权限重确认 / remote 按 storeBase 重连（含 rootIndex）/ 其余占位 unrestorable）。

### 2.3 UI（阶段 3）

- **workspace 切换器**（TopBar，打开按钮右侧下拉）：列出全部 workspace（活动项高亮）、新建、重命名、删除（删除确认：连带关闭其全部 tab；至少保留一个 workspace，删最后一个先建空默认）。≤600px 收进 TopBar 溢出菜单。
- **新建流程**：模态——命名（默认「工作区 N」）→ 可选立即添加来源（本地文件夹 / 本地文件 / 后端路径，均可跳过）→ 创建并切换。
- **后端路径来源模态**：需已连接服务器；health `roots>1` 先选根（显示根路径）→ `/api/tree?root=n` 逐层浏览（沿用 Bearer/token 与现有 fetch 封装）→ 选「将此目录作为来源」或「将此文件作为来源」；断线/越界按既有错误卡片语义提示。
- **TabBar**：仅渲染当前 workspace 的 tabs（顺序即数组序）；tab 上显示来源徽标（多源 workspace 区分归属）。
- **Tab 管理面板（覆盖层）**：`WorkspaceTabsPanel.svelte`——入口 TabBar 右端「管理」按钮 + `Alt+W`；半屏浮层：搜索框过滤（名称/路径）、按 workspace 分组（活动组在前，组头可折叠）、每行 tab 条目（名称、来源徽标、路径）支持点击激活（跨 workspace 自动切换）、悬停快捷关闭、Esc 关闭；组尾显示「+ 添加来源」快捷入口。面板无 tab 的空 workspace 显示来源数与「打开文件」引导。

### 2.4 状态与动作迁移要点

- `TabCollection.add/close/activate` 增加作用域参数（默认当前 workspace）；`close` 后激活邻位逻辑保持在组内。
- `persistScroll`、SSE `refreshPaths`、archive 打开事件等既有链路以 `tab.workspaceId` 归位，无需感知分组。
- 全局键位新增 `Alt+W`（无浏览器占用冲突）；`Ctrl+Shift+F` 全局搜索与 `Ctrl+P` QuickOpen 同步扩域为「当前 workspace 全部源」。

## 3. 测试

- 服务端集成（多根）：`--root a --root b` 下 tree/file 的 `root` 参数路由与越界 403/400；search 跨根命中帧 `root` 字段；SSE 事件 root 归属；单根请求形状回归不变。
- 单测：workspace store（增删改/去重/至少一个不变式）；快照 v2 迁移（旧 tabs → 单 workspace）与往返；RemoteStore storeId 编解码（旧格式/新格式/basePath）；TabCollection 作用域动作。
- e2e：新建 workspace + 添加远端来源（server e2e 通道）+ 切换 + tab 归组；管理面板搜索/跨组激活/关闭；多根服务端 tree 浏览选源；刷新恢复（workspace 结构、localfs 重授权、remote 重连）。

## 4. 风险与已知限制

- 单根假设散布：`guard::resolve` 调用点、watcher、状态栏根名展示等需逐点盘点（阶段 1 首任务列出清单再动手）。
- SSE 事件帧加字段对旧前端无害（多余字段忽略）；旧前端新服务端组合下多根的 `roots>1` 健康字段被忽略，行为退化为「只见 0 号根」，可接受。
- FS Access 目录源在 e2e 无法原生驱动：沿用既有 upload/remote 通道覆盖，真机链路为已知无法完成项（与历史 e2e 报告口径一致）。
- 远端子目录源的 `basePath` 拼接需与 watcher/SSE 刷新路径对齐（事件 path 为根相对，需按源换算），阶段 2 单测锁死。

## 5. 验收

| 项 | 标准 |
| --- | --- |
| 服务端 | 多根 tree/file/search/watch 全链路集成测试绿；单根 API 形状回归不变 |
| 模型 | workspace 增删改/迁移/恢复单测绿；旧快照升级无感 |
| UI | 创建/切换/添加来源（浏览器 + 后端路径）/管理面板/文件树多根可用，移动端收拢 |
| 回归 | vitest / typecheck / cargo / playwright（默认 + 服务端）全绿 |

交付顺序：阶段 1 服务端多 root → 阶段 2 模型与持久化 → 阶段 3 UI；每阶段独立 commit，TDD。
