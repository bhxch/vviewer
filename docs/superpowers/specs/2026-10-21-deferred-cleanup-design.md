# 递延清偿批设计（六 SDD 台账 57 项全清）

状态：待用户审阅 → writing-plans
日期：2026-10-21
来源：docs/report/sdd-deferred-minors-2026-10-21.md（提取与销账核对）+ docs/superpowers/sdd-archive/2026-10-19/（六台账归档）
执行形态：单 spec 五阶段，逐阶段 writing-plans → SDD → 阶段门禁；用户已拍板「接受项也要修」，故全批 57 项零挂账出批。

## §1 背景与目标

上一会话六个 SDD 运行（多端发布 desktop-tauri/server-core/workers + 目录挂载 mounts-storage/api/direct）各终审与任务评审递延 Minor 共 57 项（含更早四 spec 附录要点 12 项与「候选不立项」4 项转正）。台账本身未入 git（`.superpowers/sdd/.gitignore` 为 `*`），已自会话转录恢复归档；本批将其全数清偿，并把每项终态回写 digest，使「仍开放」清零。

目标：
1. 57 项逐项终态化：修复落码 53 项（含待核 3 项核实后修复）、核实销账若干（待核项若确认已解决）、其余零残留。
2. clippy 基线从 48 项告警降到 0，新门立起。
3. digest 文档回写后作为唯一幸存的递延台账事实源。

## §2 范围与处置总表

处置口径（用户 2026-10-21 拍板）：原「接受记档」6 项全部转入修复；「候选不立项」4 项转正修复（其中 region/降级重探为仅有的两个新功能面，按最小实现）；待核 3 项阶段五首任务核实后修复或带证据销账。

| 阶段 | 域 | 项数 | 处置构成 |
| --- | --- | --- | --- |
| 一 | server / core / worker | 14 | 修复 14 |
| 二 | 桌面壳 | 7 | 修复 7（含原接受 2 项的升级修法） |
| 三 | 挂载 / 存储 | 21 | 修复 21（含原备选 4 项转正；含原接受 1 项） |
| 四 | web 卫生 | 6 | 修复 6（含原接受 1 项） |
| 五 | 附录 + 待核 | 8 | 修复 5 + 待核 3；附录 kroki UX 项并入阶段四 kroki 失败文案，57 项全数入册 |

## §3 阶段明细

各任务面文件位置为已核实或高置信起点，writing-plans 阶段允许微调；每项验收含对应回归锚（测试/锁测/文档断言）。

### 阶段一 · server / core / worker（14 项）

| # | 项 | 修法方向 | 位置（已核实处标 ✅） |
| --- | --- | --- | --- |
| 1-1 | MountConfig derive(Debug) 凭据泄漏面 | 照 core MountMeta 手工 Debug 脱敏先例，server 侧 TOML 挂载段改手工/脱敏 Debug；补泄漏断言测试 | server/src/config.rs:28,48 ✅ |
| 1-2 | 双重故障错误优先级（Range 非法+打开失败 500→416） | 错误判定排序：Range 合法性前置；锁测覆盖并存形态 | core::file + routes/file.rs |
| 1-3 | file::read 窗口 len≥1 debug_assert | 补断言 | server/core/src/file.rs ✅（现无） |
| 1-4 | CoreState.runtime_transport pub 跨 crate 可写 | 构造内收/getter 化，消费面收口 | server/core/src/state.rs |
| 1-5 | CoreState.version 默认空串旁路构造 | 装配点断言或构造强制注入 | server/core/src/state.rs |
| 1-6 | events.rs 未随 wasm 门控 | 模块级门控（对齐 search.rs 的 host 目标门），消 wasm 运行时 panic 面 | server/core/src/events.rs ✅ |
| 1-7 | 门控谓词风格不一致 | 统一 `target_family = "wasm"` 口径（或统一 wasm32，取多数派），机械替换+编译锚 | core/storage/worker 各处 |
| 1-8 | is_asset_path 大小写敏感 | eq_ignore_ascii_case + 测试（`.WASM` 命中） | server/worker/src/http.rs:57 ✅ |
| 1-9 | 裁剪形态 adapter 静态挂载面运行时报错 | 类型级收口优先（非 native 形态不暴露静态挂载装配入口）；不可行则维持运行时报错+debug_assert，裁决入注记 | server/src/state.rs / builder |
| 1-10 | worker 413 判定时机=body 全读 | 流式长度闸（对齐路由层 64KB 闸先例）；实现代价过高则注记裁决降级为记录 | server/worker/src/dispatch.rs |
| 1-11 | storage lib.rs:213 锚归属注释含混 | 文档修正 | server/storage/src/lib.rs |
| 1-12 | s3「前导零」搬运注释固有缺陷 | 文档修正 | server/storage/src/s3.rs |
| 1-13 | remote.ts:207 AbortSignal.any 同构裸用 | 复用 directS3.ts:444 存在性守卫先例（抽共享或镜像），守卫分支单测 | packages/core/src/tree/remote.ts:207 ✅（先例 directS3.ts:444 ✅） |
| 1-14 | VV_READY 无条件输出 | 改 `--port 0`（内核分配）时才输出；ready_protocol.rs 补显式端口无 VV_READY 行断言 | server/src/main.rs + server/tests/ready_protocol.rs |

