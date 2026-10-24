# vviewer 前后端结构重构方案（2026-10-24）

> 性质：**结构运动、行为不动**。功能零改变；既有测试全绿是底线；Cargo.lock / pnpm-lock 零漂移；CI 门禁面、公共 HTTP API 与 capabilities 契约零触碰。
> 依据：三份勘察（前端/后端/质量面）+ 本轮对全部目标文件的源码复核（下文引用均为本轮实读行号）。勘察与源码不一致处以源码为准（复核修正见「现状评估」）。

---

## 1. 目标

1. 消解双适配层（native axum / worker wasm）间**手工同源复刻的 HTTP 语义件**（Range 解析、body 闸门常量、kroki 上游错误映射）——安全面（416/413/404）双份维护的漂移风险归零。
2. 错误类型三套并行收敛为**单一构造源**（core），适配层错误壳薄化。
3. 拆解前端三大巨石热点中的两个（`openFlow.svelte.ts` 1427 行、`code.ts` 2730 行），并把其中**不可单测的状态/纯逻辑**迁到可测位置（root vitest 无 svelte 插件是既定约束，方案顺着仓内既有「纯 .ts 抽取」先例走，不改测试基建）。
4. watch 域单文件多职责切分（1323 行）。
5. 设置字段白名单的人工对账机械化——「漏一处即导入静默丢字段」这一失败模式从根上不可再发生。

## 2. 原则

- **每个抽象必须有勘察痛点支撑**。无痛点支撑的统一化（如把 worker/native 有意分叉的资产 404 扩展名集合并、Renderer 6 参签名改 options 对象）一律不做，理由见「不做清单」。
- **入口不变、消费方零改动**：包导出面（`@vviewer/render-text` 的 `.`→`src/code.ts`）与模块路径（`./openFlow.svelte`）以 façade 保持不变——重构 diff 收敛在被移动代码内部。
- **顺仓内既有模式**：纯逻辑抽 `.ts`（先例 `openWith.ts`、`dragEntry.ts` 头注「提取为纯函数以便 jsdom 单测」）；域目录化（先例 `render-text/src/markdown/`、`jsonl/`）；文本扫描锚测（先例 `core/src/lib.rs:98-183` source_anchors）。
- **测试只搬不改**：搬迁的测试断言逐字保留；新增测试只做结构/纯函数覆盖，不改任何既有行为断言。
- **依赖纪律零松动**：不新增/移动任何 crate 或 npm 依赖；core 新增模块为零第三方依赖的纯函数/常量；`native` feature 门控链与 reqwest 零进入裁剪形态的纪律不变。

## 3. 现状评估（本轮源码复核结论）

复核确认的关键事实（与勘察一致）：

- **错误三套同构**：`server/core/src/error.rs:12-53`（CoreError + 7 构造器 + `From<StorageError>`）与 `server/src/error.rs:9-83`（AppError + 同款 7 构造器 + 同款 `From<StorageError>` + `From<io::Error>` + `From<CoreError>`）逐语句重复。**复核新发现：AppError 的 7 个构造器全仓只有 3 个使用点**（`routes/kroki.rs:44`、`routes/compute.rs:67,69`），`From<io::Error>`/`From<StorageError>` 在适配层**零使用点**（`rg "From<|io::Error|StorageError"` 于 `src/routes/*`、`adapt.rs`、`main.rs` 仅命中测试里的 `std::fs::write`）——适配层错误面已是薄壳，收敛成本远低于勘察预估。kroki 错误映射「core 无 upstream 构造器」的注释（`routes/kroki.rs:7-8`、`worker/src/kroki.rs:8-9`）正是双份维护逼出的散落决策实证。
- **HTTP 语义件复刻**：`src/routes/file.rs:30-136` 与 `worker/src/http.rs:12-147` 的 Range 家族（`has_multiple_ranges`/`RawRange`/`parse_range_syntax`/`resolve_range`/`parse_range`，worker 另有 `should_pre_reject_range`）逐行同源，双侧各持一份逐字同款单测（`file.rs:186-231` vs `http.rs:149-267`）；body 闸门常量 `MOUNTS_BODY_LIMIT`(64KB)/`KROKI_BODY_LIMIT`(1MB) 双份（`routes/mod.rs:45,51` vs `worker/dispatch.rs:32,37`）；kroki 上游错误映射 + `trunc_200` 双份（`routes/kroki.rs:50-56,102-111` vs `worker/kroki.rs:34-40,78-88`）；`KrokiRequest` DTO 双份。两适配层共同依赖 `vviewer-core`（worker 已依赖，`worker/src/dispatch.rs:17-21`）——core 是唯一合法共享容身点（core 禁 axum/reqwest，这些件均为纯函数/常量，无碍）。
- **有意分叉不收敛**：资产 404 扩展名集 native 仅 `.scm/.wasm`（`src/lib.rs:64`，ServeDir 兜底层）而 worker 为 4 扩展名（`worker/http.rs:110-115`）；native 用 axum `DefaultBodyLimit`、worker 用流式累计闸 `payload_fits`。这是平台机制差异下的既有行为面，**合并即行为改变**，不动。
- **watch.rs 1323 行**：域职责至少五块（ErrorLogGate 限频 `:49-110`、健康槽位 `:112-192`、ChangeHub `:141-268`、自愈状态机 RetryPolicy/WatchFault/RetryFactory `:308-571`、聚合/会话循环 `:572-836`）+ 849 行起约 475 行内嵌测试。`crate::watch::ChangeHub` 被 `state.rs:65,105,161` 与 `lib.rs:17` 引用——目录化后路径不变。
- **openFlow.svelte.ts 1427 行**：至少 9 类职责混居；AppShell 一口气导入 21 符号（`AppShell.svelte:16-38`）、`viewer.ts:28` 也导入其中 2 个纯缓存读取函数；20 个消费方全部经 `./openFlow.svelte` 导入。**复核新发现**：SSE watch 接线回调为 **3 处逐字同款 + 1 处有意变体**——remote 创建链三处（`connectServer :1025-1036`、`applyMountRootIndexMigrations :1092-1101`、`openRemoteSource :1250-1260`：autoRefresh 过滤 + watchHealth 创建期复位/onError 置位 + 同款 console.warn）完全同源；第 4 处 `createDirectMountStore :1293-1301`（direct 链）是**被锚测锁死的有意分叉**：不写全局 watchHealth（立即 onError 置位会污染健康 remote 来源 tab、创建期复位会抹掉 remote 真实降级指示——`openFlow.svelte.ts:1282-1288` 注释明示）、console.warn 文案不同（『直连挂载不支持变更推送…』），`watchHealth.test.ts:79-85`（`createDirectMountStore` 函数窗口 `not.toMatch(/watchHealth\./)` + ViewerPane 桥锚）与 `directMountFlow.test.ts:28-37`（同窗口零 watchHealth 写点 + 文案断言）双锚锁定。另 tab 关闭邻位选择（先右后左）与批量关闭激活对齐（`alignActivationAfterBatch :299-320`）是纯算法逻辑却困在 runes 模块内不可测；能力缓存三组 sessionStorage 读写（`:803-845`）与 `searchEngineCache.ts`/`serverHealthCache.ts` 同型却未按该先例独立。
- **openFlow.svelte.ts 同时是两份源码契约锚测的锚定文件**：`watchHealth.test.ts:56`（`readSrc('src/lib/openFlow.svelte.ts')` + `:59-63/:65-68` 对 `connectServer`/`openRemoteSource` 的 `expectResetDirection` 函数窗口顺序断言）与 `directMountFlow.test.ts:19`（`:66-72` connectServer 重连清扫窗口、`:74-87` applyMountRootIndexMigrations 窗口、`:89-90` syncMountsOnConnect 注入、`:97-104` dirTabNameOf/addDirStoreTab/addDirTabForRestore 命名锚）——FE-1 迁移这些函数时锚点必须同步随迁，否则 `fnWindow` 未命中即红（详见 FE-1 锚测随迁面）。
- **code.ts 2730 行 = 包入口**：`render-text/package.json` `main`/`exports["."]` 均指向 `src/code.ts`——**拆分必须保留该文件作为 façade**（exports 子路径是稳定禁区）。内部天然分块：常量/策略/hljs 桥（27-125）、chunk 缓存与行尺度（134-527）、attach 注入态（529-647，模块级单例状态自洽）、renderCode 全量路径（720-1255）、窗口流式路径（1256-2551，含 pump 控制 WeakMap `:2552`）、Renderer 装配（2554-2693）、富文本降级共用入口 `renderDegradedCode`（2703-2730，被 markdown/html 消费）。
- **设置对账**：`stores/settings.ts:57` `DEFAULTS` 未导出；`settingsDraft.ts:27-41` `SETTINGS_KEYS` 手工清单（注释自认「未新增字段」靠记忆）。复核确认两清单**当前 11 键且顺序完全一致**——派生替换可做到键序不变（localStorage 落盘字节面也零漂移）。

