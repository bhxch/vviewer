# workspace 多根工作区、tab 分组与 tab 管理面板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端 `--root` 多值（API 可选 `root` 参数向后兼容）、前端 workspace 实体（命名多来源根、自有 tab 组、快照 v2 迁移）、workspace 切换器/创建流程/后端路径来源、覆盖层 tab 管理面板（Alt+W）。

**Architecture:** 三阶段——①服务端多 root（CLI `Vec<PathBuf>`、`AppState.roots` + 兼容视图、`guard::resolve(state, raw, root_idx)`、tree/file/compute 可选 `root`、search 缺省跨全部根、watch 每根一 watcher 聚合进现有 ChangeHub、health `roots` 字段）；②前端模型（workspace store 纯逻辑单测、`Tab.workspaceId`、TabCollection 作用域化、废除 `addDirStoreTab` 替换语义、快照 key `workspaces` 一次性迁移、RemoteStore `rootIndex/basePath`）；③UI（切换器/创建模态/来源模态/管理面板/TabBar 组内过滤/文件树多根）。

**Tech Stack:** Rust（clap 多值、notify 多实例聚合、axum Query 可选参数）；Svelte 5 runes；vitest（workspace store 纯逻辑——`.svelte.ts` 不可单测，纯逻辑抽 `.ts`）；Playwright（前端 + e2e-server）。

**Spec:** `docs/superpowers/specs/2026-10-11-workspace-tabs-design.md`

## Global Constraints

- **兼容铁律**：单 `--root` 语义与 API 形状完全不变——新参数全部可选、缺省 0 号根；`AppState::new` 签名不变（10+ 调用点零改动）；`root`/`root_canonical` 字段保留为 roots[0] 兼容视图；旧前端/旧快照零破坏（快照 v2 一次性迁移）。
- **search 多根语义**：请求缺省（无 `root`）= 跨全部根，此时 `path` 必须缺省（传了 → 400）；`root` 指定 = 限定该根，`path` 相对该根。跨根搜索命中帧增 `"root": <index>`；单根或限定单根时省略。
- **watch 帧**：`{"type":"changed","paths":[...]}` 多根时增 `"root": <index>`；单根时帧形状与现状逐字节等价。每根一个 notify watcher 实例聚合进现有 ChangeHub（broadcast/debounce/健康状态共享）。
- **workspace 模型**：`Workspace { id: 'w1' 起序号, name, sources: WorkspaceSource[], createdAt }`；`WorkspaceSource { kind: 'localfs'|'localfiles'|'remote'|'single'|'url', storeId, storeLabel, storeBase? }`；`Tab.workspaceId`；**至少保留一个 workspace**（删最后一个先建空默认）；source 按 storeId 去重。
- **快照 v2**：IndexedDB kv 新 key `workspaces`（kv 是键值 store，**无需升 DB 版本**——现 DB_VERSION 已为 2）；`WorkspacesSnapshot { version: 2, workspaces: [{id,name,sources,tabs:TabSnapshot[],activeTabId?}], activeWorkspaceId }`；迁移：`workspaces` 缺失而 `tabs` 存在 → 单 workspace「默认」收纳；迁移后只读写 `workspaces`（`tabs` 键保留最后一次迁移副本不更新）。
- **恢复语义沿用现状三态**：localfs 重授权 / remote 按 storeBase 重连（含 rootIndex/basePath）/ 其余占位 unrestorable。
- **RemoteStore 扩展**：storeId 编码 `remote:<hash(base:label)>:r<n>[:<hash(basePath)>]`；旧格式解析缺省 r0、无 basePath；`request()` 拼 `&root=<n>`；watch 回调 paths 按 rootIndex/basePath 换算（单测锁死）。
- **远端来源粒度**：仅目录或单文件可作为远端源（spec 决策）。
- **UI 锚点**：切换器在 TopBar（≤600px 收进溢出）；管理面板入口 TabBar 右端按钮 + `Alt+W`；面板类名 `.vv-wspanel`（浮层，Esc/外点关闭）；`Ctrl+P`/`Ctrl+Shift+F` 扫描/搜索范围扩为当前 workspace 全部源。
- 中文注释讲 why；TDD；每任务独立 commit（Angular 中文 message）。
- 门禁：`cargo test --manifest-path server/Cargo.toml`（阶段 1）、`pnpm test`、`pnpm typecheck`、svelte-check 基线（stash 法）不新增；e2e 影响清单见 Task 7。