### 阶段二 · 桌面壳（7 项）

GUI 不可本地验证的验收形态沿用 spec 2026-10-19 惯例：解析器/纯函数单测 + 源码锚测试 + 人工冒烟清单扩充（发布门禁项）。

| # | 项 | 修法方向 |
| --- | --- | --- |
| 2-1 | health_status 解析失败 unwrap_or(0) 丢响应体 | 解析失败保留响应体片段进诊断输出（错误枚举带 body 摘要）；单测 |
| 2-2 | spawn_exit_monitor Err 分支子进程僵尸 | Err 分支日志+退出/重试路径；单测覆盖分支 |
| 2-3 | stderr 跨块截断观感 | 摘要缓冲加截断标记（如「…（截断 N 字节）」）；单测 |
| 2-4 | 重启主线程同步冻结 15s | 重启改异步 spawn + 等待态 UI（错误窗按钮态）；冻结窗口消失为验收 |
| 2-5 | VV_READY 解析器容忍前导 `+` | 拒绝 + 单测（server 侧纯净性已锁，壳侧对齐） |
| 2-6 | dialog 契约测试防不了 main 链删行（原接受转修） | handler 逻辑抽提为可测单元（注入 DialogHandle trait）+ main Builder 链源码锚测试（读源码断言 dialog 插件注册行存在——Wry 不可 mock 下的诚实防线，测试注释声明防线边界） |
| 2-7 | SIGTERM 孤儿 server（原接受转修） | ctrlc（或同型 crate）注册 SIGTERM/SIGINT，触发与 RunEvent::Exit 同一子进程回收路径；Windows 语义差异注记；单测+冒烟清单补 SIGTERM 项 |

### 阶段三 · 挂载 / 存储（21 项）

