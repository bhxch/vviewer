# PWA、移动端与性能预算（M7） — e2e 场景

> 转写自：`docs/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`，2026-10-08）。
> 本文将该报告「PWA、移动端与性能预算（pwa-mobile-performance，M7）」域的黑盒测试内容转写为可独立执行的场景文档；只收录报告中有依据的内容，不补充报告之外的 spec 行为。各场景括注报告原始结果（pass / partial / fail）。

## 1. 域描述与覆盖范围

以下均摘自报告 §1.1、§3.3、§4 矩阵、§6 与 §8.10 附录。

- **覆盖与评级**：9 个测试点全部实跑——4 pass / 4 partial（内含 1 fail）/ 0 blocked，域评级 **部分实现**。failed=PWA-02，partial=PWA-03/04/06/08。
- **通过面**（报告 §4 备注）：PWA 基础扎实——SW activated、precache 102 条含 manifest、离线壳导航可用、`/api/*` 严格网络优先；移动视口无溢出；文本首帧与媒体起播远优于预算。
- **缺陷面**（报告 §4 备注，拉低评级的四块，均为离线相关承诺密集不达标）：离线 reload 落浏览器错误页（BUG-15）、离线高亮承诺不成立（BUG-06 关联）、hex 首屏超预算 3~9 倍（BUG-16）、断网静默失败（BUG-24）。触摸/惯性结论受仿真环境限制（BUG-26 unconfirmed）。
- **关联缺陷**（报告 §5，共 5 条）：
  - BUG-06（medium · verified，跨域合并 HL-01 + HL-10 + PWA-03，主体在 code-highlight-degrade 域）——本地 tree-sitter wasm 主路径完全失效致离线高亮承诺不成立，本域对应 PWA-03（fail）；
  - BUG-15（medium · verified）——离线 reload 落 chrome-error 浏览器错误页，对应 PWA-02；
  - BUG-16（medium · verified）——1MB .bin 的 hex 首屏超桌面预算约 7~9 倍、移动预算约 3 倍，对应 PWA-08；
  - BUG-24（low · verified）——断网展开未加载树目录静默失败无提示，对应 PWA-04；
  - BUG-26（low · **unconfirmed** · 复核不可复现）——报告称触摸滑动 touchend 后无惯性续滚，复核同参数快滑 5 次中 4 次复现出典型惯性，判定不成立，对应 PWA-06。
- **环境限制**（报告 §3.3、§7.1 未覆盖项 9）：本域移动端场景全部为桌面 headless + 设备仿真；agent-browser device 仿真不启用触摸（`maxTouchPoints=0`），触摸交互以 CDP `Input.dispatchTouchEvent` 替代；真实触摸/惯性/移动 UA wheel 未在真机验证，hex 性能数字亦含 headless 容器噪声。
- **交叉验证**（报告 §6）：仓库自带 Playwright 套件与本域 pass 结论互相印证——m7 项目（SW 注册与 workbox precache、hljs 近似映射真实级联）与 mobile 项目（抽屉开合、文件夹打开→树→md 渲染、触摸滑动 markdown 正文 scrollTop 前移、视频播放页不崩等）全部通过；但该套件未覆盖本次黑盒发现的主要缺陷面（离线 reload、本地 wasm 主路径失效等），两套验证互补。

## 2. 场景清单表