勘察声称与源码不符需修正的：勘察称 AppError 构造器集合「逐个重复两份」暗示大面积使用——实际适配层构造点仅 3 处、两个 From 映射是死代码；BE-1 的工作量与风险因此显著小于勘察估计。

## 4. 工作项详设（按实施顺序）

依赖关系：**BE-1 → BE-2**（同触 `routes/kroki.rs`/`worker/kroki.rs`，串行防冲突；BE-2 的映射下沉产物 `upstream_error` 直接使用 BE-1 归一后的 CoreError 构造面）。**BE-3、FE-1、FE-2、FE-3 相互独立**，与 BE 组也独立，可任意并行/穿插。

---

### BE-1 错误类型单源化：AppError 薄壳化（server/src/error.rs）

**scopePaths**: `server/src/error.rs`、`server/src/routes/kroki.rs`、`server/src/routes/compute.rs`、`server/core/src/error.rs`

**design**（模式：**单源 + 适配器薄壳**。为什么值得：错误 JSON 形态是逐字节行为锁，而构造器与 `From<StorageError>` 映射双份维护的漂移已有实证——kroki 502 语义因「core 无构造器」被逼落在两个适配层各写一遍；单源后新增错误类别只触 core 一处。为什么不过度：不把 CoreError 改成域语义 enum——tuple 字段 `pub (StatusCode, String)` 被 worker `dispatch.rs:104,317` 直接消费，且勘察所提「任意状态码可构造」并无实际缺陷场景支撑，改形是纯 churn）：

1. `AppError` 改为 newtype：`pub struct AppError(pub vviewer_core::error::CoreError);`
   - `IntoResponse`：`(self.0.0, Json(json!({"error": self.0.1})))` —— 状态码与消息逐字不变，JSON 构造点不变。
   - 保留 `Display`/`std::error::Error`/`From<CoreError>`（`?` 通道）。
2. 删除适配层 7 个重复构造器；删除 `From<io::Error>`、`From<StorageError>`（全仓零使用，本轮 rg 已证）。**预案**：若 `cargo check` 揭示隐式 `?` 使用点，`From<StorageError>` 以 `Self(e.into())` 薄转发 core 映射保留——转发不复制逻辑，单源目标不受损。
3. 迁移 3 个构造点为 `CoreError::internal/bad_request`（`kroki.rs:44`、`compute.rs:67,69`），经既有 `From<CoreError>` 自动包装，handler 签名零改动。
4. core 侧补一条纯结构单测：`From<StorageError>` 映射（NotFound→404 "not found"、Other→500 透传）现状锁测（当前无测试，属新增纯结构测试）。