---

### Task 1: 服务端多 root 地基——CLI/AppState/guard/tree/file/compute

**Files:**
- Modify: `server/src/main.rs`（L20-21 root → 可重复 Vec；L86 ServeArgs；L118-123 校验逐个；L145-152 传 roots）
- Modify: `server/src/state.rs`（roots: Vec<RootSpec> + 兼容视图 + with_roots + ChangeHub 暂仍挂 roots[0]——多根聚合在 Task 2）
- Modify: `server/src/guard.rs`（resolve 增 root_idx）
- Modify: `server/src/routes/tree.rs` / `server/src/routes/file.rs` / `server/src/compute/highlight.rs`（Query/请求体增可选 root）
- Modify: `server/tests/tree_file.rs`（多根用例）+ `server/tests/security.rs`（root 参数越界）

**Interfaces:**
- Produces:
  - `RootSpec { raw: PathBuf, canonical: PathBuf }`；`AppState.roots: Vec<RootSpec>`；`root`/`root_canonical` 保留（= roots[0]）；`with_roots(Vec<PathBuf>)`（逐个 canonicalize，失败回退原路径——与 new 同款）
  - CLI：`#[arg(long)] root: Vec<PathBuf>`（可重复，≥1 由 main 校验：空 → error exit 2）
  - `guard::resolve_at(state, raw, root_idx: usize) -> Result<PathBuf, AppError>`（root_idx 越界 → 400 "root index out of range"；基准/越界校验对所选根）；`resolve(state, raw)` 保留 = `resolve_at(state, raw, 0)`
  - TreeQuery/FileQuery 增 `pub root: Option<usize>`；HighlightRequest 增 `root: Option<usize>`（serde 默认字段名，前端补发）

- [ ] **Step 1: 写失败集成测试**（tree_file.rs 追加，双 tempdir fixture）：

```rust
// ---------- 多 root（E 项阶段 1） ----------
fn multi_root_fixture() -> (tempfile::TempDir, tempfile::TempDir, AppState) {
    let d0 = tempfile::tempdir().unwrap();
    let d1 = tempfile::tempdir().unwrap();
    std::fs::write(d0.path().join("a.txt"), "root zero\n").unwrap();
    std::fs::create_dir(d1.path().join("sub")).unwrap();
    std::fs::write(d1.path().join("sub/b.txt"), "root one\n").unwrap();
    let state = vviewer::state::AppState::new(d0.path().to_path_buf(), None, None, false, None)
        .with_roots(vec![d0.path().to_path_buf(), d1.path().to_path_buf()]);
    (d0, d1, state)
}

#[tokio::test]
async fn tree_accepts_root_index_and_defaults_to_zero() {
    let (_d0, _d1, state) = multi_root_fixture();
    let app = vviewer::build_router(state);
    // 缺省 = 0 号根（兼容现状形状）
    let (s0, body0) = get(&app, "/api/tree").await;
    assert_eq!(s0, 200);
    assert!(serde_json::from_slice::<serde_json::Value>(&body0).unwrap()["entries"]
        .as_array().unwrap().iter().any(|e| e["name"] == "a.txt"));
    // root=1 → 1 号根
    let (s1, body1) = get(&app, "/api/tree?root=1").await;
    assert_eq!(s1, 200);
    assert!(serde_json::from_slice::<serde_json::Value>(&body1).unwrap()["entries"]
        .as_array().unwrap().iter().any(|e| e["name"] == "sub"));
    // root 越界 → 400
    let (s2, _) = get(&app, "/api/tree?root=5").await;
    assert_eq!(s2, 400);
    // root=1 下的相对 path 相对 1 号根解析
    let (s3, body3) = get(&app, "/api/tree?root=1&path=sub").await;
    assert_eq!(s3, 200);
    assert!(serde_json::from_slice::<serde_json::Value>(&body3).unwrap()["entries"]
        .as_array().unwrap().iter().any(|e| e["name"] == "b.txt"));
}

#[tokio::test]
async fn file_honors_root_index_and_escape_check_targets_selected_root() {
    let (_d0, _d1, state) = multi_root_fixture();
    let app = vviewer::build_router(state);
    let (s, body) = get(&app, "/api/file?root=1&path=sub/b.txt").await;
    assert_eq!(s, 200);
    assert!(String::from_utf8(body).unwrap().contains("root one"));
    // 越界校验对所选根：0 号根文件用 root=1 找不到 → 404；而非 0 号根视角的误判
    let (s2, _) = get(&app, "/api/file?root=1&path=a.txt").await;
    assert_eq!(s2, 404);
}
```