编号沿用报告测试点编号（PWA-01~09，见报告 §8.10 附录）。本域报告所有材料均落在这 9 个测试点内，无续编号场景。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| PWA-01（pass） | 主服务已启动：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；测试前已执行 `pnpm gen:grammars`（偏差 #10 强制前置）；浏览器在线访问 http://127.0.0.1:8391 | ① 在线打开首页，等待 Service Worker 注册完成；② eval 检查 `navigator.serviceWorker.controller`；③ `caches.keys()` 读取缓存名并统计 precache 条目数，确认 manifest 是否在其中 | SW 状态 activated、`controller=true`；precache 缓存实测 102 条（满足 >10 判据）且包含 manifest（证据 pwa01-sw-precache.png） | — |
| PWA-02（partial） | PWA-01 已完成（SW activated、`controller=true`）；页面为 http://127.0.0.1:8391（报告 BUG-15 复现步骤所指实例） | ① 在线打开首页等待 SW activated，eval 确认 `controller=true`；② set offline on，eval 确认 `navigator.onLine=false`；③ 执行 reload，观察 URL 与页面内容；④ 对照：保持离线，经地址栏重新导航（回车）到 http://127.0.0.1:8391；⑤ 在线 reload 基线对照（复核会话从零走完含此基线） | 期望：断网后刷新页面，应用壳从 precache 提供、界面完整打开不白屏。实测现状：离线 reload 2/2 稳定失败——URL 变为 `chrome-error://chromewebdata/`、body 仅 121 字符的 ERR_INTERNET_DISCONNECTED 错误页；离线重新导航成功（location 保持 8391、body 3060 字符、完整控件、`controller=true`）；在线 reload 基线正常（证据 pwa02-offline-reload-chromeerror.png、pwa02-offline-shell-nav.png、pwa02-offline-shell.png） | BUG-15 |
| PWA-03（fail） | `pnpm gen:grammars` 已执行（34 项 manifest 写入 `apps/web/static/grammars/`）；curl 预验证 `/grammars/manifest.json`、`rust.wasm`、`tree-sitter.wasm`、queries 均 200；8391 在线连接；备好本地代码文件（复核经 upload 打开 hello.py / lib.rs） | ① 在线经树打开 9 种语言文件；② 查 `caches.keys()` 与 performance entries，CDP 网络层按 wasm 过滤；③ 检查 IndexedDB 有无 grammar 存储；④ set offline on；⑤ 离线 fetch 各 grammar wasm；⑥ 离线打开本地 .py（upload），读状态栏高亮引擎字样与 ts-*/hljs-* span 数 | 期望：grammar wasm 按 CacheFirst 写入 vv-grammars-* 运行时缓存，断网后仍可 tree-sitter 高亮。实测现状：sw.js 声明的 vv-grammars-* 缓存从未创建（打开 9 语言后 caches 仅 precache）；全会话零 .wasm 网络请求、仅 manifest fetch（复核 CDP 网络层仅 1 条 manifest.json）；IndexedDB 无 grammar 存储；断网后 8 个 grammar wasm fetch 全部 Failed to fetch；离线 upload hello.py/lib.rs 均降级 hljs 兜底（复核另发现在线本地文件模式也不显示 tree-sitter、在线 tree-sitter 仅覆盖 4/9）（证据 pwa03-offline-local-py.png、pwa03-offline-sql-highlight.png、pwa03-open-go.har） | BUG-06 |
| PWA-04（partial） | 8391 在线连接、SW activated、文件树可见；树中存在子节点未加载的折叠目录（复核以 samples/m5/edge 等三个目录交叉验证）与一个先前已在线加载过子节点的目录（对照用） | ① 在线展开树确认在线展开正常；② set offline on；③ 离线点击树中一个文件，观察失败提示；④ 离线点击未加载子节点的折叠目录，检查 aria-expanded、子节点数、toast/alert/dialog（3s 与 9s 采样、多目录交叉验证）；⑤ 对照：点击已加载子节点的目录做折叠/展开；⑥ `caches.keys()` 与缓存条目中检索 /api；⑦ 恢复在线重载后按同场景重做 | 期望：`/api/*` 一律走网络不读缓存（成立项）；断网操作失败处给出明确错误提示。实测现状：不缓存成立（fetch 失败、caches 无任何 /api 条目）；文件打开失败提示明确（「无法预览此文件 / Failed to fetch」）；但断网点击折叠目录 aria-expanded 保持 false、子节点 0、无任何 toast/alert/dialog（BUG-24）；对照目录（子节点已加载）断网时折叠/展开为纯客户端切换可正常 toggle（证据 pwa04-offline-api-error.png、pwa04-verify-offline-dir-expand-silent.png） | BUG-24 |
| PWA-05（pass） | 主服务已启动；数据中含 12 层嵌套 blockquote 的 markdown（deep-quotes.md，报告 §2.3）；浏览器 device 仿真 375×667 | ① 设置 375×667 移动视口；② 打开抽屉；③ 经可用通道打开文件夹出现文件树；④ 展开树并打开上述 markdown；⑤ eval 检查横向溢出（文档滚动宽度 vs 视口宽度） | 无横向溢出；抽屉开合正常；12 层嵌套 blockquote 全部渲染（证据 pwa05-drawer-open.png、pwa05-md-rendered.png；Playwright mobile 项目「抽屉开合、文件夹打开→树→md 渲染」交叉印证通过） | — |
| PWA-06（partial） | 375×667 移动视口（iPhone UA）；注意 agent-browser device 仿真不启用触摸（`maxTouchPoints=0`），须先经 CDP `Emulation.setTouchEmulationEnabled` 开启触摸模拟（复核补充要点，报告 §5 BUG-26）；树中有 long-3mb.txt | ① 经文件树打开 long-3mb.txt；② CDP `Input.dispatchTouchEvent` 执行慢滑 300px；③ 同法快滑 480px（12 步 × 40px / 8ms）；④ touchend 后多次采样 scrollTop；⑤ 观察虚拟渲染表现（行号随动、行高 20px/行） | 期望：触摸滑动驱动虚拟滚动、scrollTop 1:1 变化，且 touchend 后含惯性续滚。实测现状：1:1 跟手与虚拟渲染数字一致复现（30000→30285、行高 20px/行）；「无惯性」复核不可复现——同参数快滑 5 次中 4 次出现典型衰减曲线惯性（~400ms 内续滚 ~250-280px，如 613→718→737），仅 1/5 偶发，疑为报告会话首滑手势/合成器时序；慢滑无惯性属低于 fling 速度阈值的正常表现（BUG-26 unconfirmed，复核判不成立；证据 pwa06-virtual-scroll.png、pwa06-after-fling-verify.png，复核脚本 `/tmp/vv-verify-pwa06/touch-scroll.mjs`） | BUG-26（unconfirmed） |
| PWA-07（pass） | 375×667 移动视口；树中有 mp4 样例（3s mp4，ffprobe 验证合法，报告 §2.3） | ① 移动视口下经树打开 mp4；② 观察页面状态与播放器挂载；③ 以 trusted click 触发全屏；④ 退出全屏 | 页面不崩溃；播放器（ArtPlayer）正常挂载；全屏进入/退出成功（证据 pwa07-mp4-player.png、pwa07-fullscreen.png；Playwright mobile「视频播放页不崩」交叉印证通过） | — |
| PWA-08（partial） | 树中有 perf-1mb.bin（1,048,576B，报告 BUG-16 复现步骤）与 long-3mb.txt（文本首帧对照）；桌面会话，另备移动视口补测 | ① 先点参照文件重置 pane；② 以 performance.now() 为起点点击树内 perf-1mb.bin；③ MutationObserver 检测 hex 内容首现，双 rAF 后为绘制终点；④ 桌面多轮重复；⑤ 移动视口补测；⑥ 对照 long-3mb.txt 的文本首帧 | 期望：≤10MB 文件点击到首帧 <300ms（移动 <800ms）；1MB .bin hex 首屏 <200ms（移动 <500ms）。实测现状：文本 3MB 首帧中位 192~208ms 达标（冷态首轮偶超 437ms，仅单次采样）；hex 首屏桌面 paintMs 1404~1781ms（复核 4 轮，与报告 1570/1781/1601ms 同量级）、移动 1523~1738ms——超桌面预算约 7~9 倍、移动预算约 3 倍；即使取最宽松的 hex 头 DOM 首现口径（351~472ms）仍超桌面预算 1.8~2.4 倍；hex 内容最终渲染成功且正确（pane textContent 约 505 万字符全量 hex 渲染）（复核截图 pwa08-desktop-hex-1mb.png、pwa08-mobile-hex-1mb.png） | BUG-16 |
| PWA-09（pass） | 树中有 mp4 与 mp3/wav 样例（3s mp4、wav/mp3，报告 §2.3，均经 ffprobe 验证合法） | ① 打开 mp4，测量打开到起播耗时；② 打开 mp3，同法测量 | 打开到起播 <1s；实测 mp4 40ms、mp3 36ms 起播，远优于预算 | — |