| # | 项 | 修法方向 |
| --- | --- | --- |
| 3-1 | 重注册后已开 tab 旧 rootIndex 不迁移 | 对账重注册时按 storeId 建旧→新 rootIndex 映射，迁移已开 tab 与快照恢复路径；回归测试 |
| 3-2 | watchHealth 复位方向跨源污染——用例面补 | per-source 通道双向（置劣化/复位）用例补齐（终审 I-1 修复的测试面收尾） |
| 3-3 | mockS3 兜底 200 空体 vs mockDav 404 不对称 | 测试夹具对齐（未路由请求显式 404/错误语义一致） |
| 3-4 | MM-07 dav 负断言弱于 s3 | 补 dav 链路负断言对齐 s3 口径 |
| 3-5 | MockTransport no-route 错误拼原始 URL | 错误消息脱敏（endpoint 凭据不外泄），对齐 display_endpoint 纪律 |
| 3-6 | serve 全链路带挂载端到端集成缺失 | router 级集成测试（MockTransport，不起真网络）：TOML/VV_MOUNTS 装配→三挂载 API→tree/file 经挂载根读写全串 |
| 3-7 | security.rs 函数级门使 ticket 断言仅 native 跑 | 门收窄到真依赖 native 的断言面，或 ticket 语义改 core 锚测补齐 |
| 3-8 | AppShell 重连接线零自动化覆盖 | e2e 用例：断连→重连→挂载/树恢复（复用既有 TAX/WSX 装置） |
| 3-9 | TOCTOU 窗口（头体两测失去同源） | 头/体两测共享同一 fixture 实例（原接受转修，测试重构） |
| 3-10 | probeMountRoot 冗余 encodeURIComponent | 移除冗余编码 + 回归 |
| 3-11 | failedRecord registeredRootIndex 残留展示 | 展示优先级清理（失败记录不展示已失效索引） |
| 3-12 | RangeSpec len>0 不变式无锚 | 补 debug_assert/构造校验 + 测试 |
| 3-13 | allow_lan 文件 false≡缺省无直测 | 补单测 |
| 3-14 | web_dist 文件侧无单测 | 补单测 |
| 3-15 | 任意自定义前缀（<md:）无测试样本 | WebDAV PROPFIND 前缀解析补自定义前缀夹具锚 |
| 3-16 | s3⇄webdav 同名异构助手迁 lib 统一（原备选转正） | 同型助手下沉 lib.rs 单源，双后端复用；既有向量测试零翻转 |
| 3-17 | region 配置面扩展（原备选转正，最小实现） | MountConfig 可选 region 字段（缺省维持现状值）贯通 TOML/VV_MOUNTS/POST API/SigV4 credential scope；非默认 region 官方向量锚测试；管理页表单可选（若 UI 侧代价高可仅服务端字段，注记） |
| 3-18 | 挂载降级不可逆→重探恢复（原备选转正，最小实现） | 对账/重连路径重探：失败挂载在下次对账时重试 probe，成功即恢复并在 UI 呈现；**不做后台轮询** |
| 3-19 | clippy 48 项既有基线清偿（原备选转正） | 全 workspace 清零；**本阶段收尾任务**（阶段一/三 Rust 改动落定后执行），新门=0 写入 CI/文档 |
| 3-20 | tab 名信息损失（storeId 与显示名解耦根治） | 挂载元数据侧维护 storeId→显示名映射（快照/mountsSync 消费），**不动 TabCollection schema**；重命名/重注册路径回归 |
| 3-21 | 静默关闭（凭据轮换释放）无衔接提示 | 释放路径接 toast/statusNotice 提示（终审知情取舍保留、提示补齐） |

### 阶段四 · web 卫生（6 项）

| # | 项 | 修法方向 |
| --- | --- | --- |
| 4-1 | pako 主包静态导入 ✅（diagrams.ts:4） | 动态 import；diagram-budget 门禁复验 |
| 4-2 | graphre 未入 chunk 组 ✅（groups 仅 viz/nomnoml） | codeSplitting.groups 正则补 graphre；预算门复验 |
| 4-3 | kroki 失败态只露源码无失败文案（含附录 kroki UX 项） | wrapper 错误态补失败文案/重试提示；kroki 失败渲染路径单测 |
| 4-4 | manifestJson 引用相等过滤 cosmetic | 测试助手微调 |
| 4-5 | e2e 断言分号进注释风格 | 机械修正 |
| 4-6 | README :index 表示法 | 文档修正 |

### 阶段五 · 附录 + 待核（8 项）

首任务为三项待核的核实（各出结论与证据，修复或销账回写 digest）。

| # | 项 | 处置 |
| --- | --- | --- |
| 5-1 | spec 两处未同步小勘误（2026-10-19 md-katex spec） | 文档修正 |
| 5-2 | lightbox onKey 输入元素守卫 | 修——输入焦点时快捷键不劫持；单测 |
| 5-3 | lightbox 键盘可达性 a11y | 修——焦点管理/aria；按仓库 a11y 惯例 |
| 5-4 | 点击图表 svg 直开灯箱 | 修——画廊共集已含 .md-diagram-view svg（既有画廊收集复用） |
| 5-5 | 画廊按元素身份定位（同 src 错位） | 修——收集/定位改元素身份（索引或引用），同 src 多图回归 |
| 5-6 | 导出 dynamic 页型接线 | 待核：类型与机制已在 export.ts:292（✅），疑仅 UI 未暴露——核实后接 UI 选项或销账 |
| 5-7 | print 降级 toast 引导 | 待核：记忆称 toast 已实现——核实后销账或补实现 |
| 5-8 | mermaid 浅色重画失败静默保留 | 待核：markdownRenderer.ts:530 显示 kroki 态 mermaid 已改走 local 引擎重渲（✅ 注释在案）——核实后销账或补失败文案 |