（`get(&app, uri)` 若与现有 helper 签名不符按 tree_file.rs 现状适配——现有 `get/get_with` 已在 L43-61。）

- [ ] **Step 2: 跑测试确认失败**（with_roots 不存在 / root 参数被忽略）
- [ ] **Step 3: 实现**（要点：clap `root: Vec<PathBuf>`；main 校验 `roots.is_empty()` → error；逐个 is_dir；`with_roots` 内 canonicalize；`resolve_at` 按 `state.roots.get(idx)` 取 RootSpec；tree/file 的 Query 增 `root: Option<usize>` 传 `resolve_at`；compute/highlight.rs L445 同理——`HighlightRequest` 增字段。`AppState::new` 内 `roots: vec![RootSpec{raw: root.clone(), canonical: root_canonical.clone()}]`，`root`/`root_canonical` 字段保留原赋值）
- [ ] **Step 4: 跑 server 全量测试**（`cargo test --manifest-path server/Cargo.toml`）——既有 9+ 处 `AppState::new` 零改动全绿
- [ ] **Step 5: Commit**

```bash
git add server/src/main.rs server/src/state.rs server/src/guard.rs server/src/routes/tree.rs server/src/routes/file.rs server/src/compute/highlight.rs server/tests/tree_file.rs
git commit -m "feat(server): --root 多值地基与 API 可选 root 参数

why: workspace 后端来源需服务端多根（spec E 阶段 1）。
what: CLI root 可重复 + AppState.roots 兼容视图 + resolve_at(root_idx)
+ tree/file/compute 可选 root（缺省 0 号根，单根形状不变）。"
```

---

### Task 2: 服务端 search 多根 + watch 多根聚合 + health roots

**Files:**
- Modify: `server/src/routes/search.rs`（SearchRequest.root、跨根语义、FrameParser 根感知、帧 root 字段）
- Modify: `server/src/watch.rs`（ChangeHub 多根聚合 + changed 帧 root 字段）
- Modify: `server/src/state.rs`（ChangeHub 挂载全部根）
- Modify: `server/src/routes/health.rs`（roots 字段）
- Modify: `server/tests/search.rs` / `server/tests/events.rs`

**Interfaces:**
- Consumes: Task 1 `RootSpec/roots`。
- Produces:
  - `SearchRequest { ..., root: Option<usize> }`；语义：`root=None` 且 `path=Some` → 400 "path requires an explicit root"；`root=None` → 目录参数 = 全部根（rg/grep 多目录 `.arg()` 逐个追加）；`root=Some(i)` → 该根 + path 相对该根。
  - `FrameParser::Rg { roots: Vec<PathBuf> }` / `Grep { roots: Vec<PathBuf> }`——`match_frame`/`grep_frame` 的 strip_prefix 改为「逐根尝试，命中即剥并返回 (rel, root_idx)」；跨根（roots.len()>1）时命中帧加 `"root": <idx>`；单根形状不变。
  - watch：`ChangeHub::spawn(roots: &[PathBuf])`（签名变更——内部每根一个 watcher 线程 + notify 实例，事件携带根索引进同一 debounce 聚合）；changed 帧多根时 `{"type":"changed","paths":[...],"root":<idx>}`，单根逐字节等价；`collect_event(ev, root, out)` 按根参数化。
  - `Health.roots: Option<usize>`（=1 省略）。