## 3. 关联缺陷的验收行为

每条：缺陷现状（引用报告证据）→ 修复后应有行为（作为回归验收依据）。

### BUG-06【medium · verified】本地 tree-sitter wasm 主路径完全失效，离线高亮承诺不成立（本域相关部分：PWA-03）

- **涉及测试点**：本域 PWA-03（fail）；跨域合并 HL-01、HL-10（code-highlight-degrade 域），同根因合并。复核会话 vv-verify-pwa-mobile-performance-PWA-03 等，证据截图 HL01/PWA03 系列。
- **缺陷现状**（报告 §5 BUG-06）：前端运行时从不请求/消费 grammar wasm，故 sw.js 声明的 CacheFirst 无从命中，`pnpm gen:grammars` 产物（34 项）整链闲置。PWA-03 复核：gen:grammars 后 curl 验证 `/grammars/manifest.json`、rust.wasm、tree-sitter.wasm、queries 均 200，但自动与本地策略下 sample.rs 均降级「hljs 兜底 · 执行: 本地」（ts-* span=0、hljs-*=36，等待 6.5s 与硬刷新均复现）；全会话零 .wasm 网络请求、CDP 网络层仅 1 条 manifest.json；manifest 34 项 abi 字段全为 null（疑为本地引擎门控依据，因果关系未定位，报告 §7.1 未覆盖项 8）；sw.js 声明的 vv-grammars-* 运行时缓存从未创建（打开 9 语言后 caches 仅 precache）、IndexedDB 无 grammar 存储；断网后 8 个 grammar wasm fetch 全部 Failed to fetch；离线 upload hello.py/lib.rs 均为 hljs 兜底；复核并发现在线本地文件模式也不显示 tree-sitter、在线 tree-sitter 覆盖仅 4/9（比报告更差）。HL-10 复核补充操作要点：重开已打开文件不触发重载，需换文件中转。仲裁：三项复核均 medium（远程策略/hljs 兜底可绕过、无崩溃无错误结果），合并 medium。theme-system 域亦独立观察到同一现象（佐证）。
- **修复后应有行为**（回归验收，本域 PWA-03 视角）：
  1. 在线经树打开多种语言文件后，`caches.keys()` 中出现 vv-grammars-* 运行时缓存，grammar wasm 按缓存策略写入（performance entries 可见实际发出的 .wasm 请求，不再为零）；
  2. 断网后 fetch 各 grammar wasm 命中运行时缓存成功，不再出现 Failed to fetch；
  3. 离线打开本地代码文件（upload hello.py / lib.rs）显示 tree-sitter 高亮（状态栏非「hljs 兜底」、ts-* span > 0），离线高亮承诺成立；
  4. 回归不破坏：PWA-01 的 SW 注册与 precache、PWA-04 的 `/api/*` 严格网络优先行为均不变（离线壳不因新增运行时缓存回退为缓存优先）；
  5. 根因侧配合项（报告 §7.2 建议 2）：manifest 34 项 abi 全 null 与本地引擎零请求的因果关系需读源码定位后修复。
  - 注：HL-01/HL-10 主体场景（本地主路径高亮、远程矩阵）的完整验收在 code-highlight-degrade 域文档。

