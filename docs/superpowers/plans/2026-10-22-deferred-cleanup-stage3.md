# 递延清偿批 阶段三（挂载/存储 21 项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿 spec 2026-10-21-deferred-cleanup-design.md §3 阶段三的 21 项挂载/存储递延项（含两个最小实现的新功能面 3-17 region 与 3-18 降级重探、clippy 基线清零新门）。

**Architecture:** Rust 面全部在既有接口内（MountConfig 加可选字段、storage 内部助手单源化、测试重构与补齐）；Web 面围绕 mountsSync/openFlow 既有结构（重注册迁移、显示名映射、提示接线），**不动 TabCollection/快照 schema、不动 storeId hash 输入面**（spec §4-2）。clippy 清偿为阶段收尾任务。

**Tech Stack:** Rust（vviewer-storage / vviewer-core / server bin / vviewer-worker）+ TypeScript（apps/web mountsSync/openFlow/mountsManager，vitest）+ playwright e2e。

**Spec:** docs/superpowers/specs/2026-10-21-deferred-cleanup-design.md（§3 阶段三、§4 裁决 1/2/3、§6 门禁）

## Global Constraints

- main 直行；每任务原子 commit；Angular 规范中文提交信息。
- 行为锁：既有测试零改动零翻转（本计划明示改锚/重构的除外：Task 4 TOCTOU 共源重构、Task 7 mockS3 兜底语义对齐）。
- 凭据三不纪律：MountConfig 手工 Debug 脱敏面（core/src/mounts.rs:68-84）新增字段必须同步脱敏口径（region 非敏感、原样列出）。
- clippy：Task 8 之前与基线（56±1）比零新增；Task 8 起 workspace 新门=0。
- SDD 台账：`.superpowers/sdd/2026-10-22-deferred-cleanup-stage3/progress.md`；收口抄送 digest。
- 语义仲裁源：各任务「定位（计划期侦察）」给出的 行号 为 BASE 时点，盘上漂移以现状为准。

---

### Task 1: storage 小件三件——RangeSpec 锚 / MockTransport 脱敏 / 助手单源化（3-12、3-5、3-16）

**定位（计划期侦察）**：RangeSpec=storage/src/lib.rs:137-141（无构造校验）；MockTransport no-route=storage/src/transport.rs:220-227（`format!("mock transport: no route for {} {}", req.method, req.url)` 拼原始 URL，URL 含 userinfo——main.rs:537 锁测证 `http://ak:sk@host/...`）；助手现状=已共享 `xml_unescape/parse_http_date_millis/normalize_prefix/into_tokio/read_up_to/header_value/dir_entry`（s3.rs 内 pub(crate)，webdav.rs:38-40 导入），仍双份的七组里**真异构**：percent 集（S3 保留 `~`）/decode 路径/XML 扫描——webdav.rs:26-29 模块注明言「同构但独立声明，防单边改动串扰」。

**Files:**
- Modify: `server/storage/src/lib.rs`（RangeSpec doc+锚测）、`server/storage/src/transport.rs`（no-route 消息脱敏）、新 `server/storage/src/util.rs` 或 lib.rs 内共享区（三组同义助手单源）

**Interfaces:**
- Produces: `ensure_status`/`ERROR_BODY_SNIPPET`/`total_size_*` 三组自 lib 共享导出（s3/webdav 改导入）；`RangeSpec` 的 len>0 契约有行为锁测。

- [ ] **Step 1: 写失败测试**（lib.rs tests 或 transport.rs tests）

```rust
/// 3-5：no-route 错误消息不得携带 userinfo（对齐 display_endpoint 纪律；
/// 既有 send_failure_error_message_strips_userinfo 同款红线）。
#[test]
fn mock_no_route_error_strips_userinfo() {
    // MockTransport 路由表空 → POST http://ak:sk@127.0.0.1:9000/x
    // 断言错误消息含 "127.0.0.1:9000/x" 且不含 "ak:sk"
}
```