- [ ] **Step 1: 写失败测试**：
  - search.rs：双根 fixture（两 tempdir 各含 needle 文件）→ 无 root 有 path → 400；无 root 无 path → 命中帧含两根文件且各带 `"root": 0/1`；`root=1` → 仅 1 号根命中、帧无 root 字段。单根形状回归：既有用例全绿即证。
  - events.rs：双根 fixture → 改 d1 文件 → changed 帧 `root: 1` 且 paths 相对 d1；单根回归（现有用例）帧无 root 字段。
  - health.rs：多根 → `roots: 2`；单根 → 字段省略（现有 `no_compute_omits_language_list` 风格）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（watch.rs 的 spawn 签名变更波及 state.rs L95 与 events 测试 fixture——`ChangeHub::spawn(&roots)` 收 `&[PathBuf]`；每根 watcher 线程共享 tx/health/stop；session_loop 聚合事件带根索引：把 `collect_event` 的输出从 `BTreeSet<String>` 改为 `BTreeMap<usize, BTreeSet<String>>`，逐根发帧）
- [ ] **Step 4: server 全量测试绿**（含 A 项 grep fallback 回归）
- [ ] **Step 5: Commit**

```bash
git add server/src/routes/search.rs server/src/watch.rs server/src/state.rs server/src/routes/health.rs server/tests/search.rs server/tests/events.rs
git commit -m "feat(server): search 跨根语义、watch 多根聚合与 health roots 宣告

why: 多根下的搜索/变更推送/能力发现（spec E 阶段 1 收口）。
what: search root 参数（缺省跨根+path 互斥 400+帧 root 字段）+
ChangeHub 按根聚合（changed 帧 root 字段，单根逐字节等价）+ health roots。"
```

---

### Task 3: 前端 workspace 模型 + TabCollection 作用域化 + 快照 v2 + RemoteStore 扩展

**Files:**
- Create: `apps/web/src/lib/workspaceStore.ts`（纯逻辑，vitest 可单测）+ `apps/web/src/lib/workspaceStore.test.ts`
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（Tab.workspaceId、TabCollection 作用域、快照 v2、废除替换语义）
- Modify: `apps/web/src/lib/stores/session.ts`（WorkspacesSnapshot + loadWorkspaces/saveWorkspaces + 迁移）
- Modify: `packages/core/src/tree/remote.ts`（rootIndex/basePath）
- Modify: `apps/web/src/lib/session` 相关测试（新建迁移测试于 workspaceStore.test.ts 或独立）