**steps**:
1. `server/src/error.rs` 重写为 newtype（~40 行，含迁移期注释：为何保留壳——orphan rule 禁止为外部类型 impl axum `IntoResponse`）。
2. `routes/kroki.rs:44`、`routes/compute.rs:67,69` 改 `CoreError::*` 构造（import 调整）。
3. `core/src/error.rs` 补 `From<StorageError>` 锁测。
4. 验证（§6 BE 面；其中双形态两条 check 为**本地必跑，CI 不覆盖**——ci.yml rust job 仅跑 clippy 与 test，wasm/裁剪 check 不在任何 push/PR 触发的工作流）：`cargo clippy --manifest-path server/Cargo.toml --workspace --all-targets -- -D warnings`；`cargo test --manifest-path server/Cargo.toml --workspace`；`cargo check --manifest-path server/Cargo.toml --workspace --all-targets --no-default-features`；`cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`（cwd=server/）。

**behaviorGuards**: 错误 JSON `{"error": msg}` 形态与状态码由 `tests/security.rs`(15 例)、`tests/tree_file.rs`(24)、`tests/kroki_proxy.rs`(9)、`tests/mounts_api.rs`(14) 的既有断言兜底；`tests/kroki_proxy.rs:39` 注释所述「CoreError → AppError 适配映射」路径行为不变。缺口：无 —— 新增的仅是 core 映射锁测。

**risks**: 低。唯一不确定是隐式 `?` From 使用点，`cargo clippy/check --workspace --all-targets` 编译期即暴露；预案已备。Display 消费面极窄（logging/测试打印）。

**commitMessage**: `refactor(server): AppError 薄壳化单源 CoreError——错误构造器与 From 映射双份复刻根治`

---

### BE-2 双适配层 HTTP 语义件收敛 core（Range 家族 / body 闸门常量 / kroki 上游映射）

**scopePaths**: `server/core/src/range.rs`（新）、`server/core/src/kroki.rs`、`server/core/src/mounts.rs`、`server/src/routes/file.rs`、`server/src/routes/mod.rs`、`server/src/routes/kroki.rs`、`server/worker/src/http.rs`、`server/worker/src/dispatch.rs`、`server/worker/src/kroki.rs`

**design**（模式：**共享内核下沉**——两适配层已共同依赖框架无关的 core；这些件是纯字符串解析/常量/纯映射，无任何 axum/reqwest 依赖，core 是唯一不动依赖边即可共享的位置。为什么值得：`worker/src/http.rs:3-7` 注释自认「逐行同源（语义锚）双向防漂移」——防漂移靠人肉复制同款测试维持，Range 416/闸门 413 恰是安全面，每次语义调整双处同步、漏一侧即两形态行为分叉。为什么不过度：只收**逐字同源**的件；native/worker 有意分叉的资产判定与闸门机制（DefaultBodyLimit vs 流式累计）不动；`strip_base_path`/`is_asset_path`/`payload_fits` 是 worker 单侧件，留守 `worker/http.rs`）：

1. 新建 `core/src/range.rs`：`has_multiple_ranges`、`pub struct RawRange`（字段 pub——两侧现有测试的字面量构造需要）、`parse_range_syntax`、`resolve_range`（私有）、`parse_range`、`should_pre_reject_range`，函数体从 `worker/src/http.rs:12-147` **逐字**搬移（与 native 版已互为同源），`#[allow(clippy::result_unit_err)]` 注释一并保留。双侧重复单测（`file.rs:186-231` 三件 + `http.rs` 的 Range 四件）合并为 core 一份，**断言逐字保留**；适配层各自的 Range 单测删除（防漂移锚从「双份同款」变为「单份共享」）。
2. `core/src/mounts.rs` 增 `pub const MOUNTS_BODY_LIMIT: usize = 64 * 1024;`、`core/src/kroki.rs` 增 `pub const KROKI_BODY_LIMIT: usize = 1024 * 1024;`（原注释语义随迁）；`routes/mod.rs:45,51` 与 `worker/dispatch.rs:32,37` 改引用 core 常量。`COMPUTE_*` 两常量 native 单侧，留守。
3. `core/src/kroki.rs` 增上游映射单源：`pub fn trunc_200(&str) -> &str` + `pub fn upstream_error(status: u16, body: &[u8]) -> CoreError`（4xx→bad_request、其余→internal，消息 `format!("kroki {}: {}", status, trunc_200(...))`——与两传输实现现产出逐字节同形，native 的 `status.as_u16()` 与 worker 的 `status: u16` 输出一致）+ `#[derive(Deserialize)] pub struct KrokiRequest { lang, source }`（双份 DTO 合一）。补 core 单测：字符边界截断（多字节字符中间安全）与 4xx/5xx 分类。
4. 传输实现瘦身：`ReqwestKrokiHttp`/`FetchKrokiHttp` 的非 2xx 分支改调 `kroki::upstream_error`；网络错误/构造错误映射（消息源不同构）各留传输侧。`routes/kroki.rs`/`worker/kroki.rs` 删除各自 `trunc_200` 与 DTO。
5. `src/routes/file.rs` 删除本地 Range 家族改 `use vviewer_core::range::*`，416 响应构造器（axum 形态）留守；`worker/src/http.rs` 同步删除，`dispatch.rs` 导入面调整。
6. `core/src/lib.rs` 注册 `pub mod range;`。**source_anchors 锚测兼容性**：新模块不出现 `ReqwestTransport` 符号，文本扫描（`core/src/lib.rs:98-183`）不受影响。

**steps**: ① 建 `core/src/range.rs`（搬移+测试合并）→ ② 常量下沉（mounts/kroki 域）→ ③ kroki 映射/DTO 下沉 + 传输瘦身 → ④ 两侧适配层删复刻改引用 → ⑤ 验证（§6 BE 面；双形态两条 check 为**本地必跑，CI 不覆盖**——ci.yml rust job 仅跑 clippy 与 test，deploy-worker.yml 为手动 workflow_dispatch）：`cargo clippy --manifest-path server/Cargo.toml --workspace --all-targets -- -D warnings`；`cargo test --manifest-path server/Cargo.toml --workspace`；`cargo check --manifest-path server/Cargo.toml --workspace --all-targets --no-default-features`；`cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`（cwd=server/）→ ⑥ `git diff --stat server/Cargo.lock` 为空。

