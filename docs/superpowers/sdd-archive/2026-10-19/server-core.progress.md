# SDD ledger — plan: docs/superpowers/plans/2026-10-19-server-core.md

BASE: 062fb83（main 直行；实现者 general-purpose）

## 预检扫描

| 对 | 结论 |
| --- | --- |
| T1→T2→T3 | CoreRequest/CoreResponse/CoreState 类型与逐域 handler | 串行依赖（每步行为锁） |
| T3→T4 | feature 门控双形态 → 收尾核验 | 一致 |
| T1 自洽 | Range 解析留适配层（HTTP 语义）vs core 收 ResolvedRange——计划已定 | 实现者按计划 |
| T3 自洽 | search 的 worker 裁剪口径：core 保留 handler、worker 适配层不挂路由+health 不宣告（机制存在性）——本计划只保机制，worker 消费归 Plan C | 已定 |
| 全局 | SSE 流 CoreResponse 形态（core 自定义 Stream 避免 axum 依赖） | 风险预留已列 |
| 全局 | 集成测试零改动的前提=router 形态不变——**若实现中 router 结构必须变化则集成测试允许 use 级适配，断言零变化**，报告记录 | Ruling: 已预留 |

无跨任务矛盾。开始执行。T1→T2→T3→T4 严格串行（每步行为锁全量回归）。
Task 1: minor (deferred): CoreState.version 默认空串（旁路构造宣告空版本——装配点必然注入）；search.rs 前置触碰为缝注入最小必要形态；报告套件记数口径微瑕
Task 1: complete (commits 062fb83..1def40f, review clean)
Task 2: minor (deferred): CoreState.runtime_transport pub 字段跨 crate 可写（Task 4 撤 Deref 时收口）；计划 Interfaces 字面 read 签名落 locate+read 双段（更忠实既有顺序——Task 4 零残留核验按此口径豁免适配层 Range 解析）；206 窗口合法性契约位置在适配层（记录）
Task 2: complete (commits 1def40f..6c9bd6c, review clean)
Task 3: fix round 1/5 (2 addressed, 0 open — M-1 裁剪形态测试面 native 门禁化+L1 裁剪侧 health 锚测+勘误更正; commits f936b7e..3b62626)
Task 3: minor (deferred): security.rs 函数级门使 ticket HTTP 断言仅 native 形态运行（ticket 语义覆盖不丢——core 锚测非门控面）；guard.rs 兼容缝无消费方留 Task 4 评估；「core 不依赖 comrak」约束表述需 Task 4 文档改写（默认形态 compute 域入核 vs 裁剪形态严格成立）
Task 3: complete (commits 6c9bd6c..3b62626, review clean after 1 fix round)
Task 4: minor (deferred): validate_startup 留守 bin main.rs（ServeArgs 属 bin CLI 类型——阶段三评估下沉）；guard.rs 缝已撤/Deref 缝保留+注记
Task 4: complete (commits 3b62626..a96720b, review clean)
Final review: Yes 可合并（零 C/I；I-1 reqwest/storage-native 耦合=阶段三前置而非本分支缺陷；递延 8 条全可递延/3 条销账/2 条已闭环）
Final review: minor (deferred): CoreRequest 零消费死类型（删除或改注预留）；guard.rs 文档单行修正；file::read 窗口 len>=1 debug_assert；集成测试文件计数口径（14 非 13）；阶段三前置注记【core增设 storage native 转发 feature+懒构造挪出/门控——写入 Plan C 输入】
Plan B complete: HEAD a96720b，全门禁绿（cargo --workspace 392/0+裁剪形态 all-targets 绿/集成测试断言零变化/SSE+NDJSON wire 等价）
阶段二闭环。待续：阶段三（Workers 适配——I-1 前置项+VV_MOUNTS env+Assets binding+体积门禁）