### BUG-15【medium · verified】离线（断网）reload 落到 chrome-error 浏览器错误页，仅重新导航才能打开离线应用壳

- **涉及测试点**：PWA-02（partial）。复核会话 vv-verify-pwa-mobile-performance-PWA-02 从零走完 steps 含在线基线对照；截图 pwa02-offline-reload-chromeerror.png、pwa02-offline-shell-nav.png；curl 辅证 `/sw.js` 与 `/manifest.webmanifest` 均 200。
- **缺陷现状**（报告 §5 BUG-15）：在线打开 http://127.0.0.1:8391 等待 SW activated（`controller=true`）后 set offline on（eval 确认 `onLine=false`），执行 reload 稳定失败（2/2 次）：URL 变为 `chrome-error://chromewebdata/`，body 仅 121 字符的 ERR_INTERNET_DISCONNECTED 错误页；离线下重新导航（地址栏回车）成功——location 保持 8391、body 3060 字符、完整控件、`controller=true`；在线 reload 基线正常，排除环境问题。仲裁：medium（离线应用壳本身可用、单次重新导航即可完全恢复，「刷新不白屏」这一测试点未达成，属功能不符可绕过）。
- **修复后应有行为**（回归验收）：
  1. SW 控制页面（`controller=true`）在 `onLine=false` 下执行 reload，页面从 precache 提供应用壳正常打开，不落 `chrome-error://chromewebdata/`、不出现 ERR_INTERNET_DISCONNECTED；
  2. reload 后界面完整（控件齐全、`controller=true`），行为与「离线重新导航」一致；
  3. 回归不破坏：离线重新导航可用（本轮已验证 ✓）与在线 reload 正常（基线 ✓）两条既有行为保持。