**behaviorGuards**: Range 行为由 `tests/tree_file.rs`(24 例，含 416/BUG-47 面) + worker `http.rs` 保留单测（base-path/资产/闸门）兜底；kroki 转发由 `tests/kroki_proxy.rs`(9 例) 兜底；mounts 413 面由 `tests/mounts_api.rs` 兜底；wasm 形态经 `cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features` **本地手工 check 验证（非 CI 门——CI 不跑该命令，执行者不得以「CI 会兜」为由跳过）**。缺口：core 侧原无 Range/映射直测——搬入的合并测试即补上此缺（断言来自既有两侧同款用例，零新语义）。

**risks**: 中低。① 搬移必须逐字（含 allow 属性与注释），任何「顺手优化」都可能漂移 416 语义——以断言逐字搬迁纪律约束；② worker wasm 形态仅本地 check 验证（CI 不覆盖），core 新模块的零依赖纯度靠该本地命令把关；③ 常量下沉后适配层引用名变化是纯机械面。

**commitMessage**: `refactor(core): HTTP 语义件收敛 core 单源——Range/闸门常量/kroki 上游映射双适配层同源复刻根治`

---

### BE-3 watch.rs 目录化拆分（src/watch/）

**scopePaths**: `server/src/watch/`（由 `server/src/watch.rs` 迁移）、`server/src/lib.rs`（零改动，仅验证）

**design**（模式：**按域职责分模块**。为什么值得：1323 行单文件混居五块职责（限频/健康/聚合 hub/自愈状态机/平台事件归集）+ 475 行测试，SSE 帧类型与前端 `remote.ts` 的终态语义耦合散落其中，改动定位成本高（勘察 medium 痛点、README 分层表自认的唯一滞留业务域）。为什么不过度：**不移 core**——那需要把 `notify` 依赖从主 crate 迁入 core（Cargo.toml 变更、Cargo.lock 文本漂移风险、feature 转发链加长），在「lock 零漂移」约束下收益不抵；watch 本就 native-only，目录化后职责边界即清晰，归属问题是分层洁癖而非现实痛点）：

1. `watch.rs` → `watch/mod.rs`：保留模块大文档头 + `pub use` 子模块符号；`crate::watch::ChangeHub` 等外部引用路径**零变化**（`state.rs:65,105`、`lib.rs:17`、`routes/events.rs` 不动）。
2. `watch/health.rs`：`WatchHealth`（含 `snapshot_frame` SSE 帧语义）、`HealthSlots` + 对应测试（`snapshot_frame_matches_health_semantics`）。
3. `watch/recovery.rs`：`ErrorLogGate`、`RetryPolicy`、`WatchFault`、`RetryFactory`、`WatchSession`、`run_loop`、`session_loop`、`open_recommended/open_poll`、`backend_name`、`unescape_mount` + 自愈/限频测试（`error_log_gate_*`、factory 系脚本化 opener 测试）。
4. `watch/hub.rs`：`ChangeHub`（spawn/spawn_with/subscribe/health/Drop）。
5. `watch/inspect.rs`：`fs_type_of`（cfg 双平台实现）、`collect_event`、`#[cfg(test)] collect_paths` + 对应测试（`access_events_and_out_of_root_paths_are_dropped`、`fs_type_of_resolves_mount_of_tmp`）。可见性拼装：cfg(test) helper `collect_paths` 与消费它的测试同文件即消；**非 cfg 的私有 `collect_event`（watch.rs:817）同时被 recovery 域测试消费**（watch.rs:1304 降级 poll 会话用例以 `collect_event(&ev, 0, &root, &mut out)` 断言事件归集）——目录化后 `inspect.rs` 内将其升 `pub(super)`（仅 watch 子树可见，非 crate 外暴露面，不构成新增风险；替代方案为该测试改走 `collect_paths` 同款包装，取改动更小的前者）。
6. 纯文件级移动：函数体、注释、`#[cfg]` 逐字搬移；内嵌测试按被测对象分居各子文件。

**steps**: ① `git mv watch.rs watch/mod.rs` 建目录 → ② 按上述五块逐块剪切为子模块（每块搬完即 `cargo check` 一次；`inspect.rs` 落位时同步把 `collect_event` 升 `pub(super)` 供 recovery.rs 测试消费）→ ③ 测试随域分置 → ④ clippy -D warnings 清 pub use 面 → ⑤ 全量验证。

**behaviorGuards**: SSE 帧行为由 `tests/events.rs`(9 例) 兜底；自愈/聚合/限频逻辑由内嵌单测（约 475 行，断言逐字随迁）兜底；native feature 门控由双形态 check 兜底（裁剪形态 watch 不编译）。

**risks**: 低——零语义改动的文件重组。风险点仅两个：pub 可见性拼装错误（clippy/编译即红）与 `#[cfg(unix)]` 平台段搬错位置（双平台编译门兜住；本地 linux 只能验 unix 分支，非 unix 分支靠「逐字搬移」纪律 + CI）。

**commitMessage**: `refactor(server): watch.rs 目录化拆分——1323 行自愈/聚合/健康多职责单文件根治`

---

### FE-1 openFlow 拆分：runes 壳分层 + 纯逻辑可测化（apps/web/src/lib）

**scopePaths**: `apps/web/src/lib/openFlow.svelte.ts`、`apps/web/src/lib/tabsModel.svelte.ts`（新）、`apps/web/src/lib/serverConnect.svelte.ts`（新）、`apps/web/src/lib/serverCapsCache.ts`（新）、`apps/web/src/lib/tabNeighbors.ts`（新）、`apps/web/src/lib/viewer.ts`（1 行导入改道）

