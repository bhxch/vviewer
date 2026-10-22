# 终审新增挂账候选清偿批设计（C1–C5）

状态：待用户审阅 → writing-plans
日期：2026-10-22
来源：docs/report/sdd-deferred-minors-2026-10-21.md「阶段一终审新增挂账候选」节（:168-174）+ 交接文档 /tmp/handoff-deferred-cleanup-candidates.md（行号定位均已核实于 1d3547b）
执行形态：单 spec 五任务，逐任务 writing-plans 拆步 → SDD → 门禁；批末 digest 五条回写终态。

## §1 背景与目标

递延清偿批（57 项，五阶段 SDD）终审全 PASS；终审过程新增 5 条挂账候选，均小项，记录于 digest「阶段一终审新增挂账候选」节。本批将其全数清偿或落库挂账（C5），终态回写 digest。

用户拍板（2026-10-22）：

1. 流程档位：spec 化 + SDD（本 spec）。
2. C1 占位目录条目处置：**留**——restore 查找剥前缀，来源重建成功后复活为真目录 tab。
3. C4 修法：**AtomicBool 护栏**（非注释声明）。
4. C5 处置：**落脚本挂 CI 首跑**，本批不尝试本地 wrangler dev。

## §2 范围与处置总表

| # | 项 | 性质 | 处置 |
| --- | --- | --- | --- |
| C1 | 占位 tab snapshot 无过滤缺陷 | 真缺陷（行为修复） | 修复：restore 侧查表剥 `placeholder:` 前缀，TDD RED 先行 |
| C2 | worker 416 parity | 行为对齐（native 8c5fe16 的 worker 面） | 修复：locate 前置语法闸 + unbounded 416 |
| C3 | config 手工 Debug 字段数锚测 | 测试补强 | 新增锚测：五面字段数对齐 + Debug 输出逐字段断言 |
| C4 | desktop SIGTERM×重启毫秒级孤儿窄窗 | 罕见竞态 | 修复：`restarting` AtomicBool 护栏 + shutdown_now 双检 |
| C5 | workerd Content-Length: 0 POST 形态实证 | 实证补齐（非缺陷） | 探针脚本落库，挂 deploy-worker workflow 首跑 |

建议序：C1 → C2 → C3 → C4 → C5（C2/C3 同为 Rust 测试面相邻执行）。

## §3 任务明细

各任务位置为已核实起点（1d3547b 时点行号），writing-plans 阶段允许微调。

### C1 · restore 查表剥占位前缀（真缺陷）

缺陷链（已核实）：

- snapshot 写侧 `openFlow.svelte.ts:74-93` 无过滤：占位 tab 的 storeId 带 `placeholder:` 前缀（`addPlaceholder` :441 构造）原样入快照。
- restore 侧 `AppShell.svelte` 的 `rebuilt` 表键全部来自 `sources[].storeId` 原始 id；:636 `rebuilt.get(t.storeId)` 对前缀 id 必 miss → :646 恒再落占位。触发：断连期间刷新过的会话，服务端恢复后再刷新，文件 tab 恒再落占位、内容不自动复活（可手动重开）。
- :632-635 exists 查重按前缀逐字比较，merge 窗口内用户已开同文件时产生重复。
- 目录条目 :627 `path===''` continue 整条丢弃。

修法（**snapshot 写侧不动——快照忠实记录，restore 读侧理解前缀**）：

1. `originStoreIdOf`（openFlow.svelte.ts:99-103，现私有）导出。
2. :636 查表改 `rebuilt.get(originStoreIdOf(t))`：命中 → 内容 tab 复活（scrollTop/overrideRenderer/pinned/size 读回链不变）；仍 miss（服务端未恢复）→ 照旧落 `addPlaceholderTab`（其内部 :441 已用 originStoreIdOf 防双前缀，幂等）。
3. :632-635 exists 查重比较改剥前缀后比对（堵 merge 窗口重复）。
4. 三处 dirSnap 查找（:565 localfs / :592 remote / :615 direct）匹配改 `originStoreIdOf(t) === src.storeId`：快照里的占位目录条目（undo 栈窄径产出：关目录 tab → store 失活 → reopenClosed 落 addPlaceholder 得 `path===''` 占位）在来源重建成功后复活为真目录 tab（含 pinned 读回）。

维持现状（注记，不修）：

- 断连期 restore 的**真 id** 目录条目仍被 :627 丢弃（占位化不产出目录条目，pre-existing 行为；用户重开即可）。
- `TabSnapshot.kind`（session.ts:12）对 `placeholder:localfs:` 前缀误判 `rename-only`——已核实 restore 无 `t.kind` 消费面（分支只读 `sources[].kind`），维持现状。