### BUG-16【medium · verified】1MB .bin 的 hex 首屏 1.4~1.8s，超桌面预算（200ms）约 7~9 倍、移动预算（500ms）约 3 倍

- **涉及测试点**：PWA-08（partial）。复核独立复现数值与报告几乎重合，截图 pwa08-desktop-hex-1mb.png、pwa08-mobile-hex-1mb.png（hex 视图实拍）。
- **缺陷现状**（报告 §5 BUG-16）：先点参照文件重置 pane，以 performance.now() 为起点点击树内 perf-1mb.bin（1,048,576B），MutationObserver 检测 hex 内容首现、双 rAF 后为绘制终点：文本 3MB（long-3mb.txt）首帧中位 192~208ms 达标（冷态首轮偶超，437ms 仅单次采样）；hex 首屏桌面 paintMs 1404~1781ms（复核 4 轮，与报告 1570/1781/1601ms 同量级）、移动 1523~1738ms；即使取最宽松的 hex 头 DOM 首现口径（351~472ms）仍超桌面预算 1.8~2.4 倍，远超环境噪声。pane textContent 约 505 万字符的全量 hex 渲染，内容正确。仲裁：medium（hex 最终渲染成功且内容正确、功能可用，属明显性能不达标而非功能损坏）。本地 upload 路径首帧未测（报告 §7.1 未覆盖项 7）。
- **修复后应有行为**（回归验收）：
  1. 1MB .bin 的 hex 首屏（点击到首帧）桌面 <200ms、移动 <500ms；
  2. ≤10MB 文本文件点击到首帧桌面 <300ms、移动 <800ms 不退化（本轮中位 192~208ms 已达标）；
  3. hex 内容正确性不回退（渲染结果与文件字节一致，本轮 505 万字符全量渲染内容正确为基准）；
  4. 补测本地 upload 路径的首帧/性能（报告 §7.1 未覆盖项 7、§7.2 建议 6），纳入同一预算判据。

### BUG-24【low · verified】断网时展开未加载的树目录静默失败，无任何错误提示（对照：文件打开失败有明确提示）