**design**（模式：**façade + 按域分层 + 纯函数抽取**。为什么值得：勘察 high 痛点——tab/连接/挂载任何改动都汇聚这一个 1427 行 `.svelte.ts` 热点，且因 root vitest 无 svelte 插件其核心状态逻辑（关闭邻位、批量激活对齐）完全不可单测，AppShell 21 符号导入使任何拆分都怕断消费方。façade 保 20 个消费方导入面零改动；SSE 接线 remote 创建链 3 处逐字同款顺手归一（direct 变体有意不归一，见分层②）。为什么不过度：不把所有域都拆成独立 `.svelte.ts`——`$state` 单例跨模块重组有响应性/HMR 边界成本，收敛为「两个域模块 + façade」即消解热点；不统一三种状态传播机制（runes/pub-sub/CustomEvent 归一是行为漂移面，见不做清单 #5））：

分层（依赖单向：tabsModel ← serverConnect ← openFlow façade，无环——`connectServer` 末尾的 `addDirStoreTab`/`sourceOf` 属「来源登记 + 目录 tab」域，随 TabCollection 下沉 tabsModel，即断开反向边）：

1. **`tabsModel.svelte.ts`**（runes 域模块）：`Tab` 接口、`snapshot()`、`TabCollection`、`closedStack`/`pushClosed`、注册表（`activeStores`/`registryVersion`/`storeRevisions`/`storeById`/`registerStore`）+ 新增 `unregisterStore(storeId)`（把 `close():227-230` 与 `applyMountRootIndexMigrations:1108-1109` 的同语义三行收敛为一）、`workspacesView` 镜像、`sourceOf`/`dirTabNameOf`/`addDirStoreTab`/`addDirTabForRestore`、`persist`（导出供连接域迁移后落盘）。
2. **`serverConnect.svelte.ts`**（runes 域模块）：`watchHealth`/`statusNotice`/`showStatusNotice`、`connectServer`、`loadLastServer`/`saveLastServer`、`applyMountRootIndexMigrations`、SSE watch 接线导出 helper `wireStoreWatch`——**只归一 remote 创建链 3 处逐字同款**（`connectServer :1025-1036`、`applyMountRootIndexMigrations :1092-1101`、`openRemoteSource :1250-1260`：autoRefresh 实时过滤 + 创建期复位 + onError 置位 + 同款 console.warn；前两处随函数迁入 serverConnect，第三处由 façade 的 `openRemoteSource` 导入调用）。**两处有意不归一**：`createDirectMountStore :1293-1301`（direct 链）保留独立接线原文——它是双锚测锁死的有意分叉（零 watchHealth 写点 + 异文案，归一即 `watchHealth.test.ts:79-85`/`directMountFlow.test.ts:28-37` 红，且 direct 打开会误置全局降级旗标=行为回归）；AppShell 的 `reconnectRemoteStore`（remote 第 4 处接线，`.svelte` 组件内）本轮不动——其 `watchHealth.test.ts:71-77` 锚原样保留，兼作「归一 helper 与未归一接线同语义」的对照锚。
3. **`serverCapsCache.ts`**（纯 .ts，可测）：`CAPABILITIES_KEY`/`COMPUTE_LANGUAGES_KEY`/`DIAGRAM_CAPABILITIES_KEY` 三组 load/save（自 `openFlow:803-845` 与 `connectServer` 内联写缓存段抽出）+ lastServer 读写——与既有 `searchEngineCache.ts`/`serverHealthCache.ts` 同型同层。
4. **`tabNeighbors.ts`**（纯 .ts，可测）：关闭邻位选择（`close():203-223` 先右后左算法）与批量关闭激活对齐（`alignActivationAfterBatch:299-320`）的纯函数版（输入 `{id, workspaceId}[]` 投影 + 参数），`TabCollection` 薄化为调用点。
5. **`openFlow.svelte.ts` 保留为 façade + 打开通道**：`openFiles`/`openDirectoryViaPicker`/`openSavedDirectory`/`openDirectoryViaInput`/fallback、`openUrl`、`openRemoteSource`、direct 挂载群（`createDirectMountStore`/`openDirectMount`/`releaseDirectMountStore`，接线原文不动）、`bindArchiveOpenEvents`、e2e 钩子块、`export *`（含 type 再导出）自两个域模块——**20 个消费方零改动**；`viewer.ts:28` 的 2 个缓存读取改从 `./serverCapsCache` 导入（纯模块依赖纯模块，1 行）。

**锚测随迁面与改写豁免**（原则④的显式豁免，豁免范围仅限「锚的位置/对象」，锁定的行为语义断言逐字保留）：`watchHealth.test.ts` 与 `directMountFlow.test.ts` 是对 `openFlow.svelte.ts` 的**源码契约锚测**（两文件头注自认「源码锚非行为用例，行为由 e2e 收口」），函数迁走即 `readSrc`/`fnWindow` 不命中而红，须同步改锚：

- `watchHealth.test.ts`：① `:59-63` connectServer 用例 `readSrc` 改指 `serverConnect.svelte.ts`（函数迁入处）；② `expectResetDirection` 三用例中 connectServer/openRemoteSource 两例因接线归一进 `wireStoreWatch` 而失去函数窗口锚对象——**改写为锚 `wireStoreWatch` 函数窗口**（`watchHealth.degraded = false;` 复位先于 `store.watch(` 接线、置位唯一写点在 onError 回调内——顺序与单一写点断言原样迁移）**+ 三调用点存在性断言**（connectServer/applyMountRootIndexMigrations/openRemoteSource 各含 `wireStoreWatch(`）；③ `reconnectRemoteStore`（AppShell，`:71-77`）与 direct 桥锚（`:79-85`，锚 façade 内原文不动的 `createDirectMountStore`）**断言原文不动**。
- `directMountFlow.test.ts`：① connectServer 重连清扫窗口（`:66-72`）、`applyMountRootIndexMigrations` 窗口（`:74-87`）、`syncMountsOnConnect` 注入的 openFlow 半边（`:89-90`）——`readSrc` 改指 `serverConnect.svelte.ts`，正则与断言逐字保留；② `dirTabNameOf`/`addDirStoreTab`/`addDirTabForRestore` 命名锚（`:97-104`）——改指 `tabsModel.svelte.ts`（含 `addTab(store, '', dirTabNameOf(store))` 计 2 次的计数断言，两调用点同迁该文件）；③ direct 挂载群（`:21-43`）与 `openRemoteSource` label 锚（`:45-49`）、`releaseDirectMountStore`（`:51-64`）锚定对象留在 façade 原文件——**断言原文不动**。