**Interfaces:**
- Produces:
  - `workspaceStore.ts`（非 runes 纯逻辑 + 轻量订阅，模式仿 settings.ts）：
    - `interface Workspace { id: string; name: string; sources: WorkspaceSource[]; createdAt: number }`
    - `interface WorkspaceSource { kind: 'localfs'|'localfiles'|'remote'|'single'|'url'; storeId: string; storeLabel: string; storeBase?: string; rootIndex?: number; basePath?: string }`
    - `createWorkspaceState(): { list, activeId, add(name, sources?), rename(id,name), remove(id), setActive(id), addSource(wsId, source)（storeId 去重）, removeSource(wsId, storeId), ensureNonEmpty()（删最后先建默认）, nextId()（'w1' 起序号）, replaceAll(snapshot)（迁移/恢复入口） }`——快照往返与迁移（旧 tabs 快照 → 单 workspace）为纯函数 `migrateLegacyTabs(tabs: TabSnapshot[]): WorkspacesSnapshot`。
  - openFlow：`Tab.workspaceId`；`TabCollection` 增 `activeWorkspaceId`（委托 workspaceStore 单例）；`add/close/activate` 作用域当前 workspace（close 邻位激活限组内）；`list` 选择器不变（全量），新增 `tabsOf(wsId)`；`persist()` 改写 `saveWorkspaces(...)`（组 TabSnapshot 进所属 workspace、activeTabId）；**废除 addDirStoreTab L443-445 替换扫描**（目录 tab 加入当前 workspace；同 storeId 已有目录 tab 则激活之——去重语义）；`seedSeqFromSnapshots` 兼容 v2。
  - session.ts：`loadWorkspaces(): Promise<{ snapshot: WorkspacesSnapshot | null; legacyTabs: TabSnapshot[] }>`——读 `workspaces` 缺失则回落读 `tabs`（不删旧键）；`saveWorkspaces(s)`。
  - remote.ts：`createRemoteStore(baseUrl, token, dirLabel, opts?: { rootIndex?: number; basePath?: string })`；storeId 新编码（旧格式解析兼容——`getRemoteBase` 等既有解析函数同步适配）；`request()` 拼 root 与 basePath（tree: `?root=n&path=<basePath>/<path>`；file 同）；watch 回调 paths 换算为「源相对」再回调（rootIndex !== 0 或 basePath 存在时：path 必须前缀匹配 basePath 才回调，剥离之；带 root 参数的 SSE 帧按 rootIndex 过滤）。

- [ ] **Step 1: 写失败测试**（workspaceStore.test.ts：增删改/去重/至少一个不变式/nextId/migrateLegacyTabs 旧快照→单 workspace/快照往返；remote 换算与 storeId 编解码放 `packages/core/test/remote.test.ts`——若该文件不存在则新建，fake fetch 先例参照 tree 相关既有 core 测试）：

```ts
// workspaceStore.test.ts 关键用例（语义锚）：
// - 空态 ensureNonEmpty 建默认；remove 最后一个先建再删
// - addSource 按 storeId 去重（重复返回既有）
// - migrateLegacyTabs([{...旧 TabSnapshot}]) → 单 workspace {id:'w1', name:'默认', sources:[...由 tabs 派生], tabs:[原样]}
//   sources 派生规则：tabs 中 path==='' 的目录来源（storeId/storeLabel/storeBase）+ 非 '' 的不产生 source
// - replaceAll/快照往返字段无损
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（注意：workspaceStore 是纯逻辑 + 订阅；openFlow 的 TabCollection 与其集成属 Svelte 侧——集成处仅做委托，复杂逻辑全在纯模块。`addDirStoreTab` 改造后 `connectServer` 的同 base 关旧 remote tab 循环保留）
- [ ] **Step 4: 跑测试确认通过 + `pnpm test && pnpm typecheck`**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/workspaceStore.ts apps/web/src/lib/workspaceStore.test.ts apps/web/src/lib/openFlow.svelte.ts apps/web/src/lib/stores/session.ts packages/core/src/tree/remote.ts packages/core/test/remote.test.ts
git commit -m "feat(web,core): workspace 模型、tab 作用域化与快照 v2

why: 多根工作区的模型与持久化地基（spec E 阶段 2）。
what: workspaceStore 纯逻辑（增删改/去重/迁移）、Tab.workspaceId+
TabCollection 作用域化、废除目录 tab 替换语义、workspaces 快照键
一次性迁移、RemoteStore rootIndex/basePath 编码与请求/watch 换算。"
```

---

### Task 4: 恢复链路 + 文件树多根 + QuickOpen/GlobalSearch 扩域

