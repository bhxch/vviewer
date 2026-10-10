# 设计：BUG-68 watcher 日志刷盘（越界 symlink 扫描 + 周期重扫无抑制 + 无日志轮转）

- 日期：2026-10-11
- 状态：已立项（用户确认按四点修复；brainstorm 勘察收口）
- 关联：`2026-10-08-e2e-fixes.md`（BUG-02 watcher 降级自愈链路）、`docs/report/e2e/e2e-test-report-2026-10-10.md` §2.3（遗留环境告警，本缺陷的发现现场）

## 1. 缺陷登记（BUG-68）

- **编号**：BUG-68（接续 2026-10-10 报告的 37 条主条目 BUG-27~67）
- **域归属**：服务端文件服务（srv，运维面）
- **严重度**：medium（不丢数据、功能可用，但触发条件下可持续写满磁盘并烧 CPU；触发条件在真实部署中常见——见下）
- **现象**：服务数据根内存在「扫描时产生 PermissionDenied 的路径」（典型：指向外部目录的 symlink，如 e2e 夹具 `edge/symlink/escape-etc → /etc`；真实部署等价物为用户解压物中的软链、权限不足子目录）时，watcher 降级 PollWatcher 后日志以 ≈47GB/天 无上界增长（实测 7 小时 13.65GB），进程常驻 ~200% CPU（周期性全量重扫空转）。
- **实测证据**（2026-10-10 e2e 轮）：`.temp/explore-server-8391.log` 13,645,964,047B，5 秒采样增量 ≈559KB/s；日志内容全部为 `notify::poll::data: walkdir error scanning … PermissionDenied` WARN。

## 2. 根因链（源码勘察收口）

1. `notify 8.2.0` 的 `Config::default()` 为 **`follow_symlinks: true`**（notify `src/config.rs:122`）。`open_recommended` 走 `notify::recommended_watcher()`（不传 Config，吃默认），`open_poll` 的 `NotifyConfig::default()` 同样吃默认——两级后端的递归扫描（notify 内部 walkdir，`poll.rs:291`、`inotify.rs:407-408`）都会**深入 root 外 symlink**。
2. inotify 后端建 watch 的 walk 深入越界 symlink 遇 PermissionDenied → 建监听失败 → 按 BUG-02 口径退避重试后**降级 PollWatcher**（`watch.rs` RetryFactory）。
3. PollWatcher 每 2s 周期重扫（`poll.rs:209-233` rescan），重扫 walkdir 对每个被拒路径记 `log::warn!("walkdir error scanning …")`（`poll.rs:297`，target `notify::poll::data`）——**每轮重复、无去重**。
4. 该 WARN 经 tracing-subscriber 的 log 桥接落 stderr；服务端默认 `EnvFilter::new("info")`（`main.rs:126-130`）不拦 WARN；服务端无日志轮转/上限，部署侧裸重定向到文件时无任何兜底 → 无上界累积。
5. 附带口径问题：`watch.rs` 全部诊断日志用裸 `eprintln!`（约 10 处），不经 tracing subscriber——任何「落文件/轮转」的改造都必须先收编这些输出。

## 3. 已拍板的决策（用户确认的四点 + 勘察细化）

| 决策点 | 结论 |
| --- | --- |
| 根因修法 | 两级后端显式 `with_follow_symlinks(false)`：扫描不深入 symlink（symlink 条目自身的增删改仍上报；其目标内容本就属 root 外，`collect_event` 既有口径已剔除，语义自洽） |
| 刷屏抑制 | 两层：① 默认 EnvFilter 从 `info` 收紧为 `info,notify=error`（notify crate 内部 WARN 默认静默，RUST_LOG 可显式打开）；② watch.rs 自身错误日志加限频（同源错误首条直记 + 窗口聚合计数） |
| 日志轮转 | 服务端新增 `--log-file <PATH>`：走 tracing 的文件 Writer，超上限（10MB）滚动为单备份 `<PATH>.old`（覆盖式，YAGNI 不做多代备份）；不设该参数时保持 stdout 现状 |
| 文档 | `docs/deploy.md` 新增「日志与轮转」节（journald 建议、--log-file 用法、RUST_LOG/notify 过滤说明）；`server/README.md` 参数表补 --log-file |
| 缺陷登记 | 本 spec 即 BUG-68 立项文档；回归以可执行测试落位（非 fixme——本任务即修复 PR） |

## 4. 修复设计

### 4.1 扫描不越界（根因）

- `watch.rs::open_recommended`：`notify::recommended_watcher(..)` 改为 `RecommendedWatcher::new(handler, NotifyConfig::default().with_follow_symlinks(false))`。
- `watch.rs::open_poll`：`NotifyConfig::default().with_poll_interval(poll_interval)` 追加 `.with_follow_symlinks(false)`。
- 模块 doc 注释补语义：**watcher 不跟随 symlink**——越界 symlink 目标内的变更不在推送范围（与 `/api/tree`「symlink 呈现为 dir」的呈现口径不冲突：条目本身仍在树中，变更通知只覆盖 root 内真实路径）；同时不再因越界目标的权限错误导致建监听失败/重扫报错。
- 预期行为变化：含越界 symlink 的 root 修复前 inotify 建监听失败 → Degraded + PollWatcher 刷屏；修复后 inotify 直接建立成功 → `WatchHealth::Ok`（这是可断言的回归判据，见 §5）。

### 4.2 刷屏抑制（防御纵深）