- **涉及测试点**：PWA-04（partial）。复核会话 vv-verify-pwa-mobile-performance-PWA-04 独立复现含对照组，截图 pwa04-verify-offline-dir-expand-silent.png。
- **缺陷现状**（报告 §5 BUG-24）：在线连接展开树确认正常后 set offline on，点击子节点未加载的折叠目录（samples/m5/edge 等三个目录交叉验证）：aria-expanded 保持 false、子节点 0，无任何 toast/alert/dialog（3s 与 9s 采样一致）。对照两项均正常：`/api/*` 一律走网络不读缓存成立（fetch 失败、caches 无任何 /api 条目）；文件打开失败提示明确（「无法预览此文件 / Failed to fetch」）；先前已在线加载子节点的目录断网时折叠/展开为纯客户端切换可正常 toggle——静默失败仅发生在需请求 /api 的目录。仲裁：low（断网下目录展开本不可能成功，缺陷仅为失败处缺少提示，对比文件打开有提示，属体验细节）。报告引用的 query.sql 不存在系样例缺失，复核已自建辅助文件验证。
- **修复后应有行为**（回归验收）：
  1. 断网时展开需请求 `/api` 的折叠目录失败处出现明确错误提示（toast/文案），不再静默；
  2. `/api/*` 严格网络优先不缓存的行为不回退（caches 中无任何 /api 条目）；
  3. 回归不破坏：文件打开失败的明确提示（「无法预览此文件 / Failed to fetch」）与已加载目录的纯客户端折叠/展开两条既有行为保持。

### BUG-26【low · unconfirmed · 复核不可复现】报告称移动端触摸滑动 touchend 后无惯性续滚

- **涉及测试点**：PWA-06（partial）。**状态：unconfirmed，复核未能复现报告缺陷并判定不成立**（按规则保留标注不丢弃）。
- **缺陷现状**（报告 §5 BUG-26）：报告称 375×667 移动视口（iPhone UA）经文件树打开 long-3mb.txt，CDP `Input.dispatchTouchEvent` 慢滑 300px 与快滑 480px（12 步×40px/8ms）后，1:1 跟手成立但 touchend 后 8×200ms 采样 scrollTop 恒定无惯性（并自注可能为合成输入限制）。复核（confirmed=false）推翻：跟手与虚拟渲染数字一致复现（30000→30285、行高 20px/行），但同参数快滑 5 次中后 4 次出现典型衰减曲线惯性（~400ms 内续滚 ~250-280px：613→718→737 等），「无惯性」仅为 1/5 偶发，疑为报告会话首滑手势/合成器时序；另报告未提 dispatchTouchEvent 需先经 `Emulation.setTouchEmulationEnabled` 开启触摸模拟。慢滑无惯性属低于 fling 速度阈值的正常表现。证据：复核自写 CDP 脚本直连 ws 采集（`/tmp/vv-verify-pwa06/touch-scroll.mjs`；截图 pwa06-after-fling-verify.png）。仲裁：维持 low；真机触摸行为未测（报告 §7.1 未覆盖项 9、§7.2 建议 4）。
- **验收行为**（现状正确行为的回归保护 + 补测要求；本条非已证实缺陷，无「修复」对象）：
  1. 触摸滑动 1:1 驱动虚拟滚动、scrollTop 跟手、虚拟渲染行号随动（本轮复核已一致复现，不得回退）；
  2. 快滑（超过 fling 速度阈值）touchend 后呈现惯性续滚——以复核实测为正常行为基准（~400ms 衰减曲线内续滚约 250-280px）；慢滑低于 fling 阈值无惯性属正常表现，不判缺陷；
  3. 复测方法约束：CDP `Input.dispatchTouchEvent` 前须先经 `Emulation.setTouchEmulationEnabled` 开启触摸模拟；多轮采样（复核 5 次中 4 次），避免单次手势时序误判；
  4. 真机补测：真实触摸/惯性/移动 UA wheel 表现未在真机验证，最终定论须真机执行（报告 §7.1 未覆盖项 9、§7.2 建议 4）。

## 4. 测试数据与边界

### 4.1 运行形态（报告 §2.1、§2.2）

- 主服务：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；本域 PWA-02/03/04 均在该实例上执行。
- 前置：测试前执行 `pnpm gen:grammars`（偏差 #10 强制前置，grammar wasm 资产不入库、构建期生成）；报告实测 `curl /sw.js` 与 `/manifest.webmanifest` 均 200（PWA-02 复核辅证）。
- 数据根 `.temp/e2e-data/` 总量约 24MB；本域另造样例存于 `.temp/e2e-data/domain-pwa-mobile-performance/`。

