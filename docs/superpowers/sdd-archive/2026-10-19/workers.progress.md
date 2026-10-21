# SDD ledger — plan: docs/superpowers/plans/2026-10-19-workers.md

BASE: d9066a2（main 直行；实现者 general-purpose）

## 预检扫描

| 对 | 结论 |
| --- | --- |
| T1→T2 | core storage 解耦 → worker 注入构造 | 一致（T1 交付注入形态，T2 消费） |
| T2→T3 | worker crate/wrangler → 部署 CI 与门禁 | 一致 |
| T1 自洽 | CoreRequest 处置重裁决（终审 Minor-2 遗留：零消费死类型——Plan C 若 worker dispatch 不走它则删除或激活） | Ruling: T1 实现者按 worker dispatch 实际形态重裁决并报告 |
| T2 自洽 | wasm 侧流桥（tokio 裁剪后 compat 不可用——ByteStream 是 tokio AsyncRead） | **关键风险**：StorageBackend ByteStream 是 tokio 形态，wasm fetch 响应需桥接——T1/T2 实测校准；若 tokio 在 worker wasm 不可用则需 ByteStream 抽象化（前置项扩展），报告 BLOCKED 提请 |
| T3 自洽 | canary 探活无 CF 凭据跳过 | 已留 |

**关键风险前置声明**：StorageBackend::read_range 返回 tokio ByteStream（Pin<Box<dyn tokio::io::AsyncRead + Send>>）——workers wasm 无 tokio 运行时。两条路：①worker 用 tokio（workers-rs 支持 tokio runtime? workers-rs 0.x 内置—as of 2025 workers-rs 有 `#[worker::send]` 与 tokio 集成形态，实测为准）；②ByteStream 抽象化（如阶段二 HttpByteStream 同款 futures-io 载体）。T1/T2 实现者实测后裁决，BLOCKED 则提请。

无跨任务矛盾。开始执行。T1 前置解耦；T2 worker 适配；T3 部署链；T4 文档收口。
Task 1: minor (deferred): 裁剪形态 adapter 静态挂载面报配置错误（编译门禁形态无害，compile_error! 升级留终审裁量）；CoreRequest 删除已终审授权
Task 1: complete (commits d9066a2..29d833c, review clean)
Task 2: minor (deferred): Minor-1 HEAD /api/mounts 404（native 派生 HEAD——单条件追加 Task 3/4 顺带）；events.rs 未随 wasm 门控（可编译但运行时 panic 面——不可达论证成立，建议模块级门控）；门控谓词风格不一致（wasm32 vs wasm family）；413 判定时机 body 全读；3xx follow 未实证
Task 2: complete (commits 29d833c..78ef95d, review clean)
Task 3+4: minor (deferred): 根 README 表头错位（阶段一加重，一行修）；is_asset_path 大小写字面；canary inputs 内插（自用仓库风险可忽略）；deploy workflow 未实跑（首跑校准点）
Task 3+4: complete (commits 78ef95d..7972987, review clean)
Final review: Yes 可合并（I-1 无 token 公网开放=计划级缺口首次部署前必修）→ 修复波 4d072f6（fail-closed 装配失败+对外通用化+README 表头）→ scoped re-review 3/3 ADDRESSED（空白串绕过封死/VV_MOUNTS+无 token 最危险形态封死/装配失败对外 500 通用化）
Final review: minor (deferred): canary tripwire 有意行为（未配 token 部署必失败）；资产面不在 fail-closed 范围（公开面同构 native）；README 文档比实现宽松（空白串）
Plan C complete: HEAD 4d072f6，全门禁绿（cargo --workspace 403/裁剪 all-targets 绿/wrangler dev 双形态冒烟/vitest 1727+1 环境项）
Spec 4 三阶段全部闭环（Tauri eaea388/core 抽取 a96720b/Workers 4d072f6）——六大 spec 全部完成
