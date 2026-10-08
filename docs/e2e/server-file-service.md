# 后端档 1 文件服务（M5） — e2e 场景

> 来源：`docs/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`）。本文将该报告 server-file-service 域的测试内容忠实转写为可复现场景，不引入报告之外的行为。引用格式：「报告 §n」指该报告章节，「BUG-xx」指该报告第 5 节缺陷清单条目。

## 1. 域描述与覆盖范围

以下摘自报告 §4 功能完成度矩阵 server-file-service 行与 §8.8 附录明细。

**总体情况**（报告 §4）：13 个测试点，通过 10，缺陷 3（1 fail / 2 partial），受阻 0，域级评级 **基本完整**。报告备注：HTTP 契约全部通过——health capabilities、Range 三态、路径穿越防护、allow-lan token 约束、hidden 过滤、SSE ticket 与 15s 心跳、中文名深层目录、自然排序；btrfs watcher 故障（BUG-02，主部署环境自动刷新不可用）与刷新设置/按钮缺失（并入 BUG-05）为主要扣分。SSE 功能链路本身经 /tmp 实例验证正常，故障特定于 btrfs 数据根。

**逐点结果**（报告 §8.8，13 点：10 pass / 2 partial / 1 fail）：

| 编号 | 测试点 | 结果 | 简要证据（摘自报告） |
| --- | --- | --- | --- |
| SRV-01 | release 单二进制冒烟（8399） | pass | capabilities=[file-server]、首页 200、树懒加载正常 |
| SRV-02 | /api/health capabilities 随 --compute 变化 | pass | 无 compute=[file-server]；有 compute 追加 "compute" 于尾部（curl 对照） |
| SRV-03 | 前端连接服务器 + 目录树出现 | pass | 空 token/token 两种场景连接成功、懒加载树展开正常（偏差 #2 已知） |
| SRV-04 | 错误 token 前端明确提示；接口 401 | pass | 接口 401 unauthorized + www-authenticate；前端「鉴权失败：令牌缺失或错误（HTTP 401）」 |
| SRV-05 | 打开 sample.js：状态栏语言/编码来自 X-VV 头 | partial | 高亮 ✓、x-vv-lang/x-vv-encoding 正确下发；状态栏不展示（BUG-04） |
| SRV-06 | SSE 变更推送：约 500ms 自动重读且滚动保留 | partial | /tmp 实例全链路 ✓（scrollTop 12000 保持）；8391 btrfs watcher 故障 watch-error（BUG-02） |
| SRV-07 | 设置切换刷新自动/手动 + 手动刷新按钮 | fail | 全 UI 穷举无刷新设置与按钮（并入 BUG-05）；spec 262 行明确要求 |
| SRV-08 | /api/file Range 三态 | pass | 206/416/后缀 206 三态+非法 Range 416 严格拒绝（curl 实测） |
| SRV-09 | 路径穿越与越界 symlink 防护 | pass | ../ 与 %2e%2e%2f → 400；root 内外链 symlink → 403（curl 实测） |
| SRV-10 | --allow-lan 无 token 拒绝启动；--token-gen 可启动 | pass | exit=2 明确报错；加 --token-gen 正常启动、stdout 打印 64 位 token |
| SRV-11 | dot 文件默认显示、--hidden 过滤 | pass | 默认全显示；--hidden 实例仅 visible.txt（8391/8396 对照） |
| SRV-12 | 中文名深层嵌套目录 + 排序 | pass | 4 层懒加载展开正常；目录优先+自然排序 file1<file2<file10 |
| SRV-13 | SSE 一次性 ticket + 15s ping 心跳 | pass | ticket 一次性 ✓、Bearer 不可用于 events ✓、心跳间隔精确 15s（时间戳实录） |

**关联缺陷**（报告 §5，本域涉及的 3 条，均为 verified）：BUG-02（SRV-06 单点，btrfs watcher 故障）、BUG-04（SRV-05 并入合并条目，另含 SHELL-12/HL-06/HL-07）、BUG-05（SRV-07 并入合并条目，另含 SHELL-09/SHELL-13）。