```rust
/// 3-12：RangeSpec len=0 的现状语义钉死（不变式锚——路由层 parse_range
/// 已拒 len 0，此处锁后端面行为防静默漂移）。
#[test]
fn range_spec_zero_len_current_semantics_is_pinned() {
    // LocalFs.read_range 对 len=0 的现状行为（空流或 Err，以实测为准）断言钉死，
    // doc 同步「len>=1 由路由层保证，后端信任」
}
```

- [ ] **Step 2: 红灯确认 → 实现**：no-route 消息改为剥 userinfo 的形态（复用 display_endpoint 的剥法或 `url::Url` 解析取 scheme//host/path）；三组同义助手（`ERROR_BODY_SNIPPET`、`ensure_status`、`total_size_from`/`total_size_of`——语义逐字节一致者）下沉共享区，s3/webdav 改导入；**真异构三组（percent 集/decode/XML 扫描）不动**，webdav.rs:26-29 模块注补一句「3-16 裁决：语义真异构面保持独立（S3 保留 `~`、decode 目标面不同、XML 前缀域不同），仅全同语义面单源」。RangeSpec doc 补不变式句+锁测落位。
- [ ] **Step 3: 全量**——`cargo test -p vviewer-storage && cargo test --workspace`：全绿零翻转（两侧向量测试 ：631-775/:940-1150 是单源化回归网）。
- [ ] **Step 4: Commit**

```bash
git add server/storage/
git commit -m "refactor(storage): no-route 错误剥 userinfo+RangeSpec 契约锚+全同语义助手单源（台账 3-5/3-12/3-16）"
```

---

### Task 2: region 配置面（3-17，最小实现）

**定位**：region 现为常量 `DEFAULT_REGION="us-east-1"`（s3.rs:44-48，注释明言「签名函数已参数化，扩展零改动」）；`sign_request`(:148) 已收 region 参数，scope 拼接 ：209；`S3MountConfig`(:73-87) 无字段；`MountConfig`（core/src/mounts.rs:50-63，deny_unknown_fields）+手工 Debug(:68-84)+`build_mount` S3 分支(:146-156)；指纹 `mount_fingerprint`(:91-104)；官方向量测试 s3.rs:957 起。

**Files:**
- Modify: `server/core/src/mounts.rs`（MountConfig.region 可选字段+Debug 面原样列出）、`server/storage/src/s3.rs`（S3MountConfig.region+消费点替换 DEFAULT_REGION 常量）、`server/storage/src/lib.rs`（build_mount 无关——映射在 core）
- Test: `server/core/src/mounts.rs` tests（反序列化/Debug/指纹）、`server/storage/src/s3.rs` tests（region 差分）

**Interfaces:**
- Produces: `MountConfig.region: Option<String>`（缺省 None→us-east-1 现状）；TOML `region = "..."`、VV_MOUNTS JSON、POST body 三通道免费获得（同型反序列化）；`S3MountConfig.region`。

- [ ] **Step 1: 写失败测试**

```rust
// core/src/mounts.rs tests——3-17 三件
#[test] fn region_field_roundtrips_via_serde() { /* JSON region="eu-central-1" → Some；缺省 → None */ }
#[test] fn region_lists_plain_in_debug() { /* Debug 含 region 值本身（非敏感），凭据仍 [redacted] */ }
#[test] fn region_not_in_fingerprint() { /* 同挂载异 region → mount_fingerprint 相同（裁决：region 不改挂载身份） */ }
```

```rust
// s3.rs tests——region 差分（官方向量仅 us-east-1，保持不动；新增差分锚）
#[test] fn region_flows_into_credential_scope_and_signature() {
    // 同请求同凭据，region="eu-central-1" vs 缺省：
    // authorization 头的 Credential 段含各自 region 串，且两签名不同
}
```

