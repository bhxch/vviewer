# SDD ledger — plan: docs/superpowers/plans/2026-10-19-desktop-tauri.md

BASE: 299fe33（main 直行；实现者 general-purpose）

## 预检扫描

| 对 | 结论 |
| --- | --- |
| T1→T2 | VV_READY 协议 → shell 解析器 | 一致（解析器纯函数在 shell crate） |
| T2→T3 | 壳项目 → CI matrix | 一致 |
| T1 自洽 | 就绪协议测试形态（spawn 先例可能不存在）——纯函数提取+脚本化端到端替代已留 | 实现者取并报告 |
| T2 自洽 | Tauri CLI 安装形态/产物矩阵校准/资源路径 dev-release 差异 | 风险预留已列 |
| T3 自洽 | GUI 不可本地验证——脚本化端到端+冒烟清单为验收形态 | 已列 |

无跨任务矛盾。开始执行。T1 服务端先行；T2 壳；T3 CI+文档。
Task 1: minor (deferred): health_status 解析失败 unwrap_or(0) 丢响应体（诊断完整性可选整改）；解析器容忍前导 +（server 端纯净性已锁，壳侧实现须知）；VV_READY 无条件输出（显式端口路径多一行，人读无碍）
Task 1: complete (commits 299fe33..2358644, review clean)
Task 2: minor (deferred): spawn_exit_monitor Err 分支子进程僵尸（罕见）；重启主线程同步冻结 15s（已自曝，阶段二重审条件）；报告引用出处不实（dialog 措辞）；SIGTERM 孤儿 server（brief 范围外）；stderr 跨块截断观感；release 资源落盘布局待 Task 3 CI 冒烟
Task 2: complete (commits 2358644..aceab3b, review clean)
Task 3: fix round 1/5 (3 addressed, 0 open — Major-1 Linux apt 垫片+Minor 注释失实修正+Gatekeeper 措辞; commits fe244c6..c17db37)
Task 3: minor (deferred): windows build.rs mingw×msvc 链接面/macOS objcopy 垫片/bundler 下载面——CI 首跑校准项（失败不影响其他 job）
Task 3: complete (commits aceab3b..c17db37, review clean after 1 fix round)
Final review: With fixes → C1 dialog 插件未注册（一行注册+mock 契约测试诚实弱锚声明）+C2 Windows .exe 解析（cfg!(windows) 统一追加+binaries README）+I1 冒烟清单升级发布门禁+M1-M4 → 修复波 eaea388 → scoped re-review 5/5 ADDRESSED（Builder 次序/mock 测什么防什么边界/externalBin Windows 约定逐点核实）
Final review: minor (deferred): dialog 契约测试防不了 main 链删行（Wry 不可 mock——评审把关兜底）；SIGTERM 孤儿 server（本机语义基线）；重启冻结（阶段二）；windows/macOS 运行期行为 CI 首跑+人工冒烟收口
Plan A complete: HEAD eaea388，全门禁绿（desktop cargo check/clippy 零警告+16 单测/server --workspace 全绿零翻转）
阶段一闭环。待续：阶段二（vviewer-core 抽取重构）→阶段三（Workers 适配）
