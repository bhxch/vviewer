# SDD ledger — plan: docs/superpowers/plans/2026-10-19-mounts-storage.md

BASE: 7cf15e0（main 直行；实现者 general-purpose）

## 预检扫描

| 对 | 结论 |
| --- | --- |
| T1→T5 | FileConfig.mounts → 装配链 | 一致（MountConfig 结构 T1 定义 T5 消费） |
| T2→T5 | StorageBackend trait/RootSpec 扩展 → 按根分发 | 一致 |
| T3/T4→T5 | S3/WebDavBackend → 装配 | 一致（MockTransport 统一测试基建） |
| T2 自洽 | LocalFs 下沉的 Range 解析职责归属留实现者取最小迁移 | Ruling: 已留 |
| T5 自洽 | AppState 测试注入点（with_mounts）按既有 with_* 模式 | 先例形态 |
| T3 自洽 | SigV4 的 canonical uri 对 key 的 percent-encode 规则（保留 / 编码其余）——实现以 AWS 官方向量锚定 | 已留 |

无跨任务矛盾。开始执行。T1 独立先行；T2 纯重构风险最高单独派发；T3/T4 可合并（同 crate 同测试基建）；T5 收尾依赖全部。
Task 1: minor (deferred): --help 丢 [default: 8321] 机器标记（人读文案兜底，评审认可不返工）；port=0 无回归锚（Task 5 补）；allow_lan 文件 false≡缺省无直测（Task 5 补）；web_dist 文件侧无单测（Task 5 补）；首跑 flaky lib 未捕获用例名（再复现必须记录）；README 配置示例+600 权限建议（计划层跟踪）
Task 1: complete (commits 7cf15e0..c2b0aa0, review clean)
Task 2: fix round 1/5 (1 addressed, 0 open — Major-1 HttpByteStream futures-io 载体替换+三层编译锚+CI --workspace+已知差异补记; commits 9122ba6..cdfc291)
Task 2: minor (deferred): 双重故障错误优先级重排（Range 非法+打开失败 500→416）；TOCTOU 窗口（头体两测失去同源）；lib.rs:213 锚归属注释含混；「前导零」保真搬运的原注释固有缺陷；flaky lib 用例名再复现必须记录
Task 2: complete (commits c2b0aa0..cdfc291, review clean after 1 fix round)
Task 3: fix round 1/5 (4 addressed, 0 open — Major-1 凭证脱敏手工 Debug+Minor-1 object_url 纯编码+Minor-2 canonical 折叠+Minor-3 窗 GET 206 校验错误语义; commits cc9b609..941fcca)
Task 3: minor (deferred): config.rs server 侧 MountConfig derive(Debug) 泄漏面（Task 5 装配时处理）；wasm32 编译仅主机形态验证；reqwest 线路层无实机证据；RangeSpec len>0 不变式 Task 5 确认；canonical_uri/encode_key_path 双函数并存（各有职责域）
Task 3: complete (commits cdfc291..941fcca, review clean after 1 fix round)
Task 4: minor (deferred): WebDavCredentials pub 收敛（Task 5 顺手）；206 无 CR 且 CL==窗长的病态形态启发式（不要求改）；任意自定义前缀（<md:）无测试样本（Task 5 补锚）；降级不可逆（阶段二健康检查可考虑重探）；s3⇄webdav 同名异构助手迁 lib 统一（既定后路）
Task 4: complete (commits 941fcca..ba043be, review clean)
Task 5: fix round 1/5 (1 addressed, 0 open — M1 display_endpoint userinfo 剥除两线分离; commits 97e49d1..015e363)
Task 5: minor (deferred): 多 @ 形态部分残留（split_once 首个 @ vs reqwest 末个 @ 语义——rsplit_once 一行修，后续跟进）；search 显式 root→挂载根 404 文案（阶段二收敛）；ReqwestTransport 错误消息含 URL 残余通道（另立裁定）；serve 全链路无带挂载端到端集成（三段拼合覆盖）
Task 5: complete (commits 941fcca..015e363, review clean after 1 fix round)
Final review: With fixes → I1 ReqwestTransport 错误消息凭据通道（display_endpoint 下沉 storage+reqwest Display replace 双通道收口）+I2 rsplit_once 末个 @+I3 server/README 配置章节+M4 debug_assert → 修复波 5703859（已推送）→ scoped re-review 4/4 ADDRESSED（reqwest 0.12.28 Display 源码核实/三 yml 裁定/README 逐键对照）
Final review: minor (deferred): reqwest without_url 为 pub API（报告「私有不可达」失实——阶段二可直接修）；clippy 既有基线未清；MockTransport no-route 错误拼原始 URL（测试基建）；实机 MinIO/DAV smoke 阶段二前必做；region 配置面扩展候选；search 挂载根 404 文案
Plan A complete: HEAD 5703859（已推送），全门禁绿（cargo --workspace 352+storage 277 零警告/既有 255 行为锁零改动）
阶段一闭环。待续：阶段二（mounts API+前端接入+对账重注册）→阶段三+四（直连 store+目录管理页）