- [ ] **Step 2: 红灯 → 实现**：MountConfig 加 `#[serde(default)] pub region: Option<String>`（Debug 面原样列出）；build_mount S3 分支透传；S3MountConfig 加字段，签名消费点（:209 scope 拼接处上游）把常量替换为 `region.as_deref().unwrap_or(DEFAULT_REGION)`；**指纹不含 region**（Ruling：region 是解析语义参数非身份面，对账幂等语义不变——代价：同 endpoint 换 region 不会触发重注册，知情接受）。
- [ ] **Step 3: 全量**——`cargo test -p vviewer-core -p vviewer-storage && cargo test --workspace`；worker 面免费获得（parse_mounts_json 复用 MountConfig），wasm check 锚绿。
- [ ] **Step 4: 文档**——server/README.md 配置文件章节 `[[mount]]` 键表补 region 行（可选，缺省 us-east-1）。
- [ ] **Step 5: Commit**

```bash
git add server/core/src/mounts.rs server/storage/src/s3.rs server/README.md
git commit -m "feat(storage,core): S3 挂载可选 region 配置面——贯通 TOML/env/API 入签名 scope（台账 3-17）"
```

---

### Task 3: config 校验直测两件（3-13、3-14）

**定位**：`validate_startup`（main.rs:158-199）纯函数已可测；allow_lan 判定 :163-168、web_dist `is_dir()` :192-196（文件路径误配报 not a directory）；config.rs tests 现有 allow_lan 链测 :513-517 但**无 false≡缺省直测**；web_dist 校验链零单测。

**Files:**
- Test: `server/src/config.rs` tests / `server/src/main.rs` tests（validate_startup 落点以现状为准）

- [ ] **Step 1: 写测试**

```rust
/// 3-13：文件侧 allow_lan=false ≡ 缺省（不做「显式拒绝」）——false 不绕过
/// 「allow_lan 必须 token」校验的否全面，也不新增面。
#[test]
fn file_allow_lan_false_equals_absent() {
    // FileConfig { allow_lan: Some(false), token: None, .. } 合并后：
    // resolved.allow_lan == false，validate_startup（无 CLI --allow-lan）不因 allow_lan 拒绝
}

/// 3-14：web_dist 指向文件（非目录）→ 校验链报错且消息含 is_dir 语义。
#[test]
fn web_dist_pointing_at_file_is_rejected() {
    // tempfile 写一个文件 → validate_startup Err 消息断言（消息以现状为准，锁现状文案）
}
```

- [ ] **Step 2: 红灯确认（3-13 大概率直接绿——它是「缺直测」非「缺行为」，测出绿即锚定；3-14 若校验链对文件路径 panic 而非报错则为真缺陷，按现状行为钉死或最小修复，报告记录）→ 全量 → Commit**

```bash
git commit -m "test(server): allow_lan 文件 false≡缺省直测+web_dist 文件侧校验锚（台账 3-13/3-14）"
```

---

### Task 4: server tests 三件——TOCTOU 共源 / security 门定性 / serve 全链路集成（3-9、3-7、3-6）

**定位**：TOCTOU 对=server/tests/mounts.rs:240-251（头）vs :253-266（体）——各自 `fixture()` 独立实例；同型对 tree_file.rs:188-208/:211-223；security.rs 门=:5-6 import、:58-74 helper、:151-201 ticket 全链（:148-150 门控理由注释在案；:135-146 bearer 测试恒跑）；serve 全链缺口=无任何测试走 `config→build_mount_roots→builder→router→三 API→tree/file 经挂载根`（mounts.rs 仅静态注入面绕过 build_mount；mounts_api.rs 仅运行时 API 面；main.rs:489-541 有 build_mount_roots 单测先例但无 router）。

**Files:**
- Modify: `server/tests/mounts.rs`（:240-266 共源重构）、`server/tests/tree_file.rs`（:188-223 同款）、`server/tests/security.rs`（:148-150 注释定性）、`server/src/main.rs` tests（全链集成新用例）

**Interfaces:**
- Produces: `fixture_with_mount` 共享装置（mounts.rs）——头/体两测共用单实例。

