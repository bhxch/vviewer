# 六 SDD 台账递延 Minor 提取（多端发布 + 目录挂载批次）

- 提取日期：2026-10-21。覆盖：上一会话六个 SDD 运行——多端发布阶段一/二/三（desktop-tauri / server-core / workers）与目录挂载阶段一/二/三四（mounts-storage / mounts-api / mounts-direct）。
- **来源更正**：台账并不在 git 历史里。`.superpowers/sdd/.gitignore` 内容为 `*`，台账从未入库；SDD 工作区清理后盘上文件已删，git 悬空对象（fsck）中亦无。本提取从上一会话模型 IO 转录（`~/.zcode/cli/rollout/model-io-sess_8964b1e2-*.jsonl`）中的 Write 调用与 Bash heredoc 追加重放重建，六个台账全文已归档至 `docs/superpowers/sdd-archive/2026-10-19/`（唯一幸存副本）。
- 销账核对：条目状态对照台账自身修复波记录与现行代码核实（标 ✅ 已销账附出处；⬜ 仍开放；👁 观察/校准项；📄 记录/知情接受）。
- 更早四 spec（markdown 五 plan、字体、布局 Zen、设置中心）的台账已随更早会话不可恢复，其要点见文末附录。

## 一、仍开放递延（建议后续清偿的实体项）

### 必做/高价值
| 项 | 出处 | 说明 |
| --- | --- | --- |
| 实机 MinIO/DAV smoke | mounts-storage 终审 | 台账原话「阶段二前必做」，阶段二/三均以 MockTransport/wrangler mock 完成，实机验证至今未做。SigV4/PROPFIND 真实链路只有主机形态单测锚 |
| 桌面 windows/macOS 运行期行为 | desktop-tauri 终审 | CI 首跑+人工冒烟收口（冒烟清单已升发布门禁 I1，待下一次发版实跑） |
| deploy-worker workflow 实跑 | workers T3+4 | 手动 dispatch 工作流从未实跑；canary/体积门禁/Assets 部署链均属首跑校准面 |
| 3xx follow 未实证 / 413 判定时机 body 全读 | workers T2 | worker fetch 链路重定向语义与 413 限值判定时点待 CI 断言/实证 |

### 根治候选（代码）
| 项 | 出处 | 说明 |
| --- | --- | --- |
| remote.ts:207 AbortSignal.any 同构裸用 | mounts-direct 终审 | 同构环境无 AbortSignal.any 时的裸用面，留根治轮收编（现行有 anySignal 守卫在前端创建侧，此处是另一触点） |
| MountConfig derive(Debug) 泄漏面 | mounts-storage T3 | server/src/config.rs 服务侧 TOML 挂载段仍 derive(Debug)（已核实），凭据可经 Debug 日志外泄；core 侧 MountMeta 已手工脱敏，此为遗漏面 |
| 双重故障错误优先级 | mounts-storage T2 | Range 非法+打开失败并存时 500 应让位 416 |
| 重注册后已开 tab 旧 rootIndex 不迁移 | mounts-api T2/终审 | 原「阶段四收敛」，管理页已交付但迁移未做；对账重注册后旧 tab 指向失效 |
| file::read 窗口 len>=1 debug_assert | server-core 终审 | 已核实 core 中无此断言 |
| CoreState.runtime_transport pub 字段跨 crate 可写 | server-core T2 | 原计划 Task 4 撤 Deref 时收口，实际 Deref 保留+注记（93c77b9），字段仍 pub |
| CoreState.version 默认空串 | server-core T1 | 旁路构造会宣告空版本（装配点必然注入，防御性 nit） |
| health_status 解析失败 unwrap_or(0) 丢响应体 | desktop-tauri T1 | 诊断完整性可选整改 |
| spawn_exit_monitor Err 分支子进程僵尸（罕见）/ SIGTERM 孤儿 server / 重启主线程同步冻结 15s / stderr 跨块截断观感 | desktop-tauri T2/终审 | 桌面壳进程治理四项（冻结项原注「阶段二重审条件」未见重审） |
| watchHealth 复位方向跨源污染（根治任务用例面补） | mounts-direct T3 | 终审以 per-source 通道修复主体，用例面补强挂账 |

