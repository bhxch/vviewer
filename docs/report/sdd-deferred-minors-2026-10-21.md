# 六 SDD 台账递延 Minor 提取（多端发布 + 目录挂载批次）

- 阶段一清偿：2026-10-22，14/14（commit 区间 6f1db69..83ba0e0；各条终态标注见一/二节，1-1 附勘误）。
- 阶段二清偿：2026-10-22，6 修+1 核实销账（commit 区间 69d02be..4835b5b；各条终态标注见一/二节）。
- 阶段三清偿：2026-10-22，21/21（19 修+2 核实销账，commit 区间 1560c95..b2bf99a；各条终态标注见一/二节）。
- 阶段四清偿：2026-10-22，6/6（4 修+1 翻案修+1 核实销账，commit 区间 5b3a309..726a7a4；各条终态标注见一/二节）。
- 阶段五清偿：2026-10-22，8/8（4 修+3 核实销账+1 勘误，commit 区间 5f259db..648cdaa；各条终态标注见一/二节）。
- 提取日期：2026-10-21。覆盖：上一会话六个 SDD 运行——多端发布阶段一/二/三（desktop-tauri / server-core / workers）与目录挂载阶段一/二/三四（mounts-storage / mounts-api / mounts-direct）。
- **来源更正**：台账并不在 git 历史里。`.superpowers/sdd/.gitignore` 内容为 `*`，台账从未入库；SDD 工作区清理后盘上文件已删，git 悬空对象（fsck）中亦无。本提取从上一会话模型 IO 转录（`~/.zcode/cli/rollout/model-io-sess_8964b1e2-*.jsonl`）中的 Write 调用与 Bash heredoc 追加重放重建，六个台账全文已归档至 `docs/superpowers/sdd-archive/2026-10-19/`（唯一幸存副本）。
- 销账核对：条目状态对照台账自身修复波记录与现行代码核实（标 ✅ 已销账附出处；⬜ 仍开放；👁 观察/校准项；📄 记录/知情接受）。
- 更早四 spec（markdown 五 plan、字体、布局 Zen、设置中心）的台账已随更早会话不可恢复，其要点见文末附录。

## 一、仍开放递延（建议后续清偿的实体项）

### 必做/高价值
| 项 | 出处 | 说明 |
| --- | --- | --- |
| 实机 MinIO/DAV smoke（**实机窗口等待，非 57 项清偿范围**） | mounts-storage 终审 | 台账原话「阶段二前必做」，阶段二/三均以 MockTransport/wrangler mock 完成，实机验证至今未做。SigV4/PROPFIND 真实链路只有主机形态单测锚 |
| 桌面 windows/macOS 运行期行为（**实机窗口等待**） | desktop-tauri 终审 | CI 首跑+人工冒烟收口（冒烟清单已升发布门禁 I1，待下一次发版实跑） |
| deploy-worker workflow 实跑（**CI/实机窗口等待**） | workers T3+4 | 手动 dispatch 工作流从未实跑；canary/体积门禁/Assets 部署链均属首跑校准面 |
| 3xx follow 未实证（已与 413 拆分）/ ~~413 判定时机 body 全读~~ ✅ 已修（阶段一 03e1a14）：413 判定前移至 body 全读之前，超限即 413 | workers T2 | worker fetch 链路重定向语义半边保持开放，待 CI 断言/实证；413 半边已清 |