- [ ] **Step 1: TOCTOU 共源**（3-9）——mounts.rs 抽 `fixture_with_mount()`（建一次 AppState+router），两用例改消费同一实例（各自 oneshot 请求——服务端实例同源即达意）；tree_file.rs 两用例同款重构。**既有断言逐字保留，只改装置共享**。
- [ ] **Step 2: security 门定性**（3-7）——核实 core::tickets 锚测确覆盖签发/一次性/过期（fe7d163 迁入的 5 锚测）；:148-150 注释改写为准确口径：「HTTP 链路断言仅 native 形态运行（/api/ticket 路由 native-gated）——签发/一次性/过期语义由 core::tickets 锚测（<测试名>）双形态覆盖，本函数为 wire 面锚」。若发现可双形态运行的断言被误门，摘出同门；预期无（router native-gated），如实记录。
- [ ] **Step 3: serve 全链路集成**（3-6）——main.rs tests 新增（bin 侧可调 build_mount_roots；router 经 lib builder）：

```rust
/// 3-6：serve 全链路带挂载端到端（config→build_mount_roots→builder→router
/// →三 API→tree/file 经挂载根）——MockTransport 免真实网络（:505-541 先例）。
#[test]
fn mounts_full_chain_config_to_router() {
    // FileConfig{ [[mount]] s3 endpoint=http://ak:sk@127.0.0.1:9000/b1 } 解析合并
    // → build_mount_roots(MockTransport 路由: PROPFIND 列表/GET 对象/PUT/DELETE)
    // → AppState builder with_roots(fs)+with_mounts → build_router
    // → GET /api/mounts 201 面清单、POST 幂等、DELETE tombstone
    // → GET /api/tree?root=<挂载idx> 列出 S3 对象、GET /api/file?root=<idx> 200/Range 206
}
```

（装置细节照 main.rs:489-541 既有 build_mount_roots 测试与 mounts_api.rs 的 MockTransport 路由形态；断言面取三 API 各一状态码 + tree/file 各一。）

- [ ] **Step 4: 全量**——`cargo test --workspace` 全绿（重构面既有断言零翻转）。
- [ ] **Step 5: Commit**

```bash
git add server/tests/ server/src/main.rs
git commit -m "test(server): 头体两测同源化+ticket 门注释定性+serve 全链路带挂载集成（台账 3-9/3-7/3-6）"
```

---

### Task 10: 补遗两件——自定义前缀样本 / 降级重探（3-15、3-18）

**定位**：WebDAV PROPFIND 解析的任意前缀面（webdav.rs `open_tag`/`blocks`/`inner`，侦察 :147-197 区）；降级重探的消费面=mountsSync 对账（syncMountsOnConnect probe 失败→failedRecord/pendingRetry，:462-474）与 openRemoteSource/connectServer 重连路径（openFlow :1102/:954）。

**Files:**
- Test: `server/storage/tests/webdav.rs`（3-15 夹具锚）
- Modify: `apps/web/src/lib/mountsSync.ts`（3-18 重探）+ Test `mountsSync.test.ts`

**Interfaces:**
- Produces: 3-18——对账路径上失败挂载的**重探**：failedRecord 存在且非 pendingRetry 首败时，下次对账仍重发 probeMountRoot，成功即转 healthyRecord 并触发挂载行恢复呈现；**不做后台轮询、不加定时器**（spec §4-1 裁决）。

- [ ] **Step 1: 3-15 夹具锚**（webdav.rs tests）——构造自定义命名空间前缀（如 `<md:response>` 包裹的 multistatus 样本）走既有解析断言路径（条目数/href 提取与既有向量同款断言，仅前缀不同）；现状若无测试样本则此为首个锚（行为应已支持，锚定防回归）。
- [ ] **Step 2: 3-18 行为测试先行**（mountsSync.test）——首次对账 probe 失败（failedRecord/pendingRetry）→ 第二次对账 probe 成功 → 记录转 healthy（registeredRootIndex 落位、pendingRetry 清除、展示行恢复）；「不做轮询」的边界=不引入任何定时器（断言测试内无 timer 依赖即可，诚实注记）。
- [ ] **Step 3: 红灯→实现**——核对 syncMountsOnConnect 现状：失败记录是否被「跳过 probe」短路（若现状失败后不再 probe 则补重探路径；若现状每次对账本就重 probe 则销账——实测为准，报告记录走向）。
- [ ] **Step 4: 全量**——`cargo test -p vviewer-storage && pnpm vitest run apps/web/src/lib/ && pnpm typecheck`。
- [ ] **Step 5: Commit（两笔原子）**