- `server/src/logging.rs`（新模块，见 §4.3）内默认 EnvFilter 常量 `info,notify=error`：notify crate 的内部 WARN（含 poll 重扫报错）默认静默；`RUST_LOG` 仍可整体覆盖（如 `RUST_LOG=info,notify=warn` 显式排查）。无 `RUST_LOG` 时使用该默认。
- watch.rs 自身日志两处收口：
  - 全部 `eprintln!` → `tracing::info!/warn!/error!`（统一走 subscriber，`--log-file` 才对全部日志生效）；
  - `session_loop` 的运行期错误日志（现每条 Err 一行）加 `ErrorLogGate` 限频：首条直记，其后同一会话内累计，每 60s 输出一条「N 条同类错误已抑制」摘要。限频器抽为可单测的小结构体。
- 既有重试/探试日志已有节流（attempts 上限、`POLL_PROBE_EVERY`、fallback `misses % 12`），维持不动。

### 4.3 日志轮转（--log-file）

- `server/src/logging.rs`：
  - `RotatingWriter`：`Arc<Mutex<WriteState>>`（当前 File + 已写字节数）；每次写前检查，超 `LOG_ROTATE_BYTES`（10MB）即：flush + close → `rename(current, current.old)`（覆盖旧备份）→ 新建当前文件。单备份覆盖式滚动，满足「简单的大小上限」且实现可控。
  - 实现 `tracing_subscriber::fmt::MakeWriter`（`for<'a> MakeWriter<'a>` 借出持有锁 guard 的 Writer）。
  - `init_tracing(log_file: Option<&Path>)`：有文件时 `fmt().with_ansi(false).with_writer(...)`，否则维持 stdout 现状；EnvFilter 装配（`RUST_LOG` 优先，缺省 `DEFAULT_FILTER`）从 `main.rs` 迁入。
- `main.rs`：`Serve` 子命令新增 `--log-file <PATH>`（clap `#[arg(long)]`，与既有参数同风格，透传 `ServeArgs`）；在启动校验（--root/--web-dist）之后调用 `logging::init_tracing` 初始化 subscriber——启动期参数错误仍直写 stderr（早于 subscriber 初始化，行为不变）。

### 4.4 文档

- `docs/deploy.md` 新增「日志与轮转」节：默认 stdout + journald 自带轮转的建议；`--log-file` 用法与滚动行为（10MB 单备份）；`RUST_LOG` 说明（默认 `info,notify=error`，如何打开 notify 调试）；明确「勿裸重定向 stdout 到文件」的告警。
- `server/README.md` 参数表补 `--log-file`（与既有参数条目同格式）。

## 5. 测试与验收

Rust 单测（`cargo test -p vviewer` 或仓库既有 server 测试入口）：

1. **越界 symlink 集成（根因回归）**：tempdir root 内建 symlink → 外部目录，`ChangeHub::spawn` 后断言 `health() == Ok`（修复前该 root 必 Degraded/Recovering）；轮询会话路径（注入 `open_recommended` 恒败 + 真实 PollWatcher）断言 N 个轮询周期内会话稳定、无错误风暴（Err 事件计数为 0 或有界）。
2. **限频器**：注入 M 条同源错误，断言日志条数 = 首条 + 窗口摘要数（抽结构体直测，时间用注入时钟或短窗口）。
3. **EnvFilter 默认**：`DEFAULT_FILTER` 常量等于 `info,notify=error`；`RUST_LOG` 设置时优先生效（`try_from_default_env` 路径不回归）。
4. **RotatingWriter**：写入超 cap 触发滚动（`.old` 存在且为新文件腾位）、滚动后继续可写；无 `--log-file` 时 subscriber 仍为 stdout（装配分支单测或编译期保证）。

e2e 回归（`apps/web/e2e-server/`）：

5. `t-srv.spec.ts` 新增可执行用例「BUG-68: root 含越界 symlink 时 watcher 不降级」：fixtures 造 root 外 symlink 的子场景，经 SSE（`/api/events`）建连断言快照无 `watch-degraded` 帧（修复前必现 Degraded）。落位与夹具构造在实施计划中细化（避免污染既有夹具语义）。

验收门：全量 `cargo test`（server）绿 + vitest 不回归 + t-srv/t-cmp 等服务端 e2e 套件绿。

## 6. 非目标

- 不升级/替换 notify 依赖，不自行实现 PollWatcher 替代品。
- 不做多代备份轮转、压缩、按天滚动（单备份覆盖式即可满足「简单大小上限」）。
- 不改 SSE 帧语义（`watch-degraded`/`watch-recovered` 语义维持）。
- 不动前端。

## 7. 风险

- `follow_symlinks(false)` 后，**位于 root 内、经 symlink 呈现的目录内容变更**不再触发 changed 推送——与既有「symlink 呈现为 dir」的呈现口径（2026-10-08 报告 §2.3）一致：该内容本非 root 数据，且 `collect_event` 对 root 外路径本就不进 changed 帧；影响记录于 watch.rs 模块注释与本 spec。
- `notify=error` 默认过滤会静默 notify crate 的 WARN 级诊断——可观测性由 watch.rs 自身的降级/自愈日志（tracing 化后更完整）承担；`RUST_LOG` 可恢复。
- 滚动使用 rename 覆盖单备份：极端情况下（单次写入 > 10MB）备份与当前文件可能同为超限内容——接受（日志行级别写入远小于 cap）。