### 4.2 本域输入数据清单

| 数据 | 用于场景 | 构造/来源（均出自报告） |
| --- | --- | --- |
| deep-quotes.md（12 层嵌套 blockquote） | PWA-05 | 基础数据集 HTML/MD 3 件之一（报告 §2.3） |
| long-3mb.txt（约 3MB 长文本） | PWA-06（触摸滚动）、PWA-08（文本首帧对照） | 域样例「3MB 长文本×2」（报告 §2.3）；HL-08 实测其末行行号 54237 与 wc -l 一致，行高 20px/行（BUG-26 复核基准） |
| perf-1mb.bin（1,048,576B） | PWA-08 | 报告 BUG-16 复现步骤明确其文件名与字节数；报告未记录具体内容，构造为同字节数 .bin 文件即可（示例：`head -c 1048576 /dev/urandom > perf-1mb.bin`） |
| 3s mp4 | PWA-07、PWA-09 | 域样例（报告 §2.3，经 ffprobe 验证合法） |
| wav / mp3 | PWA-09 | 域样例（报告 §2.3） |
| grammar 资产：`/grammars/manifest.json`（34 项）、rust.wasm、tree-sitter.wasm、queries/ | PWA-03 | `pnpm gen:grammars` 生成（偏差 #10）；场景执行前先 curl 验证均 200 |
| 本地代码文件 hello.py、lib.rs | PWA-03（离线 upload 打开） | BUG-06 PWA-03 复核使用；任意合法 Python/Rust 源文件 |
| 含未加载子节点的折叠目录（samples/m5/edge 交叉验证）+ 已在线加载过子节点的对照目录 | PWA-04 | 基础数据集自带目录层级；对照目录须先在线展开过一次。注：报告原场景引用的 query.sql 样例缺失，复核自建辅助文件验证（报告 §5 BUG-24） |

### 4.3 边界与环境限制（报告 §3.3、§5、§7.1）

1. **触摸仿真链路**：agent-browser device 仿真不启用触摸（`maxTouchPoints=0`）；触摸交互以 CDP `Input.dispatchTouchEvent` 替代，且须先经 `Emulation.setTouchEmulationEnabled` 开启触摸模拟（复核补充要点，报告 §5 BUG-26）。JS 派发 TouchEvent 不驱动原生滚动属浏览器安全设计，非产品缺陷。
2. **真机未测**：本域移动端场景全部为桌面 headless + 设备仿真，真实触摸/惯性/移动 UA wheel 未在真机验证；hex 性能数字含 headless 容器噪声（报告 §7.1 未覆盖项 9）。
3. **性能测量口径**（PWA-08）：以 `performance.now()` 为起点、MutationObserver 检测内容首现、双 rAF 后为绘制终点；先点参照文件重置 pane 以排除冷态干扰；文本冷态首轮 437ms 偶超 300ms 仅为单次采样，判据以中位为准；本地 upload 路径首帧未测（报告 §7.1 未覆盖项 7）。
4. **BUG-26 为 unconfirmed 且复核判不成立**：回归执行时按第 3 节「现状正确行为保护」口径处理（多轮采样、区分慢滑/快滑阈值），不得按报告原「无惯性」结论单次采样判定。
5. **BUG-06 根因侧的边界**：manifest 34 项 abi 全 null 与本地引擎零请求的因果关系仅为相关性记录，未定位（报告 §7.1 未覆盖项 8）；远程 tree-sitter 语言矩阵仅抽样少数语言。
6. **交叉验证口径**：仓库 Playwright 套件 m7/mobile 项目结论（§6）与本域黑盒 pass 项互相印证，但不覆盖黑盒缺陷面（离线 reload、本地 wasm 主路径失效等）；引用时与黑盒结果互补而非替代。