**已裁决偏差**（报告 §2.4，涉及本域、不计缺陷，回归时不得当缺陷报）：#2（`?token=` URL 引导交换未实现，改为连接表单手动粘贴 token；凭据存 sessionStorage、重连需手动）、#3（`/api/file` 仅下发 X-VV-Lang 与 X-VV-Encoding，X-VV-Type 头已裁决省去）、#8（不做 RustEmbed 内嵌前端产物，`--web-dist` 是唯一前端挂载通道）。

## 2. 场景清单

所有场景的公共环境（构造方式见第 4 节）：主实例以 `vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute` 启动（报告 §2.2），`/api/health` 返回 `capabilities=["file-server","compute"]`；接口类场景用 curl 直打 `/api/*`，前端类场景经浏览器（报告 §3.1 方法层 1/2）连接首页执行。SRV-06/10/11 等场景需按第 4.1 节实例矩阵另起辅助实例。场景编号沿用报告测试点编号 SRV-01~SRV-13（报告编号齐全，无续编点）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SRV-01 | 以 release 二进制（`server/target/release/vviewer`，报告 §2.1）另起冒烟实例（本轮 8399 端口；启动参数报告未逐项记录，本轮实测 capabilities=[file-server]） | ① `curl -s /api/health` 读 capabilities；② GET 首页记录 HTTP 状态与响应；③ 浏览器打开该实例首页，展开目录树 | capabilities=[file-server]；首页 HTTP 200；目录树懒加载展开正常 | — |
| SRV-02 | 两个实例对照：有 `--compute`（8391）与无 `--compute` 实例（报告 §2.2 实例矩阵含 8397 无 --compute 形态） | ① 分别 `curl -s /api/health`；② 比对两实例 capabilities 数组 | 无 --compute 实例返回 `["file-server"]`；有 --compute 实例在尾部追加 `"compute"`（即 `["file-server","compute"]`） | — |
| SRV-03 | 主实例（8391，无 token）；另起带 `--token` 实例用于 token 场景（本轮 8398，token 值 `e2e-test-token-42`）；浏览器打开首页 | ① TopBar「连接服务器」，token 留空连接 8391；② 观察目录树出现，逐层展开验证懒加载；③ 对带 token 实例在连接表单粘贴 token 后连接（报告偏差 #2：无 `?token=` URL 引导，凭据存 sessionStorage、重连需手动）；④ 重复② | 两种场景均连接成功；目录树出现且懒加载展开正常 | — |
| SRV-04 | 带 `--token` 实例（token 值已知）；浏览器打开首页 | ① `curl` 携带错误 token 请求该实例 /api 接口，读状态码与响应头；② 连接表单输入错误 token 提交，观察前端提示文案 | 接口返回 401，响应含 `www-authenticate`（unauthorized）；前端显示「鉴权失败：令牌缺失或错误（HTTP 401）」 | — |
| SRV-05 | 连接服务器；数据集含 samples/m5/sample.js 与 python 文件（对照） | ① `curl -sD -` 读 `/api/file?path=samples/m5/sample.js` 响应头中的 `x-vv-lang`/`x-vv-encoding`；② 以 Range 头请求（206 路径）验证响应仍携带上述头；③ python 文件重复①（对照 `x-vv-lang: python`）；④ 浏览器打开 sample.js，确认代码高亮正常；⑤ 读取状态栏查找语言/编码字段 | 响应头（含 Range 206）正确下发 `x-vv-lang: javascript` 与 `x-vv-encoding`，python 文件返回 `x-vv-lang: python`（偏差 #3：无 X-VV-Type 头属已裁决）；高亮正常；**状态栏显示的语言/编码与 X-VV 头一致** | BUG-04（现状 partial：检测头正确下发、高亮 ✓，状态栏不展示语言/编码） |
| SRV-06 | 主实例 8391（数据根为 btrfs）；另以同一 release 二进制、`--root` 指向 /tmp 下 tmpfs 目录自起对照实例（本轮 8394 模式）；连接并打开 samples/m5/sample.js，保持 tab 前台 | ① 读取状态栏；② 服务器侧 `echo` 向该文件追加一行，等待 ≥3s，观察 tab 是否自动出现新行、滚动位置是否保留；③ `POST /api/ticket` 取 ticket，`curl -sN "/api/events?ticket=<ticket>"` 建立事件流，同时服务器侧再写文件，记录推送的事件类型；④ 在 tmpfs 对照实例上重复①②③ | 状态栏无「自动刷新不可用」；服务器侧写入后约 500ms debounce 内 tab 自动重读显示新内容、滚动位置保留（对照基线：append 后 3s 内自动 GET /api/file 200、scrollTop 保持、新行渲染）；事件流推送 `{"type":"changed"}`（含 paths）而非 watch-error。**帧语义更新（BUG-02 修复后，server/src/watch.rs）**：watcher 重建期/降级（PollWatcher 轮询）期以 `{"type":"watch-degraded","backend":…}` 帧表达（建连快照与运行期同形），恢复实时监听后推 `{"type":"watch-recovered","backend":…}`，降级轮询期间 changed 帧照常流动；旧 `watch-error` 帧已弃用不再广播（前端按终态断开处理，见 remote.ts）——回归判定以 changed 是否恢复流动为准，勿把 watch-degraded/watch-recovered 当故障误报（当前前端对两帧静默忽略，属知情取舍） | BUG-02（现状 partial：tmpfs 对照全链路 ✓；8391 btrfs 数据根上任何写入仅推 watch-error、tab 永不自动重读、状态栏常驻警示） |
| SRV-07 | 连接服务器并打开一个文件；准备向该文件服务器侧追加内容 | ① 遍历全部按钮/文本/dialog/右键/快捷键/路由寻找设置入口与刷新按钮（复核口径：22 个 button 穷举、checkbox/switch 计数、#settings 路由、Ctrl+comma）；② 若存在设置面板，将刷新切换为手动模式；③ 服务器侧向已打开文件追加一行；④ 使用手动刷新按钮，检查页面是否出现新行 | 存在设置入口可切换刷新自动/手动（报告转述 spec L262、决策 Q8b/Q9）；存在始终可用的手动刷新按钮；追加内容后经手动刷新页面出现新行（现状基线：追加 2.5s 后页面不含新行） | BUG-05（现状 fail：全 UI 穷举无刷新设置与按钮，用户无任何 UI 手段刷新已打开文件内容） |
| SRV-08 | 服务实例就绪；选定任一常规文件（如 samples 下文本文件） | ① `curl -s -D - -o /dev/null -H "Range: bytes=0-99" "/api/file?path=<文件>"` 记录状态码；② 以非法 Range 值重复请求，记录状态码；③ 以后缀形式（`bytes=-N`）重复请求，记录状态码 | 正常 Range 返回 206；非法 Range 被严格拒绝返回 416；后缀 Range 返回 206（报告证据：三态 + 非法 Range 416，curl 实测） | — |
| SRV-09 | 服务实例就绪；数据根含指向 root 外的 symlink（数据集 `edge/symlink/escape-etc -> /etc` 形态） | ① 以 `../` 形式构造穿越路径请求 `/api/file`，记录状态码；② 以 URL 编码 `%2e%2e%2f` 形式重复；③ 经 root 内指向 root 外的 symlink 发起请求，记录状态码 | `../` 与 `%2e%2e%2f` 均返回 400；root 内外链 symlink 返回 403（curl 实测。另见第 4 节边界 3：escape-etc 的内容层读取断言报告列为未覆盖项） | — |
| SRV-10 | 可执行文件与终端就绪；不占用已用端口 | ① 以 `--allow-lan` 且不带任何 token 参数启动实例，观察退出码与报错输出；② 追加 `--token-gen` 重新启动，观察启动结果与 stdout 输出 | ① 拒绝启动：exit=2 且报错明确；② 加 `--token-gen` 后正常启动，stdout 打印 64 位 token | — |
| SRV-11 | 两个实例对照：默认实例（8391）与 `--hidden` 实例（本轮 8396），二者数据根均含 dot 文件与 visible.txt | ① `curl -s /api/tree` 读默认实例根目录清单；② 同法读 --hidden 实例清单；③ 浏览器对照两实例树显示 | 默认实例 dot 文件全部显示；--hidden 实例仅剩 visible.txt | — |
| SRV-12 | 连接服务器；数据集含 4 层中文嵌套目录与同级 file1/file2/file10 类命名文件（报告未记录具体路径名，重建时按此规格放置） | ① 文件树逐层展开中文目录至第 4 层，观察各层懒加载；② 检查含 file1/file2/file10 同级的排序；③ 检查目录与文件的先后 | 4 层懒加载展开正常；目录优先排序；同级文件自然排序 file1<file2<file10（非字典序） | — |
| SRV-13 | 服务实例就绪（报告证据形态：无 token 主实例 8391 上即以 `POST /api/ticket` 取票——BUG-02 复现步骤实录；带 token 形态下该接口行为的差异报告未涉及，勿外推） | ① `POST /api/ticket` 取 ticket；② `curl -sN "/api/events?ticket=<ticket>"` 建立事件流，确认可收到事件；③ 同一 ticket 二次使用，确认失效；④ 改以 `Authorization: Bearer <token>` 头请求 /api/events，确认不可用；⑤ 长挂事件流，以时间戳实录相邻 ping 间隔 | ticket 一次性（二次使用失效）；Bearer/token 认证不可用于 /api/events（仅一次性 ticket 有效）；`: ping` 心跳间隔精确 15s（时间戳实录） | — |