**steps**: ① 建 `serverCapsCache.ts`/`tabNeighbors.ts` 纯模块 + 各自新增单测 → ② 建 `tabsModel.svelte.ts`（自 openFlow 剪切，`unregisterStore` 收敛）→ ③ 建 `serverConnect.svelte.ts`（`wireStoreWatch` 归一 remote 3 处；direct 挂载与 AppShell `reconnectRemoteStore` 接线原文不动）→ ④ openFlow 收敛为 façade + 打开通道（`openRemoteSource` 改调 `wireStoreWatch`，direct 挂载群原文留守）→ ⑤ 锚测随迁：按上述「锚测随迁面」同步改 `watchHealth.test.ts`/`directMountFlow.test.ts` 的 `readSrc` 目标与 `expectResetDirection` 锚对象（语义断言逐字保留），direct 侧锚不动 → ⑥ viewer.ts 导入改道 → ⑦ 验证（§6 FE 面，重点 b-tab-actions-enrichment/b-wsx-recovery/t-srv*）。

**behaviorGuards**: 既有面分两类——①与 openFlow 无锚定关系的外围单测（`stores/session.test.ts`、`tabActions.test.ts`（tabOrder 纯数学）、`storeRelease.test.ts`、`mountsSync.test.ts` 等）不动即绿；②`watchHealth.test.ts`/`directMountFlow.test.ts` 是对 `openFlow.svelte.ts` 的源码契约锚测，**必须按「锚测随迁面」同步改锚**（豁免原则④，仅改锚位置/对象：`readSrc` 目标文件与 `expectResetDirection` 的锚函数改为 `wireStoreWatch`；复位/置位顺序、单一写点、文案等行为语义断言逐字保留）——其中 direct 侧双锚（`watchHealth.test.ts:79-85`、`directMountFlow.test.ts:28-43`）断言原文不动即绿，恰是 direct 链行为不变的直接证明。e2e 主套 `b-tab-actions-enrichment`、`b-wsx-recovery`（工作区/会话恢复）、`b-app-shell-sources`、`b-filetree-src-remove`、`b-mounts-*`、`b-settings-center*` 与 e2e-server 通道（连接/挂载/多根面 94 例）兜住 tab/连接/挂载全链路行为。缺口与补齐：`$state` 模块本体此前不可直测——新增 `tabNeighbors.test.ts`（邻位/批量对齐算法）、`serverCapsCache.test.ts`（损坏 JSON/脏值容错）为纯结构测试；façade 再导出完备性由 TS 编译（20 消费方 typecheck）静态保证，不另补测试。

**risks**: 中。① `$state` 单例跨模块——经 re-export 仍是同一编译模块实例，响应性不变（Svelte 5 模块单例语义）；② 循环导入——分层已证无环（façade 是唯一双向汇聚点）；③ `persist`/`unregisterStore` 成为域间新接缝——签名极小且行为与原内联三行逐字同；④ HMR 边界（façade 热替换时域模块状态保形）——dev 期现象，e2e 走 production 构建不受影响，人肉冒烟补一眼；⑤ `wireStoreWatch` 归一面**严格限定 remote 创建链 3 处**——direct 变体（`createDirectMountStore`）是双锚测锁死的有意分叉，误归一即 direct 打开误置全局降级旗标的行为回归且 `directMountFlow.test.ts:36` 文案断言直接红，实施时以「direct 侧两锚原文不动即绿」为验收面。

**commitMessage**: `refactor(web): openFlow 拆分 tabs/连接域 + 纯逻辑可测化——巨石 runes 模块与不可测状态逻辑根治`

---

### FE-2 render-text code.ts 目录化拆分（src/code/ + 入口 façade）

**scopePaths**: `packages/render-text/src/code.ts`（改 façade）、`packages/render-text/src/code/`（新目录）、`packages/render-text/package.json`（零改动，验证）

**design**（模式：**入口 façade + 子模块 DAG**，复刻同包 `markdown/`、`jsonl/` 既有先例。为什么值得：勘察 high 痛点「渲染器即巨石已成模式」——文本渲染是最高频演进面（降级链/流式/字号联动历轮 spec 都改这里），无子模块边界使每次改动全文件检索定位；code.ts 同时是**包入口**（`package.json` `main`/`exports["."]`→`src/code.ts`，稳定禁区），façade 化后导出面零变化。为什么不过度：不再细拆到「一个导出一个文件」——按既有分块注释（`// ----------` 分隔）自然切 6 块；不引入 barrel 之外的任何间接层）：

子模块（DAG，无环；内部私有 helper 需跨块共享的升为子模块导出并注明 internal）：