测试（TDD，RED 先行）：

- RED：复用 WSX 恢复域既有快照 seed 装置——IndexedDB workspaces 键直构「remote source（可连通）+ `placeholder:` 前缀文件 tab + 同前缀目录条目」→ 加载 → 断言文件 tab 复活为真内容 tab（非 unrestorable 占位）、目录 tab 复活。现状红。
- 幂等锚：仍不可达来源的占位文件 tab，再次刷新不再叠加前缀（既有 addPlaceholder 防线的行为锚）。

### C2 · worker 416 前置 parity

现状（已核实）：native 面（8c5fe16）在 `server/src/routes/file.rs:154` 于 locate 前置语法判定（`parse_range_syntax` :48 + `range_not_satisfiable_unbounded` :129）；worker 面 `server/worker/src/dispatch.rs:170-201` 的 `file()` 仍先 locate（:174）后 parse（:187-197）——语法非法 Range + 缺失文件时 404 抢答（native 面 416）。

修法：

1. `server/worker/src/http.rs` 增 `parse_range_syntax`：与 native routes/file.rs:48 逐行同源语义（syntax-only，不依赖 size——worker 现有 `parse_range(h, size)` 需 size，不适用前置形态）。
2. dispatch.rs `file()` locate 前置语法闸：`!if_range_present && !has_multiple_ranges(h) && parse_range_syntax(h).is_err()` → 直接 416 unbounded。
3. 新增 `range_not_satisfiable_unbounded`（`Content-Range: bytes */*`，与 native 同构；现 `range_not_satisfiable(size)` 带 size 形态保留给 locate 后路径）。

锚测：

- http.rs 纯函数单测：非法语法集（`bytes=x-y`/`units=0-1` 等，对齐 native :224-228 口径）。
- native `server/tests/tree_file.rs` `invalid_range_wins_over_missing_file` 的 worker 对应物：优先 dispatch 级（计划期核实 wasm 单测能否构造 WorkerState + MockTransport）；不可行则纯函数面 + 前置次序源码锚，裁决注记。
- 门禁必跑：`cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`。

### C3 · 手工 Debug 字段数锚测

现状（已核实）：五个手工 Debug 面，字段清单与结构体定义靠人工同步，新增字段忘改 Debug 会静默丢显（可见性损失非泄漏）：

| 面 | 位置 |
| --- | --- |
| FileConfig | server/src/config.rs:49 |
| ResolvedConfig | server/src/config.rs:86 |
| ServeArgs | server/src/main.rs（台账 1-1 手工 Debug 脱敏） |
| MountConfig | server/core/src/mounts.rs:73 |
| MountRoot | server/core/src/mounts.rs:120 |

修法：各 Debug impl 旁声明字段数常量（如 `const DEBUG_FIELDS: usize = 10;`）；锚测双保险——①字段名清单（`stringify!` 数组）长度与常量一致；②全字段构造实例的 Debug 输出逐字段名 `contains` 断言（新增字段忘进 Debug → 红）。落位：config.rs 既有测试（:458 `mount_config_debug_redacts_credentials`、:490 `token_is_redacted_in_all_config_debug_faces`）旁 + mounts.rs tests + main.rs（ServeArgs 面归属处，计划期定）。

### C4 · desktop SIGTERM×重启孤儿窄窗护栏

现状（已核实）：`apps/desktop/src-tauri/src/main.rs` 的孤儿窗口为 **:177–:194**——`start_and_wait` 在 :155 `kill_server` take 旧 child、:166-177 spawn 新 child（局部变量）、:194 槽位放回；其间 ctrlc handler（:330-333 `shutdown_now` → `kill_server`）读到空槽 → no-op → `exit(0)`，新 sidecar 无人回收成孤儿（罕见 + 后果可控：孤儿进程存活至机器重启，--port 0 无端口冲突）。

修法（护栏，关窗而非声明）：

1. `ServerState` 增 `restarting: AtomicBool`；`start_and_wait` 开场（:155 take 旧 child 之前）置位，:194 槽位放回后清位（Release）。
2. `shutdown_now` 双检循环：Acquire 读护栏 → 见位则有界等待（上限 READY_TIMEOUT 量级）→ kill_server → 复查护栏（关「信号恰在置位前到达」竞态：handler 读 false 后护栏置位、其 kill_server 落空的情形，复查见位则回到等待，由重启线程收口后统一 kill）→ exit(0)。
3. 等待/双检辅助提取为可单测函数（模拟 flag 翻转）；`shutdown_now` 本体的 `process::exit` 不可测面维持薄壳。