## 3. 关联缺陷的验收行为

以下 3 条均为报告 §5 中 verified 状态的缺陷。「缺陷现状」为报告证据摘要；「修复后应有行为」作为回归验收依据，仅由报告的期望字段与实测通过部分推导。

### BUG-02 8391 主实例（btrfs 数据根）watcher 持续故障，SSE 变更推送与自动重读完全不可用且无自愈（SRV-06 单点；medium · verified）

**缺陷现状**（报告 BUG-02，§5）：

- 8391 主实例（数据根经 `df -T` 确认 btrfs /dev/sda3）上任何写入（既有文件 append、新建文件）仅推送 `{"type":"watch-error"}`，无任何 changed 事件；状态栏常驻「自动刷新不可用」（SSE 建连时即出现，非写触发）；tab 永不自动重读；复测两次均复现。
- 同一二进制在 /tmp tmpfs 自起实例（8394）上自动重读+滚动保留链路完整通过：append 后 3s 内自动 GET /api/file 200、scrollTop 保持 12000、新行渲染、DOM 出现 1502 行。
- 复核会话独立复现：SSE 探测两次仅见 watch-error 与 `: ping`；已排除 symlink 诱因。
- 仲裁备注：复核员原判 high，按统一标尺（文件查看功能本身可用、可手动重开文件绕过、状态栏有明确警示文案）仲裁调整为 medium；btrfs 根因未定位，列入未覆盖范围。