### UX 增强
| 项 | 出处 |
| --- | --- |
| tab 名信息损失（storeId 与显示名解耦根治） | mounts-direct 终审 I-2 |
| 静默关闭（凭据轮换释放）无衔接提示 | mounts-direct 终审 I-3 |
| kroki 失败态只露源码无失败文案（spec 1 Plan 1，附录） | — |

### 测试基建
| 项 | 出处 |
| --- | --- |
| mockS3 兜底 200 空体与 mockDav 404 不对称；MM-07 dav 负断言弱于 s3 | mounts-direct T3/终审 |
| MockTransport no-route 错误拼原始 URL | mounts-storage 终审 |
| AppShell 重连接线零自动化覆盖（回归盲区） | mounts-api T3 |
| serve 全链路带挂载端到端集成（现为三段拼合覆盖） | mounts-storage T5 |
| security.rs 函数级门使 ticket HTTP 断言仅 native 形态运行 | server-core T3 |

### 小项（nit，顺手清）
- workers：events.rs 未随 wasm 门控（不可达论证成立，建议模块级门控，已核实未门控）；门控谓词风格不一致（wasm32 vs wasm family）；is_asset_path 大小写字面（已核实 `ends_with` 区分大小写）；裁剪形态 adapter 静态挂载面报配置错误可升 compile_error!。
- mounts-api：probeMountRoot 冗余 encodeURIComponent；failedRecord registeredRootIndex 残留展示优先级；manifestJson 引用相等过滤 cosmetic；e2e 断言分号进注释风格；README :index 表示法。
- mounts-storage：TOCTOU 窗口（头体两测失去同源）；lib.rs:213 锚归属注释含混；「前导零」搬运注释固有缺陷；解析器容忍前导 `+`（壳侧须知）；VV_READY 无条件输出（显式端口多一行）。
- desktop-tauri：dialog 契约测试防不了 main 链删行（Wry 不可 mock，评审把关兜底——结构性弱锚）。
- 候选不立项：region 配置面扩展；s3⇄webdav 同名异构助手迁 lib 统一；挂载降级不可逆→健康检查重探；clippy 既有基线（48 项）。

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

## 三、观察/校准项（等待 CI 首跑或实机，非代码债）

- desktop：windows build.rs mingw×msvc 链接面、macOS objcopy 垫片、bundler 下载面、release 资源落盘布局——CI 矩阵首跑校准（失败不影响其他 job）。
- workers：deploy workflow 实跑（见必做表）；Assets binding 两处实测已校准（绝对 URL/响应头不可变）记录在案。
- mounts-storage：RangeSpec len>0 不变式 Task 5 确认、allow_lan 文件 false≡缺省直测、web_dist 文件侧单测、任意自定义前缀（<md:）测试样本——四处台账注「Task 5 补」但无闭合记录，**待核**。

## 四、附录：更早四 spec 的递延要点（台账已不可恢复，据项目记忆）

Spec 1 markdown 五 plan（会话转录已清，仅存要点）：
- Plan 1 图表客户端：pako 主包静态导入待改动态；kroki 失败态只露源码无失败文案；graphre 未入 chunk 组。
- Plan 3 katex/扩展语法：spec 两处未同步小勘误。
- Plan 4 lightbox：后续候选——点击图表 svg 直开灯箱、画廊按元素身份定位（同 src 错位）、onKey 输入元素守卫、键盘可达性 a11y。
- Plan 5 导出：mermaid 浅色重画失败静默保留；dynamic 页型未接线；print 降级=toast 引导手动打印。
- Plan 2 服务端图表、Spec 2 字体、Spec 3 布局 Zen、Spec 6 设置中心：递延 Minor 明细未留存活记录（各自终审 Important 均已修复入提交）。

## 五、过程注记

- 重建方法：转录中控制器以 `Write` 建骨架、以 `cat >> progress.md <<'EOF'` 逐任务追加——按工具调用 id 去重后依首次出现顺序重放，六个台账与记忆中的终态引用（如「Spec 4 三阶段全部闭环」「递延：remote.ts:207」）逐一吻合，重建可信。
- 教训：台账若需「留 git 历史」，必须显式落 `docs/`（如本次归档）；`.superpowers/sdd/` 的 `.gitignore *` 意味着该目录下的一切永不入库，「git 历史即记录」对台账本身不成立。