### 根治候选（代码）
| 项 | 出处 | 说明 |
| --- | --- | --- |
| remote.ts:207 AbortSignal.any 同构裸用 ✅ 已修（阶段一 ad9c745）：30s 超时并流信号收编 anySignal 守卫（超时+调用方取消合并），消除裸用触点 | mounts-direct 终审 | 原守卫仅覆盖前端创建侧，此处系另一触点——已随阶段一收编 |
| ~~MountConfig derive(Debug) 泄漏面~~ ✅ 已修（阶段一 41c6903）。**勘误**：本行原表述过时——MountConfig 手工脱敏+嵌套锁测本就到位，实际修复面=FileConfig/ResolvedConfig/ServeArgs 顶层 token 字段的手工 Debug 脱敏（锁测锚定） | mounts-storage T3 | server/src/config.rs；勘误依据见 41c6903 提交说明与阶段一台账 |
| ~~双重故障错误优先级~~ | mounts-storage T2 | ✅ 已修（阶段一 8c5fe16）：parse_range 拆语法面/定界面，Range 语法非法在 locate 前 416（size 未知形态 `bytes */*`） |
| ~~重注册后已开 tab 旧 rootIndex 不迁移~~ ✅ 已修（阶段三 b0a8c04）：对账重注册返回 old→new 映射，记录/sources/存活 tab storeId 段三面同步改写 | mounts-api T2/终审 | 原「阶段四收敛」，管理页已交付但迁移未做；对账重注册后旧 tab 指向失效——阶段三收口 |
| file::read 窗口 len>=1 debug_assert ✅ 已修（阶段一 8c5fe16）：窗口读取补 len≥1 debug 断言 | server-core 终审 | 原注「已核实 core 中无此断言」已随修复失效 |
| CoreState.runtime_transport pub 字段跨 crate 可写 ✅ 已修（阶段一 807e3b9）：字段私有化，跨 crate 可写面收口 | server-core T2 | 原「Deref 保留+注记」（93c77b9）的临时态终结 |
| CoreState.version 默认空串 ✅ 已修（阶段一 807e3b9）：补 debug 断言拦截旁路构造的空版本宣告 | server-core T1 | 防御性 nit 已清 |
| ~~health_status 解析失败 unwrap_or(0) 丢响应体~~ ✅ 已修（阶段二 4835b5b）：解析失败携带响应原文，诊断不再丢面 | desktop-tauri T1 | 诊断完整性可选整改，已清 |
| ~~spawn_exit_monitor Err 分支子进程僵尸（罕见）~~ ✅ 已修（阶段二 6e8a3cf）：kill+wait reap 同纪律 / ~~SIGTERM 孤儿 server~~ ✅ 已修（阶段二 1c26da5+603dea2）：ctrlc 回收处理器 / ~~重启主线程同步冻结 15s~~ ✅ 已修（阶段二 3963c9f）：编排异步化 / ~~stderr 跨块截断观感~~ ✅ 已修（阶段二 ca7d1c2）：跨块 UTF-8 边界保留 | desktop-tauri T2/终审 | 桌面壳进程治理四项，阶段二全清 |
| ~~watchHealth 复位方向跨源污染（根治任务用例面补）~~ ✅ 已修（阶段三 8aa3a61）：per-source 复位方向行为用例补齐（源 A 复位不清源 B degraded） | mounts-direct T3 | 终审以 per-source 通道修复主体，用例面补强挂账——阶段三收口 |

### UX 增强
| 项 | 出处 |
| --- | --- |
| ~~tab 名信息损失（storeId 与显示名解耦根治）~~ ✅ 已修（阶段三 419aa4a）：storeId→mount label 显示名映射，hash 输入面零改动 | mounts-direct 终审 I-2 |
| ~~静默关闭（凭据轮换释放）无衔接提示~~ ✅ 已修（阶段三 59d96b1）：释放/重连清扫接 showStatusNotice 状态栏提示 | mounts-direct 终审 I-3 |
| ~~kroki 失败态只露源码无失败文案（spec 1 Plan 1，附录）~~ ✅ 已修（阶段四 06076d2，翻案修）：失败文案 11d8862 起在案，66afead 的 CSS [hidden] 兜底把带文案 view 真隐藏退化为「只露源码」——06076d2 删 error 分支 hidden 恢复可见，口径「已修」非「核实销账」 | — |

### 测试基建
| 项 | 出处 |
| --- | --- |
| ~~mockS3 兜底 200 空体与 mockDav 404 不对称；MM-07 dav 负断言弱于 s3~~ ✅ 已修（阶段三 cbf5284）：兜底改 404 对齐+dav 链路补负断言 | mounts-direct T3/终审 |
| ~~MockTransport no-route 错误拼原始 URL~~ ✅ 已修（阶段三 08d30a6）：错误消息剥 userinfo，对齐 display_endpoint 纪律 | mounts-storage 终审 |
| ~~AppShell 重连接线零自动化覆盖（回归盲区）~~ ✅ 已修（阶段三 cbf5284）：断连→重连→挂载行恢复+tab 内容可读 e2e 用例（MM-10） | mounts-api T3 |
| ~~serve 全链路带挂载端到端集成（现为三段拼合覆盖）~~ ✅ 已修（阶段三 37b67d6）：config→build_mount_roots→router→三 API→tree/file 全链集成（MockTransport） | mounts-storage T5 |
| ~~security.rs 函数级门使 ticket HTTP 断言仅 native 形态运行~~ ✅ 已修（阶段三 37b67d6）：门注释定性改写——语义由 core::tickets 锚测双形态覆盖，本函数为 wire 面锚 | server-core T3 |