**Files:**
- Modify: `apps/web/src/lib/AppShell.svelte`（restore v2 + dirStore→sources 数组 + 面板 props 传源列表）
- Modify: `apps/web/src/lib/FileTree.svelte`（props `sources: { label: string; store: TreeStore }[]`；顶层源节点 each；源级折叠/移除入口——移除按钮 `title` 即可，confirm 后调 removeSource 并关闭该源 tabs）
- Modify: `apps/web/src/lib/QuickOpenPanel.svelte` + `apps/web/src/lib/quickOpen.ts`（多源并行扫描 + 结果源前缀显示 + 打开时按源 addTab）
- Modify: `apps/web/src/lib/GlobalSearchPanel.svelte` + `apps/web/src/lib/globalSearch.ts`（grepStoreLocal 扩多源；grepRemote 无 root 参数变化——远端跨根搜索 path 必须缺省：多根 remote 源时请求不带 path）
- Modify: `apps/web/src/lib/stores/session.ts` 如需微调

**Interfaces:**
- Consumes: Task 3 workspaceStore/TabCollection/RemoteStore。
- Produces:
  - AppShell：`const sources = $derived(currentWorkspace.sources.map(s => ({ label: s.storeLabel, store: storeById(s.storeId) })))`（store 实例注册表——openFlow 维护 `activeStores: Map<storeId, TreeStore>`，add/close 时增删）；`restore()` 走 v2 快照（workspace 循环：先建 sources 对应 store——localfs 走 tryRestoreDirectory、remote 走 reconnect、localfiles/single/url 占位——再逐 tab 恢复 + alignActive 按 workspace）；`onTreeOpen` 用命中的源 store（TreeNodeRow 回调携带 store 或 FileTree 闭包绑定）。
  - FileTree：`{#each sources as src}` 顶层源名行（`.vv-tree-src`）+ 该源 `<TreeNodeRow store={src.store} ...>`；源级「移除」小按钮（confirm 文案「将关闭该来源下全部 tab」）。
  - quickOpen.ts：`listFilesRecursively(sources, patterns)` 多源串行/并行扫描（结果 `{ path, name, storeId }`）；面板结果行显示 `源名 / path`。
  - GlobalSearchPanel：props 改 `sources`；本地 grep 逐源扫描合并结果；远端 grep：当前 workspace 的 remote 源（同 base）合并为一次请求（多根跨根 → 无 path），单根源维持现状带 path。

- [ ] **Step 1: 写失败测试**（quickOpen.ts 多源扫描纯逻辑测试——`apps/web/src/lib/quickOpen.test.ts` 若不存在新建，fake store 对象手造）：
  - 双源各 2 文件 → 结果 4 条各带 storeId；排除规则跨源生效；maxFiles 全局上限。
  - AppShell restore/FileTree 属组件层，vitest 不可达——以 e2e（Task 7）兜底，本任务静态保证 + typecheck。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（restore 迁移细节：legacy 快照路径 = migrateLegacyTabs 产物走同一 v2 恢复函数；`dirRev` key 改为按源聚合 rev——refreshPaths 已按 storeId 命中 tab.rev，文件树 key 用 `${sources.length}|${excludedPatterns}` 加各源 store.rev 聚合即可，实现时选最简）
- [ ] **Step 4: 跑测试确认通过 + `pnpm test && pnpm typecheck`**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/AppShell.svelte apps/web/src/lib/FileTree.svelte apps/web/src/lib/TreeNodeRow.svelte apps/web/src/lib/QuickOpenPanel.svelte apps/web/src/lib/quickOpen.ts apps/web/src/lib/quickOpen.test.ts apps/web/src/lib/GlobalSearchPanel.svelte apps/web/src/lib/globalSearch.ts apps/web/src/lib/openFlow.svelte.ts
git commit -m "feat(web): 恢复链路 v2、文件树多根与搜索/快速打开扩域