1. `code/strategy.ts`：策略常量（`TREE_SITTER_MAX_BYTES` 等 5 常量 + `LINE_HEIGHT`）、`resolveStrategy`、`DECODERS`、hljs 桥（`HLJS_ALIASES`/`resolveHljsLang`/auto-probe 三函数）。
2. `code/chunks.ts`：chunk 常量、`chunkRangeFor`、`evictOldestEntries`/`capChunkCoverage`/`evictChunksByLines`、`buildLineIndex`/`buildLineOffsets`/`buildByteLineOffsets`。
3. `code/lines.ts`：区间归并到行（`flattenIntervals`/`assignIntervalsToLines`/`lineOf`/`innerTie`/`innermostOf`）、`splitHighlightedLines`、`mergeChunkLines`、`overlaySearchHits`、`renderLineHtml`、escape/decode helper。
4. `code/client.ts`：attach 注入态整体（`attachedClient`/`attachPhase`/`attachWaiters` 模块级单例 + `attachHighlightClient`/`waitForAttachedClient`/`getHighlightClient`/`__resetAttachPhaseForTest`/`attachHighlightRouter` 与相关类型）——模块级可变状态整块随迁，单点不拆。
5. `code/renderCode.ts`：全量路径（720-1255）+ `renderCodeWindowed.ts`：窗口流式路径（1256-2551，含 pump 常量与 `codeWindowedPumpControls` WeakMap）。
6. `code/index.ts`（或直接由 façade 兼任）：`codeRenderer` Renderer 装配（2554-2693）+ `renderDegradedCode`（2703-2730，markdown/html 共用降级入口）+ `export *` 汇总。
7. `src/code.ts` 改为纯再导出 façade（`export * from './code/...'` + 显式 type 再导出），约 30 行——`package.json`、html.ts/jsonl/markdownRenderer 的 `./code` 深导入、26 个测试文件的 `../src/code` 导入**全部零改动**。

**steps**: ① 建 `code/` 六子模块（按分块注释逐块剪切，每块后 `pnpm --filter @vviewer/render-text test` 跑包内既有测试）→ ② code.ts 收敛为 façade → ③ 全量验证（§6 FE 面 + `pnpm build` PWA 自检 + diagram-budget——图表 chunk 在 markdown/diagramEngines，不在本次触面）。

**behaviorGuards**: render-text 既有 26 个测试文件的导入面经本轮实测校准：`test/` 下 **17 个文件**经 `../src/…` 相对导入（code 系直接 `../src/code`：`code.test`/`code-line-metrics`/`code-index-stream`/`code-window-pump`/`search`/`jsonl-render` 等），`src/markdown/` 下 **9 个 colocate 测试**经 `../code` 相对导入（`markdownRenderer*`/`export.test` 等，同指 `src/code.ts`——rg 实测该目录经 `../../src|../src/code` 写法导入为 0 个）——**两条路径殊途同归于 `src/code.ts` 入口，façade 同时覆盖两侧**，导入面与符号集不变是行为不动的主锚；上述 17+9 清单即拆分前后用例数比对的基准（评审反馈的 8/18 拆分与实测差 1，以本轮实测 9/17 为准）。e2e：`b-code-highlight-degrade`、`b-code-scan-resilience`、`b-io-streaming`、`b-io-degrade-matrix`、`b-corpus-code-text`、`b-in-file-search` 兜降级链/流式/搜索行为。缺口：无——既有覆盖已厚（含 attach 竞态、窗口泵、行尺度），不额外补测试；「façade 符号完备」由消费方 typecheck 静态保证。

**risks**: 中低。① 拆块间私有 helper 可见性拼装（升 internal 导出，编译即红）；② 循环导入——DAG 设计（strategy/chunks/lines/client 为底层，renderCode/windowed 居中，index 装配在顶）并以 `pnpm typecheck` 双轨 + 构建验证；③ vite 打包 chunk 面：公共导入图不变，产物预算门（diagram-budget）不触面；④ 模块级状态只此一处（client attach），整块随迁无跨模块共享。

**commitMessage**: `refactor(render-text): code.ts 目录化拆分——2730 行渲染器巨石子模块边界根治`

---

### FE-3 设置字段白名单 DEFAULTS 派生（对账机械化）

**scopePaths**: `apps/web/src/lib/stores/settings.ts`、`apps/web/src/lib/settingsDraft.ts`、`apps/web/src/lib/settingsDraft.test.ts`

**design**（模式：**以类型系统为对账器**。为什么值得：勘察 medium 痛点——新增设置项固定触达 5 处，其中 `SETTINGS_KEYS` 手工清单靠记忆对账，漏登记的失败模式是**导入静默丢字段**（用户数据丢失类缺陷）。`DEFAULTS: Settings` 已被 TS 静态锁全键（缺键编译错、多键不可能），`Object.keys(DEFAULTS)` 即键集的运行时唯一真相——派生后「新增字段忘登记白名单」这一缺陷**不可再发生**。为什么不过度：不做全量 schema 驱动声明源（接口 + DEFAULT + normalize + Section 组件由一张 schema 表生成）——逐字段校验语义高度异构（clamp/前缀格式/键依赖白名单如 diagrams.modes 按注册表过滤），声明式 schema 表达力不足或被迫引入新依赖，且 normalizeSettings 的落值行为被 `stores/settings.test.ts` 逐字段锁定，大改=高漂移风险低边际收益。键序本轮已核实两侧 11 键完全一致，派生后 `pickKnown` 输出对象键序不变，localStorage 落盘字节面零漂移）：

1. `stores/settings.ts`：`DEFAULTS` 导出（`export const DEFAULTS: Settings = {...}`，仅加 export）。
2. `settingsDraft.ts`：删除手工 `SETTINGS_KEYS`（27-41），改 `const SETTINGS_KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];`——`pickKnown`/`validateSettings` 消费面零改动。
3. `settingsDraft.test.ts` 补一条纯结构测试：「DEFAULTS 键集经派生后对 `openDraft(defaults)` 全量序列化-校验零 unknown 报告」（防未来退回手工清单/新增字段漏 DEFAULTS 的回归锚）。

**steps**: ① 导出 DEFAULTS → ② 派生替换 + 删手工清单 → ③ 补结构测试 → ④ `pnpm test`（`settings.test.ts`/`settingsDraft.test.ts`/`settingsCenter.test.ts` 三件全绿）+ typecheck。