```bash
git add server/storage/tests/webdav.rs
git commit -m "test(storage): WebDAV 任意自定义前缀 PROPFIND 解析夹具锚（台账 3-15）"
git add apps/web/src/lib/
git commit -m "fix(web): 挂载对账失败记录重探恢复——下次对账 probe 成功即转健康（台账 3-18）"
```



### Task 5: web mountsSync 小件三件——冗余编码 / failedRecord 清理 / watchHealth 用例（3-10、3-11、3-2）

**定位**：冗余编码=mountsSync.ts:327 `encodeURIComponent('')`；failedRecord=:308-310 只置 pendingRetry+lastError **不清 registeredRootIndex**，展示机 assembleMountRows（mountsManager.ts:320-339）按 registeredRootIndex 判 'registered'；watchHealth 复位点=openFlow:954/1102+AppShell:688，现有测试仅源码锚（directMountFlow.test.ts:28-35），无行为用例。

**Files:**
- Modify: `apps/web/src/lib/mountsSync.ts`（:327、:308-310）、`apps/web/src/lib/mountsManager.ts`（展示兜底，若需）
- Test: `apps/web/src/lib/mountsSync.test.ts`（:294-563 describe 内追加）

- [ ] **Step 1: 写失败测试**（照 ：294-563 既有 fetch 路由桩形态）

```typescript
// 3-11：probe/重注册失败后，failedRecord 不得残留旧 registeredRootIndex
// （展示机不再把它当 registered 呈现/供打开与 unregister 消费）
it('failed probe record clears stale registeredRootIndex', async () => { /* ... */ });
// 3-10：probe 请求路径为字面 `path=`（无 encodeURIComponent('') 调用产物）
it('probe mount root uses literal empty path', async () => { /* 断言 fetch URL === '/api/tree?path=&root=N' */ });
```