why: workspace 来源需贯穿恢复/浏览/搜索（spec E 阶段 2 收口）。
what: restore 走 v2 快照（localfs/remote/占位三态）、FileTree 多源顶层
节点+源级移除、QuickOpen/GlobalSearch 扫描与结果带源。"
```

---

### Task 5: workspace 切换器 + 创建流程 + 后端路径来源

**Files:**
- Modify: `apps/web/src/lib/TopBar.svelte`（切换器下拉 + 新建入口；≤600px 收进溢出菜单——现有 SettingsPanel 挂载模式参考）
- Create: `apps/web/src/lib/WorkspaceCreateModal.svelte`（命名 + 可选添加来源：本地文件夹/本地文件/后端路径）
- Create: `apps/web/src/lib/RemoteSourceModal.svelte`（后端路径浏览：health roots>1 先选根 → /api/tree?root=n 逐层 → 「将此目录作为来源」/「将此文件作为来源」）
- Modify: `apps/web/src/app.css`（最小样式，token 惯例）

**Interfaces:**
- Consumes: Task 3 workspaceStore、connectServer/createRemoteStore（远端源创建：`createRemoteStore(base, token, label, { rootIndex, basePath })` + addSource + 目录 tab）。
- Produces: UI——切换器显示当前 workspace 名（下拉列出全部 + 活动高亮 + 「新建工作区…」入口 + 每项重命名/删除图标）；创建模态：命名（默认「工作区 N」）+ 来源三选（可跳过）→ 创建并激活；远端来源模态：需已连接（loadLastServer/现连 base），roots>1 显示根选择（显示根路径），tree 逐层浏览（目录行点击进入、面包屑返回），「作为来源」按钮 → createRemoteStore({rootIndex, basePath}) → addSource → 目录 tab（basePath 为源根，path=''）。
- 需要的 openFlow 微增：`openRemoteSource(base, token, rootIndex, basePath)`（创建 store + addDirStoreTab 等价 + addSource）。

- [ ] **Step 1: 实现**（Svelte 5 runes；Esc/外点关闭仿 GlobalSearchPanel 模式；后端浏览沿用 connectServer 的 fetch 封装与 Bearer；错误走既有 serverError 提示风格）
- [ ] **Step 2: 门禁** `pnpm test && pnpm typecheck` + svelte-check stash 基线对比不新增
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/TopBar.svelte apps/web/src/lib/WorkspaceCreateModal.svelte apps/web/src/lib/RemoteSourceModal.svelte apps/web/src/lib/openFlow.svelte.ts apps/web/src/app.css
git commit -m "feat(web): workspace 切换器、创建流程与后端路径来源

why: 多 workspace 的用户入口（spec E §2.3 切换器/创建/后端来源）。
what: TopBar 切换器（新建/重命名/删除）+ 创建模态（三来源可选）+
RemoteSourceModal（多根选择+逐层浏览+目录/单文件作源）。"
```

---

### Task 6: tab 管理覆盖层面板 + TabBar 组内过滤

**Files:**
- Create: `apps/web/src/lib/WorkspaceTabsPanel.svelte`（覆盖层：搜索框 + 按 workspace 分组（活动组在前、组头可折叠）+ 行（名称/来源徽标/路径）点击激活（跨组自动 setActive）+ 悬停快捷关闭 + Esc/外点关闭 + 组尾「+ 添加来源」入口）
- Modify: `apps/web/src/lib/TabBar.svelte`（tabs props 改为当前 workspace 组内过滤值 + 右端「管理」按钮 + 来源徽标 span）
- Modify: `apps/web/src/lib/AppShell.svelte`（挂载面板 + Alt+W 全局键 + TabBar 传过滤后列表）
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: 面板类名 `.vv-wspanel`（搜索 `.vv-wspanel-search`、组头 `.vv-wspanel-group`、行 `.vv-wspanel-row`）；`Alt+W`（inField 判定沿用现 keydown 模式）；TabBar 仅渲染当前 workspace tabs（AppShell 传 `tabStore.tabsOf(activeWorkspaceId)`）。

- [ ] **Step 1: 实现**（面板为 `{#if}` 挂载仿 GlobalSearchPanel；搜索过滤名称/路径 contains；空 workspace 显示来源数与「打开文件」引导）
- [ ] **Step 2: 门禁** `pnpm test && pnpm typecheck` + svelte-check 基线
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/WorkspaceTabsPanel.svelte apps/web/src/lib/TabBar.svelte apps/web/src/lib/AppShell.svelte apps/web/src/app.css
git commit -m "feat(web): tab 管理覆盖层面板与 TabBar 组内过滤