**behaviorGuards**: `stores/settings.test.ts`（含「未知键原样透传」历史行为锁，`settings.ts:101` 注释指认）、`settingsDraft.test.ts`（白名单镜像校验全量用例）、`settingsCenter.test.ts` 兜底；e2e `b-settings-center*` 两件兜 UI 面。缺口：无——新增测试是结构锚，不改任何行为断言。

**risks**: 极低。唯一理论面是键序（已核实一致）；`Object.keys` 对对象字面量按插入序枚举是语言规范保证。

**commitMessage**: `refactor(web): 设置字段白名单 DEFAULTS 派生——导入静默丢字段的人工对账根治`

---

## 5. 不做清单（含理由）

1. **Renderer 6 参 `render` 签名改 options 对象**：`core/src/types.ts` 契约明文承诺「未迁移渲染器零改动」，改签名即同触 12 渲染器 + dispatcher/重试/open-as 链——勘察自列的公共 API 稳定禁区，扩展继续走可选 opts 字段。
2. **core 框架无关性与 DOM/sessionStorage 依赖的彻底剥离**（`virtualScroller.ts:44`、`errorRenderer.ts:15`、`SESSION_LAST_SERVER_KEY` 直读）：牵动 core 公共面与 e2e 锚（`e2e-server/b-grammar-layers-server.spec.ts:56` 直接断言键值形状），且 render-media 直读 sessionStorage 是既有行为面；属独立立项，不混入本轮。
3. **render-doc → render-text/sanitize 唯一横边**：消除它要么动 exports 子路径（禁区：等于同改 web 深导入），要么把 DOMPurify 净化器下沉 core（加重 core DOM 依赖，与 #2 相悖）。低频改动面，保留并在两侧注释注记即可。
4. **AppState Deref/DerefMut 编译期屏障**：真实修复需收 CoreState 字段可见性——`state.rs:30-42` 注释已清点消费方在适配层内部与 builder 群，收可见性将大面积破坏测试/装配编译；source_anchors 式文本锚测（禁新直改点）噪声/收益比不佳。维持评审纪律，后续随域抽取渐进。
5. **状态管理三机制（runes/pub-sub/CustomEvent）统一**：CustomEvent 的 DOM 派发时序与订阅链同步通知是行为面，统一即行为漂移风险；FE-1 已消解其最大成本（新逻辑落纯模块即可测）。workspaceStore 的手写 pub-sub 镜像模式（`openFlow:603-614`）运转良好，不动。
6. **根 vitest 加 svelte 插件使 `.svelte.ts` 可直测**：需新增 dev 依赖（pnpm-lock 漂移，违硬约束 4）；仓内「纯逻辑抽 .ts」先例即为此约束的既定答案。
7. **main.rs/config.rs 内嵌测试外移 + `serve()` 拆段、AppShell.svelte 拆分**：真实痛点但体量大（AppShell 依赖 FE-1 落定后的状态出口清点；main.rs 装配链测试外移需把装配 helper 升入 lib 面），作为后续候选，不挤占本轮 6 项的验证带宽。
8. **一切依赖增删/迁移**（含 watch 移 core 将牵动的 notify 依赖迁移、任何 crate/npm 包新增）：Cargo.lock / pnpm-lock 零漂移硬约束。

## 6. 验证策略（工作流统一执行；本轮勘察只读、未跑全量）

每项提交前（局部）+ 全部完成后（全量）两层：

**BE 组（BE-1/2/3，每项同门）**：
- `cargo clippy --manifest-path server/Cargo.toml --workspace --all-targets -- -D warnings`（CI 门：ci.yml rust job）
- `cargo test --manifest-path server/Cargo.toml --workspace`（CI 门；前置：setup-grammars / `pnpm gen:grammars`）
- 双形态 check——**本地必跑，CI 不覆盖**（ci.yml rust job 仅上述两条；deploy-worker.yml 为手动 workflow_dispatch，非 push/PR 触发）：
  - `cargo check --manifest-path server/Cargo.toml --workspace --all-targets --no-default-features`
  - `cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`（cwd=server/）
- `git diff --stat server/Cargo.lock` 必须为空。
- BE-3 追加：内嵌测试随迁后 `cargo test -p vviewer`（主 crate 单测面）确认测试数量不减（用例名清单比对）。

**FE 组（FE-1/2/3，每项同门）**：
- `pnpm test`（root vitest 124 文件全绿；FE-1/FE-3 新增测试文件计入）
- `pnpm typecheck`（tsc -b project refs + svelte-check 双轨——façade 再导出完备性的静态证明）
- FE-2 追加：`pnpm build`（gen-icons + vite build + check-pwa-build）与 `node tools/diagram-budget.mjs`（产物预算不触面，跑作回归锚）。
- `git diff --stat pnpm-lock.yaml` 必须为空。

**端到端（全量完成后一次）**：
- 主套：`pnpm --filter web exec playwright test`（chromium+mobile 双 project 472 例；前置链：grammar wasm、`build:e2e` 的 mock CDN 注入、e2e 语料）
- 服务端通道：`pnpm --filter web exec playwright test -c playwright.server.config.ts`（94 例；前置：release 二进制 + web build）——FE-1 的连接/挂载/恢复面与 BE 组的 HTTP 面在此汇合验证。

**行为不变的附加取证**：BE-2 提交说明附 `tests/tree_file.rs`、`tests/kroki_proxy.rs` 通过清单；FE-1 提交说明附 `b-tab-actions-enrichment`、`b-wsx-recovery` 结果；FE-2 附 render-text 包内测试计数（搬迁前后用例数一致）。

## 7. 实施顺序与依赖图

```
BE-1 ──► BE-2          （同文件串行：kroki 错误面先归一，映射再下沉）
BE-3 ── （独立）
FE-1 ── （独立）
FE-2 ── （独立）
FE-3 ── （独立，随时可做）
```

推荐排期：BE-1 → BE-2 → BE-3 → FE-1 → FE-2 → FE-3（先小后大、错误面先行）；六项各自独立提交，任一项可单独搁置不影响其余五项。