**修复后应有行为**（回归验收，对应报告期望字段）：

1. btrfs 数据根实例上服务器侧写入（append/新建）后，`/api/events` 推送 `{"type":"changed"}`（携带 paths），不再只推 watch-error。
2. 保持 tab 前台时，服务器侧写入后约 500ms debounce 内自动重读显示新内容，滚动位置保留（对齐 tmpfs 对照已验证的通过基线：append 后 3s 内自动 GET /api/file 200、scrollTop 保持、新行渲染）。
3. watcher 故障有自愈/重试路径，不再「无自愈」（缺陷标题指认的现状；报告 §7.2 建议 3 亦要求定位 inotify/watcher 初始化与自愈逻辑）；修复后状态栏不再因建连即出现常驻「自动刷新不可用」。
4. 故障不应特定于文件系统类型（报告 §7.2 建议 3：先在 ext4/xfs 复测圈定文件系统相关性；§7.1 未覆盖项 4 注明 ext4/xfs/NFS、macOS/Windows 通知机制本轮未测，修复验证应覆盖）。
5. **协议增量口径（修复引入）**：重建/降级期事件流出现 `watch-degraded`（含 backend 字段）、恢复后出现 `watch-recovered` 帧，均为信息性帧而非故障；全程**不得**再出现 `watch-error`（前端终态断开语义，已弃用）。判定自愈有效的口径是：降级帧后 changed 帧继续流动（PollWatcher 轮询）、恢复帧后 changed 实时性回到 ~500ms debounce。

### BUG-04 状态栏通用元数据（编码/语言/大小/行列）整体未实现——服务端检测头正确下发但 UI 不展示（合并：SHELL-12 + HL-06 + HL-07 + SRV-05；medium · verified）

**缺陷现状**（报告 BUG-04，§5；本域对应 SRV-05）：