### 小项（nit，顺手清）
- workers：~~events.rs 未随 wasm 门控~~ ✅ 已修（阶段一 0bfcd83）：events 模块随 wasm 目标门控；~~门控谓词风格不一致~~ ✅ 已修（阶段一 0bfcd83）：统一 target_family 谓词；~~is_asset_path 大小写字面~~ ✅ 已修（阶段一 03e1a14）：资产扩展名大小写不敏感；~~裁剪形态 adapter 静态挂载面报配置错误可升 compile_error!~~ ✅ 已修（阶段一 488d106）：裁剪分支补不可达 debug 断言（运行时护栏保留）。
- mounts-api：~~probeMountRoot 冗余 encodeURIComponent~~ ✅ 已修（阶段三 8aa3a61）：probe 路径字面化+线格式锚；~~failedRecord registeredRootIndex 残留展示优先级~~ ✅ 已修（阶段三 8aa3a61）：失败记录清失效索引，展示机不再当 registered；~~manifestJson 引用相等过滤 cosmetic~~ ✅ 已修（阶段四 6fdcfd8）：Set 引用判重对两次独立实例化恒不命中，改 rootIndex+endpoint 字段判（58 用例零翻转）；~~e2e 断言分号进注释风格~~ ✅ 已核实销账（阶段四）：HEAD 未复现——`;//` 紧贴形态全 e2e 零命中，`; //` 均为正常行尾注释；~~README :index 表示法~~ ✅ 已修（阶段四 6fdcfd8+726a7a4）：5 处修正累计对齐 axum 0.8 实际路由 {index}，评审收尾笔含 core/mounts.rs:341。
- mounts-storage：~~TOCTOU 窗口（头体两测失去同源）~~ ✅ 已修（阶段三 37b67d6）：头/体两测共享 fixture_with_mount 单实例（既有断言零改动）；~~lib.rs:213 锚归属注释含混~~ ✅ 已修（阶段一 488d106）：注释订正；~~「前导零」搬运注释固有缺陷~~ ✅ 已修（阶段一 488d106）：s3 历法注释补正确说明（前导零系格式化器宽度语义，非数据保真）；~~解析器容忍前导 `+`（壳侧须知）~~ ✅ 已解决（spec4 桌面 T2 顺带落地，锁测 ready.rs:124-126 在案）——阶段二核实销账；~~VV_READY 无条件输出（显式端口多一行）~~ ✅ 已修（阶段一 83ba0e0）：收窄为 --port 0 专属输出。
- desktop-tauri：~~dialog 契约测试防不了 main 链删行（Wry 不可 mock，评审把关兜底——结构性弱锚）~~ ✅ 已修（阶段二 c6c438c）：Builder 链 dialog 注册源码锚，删行防线从单人工升双保险。
- 候选不立项：~~region 配置面扩展~~ ✅ 已修（阶段三 87dc653）：MountConfig.region 可选字段贯通 TOML/env/API 入 SigV4 scope（指纹不含 region，裁决在案）；~~s3⇄webdav 同名异构助手迁 lib 统一~~ ✅ 已修（阶段三 08d30a6）：全同语义助手下沉 lib 单源，真异构三组保持独立（模块注裁决）；~~挂载降级不可逆→健康检查重探~~ ✅ 已核实销账：对账重探行为在案（无短路无定时器），Task 10 补跨对账行为锚（b2bf99a）；~~clippy 既有基线（48 项）~~ ✅ 已修（阶段三 9c3b9a4）：workspace 清零+CI 新门 -D warnings。

## 二、已销账（递延后被后续任务/修复波闭合，勿重复清偿）