## §4 关键裁决

1. **两个新功能面最小化**：region 无后台校验、可不做 UI（服务端字段+向量锚足额）；降级重探不做后台轮询，仅对账/重连触发。其余 55 项均为修复/测试/文档。
2. **tab 名解耦不动 TabCollection schema**：映射表挂挂载元数据侧，快照恢复与重注册两处消费；避免第三次动 tab 持久化结构。
3. **clippy 清偿时点**：阶段三收尾任务（最后一个 Rust 改动面之后），此前阶段保持基线对比纪律（零新增）。
4. **VV_READY 语义变更**：显式端口不再输出就绪行——ready_protocol.rs 是唯一消费锚，桌面壳走 `--port 0` 不受影响；README 同步。
5. **dialog 源码锚是诚实防线而非等价替代**：测试注释必须声明「防删行不防语义」，评审把关兜底的边界写进冒烟清单。
6. **销账回写纪律**：每项终态（修复 commit / 修法 / 待核结论）回写 docs/report/sdd-deferred-minors-2026-10-21.md；SDD 台账照旧在 `.superpowers/sdd/`，但阶段收口时递延项必须抄送 digest，不再产生无主挂账。
7. **实机相关 8 项不在本批**（用户口径）：实机 MinIO/DAV smoke、桌面三平台首跑冒烟、deploy-worker 实跑、3xx follow 实证、desktop CI 校准四项——维持实机/CI 窗口等待。

## §5 非目标

- 不做实机/CI 等待类验证（§4-7）。
- 不动 TabCollection/快照 schema（#3-20 映射方案）；不引入挂载后台健康轮询；不做 region 的云厂商厂商标色（仅 SigV4 scope 字段）。
- 不重构 spec 2026-10-19 批次已定型的架构面（storage 接缝/core 八域/直连 store 协议）；清偿一律在既有接口内。
- 附录四 spec（md/字体/布局/设置中心）除 §3 阶段五所列外不扩大范围。

## §6 验收门禁与回归口径

- 每阶段：`pnpm typecheck` 0E；`pnpm vitest run` exit0；涉 Rust 阶段 `cargo test --workspace` 全绿零翻转 + `cargo clippy` 与当时基线比零新增（阶段三收口后基线=0）。
- 阶段四/五加：`pnpm --filter web build:e2e`（防 CDN 注入冲掉假红的既有纪律）+ `node tools/diagram-budget.mjs`（#4-1/4-2 后预算复验）。
- 收口：playwright 默认 + e2e-server 双通道全量零翻转；digest 回写完成，「仍开放」节清空。
- 行为锁：#3-16 助手统一、#1-14 VV_READY 等语义变更项必须携带既有测试零翻转说明或同步改锚的逐条说明。

## §7 风险与实施注记预留

- 阶段二三项（#2-4 重启异步化 / #2-6 源码锚 / #2-7 信号处理）GUI 不可本地验证，验收=单测+源码锚+冒烟清单扩充；CI 首跑仍属实机窗口。
- #1-10 413 流式闸若实现代价超预期，允许降级为注记裁决（spec 预授权，plan 阶段实测定）。
- #1-9 类型级收口不可行时允许维持运行时报错+debug_assert（裁决记录）。
- #3-17/#3-18 两功能面的 UI 取舍允许在 plan 阶段按实现代价收窄，收窄必须注记。
- 待核三项结论必须附证据（代码位置/行为探针），销账同样回写。

## §8 交付物

1. 五阶段代码/测试/文档提交（Angular 规范，按任务原子）。
2. digest 回写：docs/report/sdd-deferred-minors-2026-10-21.md 每项终态。
3. 新 SDD 台账（.superpowers/sdd/<plan>/progress.md，阶段收口抄送 digest）。
4. README/相关文档随 #1-14、#4-6、#3-19（clippy 新门）同步。
