# SDD ledger — plan: docs/superpowers/plans/2026-10-19-mounts-direct.md

BASE: 75a03ec（main 直行；实现者 general-purpose）

## 预检扫描

| 对 | 结论 |
| --- | --- |
| T1→T2 | 直连 TreeStore/mounts store direct kind → 目录管理页表单与列表 | 一致 |
| T1→T3 | storeId/capabilities → e2e | 一致 |
| T1 自洽 | mounts store v4 已由 Plan B 建（kind 'proxy'）——本任务扩 'direct' 是记录级扩展非迁移 | 实现者核实 Plan B 的 store 形态后决定扩展方式 |
| T1 自洽 | WebCrypto SubtleCrypto HMAC 异步——TreeStore 接口本异步无冲突 | 已留 |
| T2 自洽 | OVERLAY_SELECTOR 入册（zen Esc）——设置中心先例（.vv-settings-center 入册） | 同款必做 |
| T3 自洽 | mock S3 不验签（SigV4 头存在性断言即可） | 已留 |

无跨任务矛盾。开始执行。T1 核心先行；T2 管理页依赖 T1；T3 收尾。
Task 1: minor (deferred): M1 直连 Range 防线仅判 status 非 206（弱于服务端 window_honored 口径——Content-Range 可读时补校验或偏差注释，带入 T2）；L1 endpoint 未剥 userinfo（错误消息/storeId hash/IDB 记录——T2 表单校验）；L2-L6 TypeError 泛化/无 scheme/vhost/AbortSignal.any 守卫/optInt 宽松/saveProxyMount 别名；openFlow 创建入口接线留 T2
Task 1: complete (commits 75a03ec..9fda80f, review clean)
Task 2: fix round 1/5 (3 addressed, 0 open — M1 proxyOffsiteOf serverBase 作用域状态机+L3 probe 前置校验+L4 格式; commits 51dce0c..a81b6d6)
Task 2: minor (deferred): unregistered+未连接的删除确认过度声明（无害）；尾斜杠形式重连保守误判 offsite（方向安全）；watchHealth.degraded 全局单标志+direct 前缀未纳入 isMountRootStoreId（Task 3 收口项）
Task 2: complete (commits 9fda80f..a81b6d6, review clean after 1 fix round)
Task 3: minor (deferred): watchHealth 复位方向跨源污染未入报告专节（根治任务用例面补）；mockS3 兜底 200 空体与 mockDav 404 不对称；MM-07 dav 链路负断言弱于 s3；评审包时序瑕疵（流程项）
Task 3: complete (commits a81b6d6..5dd990e, review clean)
Final review: With fixes → I-1 watchHealth 全局标志直连零写点（per-source 通道完好）+I-2 不覆写 label 同 hash8 单 storeId+I-3 releaseDirectMountStore 轮换生效（静默关闭知情取舍）+I-4 proxy 探测勘误文案+M-1 anySignal 守卫 → 修复波 d396b87+6df815a → scoped re-review 5/5 ADDRESSED（零写点 rg/同 hash8 原理/释放链闭环/三路 Esc 互斥延伸）
Final review: minor (deferred): remote.ts:207 AbortSignal.any 同构裸用（根治轮收编）；I-2 tab 名信息损失（storeId 与显示名解耦根治）；I-3 静默关闭无衔接提示（UX 增强）；MM-07 dav 负断言弱于 s3；mockS3 兜底不对称
Spec 5 complete: HEAD 6df815a，全门禁绿（vitest 793 定向+全仓/typecheck/build:e2e/b-mounts-manager 18p）
Spec 5 三阶段全部闭环（阶段一存储抽象 5703859/阶段二 mounts API e8725b1/阶段三+四直连+管理页 6df815a）