| 条目 | 闭合处 |
| --- | --- |
| CoreRequest 零消费死类型 | workers T1 删除（29d833c，「阶段二终审 Minor-2 处置落锤」） |
| HEAD /api/mounts 404 | workers T3 顺带（87dcca9） |
| 根 README 功能矩阵表头错位 | 终审修复波（4d072f6 M-1） |
| README VV_TOKEN 宽松表述 | 终审修复波改「必填 Secret + fail-closed」（4d072f6） |
| reqwest without_url 遗留 | workers T4 核销：全仓零命中，无需改动（7972987） |
| 多 @ 形态残留（split_once） | mounts-storage 终审 I2 rsplit_once（5703859） |
| ReqwestTransport 错误消息凭据通道 | mounts-storage 终审 I1（5703859） |
| server/README 配置章节 | mounts-storage 终审 I3（5703859） |
| search 显式 root→挂载根 404 文案 | 阶段二收敛（root_out_of_range 单一事实源） |
| port=0 无回归锚 | 跨计划闭合：spec 4 Plan A T1 建成 server/tests/ready_protocol.rs（CARGO_BIN_EXE spawn 端到端） |
| WebDavCredentials pub 收敛 | 已核实 storage 侧已非 pub |
| POST 无显式 body 上限 | mounts-api T3：64KB 闸门挂路由层（e8725b1） |
| 405 缺 Allow 头 | mounts-api 终审 M-1（8ca7ff4） |
| restore 重连通道未挂对账 | mounts-api T3 补挂 |
| 直连 Range 防线仅判 status / endpoint 未剥 userinfo / openFlow 接线 | mounts-direct T1→T2 带入闭合 |
| watchHealth 全局单标志/direct 前缀未纳入 isMountRootStoreId | mounts-direct T3 + 终审 I-1 per-source 通道（6df815a） |
| AbortSignal.any 守卫缺失（创建侧） | mounts-direct 终审 M-1（6df815a） |
| guard.rs 兼容缝处置 / 「core 不依赖 comrak」表述 | server-core T4（93c77b9 撤除 / a96720b 改写） |
| wasm32 编译仅主机形态验证 / reqwest 线路层无实机证据 | workers T2 wasm check + wrangler dev 冒烟实证 |
| desktop 报告引用出处不实（dialog/bundler/ready 注释） | 终审修复波 M1/M2（eaea388） |
| --help 丢 [default: 8321] | 评审认可不返工（人读文案兜底） |
| canary inputs 内插 / canary tripwire / 资产面不在 fail-closed 范围 | 知情接受（自用仓库/有意行为/公开面同构 native） |

### 阶段一清偿（递延清偿批，2026-10-22，14/14，commit 区间 6f1db69..83ba0e0）