- 代码文件状态栏仅「高亮: … · 执行: … · 自动刷新不可用」，outerHTML 中编码/语言/大小/行列四字段均为 Svelte 条件占位 `<!---->` 未渲染。
- 服务端检测正确：sample.js 下发 `x-vv-lang: javascript`，Range 206 响应同样带头；hello.py 下发 `x-vv-lang: python`（截图 srv05-samplejs-open.png、srv05-hello-py.png）；`x-vv-encoding` 对 gb18030/utf-8/utf-16le 均正确下发。
- 全页检索无任何编码/语言字样与控件；属性面板仅占位「文件元数据（M4 接入）」。
- 仲裁备注：四字段全缺、信息性缺失但检测正确；「引擎与执行位置」半项已实现（报告注：README:21 承诺范围）。

**修复后应有行为**（回归验收，对应报告期望字段，spec L290 转引自报告）：

1. 状态栏显示编码、语言、大小、行列；本域验收点：sample.js 状态栏语言与 `x-vv-lang`（javascript）一致、编码与 `x-vv-encoding` 一致；python 文件显示 `python`。
2. 状态栏值与 X-VV 检测头逐字一致，且 Range 206 路径下打开的文件同样成立。
3. 代码文件的「高亮引擎与执行位置」半项不回退（现状已实现）。

### BUG-05 设置面板整体缺失：排除规则、自动刷新（自动/手动）开关、手动刷新按钮均无任何 UI 入口，引擎正常但用户不可达（合并：SHELL-09 + SHELL-13 + SRV-07；medium · verified）

**缺陷现状**（报告 BUG-05，§5；本域对应 SRV-07）：

- 全页面无任何设置/排除/刷新控件：复核穷举 22 个 button 无一相关、checkbox/switch 为 0、无 dialog/menu、tab 右键无菜单、`#settings` 与 `GET /settings` 均为 SPA fallback、Ctrl+comma 无弹层。
- 底层引擎正常：排除规则与刷新持久化经 localStorage 探针验证正常工作（写入 `{"excludedPatterns":[".git","node_modules"]}`（单键对象 `vviewer:settings`）后树中 .git/node_modules 消失且跨刷新持久）；计算策略与代码主题两项可改可恢复。
- 向已打开文件追加内容后用户无任何 UI 手段刷新内容（2.5s 后页面不含新行）。
- 复核纠正：状态栏有「自动刷新不可用」字样但非按钮（SRV-07 原报告「无刷新文本」一处不准确）。
- 仲裁备注：设置数据模型与引擎工作正常，仅用户入口缺失；可 devtools 手写存储绕过。

**修复后应有行为**（回归验收，对应报告期望字段，spec L262/L229、决策 Q8b/Q9 转引自报告）：

1. 存在可到达的设置入口，其中可切换刷新模式自动/手动。
2. 存在始终可用的手动刷新按钮；手动刷新后已打开文件呈现服务器侧新追加的内容（追加行出现）。
3. （合并条目另含排除规则预设入口与排除规则/刷新模式 UI，验收点在 app-shell 域场景文档；本域回归时 SRV-07 的刷新两项为必需验收点。）

## 4. 测试数据与边界

### 4.1 服务器实例矩阵（报告 §2.2）