测试：桌面 crate 独立 manifest——`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` + clippy 零警告门。

### C5 · workerd Content-Length: 0 POST 形态探针（落库挂 CI）

背景：阶段三 T5 把 mounts POST 改 Content-Length 预检 + 流式累计闸；workerd 对 `Content-Length: 0` 的 `body()` 返回 null 还是空流未实证——两分支终态已收敛一致（空缓冲 → serde 400），属实证补齐非缺陷。

处置（拍板：落脚本挂 CI，本批不本地实跑）：

1. 探针脚本落库（server/worker/scripts/ 下）：`wrangler dev` 起本地 workerd → 注入临时 dev vars（含 VV_TOKEN；`.dev.vars` gitignore 不入库，脚本自备自清）→ 带 token `POST /api/mounts` + `Content-Length: 0` → 断言 400 invalid mount config（非 5xx）→ 清理。
2. 挂 deploy-worker workflow 首跑顺带执行（CI 校准窗口，与实机 8 项等待口径一致）；探针结果回写 digest。
3. 脚本不要求本批跑通环境，但语法/逻辑经静态审读；执行通道在 workflow 中的挂点（独立 step 或 job）计划期定。

## §4 关键裁决

1. **快照写侧不动**：占位前缀继续忠实入快照，restore 读侧剥前缀理解——写侧过滤会丢 tab（用户打开记录消失），读侧修复保数据。
2. **占位目录条目「留」**（用户拍板）：与文件 tab 修复对称，近零成本，符合 M-5「快照忠实恢复」语义。
3. **C4 取护栏非注释**（用户拍板）：护栏真正关窗；双检循环关置位竞态，注释只声明缺陷。
4. **C5 挂 CI 非本批实证**（用户拍板）：与「实机 8 项窗口等待」红线口径一致。
5. C2 锚测若 dispatch 级 wasm 单测不可建，降级为纯函数面 + 源码锚并注记裁决——parity 的行为证据以 native 集成锁测 + worker 纯函数同源为准。

## §5 非目标

- snapshot v2 结构变更、restore 其余分支重构。
- 断连期真 id 目录条目的占位化（维持丢弃，注记）。
- workerd 其余 body 形态（chunked、超限）实证——既有用例已覆盖。
- 实机 8 项（MinIO/DAV smoke、桌面三平台首跑、deploy-worker 实跑、3xx follow、desktop CI 校准）——维持窗口等待，本批仅 C5 探针脚本落库挂靠。
- `.superpowers/` 目录（gitignore `*`，永不入库）。

## §6 验收门禁与回归口径

- typecheck 0E；vitest 仓库根全量（基线 1766+1，唯一败 = tools/grammar-builder 本机产物过期 fresh-clone skipIf，勿修）。
- `cargo test --workspace` 全绿（基线 424）；`cargo clippy --workspace -- -D warnings` 零告警。
- 桌面 crate 独立门：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` + 该 manifest clippy 零警告。
- worker wasm 编译锚：`cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`。
- 前端构建：`build:e2e`（禁裸 build，防 CDN 注入冲掉）+ budget 1.36MB/4MB。
- playwright：默认套件 658 + e2e-server 91（跑法 `cd apps/web && npx playwright test -c playwright.server.config.ts`）；增量面（C1 RED/转正用例）计划期定，既有断言零翻转。
- 提交：main 直行、原子 commit、Angular 中文 message；SDD 每任务独立实现者 + 任务评审 + 终审。

## §7 风险与实施注记预留

- C1 的 e2e seed 若 WSX 装置不直接可复用（workspaces 键 schema v2 细节），按 session.ts 既有类型直构，装置差异计划期核实。
- C1 exists 查重剥前缀后，须防「占位条目与存活 tab 同 origin 误吞」——比较语义（storeId+path 双条件维持）计划期复核。
- C2 dispatch 级测试的 WorkerState 构造可行性未实证（§4.5 预留降级）。
- C4 双检循环的有界等待上限取值（READY_TIMEOUT vs 独立常量）计划期定；护栏清位遗漏（start_and_wait 早退路径）须逐一核对（Resolve 失败等 map_err 早退在置位之后，须保证清位）。

## §8 交付物

1. 五任务落码 + 测试（C1 e2e RED→GREEN、C2/C3/C4 Rust 锚测、C5 探针脚本 + workflow 挂点）。
2. spec（本文件）→ 批计划（docs/superpowers/plans/）→ SDD 台账（显式落 docs/ 若需留痕）。
3. digest「阶段一终审新增挂账候选」节五条回写终态（C5 标注「脚本落库待 CI 首跑」窗口口径）。