| 项 | 闭合处 |
| --- | --- |
| 1-1 config 顶层 token Debug 脱敏 | 41c6903。**勘误**：台账原「MountConfig derive(Debug) 泄漏面」表述过时——MountConfig 手工脱敏+嵌套锁测本就到位，实际修复面=FileConfig/ResolvedConfig/ServeArgs 顶层 token 字段 |
| 1-2 Range 语法前置 416 | 8c5fe16（语法非法即 416；既有锚 bytes=abc 的 Content-Range 改 bytes */*，系计划明示语义变更） |
| 1-3 file::read 窗口 len≥1 debug_assert | 8c5fe16 |
| 1-4 CoreState.runtime_transport 私有化 | 807e3b9 |
| 1-5 CoreState.version 空串 debug 断言 | 807e3b9 |
| 1-6 events.rs 随 wasm 目标门控 | 0bfcd83 |
| 1-7 门控谓词统一 target_family | 0bfcd83 |
| 1-8 is_asset_path 扩展名大小写不敏感 | 03e1a14 |
| 1-9 裁剪分支不可达 debug 断言 | 488d106 |
| 1-10 413 判定时机前移至 body 全读前 | 03e1a14 |
| 1-11 lib.rs:213 锚归属注释订正 | 488d106 |
| 1-12 s3 历法注释（fallback 补正确说明） | 488d106 |
| 1-13 remote.ts:207 AbortSignal.any 收编 anySignal 守卫 | ad9c745 |
| 1-14 VV_READY 收窄 --port 0 专属 | 83ba0e0 |

### 阶段二清偿（递延清偿批，2026-10-22，6 修+1 核实销账，commit 区间 69d02be..4835b5b）

| 项 | 闭合处 |
| --- | --- |
| 2-1 health_status 解析失败携带响应原文（诊断不再丢面） | 4835b5b |
| 2-2 exit 监视 Err 分支 reap（kill+wait 同纪律防僵尸） | 6e8a3cf |
| 2-3 stderr 跨块 UTF-8 边界保留（错误窗摘要不再产 U+FFFD 噪声） | ca7d1c2 |
| 2-4 重启编排异步化（错误窗不再被 15s 就绪等待冻结） | 3963c9f |
| 2-5 解析器前导 + 严格拒绝 | 无新 commit：spec4 桌面 T2 顺带落地，锁测 ready.rs:124-126 在案，阶段二核实销账 |
| 2-6 dialog Builder 链源码锚（删行防线从单人工升双保险） | c6c438c |
| 2-7 SIGTERM/SIGINT ctrlc 回收处理器（sidecar 不再孤儿化） | 1c26da5 + 603dea2（修复环 1：termination feature + 测试直调） |

### 阶段三清偿（递延清偿批，2026-10-22，19 修+2 核实销账，commit 区间 1560c95..b2bf99a）

| 项 | 闭合处 |
| --- | --- |
| 3-1 重注册后已开 tab 旧 rootIndex 不迁移 | b0a8c04：对账重注册返回 old→new 映射，记录/sources/存活 tab storeId 段三面同步改写（TabCollection schema 不动） |
| 3-2 watchHealth 复位方向跨源污染（用例面补） | 8aa3a61：per-source 复位方向行为用例补齐（源 A 复位不清源 B degraded） |
| 3-3 mockS3 兜底 200 空体与 mockDav 404 不对称 | cbf5284：未路由 GET 兜底改 404 对齐，全套件无依赖 200 空体用例 |
| 3-4 MM-07 dav 负断言弱于 s3 | cbf5284：dav 链路补负断言对齐 s3 口径 |
| 3-5 MockTransport no-route 错误拼原始 URL | 08d30a6：错误消息剥 userinfo，对齐 display_endpoint 纪律 |
| 3-6 serve 全链路带挂载端到端集成缺失 | 37b67d6：config→build_mount_roots→router→三 API→tree/file 全链集成（MockTransport 免真实网络） |
| 3-7 security.rs 函数级门使 ticket 断言仅 native 跑 | 37b67d6：门注释定性改写——签发/一次性/过期语义由 core::tickets 锚测双形态覆盖，本函数为 wire 面锚 |
| 3-8 AppShell 重连接线零自动化覆盖 | cbf5284：断连→重连→挂载行恢复+tab 内容可读 e2e 用例（MM-10） |
| 3-9 TOCTOU 窗口（头体两测失去同源） | 37b67d6：头/体两测共享 fixture_with_mount 单实例（既有断言逐字保留） |
| 3-10 probeMountRoot 冗余 encodeURIComponent | 8aa3a61：probe 路径字面化+线格式锚（`path=&root=N`） |
| 3-11 failedRecord registeredRootIndex 残留展示 | 8aa3a61：失败记录清失效索引，展示机不再当 registered 呈现 |
| 3-12 RangeSpec len>0 不变式无锚 | 08d30a6：len>0 现状语义契约锚+doc 不变式句（路由层保证，后端信任） |
| 3-13 allow_lan 文件 false≡缺省无直测 | 1035916：false≡缺省直测锚定（不新增面） |
| 3-14 web_dist 文件侧无单测 | 1035916：文件侧校验锚（锁现状文案） |
| 3-15 任意自定义前缀（<md:）无测试样本 | ✅ 已核实销账：解析前缀无关+`md:` 锚早由 97e49d1 落库，Task 10 补默认命名空间无前缀样本（d4b0955） |
| 3-16 s3⇄webdav 同名异构助手迁 lib 统一 | 08d30a6：全同语义助手（ensure_status/ERROR_BODY_SNIPPET/total_size_*）下沉 lib 单源；真异构三组（percent 集/decode/XML 扫描）保持独立+模块注裁决 |
| 3-17 region 配置面扩展（最小实现） | 87dc653：MountConfig.region 可选字段贯通 TOML/env/API 入 SigV4 credential scope；指纹不含 region（裁决）；region 差分锚测+README 键表 |
| 3-18 挂载降级不可逆→重探恢复（最小实现） | ✅ 已核实销账：对账重探行为在案（失败记录下次对账仍重 probe，无短路无定时器），Task 10 补跨对账行为锚（b2bf99a） |
| 3-19 clippy 既有基线清偿 | 9c3b9a4：workspace 全清零+CI 新门 -D warnings（零行为变更证明在案） |
| 3-20 tab 名信息损失（显示名解耦） | 419aa4a：storeId→mount label 显示名映射（映射优先、未命中回落旧形态），hash 输入面零改动 |
| 3-21 静默关闭（凭据轮换释放）无衔接提示 | 59d96b1：释放/重连清扫接 showStatusNotice 状态栏提示 |

### 阶段四清偿（递延清偿批，2026-10-22，6/6：4 修+1 翻案修+1 核实销账，commit 区间 5b3a309..726a7a4）

| 项 | 闭合处 |
| --- | --- |
| 4-1 pako 主包静态导入改动态（惰性化） | 5b3a309：拆出独立 chunk。备案口径：拆出 chunk 仍进 SW precache——收益=首屏不解析执行（非安装期带宽） |
| 4-2 graphre 未入 chunk 组 | 61cbbe3：并入 diagram-engines chunk 组 |
| 4-3 kroki 失败态只露源码无失败文案（翻案修） | 06076d2：失败文案 11d8862 起在案，66afead 的 CSS [hidden] 兜底把带文案 view 真隐藏——删 error 分支 hidden 恢复可见。口径「已修」非「核实销账」，实现者翻案成立 |
| 4-4 manifestJson 引用相等过滤 cosmetic | 6fdcfd8：改 rootIndex+endpoint 字段判（Set 引用判重对两次独立实例化恒不命中；58 用例零翻转） |
| 4-5 e2e 断言分号进注释风格 | ✅ 已核实销账：HEAD 未复现——`;//` 紧贴形态全 e2e 零命中，`; //` 均为正常行尾注释 |
| 4-6 README :index 表示法 | 6fdcfd8 + 726a7a4：5 处修正累计对齐 axum 0.8 实际路由 {index}（评审收尾笔含 core/mounts.rs:341） |

### 阶段五清偿（递延清偿批，2026-10-22，8/8：4 修+3 核实销账+1 勘误，commit 区间 5f259db..648cdaa）

| 项 | 闭合处 |
| --- | --- |
| 5-1 spec 两处未同步小勘误 | 397ebc2 + 648cdaa：勘误三处+名词两处修复 |
| 5-2 onKey 输入元素守卫 | 5f259db |
| 5-3 键盘可达性 a11y 基线 | 5f259db |
| 5-4 点击图表 svg 直开灯箱 | 5f259db |
| 5-5 画廊按元素身份定位（同 src 错位） | 5f259db |
| 5-6 dynamic 页型未接线 | ✅ 已核实销账：类型与占位锚为设计预留，壳侧 vv-dynamic-page 全仓零命中——机制半边未实现，补全属功能立项非清偿面 |
| 5-7 print 降级=toast 引导手动打印 | ✅ 已核实销账：MetaPanel showNotice 两态文案在案 |
| 5-8 mermaid 浅色重画失败静默保留 | ✅ 已核实销账：重渲已走 local 引擎销账；cce179a 失败分支补 console.warn 诊断 |

### 阶段一终审新增挂账候选（2026-10-22 终审，均小项）

- worker dispatch file() 的 416 前置 parity：1-2 仅落 native 适配层，worker 面（worker/src/dispatch.rs file()）仍先 locate 后 parse——语法非法 Range+缺失文件时 404 抢答（native 面 416）。
- config.rs 三面手工 Debug 的字段清单人工同步风险：可加字段数对齐锚测兜底（终审分诊 #1 建议）。
- workerd 对 Content-Length: 0 POST 的 body 形态 wasm e2e 实证（终审分诊 #8 建议升格为挂账前提；两分支终态已收敛一致）。
- desktop shutdown_now×restart_async 毫秒级孤儿窄窗：重启进行中收 SIGTERM 时新 sidecar 若在 spawn 完成至槽位放回之间无人回收（阶段二终审新增；罕见+后果可控，AtomicBool 护栏可解）。
- 占位 tab snapshot 无过滤缺陷（阶段三 T7 盘点新增）：`placeholder:` 前缀入快照→restore 必 miss→断连刷新会话恢复后内容不自动复活（dir 条目整条丢弃）；修复方向 restore 查表剥前缀（originStoreIdOf 同款）。

## 三、观察/校准项（等待 CI 首跑或实机，非代码债）

- desktop：windows build.rs mingw×msvc 链接面、macOS objcopy 垫片、bundler 下载面、release 资源落盘布局——CI 矩阵首跑校准（失败不影响其他 job）。
- workers：deploy workflow 实跑（见必做表）；Assets binding 两处实测已校准（绝对 URL/响应头不可变）记录在案。
- mounts-storage：~~RangeSpec len>0 不变式 Task 5 确认~~（✅ 阶段三 08d30a6 契约锚+doc 不变式句）、~~allow_lan 文件 false≡缺省直测~~（✅ 阶段三 1035916）、~~web_dist 文件侧单测~~（✅ 阶段三 1035916）、~~任意自定义前缀（<md:）测试样本~~（✅ 已核实销账：解析前缀无关+`md:` 锚早由 97e49d1 落库，Task 10 补默认命名空间无前缀样本 d4b0955）——四处均闭合，待核终结。

## 四、附录：更早四 spec 的递延要点（台账已不可恢复，据项目记忆）

Spec 1 markdown 五 plan（会话转录已清，仅存要点）：
- Plan 1 图表客户端：~~pako 主包静态导入待改动态~~ ✅ 已修（阶段四 5b3a309）：拆出 diagram-engines 独立 chunk。备案口径：拆出 chunk 仍进 SW precache——收益=首屏不解析执行（非安装期带宽）；~~kroki 失败态只露源码无失败文案~~ ✅ 已修（阶段四 06076d2，翻案修，见一节 UX 增强行）；~~graphre 未入 chunk 组~~ ✅ 已修（阶段四 61cbbe3）：并入 diagram-engines chunk 组。
- Plan 3 katex/扩展语法：~~spec 两处未同步小勘误~~ ✅ 已修（阶段五 397ebc2+648cdaa）：勘误三处+名词两处修复。
- Plan 4 lightbox：后续候选——~~点击图表 svg 直开灯箱、画廊按元素身份定位（同 src 错位）、onKey 输入元素守卫、键盘可达性 a11y~~ ✅ 四项已修（阶段五 5f259db）。
- Plan 5 导出：~~mermaid 浅色重画失败静默保留~~ ✅ 已核实销账（阶段五）：重渲已走 local 引擎销账，cce179a 失败分支补 console.warn 诊断；~~dynamic 页型未接线~~ ✅ 已核实销账（阶段五）：类型与占位锚为设计预留，壳侧 vv-dynamic-page 全仓零命中——机制半边未实现，补全属功能立项非清偿面；~~print 降级=toast 引导手动打印~~ ✅ 已核实销账（阶段五）：MetaPanel showNotice 两态文案在案。
- Plan 2 服务端图表、Spec 2 字体、Spec 3 布局 Zen、Spec 6 设置中心：递延 Minor 明细未留存活记录（各自终审 Important 均已修复入提交）。

## 五、过程注记

- 重建方法：转录中控制器以 `Write` 建骨架、以 `cat >> progress.md <<'EOF'` 逐任务追加——按工具调用 id 去重后依首次出现顺序重放，六个台账与记忆中的终态引用（如「Spec 4 三阶段全部闭环」「递延：remote.ts:207」）逐一吻合，重建可信。
- 教训：台账若需「留 git 历史」，必须显式落 `docs/`（如本次归档）；`.superpowers/sdd/` 的 `.gitignore *` 意味着该目录下的一切永不入库，「git 历史即记录」对台账本身不成立。
