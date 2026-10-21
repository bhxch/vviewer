# SDD ledger — plan: docs/superpowers/plans/2026-10-19-mounts-api.md

BASE: 1093151（main 直行；实现者 general-purpose）

## 预检扫描

| 对 | 结论 |
| --- | --- |
| T1→T2 | 三 API 契约 → mountsSync 对账 | 一致 |
| T2→T3 | mounts store/对账 → e2e | 一致 |
| T1 自洽 | 无 token 部署三 API 免鉴权写面——spec 字面+风险标注 | Ruling: 按 spec 字面实现+报告显著标注 |
| T1 自洽 | DELETE 活跃 tab 失效帧复杂度超预期降级路径 | 计划已留 |
| T2 自洽 | db 版本顺延（fonts v3→v4 或同 v3 追加） | 实现者按 session.ts 结构取+报告 |
| T3 自洽 | e2e 对真实 reqwest 不可达的取舍（集成 MockTransport 已覆盖读路径） | 计划已留 |

无跨任务矛盾。开始执行。T1 服务端先行；T2 前端；T3 收尾。
Task 1: minor (deferred): S-2 POST 无显式 body 上限（axum 默认 2MB 兜底，Task 3 顺手补显式限值）；Q-1 挂载根搜索 400 而非 spec 501（Task 2 确认降级判定=非 200）；Q-3 405 缺 Allow 头；rootIndex 复用窗口（对账消除）；closeOverlay armZenGuard 类比：closeOverlay 无条件 armZenGuard 死项类比不适用本计划
Task 1: complete (commits 1093151..8e2998b, review clean)
Task 2: minor (deferred): restore 重连通道未挂对账（移交 T3 裁决单行补挂）；重注册后已开 tab 旧 rootIndex 不迁移（阶段四管理页收敛）；Bearer 三面注入测试声明与实际不符（DELETE 面未覆盖，统一通道非缺陷）；failedRecord registeredRootIndex 残留展示优先级；probeMountRoot 冗余 encodeURIComponent
Task 2: complete (commits 8e2998b..a0af5d5, review clean)
Task 3: minor (deferred): AppShell 重连接线零自动化覆盖（回归盲区标注）；e2e 断言分号进注释风格；README :index 表示法
Task 3: complete (commits a0af5d5..5bbf14c, review clean)
Final review: With fixes → I-1 非尾项 DELETE 移位串扰（tombstone 容器+追加分配不填空洞+文档更正）+I-2 mountsSync 静态挂载误判（运行时段起点=fsRoots+staticMounts.length）+M-1 405 Allow 头 → 修复波 8ca7ff4+e8725b1 → scoped re-review 3/3 ADDRESSED（空转单测改真回归锁逐路径推演/四象限 tombstone 锁测）
Final review: minor (deferred): 测试助手 manifestJson 引用相等过滤 cosmetic；重注册后已开 tab 旧 rootIndex 不迁移（阶段四收敛）；e2e spec 须 server config 运行（环境注记）
Plan B complete: HEAD e8725b1，全门禁绿（cargo --workspace 369/vitest mountsSync 27+全仓/build:e2e+b-mounts 7p）
阶段二闭环。待续：阶段三+四（直连 store+目录管理页，Plan C 待写）