主实例：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`（PID 与日志写入 `.temp/e2e-server.pid`、`.temp/e2e-server.log`）；`/api/health` 应返回 `capabilities=["file-server","compute"]`。辅助/自起实例均测毕按 PID 清理（主实例 8391 保留）：

| 端口 | 形态/用途 | 用于场景 |
| --- | --- | --- |
| 8391 | 主实例，数据根 `.temp/e2e-data`（btrfs /dev/sda3）；也是 SRV-11 的「默认显示」对照 | SRV-03/05/06/08/09/11 等 GUI 与接口场景 |
| 8394 | tmpfs root 对照（同 release 二进制，root 指向 /tmp 下 tmpfs 目录） | SRV-06 |
| 8395 | `--token-gen` | SRV-10 |
| 8396 | `--hidden` | SRV-11 |
| 8397 | 无 `--compute` 形态 | SRV-02 无 compute 对照（报告 §2.2 列有此形态实例，未逐点指明映射） |
| 8398 | `--token e2e-test-token-42` | SRV-03/04 token 场景（同上，报告未逐点指明映射，token 值为报告实录） |
| 8399 | release 单二进制冒烟 | SRV-01 |

端口处置经验（报告 §2.2）：8391 起初被遗留孤儿进程占用，按 PID kill 后重启（未用 pkill）；重建环境时先确认端口占用。ripgrep 在 PATH（`/usr/sbin/rg`）。

### 4.2 数据清单

基础数据集位于 `.temp/e2e-data/`（报告 §2.3：约 24MB、53 个常规文件 + 1 个 symlink）。本域场景直接使用基础数据集与少量环境构造物；报告未记录本域另造样例目录（`domain-server-file-service/` 未在报告 §2.3 末段出现）。

| 项 | 规格（报告实测/记录值） | 来源 | 用于场景 |
| --- | --- | --- | --- |
| samples/m1~m6 | 基础样例树（目录优先、懒加载展开的展示面） | 基础数据集 | SRV-01/03 树展开 |
| samples/m5/sample.js | m5 样例代码文件；服务端下发 `x-vv-lang: javascript`；SRV-06 自动重读目标文件 | 基础数据集 | SRV-05/06 |
| hello.py | python 对照文件（`x-vv-lang: python`；截图 srv05-hello-py.png；报告未注明路径，重建时按任一 python 文件放置） | 报告证据名 | SRV-05 |
| 中文 4 层嵌套目录 + file1/file2/file10 | 4 层懒加载展开；自然排序断言件（报告未记录具体路径名） | 报告 §8.8 SRV-12 证据 | SRV-12 |
| dot 文件 + visible.txt | 默认实例全显示、--hidden 实例仅剩 visible.txt（报告未记录构造命令，重建时在两实例 root 下各放 dot 文件与 visible.txt） | 报告 §8.8 SRV-11 证据 | SRV-11 |
| edge/symlink/escape-etc -> /etc | 基础数据集 symlink；/api/tree 呈现 kind=dir（服务解析符号链接） | 基础数据集 | SRV-09（另见边界 3） |
| 空格/中文/emoji 特殊文件名 3 件 | /api/tree 均正常列出 | 基础数据集 | SRV-03/12 展开对照 |
| tmpfs root（/tmp 下目录） | SRV-06 对照实例数据根（报告未记录具体路径，重建时在 /tmp 下建目录即可） | 报告 BUG-02 证据 | SRV-06 |

### 4.3 边界与注意事项（报告 §2.4/§3.3/§7.1，如实转写）

1. **偏差 #2/#3/#8 不计缺陷**：token 经连接表单手动粘贴（凭据存 sessionStorage、重连需手动）、无 X-VV-Type 头、`--web-dist` 为唯一前端挂载通道，均为已裁决偏差；回归验收时不得作为缺陷报。
2. **BUG-02 复测前先确认文件系统**：btrfs 根因未定位，复测时先对数据根执行 `df -T` 确认文件系统类型，并保留 tmpfs 对照路径（8394 模式）；ext4/xfs/NFS、macOS/Windows 文件通知、watcher 故障后的重试/自愈/重启恢复均未测（§7.1 未覆盖项 4）。
3. **symlink 内容层断言未覆盖**：escape-etc 在 /api/tree 呈现为 dir，逃逸防护断言应放在内容/fetch 类接口，但本轮「无任何域对 `/api/file?path=…/escape-etc/…` 的越权读取做过断言（仅覆盖了常规路径穿越）」（§7.1 未覆盖项 5）；SRV-09 记录的「root 内外链 symlink → 403」为当时 curl 实测，报告 §7.2 建议 5 要求对 escape-etc 的 /api/file 读取路径补 403 断言。重建场景时应补齐该断言。
4. **SSE 长时稳定性未测**：15s 心跳与断线重连仅在短窗口验证，长时间运行与大量文件变更风暴下的推送及时性未测（§7.1 未覆盖项 10）；SRV-13/SRV-06 的期望以短窗口口径为准。
5. **端口与实例卫生**：辅助实例测毕按 PID 清理；遇到端口占用按 PID 处置、不用 pkill（报告 §2.2 原则）。
6. **ticket 接口的实录形态**：报告对 `POST /api/ticket` → `/api/events?ticket=…` 的用法实录在无 token 主实例 8391 上（BUG-02 复现步骤、SRV-06 场景③）；带 token 实例上该接口行为是否有差异报告未涉及，重建时不要外推。