why: 跨组总览与快捷触达（spec E §2.3 管理面板）。
what: WorkspaceTabsPanel（搜索/分组/跨组激活/快捷关闭/Alt+W）+
TabBar 当前 workspace 过滤与来源徽标。"
```

---

### Task 7: e2e 适配与新增 + 全量门禁 + 文档

**Files:**
- Modify: `apps/web/e2e/t-shell.spec.ts`（SHELL-06 目录 tab 语义适配：废除替换语义后「打开第二个文件夹」为追加——原断言 count 1 需按新语义改写；空态文案不变）
- Modify: `apps/web/e2e/m1.spec.ts`（IndexedDB 轮询 key `'tabs'` → `'workspaces'`——迁移后 tabs 不再更新）
- Modify: `apps/web/e2e/b-app-shell-sources.spec.ts`（如树结构变化影响 `.vv-tree-row` 定位则适配）
- Create: `apps/web/e2e/t-workspace.spec.ts`（新用例：新建 workspace + 添加远端来源（经 connectServer 通道）+ 切换 + tab 归组 + 管理面板搜索/跨组激活/Alt+W + 刷新恢复（workspace 结构/remote 重连/localfs 占位））
- Modify: `apps/web/playwright.server.config.ts` 或 e2e-server（多根服务端用例：command 追加第二个 `--root`，或 t-srv.spec.ts 内 spawnServe 双根实例——验证 tree?root=1、search 跨根、SSE root 字段端到端）
- Modify: `docs/deploy.md`（--root 多值示例与语义）
- Modify: `README.md`（workspace 特性一句）

**Interfaces:** 验证性。

- [ ] **Step 1: 适配既有用例**（先跑全量 playwright 记录破损清单，逐个按新语义改写——**禁止删用例**，语义变化在用例内注释旧语义→新语义）
- [ ] **Step 2: 新增用例**（t-workspace.spec.ts + 服务端多根用例）
- [ ] **Step 3: 全量门禁**：`cargo test --manifest-path server/Cargo.toml && pnpm test && pnpm typecheck`；重建 build；`pnpm playwright test`（默认套件）+ e2e-server 套件
- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e apps/web/playwright.server.config.ts docs/deploy.md README.md
git commit -m "test(e2e): workspace 端到端锚点与既有用例语义适配

why: 行为语义变化需用例同步（禁止删用例），多根服务端需端到端验证。
what: SHELL-06/m1 等适配、t-workspace 新用例（创建/切换/归组/面板/
恢复）、服务端双根 e2e、deploy 文档多根语义。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 服务端多 root→T1/T2；§2.2 模型/来源/持久化→T3/T4；§2.3 UI（切换器/创建/后端来源/TabBar/管理面板）→T5/T6；§3 测试→各任务+T7；§5 验收→T7 全量门禁。无缺口。
- **占位扫描**：「以实际为准」处均给了先例锚点（tree_file.rs get helper、GlobalSearchPanel 浮层模式、Markpad 路径归一、fake-indexeddb 先例）；quickOpen 多源测试落点明确；FileTree/AppShell 组件层以 e2e 兜底已声明。
- **类型一致性**：RootSpec/resolve_at/SearchRequest.root/ChangeHub::spawn(roots)/Workspace/WorkspaceSource/migrateLegacyTabs/RemoteStore opts 贯通一致；watch 帧与 search 帧的 root 字段「单根省略」约束统一。
- **两项计划级裁决（源自探索，已入 ledger 预告）**：①`ChangeHub::spawn` 签名从 `&Path` 变 `&[PathBuf]`（波及 state.rs 与 events 测试 fixture——单根行为逐字节等价为验收线）；②`workspaces` 快照走 kv 新键无需升 DB 版本（DB_VERSION 已为 2）。