- [ ] **Step 2: 红灯 → 实现**：`:327` 改字面 `` `path=&root=${rootIndex}` ``；`failedRecord` 置 `registeredRootIndex: undefined`（字段形态照 :52 声明）；assembleMountRows 若对 undefined 已安全回落则零改动，否则补兜底（报告记录）。
- [ ] **Step 3: watchHealth 行为用例**（3-2）——在 directMountFlow.test.ts 或新 watchHealth.test.ts 补「复位方向」行为测试：`connectServer/openRemoteSource 复位源 A 的 watchHealth 不清源 B 的 degraded`、`direct onError 只置本源`。若现结构难直测（store 私有），以导出的最小测试缝或源码锚+注释声明防线（诚实定性，报告记录裁决）。
- [ ] **Step 4: 全量**——`pnpm vitest run apps/web/src/lib/` + `pnpm typecheck`；全绿。
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/
git commit -m "fix(web): probe 路径字面化+failedRecord 清残留索引+watchHealth 复位方向用例（台账 3-10/3-11/3-2）"
```

---

### Task 6: web 深件三件——rootIndex 迁移 / tab 显示名解耦 / 静默关闭提示（3-1、3-20、3-21）

**定位**：对账链=mountsSync.ts:424-486（reregisterMount :340-362 成功写 healthyRecord.registeredRootIndex）；**缺口=已开 tab/sources 的旧 rootIndex 与 storeId（`remote:<hash8>:r<n>`，remote.ts:104,164-165）无任何迁移路径**，快照恢复按 storeLabel 回环（AppShell:660-676）；显示名=remoteSourceLabel（openFlow:1160-1170）只露「根N/tail」不露 mount label，**label 参与 hash（:1096-1104）——异 label 造第二个 storeId**；释放=releaseDirectMountStore（openFlow:1205-1218，undoable:false 关全部持有 tab 无提示）；提示通道=showStatusNotice（openFlow:594-605）。

**Rulings（随任务入台账）**：
1. 3-1 迁移面=「记录 + sources + 存活 tab」三面同步改写，快照恢复面自然跟随下次保存；storeId 改写按 storeId 形态正则替换 `:r<old>` 段（packages/core parseRemoteStoreId :117-118 同源正则），TabCollection schema 不动。
2. 3-20 **hash 输入面零改动**（label 参与哈希的现状保留）——只改「展示名」：新映射 `storeId → mount label`（挂载记录侧维护），tab 标题/来源名消费映射，未命中回落旧 remoteSourceLabel 形态。代价：显示名与 hash 输入解耦后，同源两处展示（来源列表/tab）需同走映射——消费点盘点后统一。

**Files:**
- Modify: `apps/web/src/lib/mountsSync.ts`（reregisterMount 返回 old→new 映射）、`apps/web/src/lib/openFlow.svelte.ts`（迁移消费/显示名映射/提示接线）、`apps/web/src/lib/AppShell.svelte.ts` 或 .svelte（:688 区复位/提示若涉）
- Test: `apps/web/src/lib/mountsSync.test.ts`、`apps/web/src/lib/openFlow` 既有测试文件（盘点后落位）

- [ ] **Step 1: 3-21 最小件先行**——releaseDirectMountStore 关闭计数处与 connectServer 清扫处接 `showStatusNotice`（文案：`已关闭 N 个标签页（挂载已释放）` / 重连清扫复用既有口径补提示）；e2e 以 `.vv-statusbar` 断言可后置到 Task 7。
- [ ] **Step 2: 3-1 迁移**——reregisterMount 成功路径返回 `{ oldIndex, newIndex }`；syncMountsOnConnect 收集本次全部迁移对，经回调注入 openFlow（ mountsSync 已有对 openFlow 的依赖注入形态，盘点后落位）执行三面改写：记录（healthyRecord 已写）、`sources[]`、TabCollection 存活 tab 的 storeId 段替换。测试：mountsSync.test 桩重注册场景断言迁移回调收到映射；openFlow 侧迁移函数抽纯函数（输入 tab/source 快照+映射→输出改写结果）直测。
- [ ] **Step 3: 3-20 显示名**——挂载记录侧导出 `displayLabelForStore(storeId): string | undefined`（proxy 记录 label+direct 记录 label，未命中 undefined）；openRemoteSource/tab 命名消费点改「映射优先、回落 remoteSourceLabel」；**hash 输入与 storeId 生成零改动**。测试：映射命中/未命中两态直测。
- [ ] **Step 4: 全量**——`pnpm vitest run apps/web/src/lib/ && pnpm typecheck`；全绿零翻转（既有 mountsSync/openFlow 测试是回归网；若 3-1 改写触发既有用例翻红，逐条定性：行为变更属预期则改锚并报告，否则修复实现）。
- [ ] **Step 5: Commit（可按 3-21/3-1/3-20 三笔原子）**

```bash
git commit -m "feat(web): 挂载释放/重连清扫接状态栏提示（台账 3-21）"
git commit -m "fix(web): 对账重注册迁移已开 tab 的 rootIndex 与 storeId 段（台账 3-1）"
git commit -m "fix(web): 挂载显示名映射解耦——tab 名不再只见根序号（台账 3-20）"
```

---

### Task 7: e2e 三件——mock 对称 / MM-07 负断言 / AppShell 重连用例（3-3、3-4、3-8）

**定位**：mockS3（b-mounts-manager.spec.ts:143-176）未命中 GET 兜底 `{status:200, body:''}`（:174）vs mockDav :206 兜底 404；MM-06 有负断言（:496-497）而 MM-07（:500-540）只有正断言；断连→重连→挂载/树恢复显式用例不存在（最近 WSX-07/09、MM-09）。

**Files:**
- Modify: `apps/web/e2e/b-mounts-manager.spec.ts`（:174 兜底、MM-07 负断言、新用例）
- Test: 同文件（新用例照 MM-09 装置）

- [ ] **Step 1: mockS3 兜底对齐**（3-3）——:174 改 `fulfill({status:404, body:'not found'})` 与 mockDav 一致；**跑全 b-mounts-manager 套件**：若有用例依赖 200 空体兜底，为该用例的路由桩补显式命中（逐条定性报告，不得放宽兜底）。
- [ ] **Step 2: MM-07 负断言**（3-4）——照 MM-06 :496-497 形态补对偶负断言（s3 面有的 dav 面也断言其不出现/反之，按 MM-07 场景语义落）。
- [ ] **Step 3: AppShell 重连用例**（3-8）——新用例（照 MM-09 装置）：注册挂载→打开 tab→模拟断连（路由桩 5xx/abort）→恢复→重连→断言挂载行恢复+tab 内容可读（server 套件形态照 e2e-server 或 manager 套件按装置归属落位）。
- [ ] **Step 4: 门禁**——`pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-mounts-manager`（CI workers=1 感知照既有 config）；全绿。
- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/b-mounts-manager.spec.ts
git commit -m "test(e2e): mockS3 兜底对齐 dav+MM-07 负断言+断连重连恢复用例（台账 3-3/3-4/3-8）"
```

---

### Task 8: clippy 基线清零（3-19，阶段收尾）

**定位**：workspace clippy 现状 55-56 条（口径差 1 系无主 span 告警），分布跨 core/storage/server/worker——阶段一终审已实证本批触碰文件零新增。

- [ ] **Step 1: 全量清点**——`cargo clippy --workspace --all-targets 2>&1 | rg '^warning' | sort | uniq -c | sort -rn` 分组；逐条修复（机械 lint 就地改；确属误报/风格保留的用 `#[allow(clippy::lint)]` + 一句话理由注释）。**禁止为清零改行为**：任何修复若触及语义（如 QuestionMark/ needless_pass 之外的改动），单独评估并在报告列出。
- [ ] **Step 2: 新门落地**——CI（.github/workflows/ci.yml 或对应 lint job）clippy 步骤加 `-D warnings`（若 CI 已有 clippy 步则升级参数；无则 README 开发门禁节补一行）。核 ci.yml 现状后落位，报告记录。
- [ ] **Step 3: 全量**——`cargo clippy --workspace --all-targets -- -D warnings` 零输出 + `cargo test --workspace` 全绿（清偿零行为变更的证明）。
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(workspace): clippy 基线清零——新门 -D warnings 入 CI（台账 3-19）"
```

---

### Task 9: 阶段门禁与 digest 回写

- [ ] **Step 1: 全量门禁**（先 server 后 desktop 后 e2e，勿并行）：
  `pnpm typecheck` → `pnpm vitest run` → `cargo test --workspace` → `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → `pnpm --filter web build:e2e` → `node tools/diagram-budget.mjs` → playwright 定向（b-mounts-manager + b-wsx）
- [ ] **Step 2: digest 回写**——21 项逐条终态（映射以台账为准）；「必做/高价值」实机 MinIO/DAV 行**不在本批**保持开放；头部补「阶段三清偿：<日期>，21/21」。
- [ ] **Step 3: 台账终条 + Commit**——`docs(report): 递延清偿批阶段三终态回写——21 项销账`

## 任务依赖

T1/T2/T3（storage/core/config）互相独立；T4 依赖 T1 的 MockTransport 消息形态（弱依赖，可并行）；T5 独立；T6 与 T5 同文件族（mountsSync/openFlow）——**T5 先行 T6 后**；T7 依赖 T6（重连用例断言提示行可选）；T8 恒在全部 Rust 改动后；T9 收尾。推荐执行序：T1+T2 批 → T3+T4 批 → T5 → T6 → T7 → T8 → T9。
