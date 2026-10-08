# 后端档 2 计算卸载与全局搜索（M6） — e2e 场景

> 转写自：`docs/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`，2026-10-08）。
> 本文将该报告「后端档 2 计算卸载与全局搜索（compute-global-search，M6）」域的黑盒测试内容转写为可独立执行的场景文档；只收录报告中有依据的内容，不补充报告之外的 spec 行为。各场景括注报告原始结果（pass / partial / fail / blocked）。

## 1. 域描述与覆盖范围

以下均摘自报告 §1.1、§2.2、§2.4、§3.1、§4 矩阵、§6 与 §8.9 附录。

- **覆盖与评级**：12 个测试点全部实跑——7 pass / 5 partial（0 fail / 0 blocked），域评级 **基本完整**。partial=CMP-02/03/06/07/11。
- **通过面**（报告 §4 备注）：搜索主链路与 compute 路由可用——能力宣告（/api/health capabilities 含 compute）、本地/远程执行位置指示、auto 远程失败真实回退（网络层捕获 400→本地渲染）、无 rg 时 501 降级、1000 条命中/2000 文件上限、取消/重发、API 层 glob/正则/大小写全部有效。
- **5 个 partial 均为可绕过的辅助功能缺失**（报告 §4 备注）：全局跳转定位（BUG-09）、remote 大文件阈值（BUG-10）、超限引导（BUG-11）、glob 无 UI（BUG-21）、执行位置指示（BUG-22）。
- **方法与证据**（报告 §3.1）：黑盒 GUI 独立会话，本域截图 20 张（`.temp/e2e-artifacts/compute-global-search/`）；接口断言 curl 直打 `/api/compute/highlight`、`/api/compute/markdown`、`/api/search`（NDJSON 流、glob 参数）。
- **运行形态**（报告 §2.2）：主服务以 `--compute` 启动（8391，`/api/health` 返回 `capabilities=["file-server","compute"]`）；ripgrep 在 PATH（`/usr/sbin/rg`），无需降级路径即可测远程搜索；另起无 rg 环境实例（8394，CMP-09）与纯前端 `python3 http.server` 实例（8395 通道，CMP-10/11）。
- **已裁决偏差**（报告 §2.4，不计缺陷，涉本域 3 条）：#5 服务端高亮无 injection，带注入的 6 种语言在 auto 策略下留在本地执行；#6 服务端 comrak 不启用数学扩展、无数学掩码，数学内容远程渲染与本地 KaTeX 可能不一致；#9 跨文件搜索结果列号（col）两端统一为 UTF-16 码元。
- **交叉验证**（报告 §6）：仓库自带 Playwright 套件 m6 组通过项与本域 pass 结论互相印证——`--compute` health capabilities、policy=remote 高亮/markdown 走服务端并显示执行位置「远程」、≈1.5MB 大文件同为远程、Ctrl+Shift+F 全局搜索 inner 命中 sub/inner.txt 并打开、comrak GFM 直连断言、policy=local 回退显示「本地」。
- **关联缺陷**（报告 §5，共 5 条，全部 verified）：
  - BUG-09（medium）——全局搜索点击命中行仅打开文件，不滚动定位、无命中行高亮，对应 CMP-06；
  - BUG-10（medium）——显式 remote 策略下 >2MB 文件仍被本地阈值压制为 hljs 分块，对应 CMP-02；
  - BUG-11（medium）——纯前端搜索超 2000 文件上限无「建议改用服务器模式」引导，对应 CMP-11；
  - BUG-21（low）——全局搜索 glob 限定无任何 UI 入口（仅 API 层支持），对应 CMP-07；
  - BUG-22（low）——auto 策略执行位置指示不符期望路由，对应 CMP-03。

## 2. 场景清单表

编号沿用报告测试点编号 CMP-01~12；本域无续编点（5 条关联缺陷均有对应测试点）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| CMP-01（pass） | vviewer 以 `--compute` 启动并已被浏览器连接（8391 主实例）；前置 `pnpm gen:grammars` 已执行（见 4.1） | ① `curl /api/health` 读 capabilities；② 打开一个代码文件，观察状态栏「高亮/执行」段；③ （对照）`curl` 无 `--compute` 实例（8397）的 /api/health | ① capabilities=["file-server","compute"]，compute 位于尾部（无 `--compute` 对照仅 ["file-server"]，SRV-02 口径）；② 状态栏本地/远程执行位置指示可见（证据 cmp01-statusbar-local.png） | — |
| CMP-02（partial） | 已连接服务器；备好 >2MB 代码文件 code-3mb.js（报告实测 3,378,599B）与 <2MB 的 samples/m5/sample.js；计算策略可切换 | ① 计算策略切「计算: 远程」；② 树中打开 code-3mb.js 读状态栏，关标签重开复验；③ 网络面板观察有无 POST /api/compute/highlight；④ 同策略打开 sample.js 对照；⑤ `curl` POST /api/compute/highlight 对同文件连续多次，对比耗时与响应体大小（size_download） | 期望（修复后验收判据）：remote 策略下约 3MB 代码文件远程执行、状态栏显示远程，缓存 (path,mtime,size) 使二次打开更快。实测现状：② 状态栏恒为「高亮: hljs 分块 · 执行: 本地」（报告 3 次、复核 2 次一致）；③ 页面网络层无任何 POST /api/compute/highlight；④ <2MB 的 sample.js 同策略显示「tree-sitter · 执行: 远程」，证明 remote 通道正常、差异确由 2MB 大小阈值触发；⑤ 服务端 curl 实测可高亮该文件（200、17,394,967B intervals，时延 1.29~1.43s），二次仅快约 7.6~8% 且顺序间有波动，响应体无缓存相关字段（证据 cmp02-3mb-local-hljs.png、cmp02-samplejs-remote2.png、cmp02-3mb-remote-localbar.png） | BUG-10 |
| CMP-03（partial） | 已连接服务器；策略 auto；备好 rust-fence.md（含 rust 围栏代码块的 markdown）、with-script.html、edge/langs 下 13 种语言文件（py/rs/go/c/cpp/java/ts/js/vue/yaml/toml/sql/sh） | ① auto 策略打开 rust-fence.md 读状态栏，并 eval 检查 pre code.className；② 打开 with-script.html 切「源码」视图读状态栏（渲染视图同查）；③ 遍历 13 种语言文件，记录「高亮引擎 · 执行位置」路由矩阵 | 期望（修复后验收判据）：auto 下 html 与含围栏 md 留在本地执行（带 injection 的语言留本地保二级高亮，偏差 #5 背景）。实测现状：① rust-fence.md 状态栏「渲染: 远程」（围栏仍由本地 hljs 着色：language-rust hljs + 8 span，二级高亮保留）；② with-script.html 渲染/源码视图状态栏均无高亮/执行段（源码完整着色不白屏）；③ 13 语言路由矩阵稳定：py/ts/yaml/toml/sh→tree-sitter·远程，rs/go/c/cpp/java/js/vue/sql→hljs 兜底·本地（证据 cmp03-html-source-view.png；复核截图 cmp03-01~05 逐字一致） | BUG-22 |
| CMP-04（pass） | 已连接服务器；备好服务端高亮会失败的文件——本轮实测 php 与 .ex 样例触发 /api/compute/highlight 400（报告未记录 400 成因）；策略可切换 | ① 策略 auto 打开 php 文件，网络面板观察 POST /api/compute/highlight 响应码与页面渲染结果；② 策略切「计算: 远程」重开同文件；③ 策略 auto 打开 .ex 文件同查 | ① auto 下服务端 400 后真实回退本地渲染，内容可读不白屏（网络层捕获 400→本地兜底）；② remote 下显示错误卡片「远程高亮失败: HTTP 400」；③ 同 ①（证据 cmp04-php-auto.png、cmp04-php-remote.png、cmp04-ex-auto.png） | — |
| CMP-05（pass） | 已连接服务器；samples/m6/sample-gfm.md（GFM 样例；数学内容远程渲染与本地一致性属偏差 #6 已裁决范围，本轮对照样例不含数学） | ① 「计算: 远程」打开 sample-gfm.md，抓渲染 DOM 指纹；② 「计算: 本地」重开，同法抓指纹；③ `curl` POST /api/compute/markdown 提交同文档，核对服务端 GFM 输出 | ①② remote/local 两次渲染 DOM 指纹一致；③ 服务端 comrak GFM 输出验证正确（证据 cmp05-gfm-remote.png、cmp05-gfm-local.png） | — |
| CMP-06（partial） | 已连接服务器；备好 tall-hit.txt（801 行，第 751 行第 1 列含关键词 treasure；行数以复核实测 801 行为准，报告原写 800）与含关键词 inner 的文件（如 samples/m5/sub/inner.txt） | ① Ctrl+Shift+F 搜 inner，检查结果按文件分组；② 搜 treasure，点击 tall-hit.txt 的「751:1」命中行；③ 立即抓取并等 2.5s 后再抓：视口首行行号、751 行是否在视口、已渲染行 .vv-code-line 的 className 与背景色、.vv-search-hit-line 数量（find click 与 JS click 两种点击变体各做）；④ 按 `/` 在该文件内搜 treasure，对照定位与高亮表现 | 期望（修复后验收判据）：结果按文件分组；点击后打开该文件并滚动到命中行高亮（仓库样例 sample-gfm.md 自标「搜索命中行定位（P2）」）。实测现状：①② 分组与打开均正常（`<mark>` 预览高亮、按文件分组）；③ 点击后视口停在 1-2 行、751 行不在视口、所有已渲染行 className 仅 vv-code-line、背景透明、.vv-search-hit-line 数量 0（各变体均复现）；POST /api/search 已返回 line/col（按钮标签 751:1）但点击未使用；④ 对照文件内搜索定位到位且 751 行带 vv-search-hit-line（rgba(255,213,0,0.18)），证明滚动定位+高亮能力存在而全局跳转未接入（证据 cmp06-click-jump.png、cmp06-tall-no-scroll.png、cmp06-contrast-infile-highlight.png、cmp06-after-close.png） | BUG-09 |
| CMP-07（partial） | 已连接服务器；数据中含大小写混合的 hello 关键词分布（本轮口径：不敏感 20 处命中、敏感 7 行跨 .ex/.js/.txt/.md，其中 case-test.txt 含 2 行小写命中，见 4.2）；API 可 curl | ① Ctrl+Shift+F 面板 snapshot 枚举全部控件；② 搜 hello 记录基线命中数，开 Aa 大小写开关再搜，开 .* 正则开关验证正则查询；③ 依次尝试 'hello glob:*.txt'、'*.txt hello'、'hello\|*.txt' 三种 glob 前缀语法；④ 全页扫描控件（复核口径 51 个）找 glob/筛选入口；⑤ `curl` POST /api/search 带/不带 glob 参数对照 | 期望（修复后验收判据）：启用 glob 限定（如 *.txt）后结果随参数正确过滤。实测现状：② 基线 20 命中、Aa 开关 20→7、.* 正则开关正常 ✓；③ 三种语法均「无结果」（按字面量处理）；④ 面板仅输入框+Aa+.*+关闭按钮，全页无任何 glob/筛选入口；⑤ API 层 glob 真实有效——带 glob 仅返回 case-test.txt 两行小写命中，去掉 glob 返回 7 行跨 .ex/.js/.txt/.md（证据 cmp07-regex-on.png）。注：设计规格将 glob 定位为 /api/search 的 API 参数，UI 仅承诺面板打开+分组+跳转，未承诺 glob 控件（此为仲裁降 low 的依据） | BUG-21 |
| CMP-08（pass） | 已连接服务器；数据集中已构造总命中数 >1000 的文件组（构造见 4.2） | ① Ctrl+Shift+F 搜索高频关键词，等待至终态；② 读命中计数与提示文案；③ 网络面板观察 /api/search NDJSON 流终帧 | ① 命中止于 1000 并提示「1000 个命中（结果不完整，已达上限）」；② NDJSON 流以 truncated 终帧收尾（证据 cmp08-truncated.png） | — |
| CMP-09（pass） | 以无 ripgrep 的 PATH 启动独立实例（本轮 8394：PATH 剔除 rg 后启动，同实例另承担 tmpfs root 验证）；浏览器连接该实例 | ① `curl` 直打该实例 /api/search，记录状态码与报错；② 前端 Ctrl+Shift+F 发起搜索，观察提示文案与结果来源 | ① /api/search 返回 501 明确报错（服务器 ripgrep 不可用）；② 前端降级为浏览器内本地搜索并提示「服务器 ripgrep 不可用，已改用浏览器内搜索」，结果仍可用（证据 cmp09-fallback-norg.png） | — |
| CMP-10（pass） | 纯前端环境：静态服务器（`python3 http.server` 等）提供 build 产物、无任何 /api 后端（本轮 8395 通道）；本地文件夹含若干文本文件、至少 1 个 >2MB 文件与 1 个二进制文件；headless 无法驱动原生 picker，须经 `window.__vvOpenDirImpl`（项目 e2e 调试钩子，与真实 input change 同路径）注入 | ① 浏览器打开纯前端页（网络面板确认全程零 /api/ 请求）；② 经钩子/OPFS stub 打开本地文件夹；③ Ctrl+Shift+F 搜索文件夹内关键词；④ 检查命中分组、<2MB 上限与二进制文件过滤 | ② OPFS stub 打开成功；③ 命中按文件分组展示；④ 超 2MB 文件与二进制文件被过滤、不进搜索（证据 cmp10-pureweb-search.png：5 命中按文件分组、过滤 ✓） | — |
| CMP-11（partial） | 同 CMP-10 纯前端环境；本地文件夹已写入 bulk2/ 共 2050 个文件、其中 41 个含关键词 bulkword（须保证第 2001 个含关键词文件存在，用于验证截断止点，见 4.2） | ① Ctrl+Shift+F 搜 bulkword，轮询至终态；② 核对命中清单止点与全部提示文案；③ 观察搜索全程状态栏文案变化（含扫描起始阶段） | 期望（修复后验收判据）：提示超限（truncated）并建议改用服务器模式（spec L257）。实测现状：② 2000 文件扫描上限与截断提示正常生效——「40 个命中（结果不完整，已达上限）」恰止于第 2000 个文件、第 2001 个含关键词文件缺席，但全程无任何服务器/切换后端引导文案；③ 附带发现：状态栏从「已扫描 2 个文件…」起即过早携带上次搜索遗留的「（结果不完整，已达上限）」（证据 cmp11-final-truncated.png；复核截图 cmp11-verify-06-final-truncated.png） | BUG-11 |
| CMP-12（pass） | 已连接服务器（rg 可用实例） | ① 发起全局搜索并在进行中取消；② 连续重发多次搜索；③ 检查网络面板全部 POST /api/search 的状态与 console 报错；④ 服务器侧检查 rg 进程残留 | 全部 POST /api/search 返回 200、无 canceled/failed 请求堆积、无 rg 进程残留（报告为间接验证口径） | — |

## 3. 关联缺陷的验收行为

每条：缺陷现状（引用报告证据）→ 修复后应有行为（作为回归验收依据）。

### BUG-09【medium · verified】全局搜索点击命中行仅打开文件，不滚动定位、无任何命中行高亮

- **涉及测试点**：CMP-06（partial）。复核会话 vv-verify-compute-global-search-CMP-06 独立复现，截图 `.temp/e2e-artifacts/compute-global-search/` 01~06。
- **缺陷现状**（报告 §5 BUG-09）：Ctrl+Shift+F 搜 treasure 点击 tall-hit.txt 的 751:1 命中行后，分组与打开均正常（`<mark>` 预览高亮、按文件分组），但视口停在 1-2 行、751 行不在视口、所有已渲染行 className 仅 vv-code-line、背景透明、.vv-search-hit-line 数量 0（立即抓取+等 2.5s、find click 与 JS click 变体均复现）；POST /api/search 已返回 line/col（按钮标签 751:1）但点击未使用。对照文件内搜索 `/` 则定位到位且 751 行带 vv-search-hit-line（rgba(255,213,0,0.18)），证明滚动定位+高亮能力存在而全局跳转未接入。复核纠正两点：`.vv-viewer-scroll` 为虚拟渲染容器（scrollHeight==clientHeight==473）scrollTop 恒 0，不构成独立证据，改以「视口显示哪些行」判定；文件实为 801 行（报告写 800）。仓库样例 sample-gfm.md 自标「搜索命中行定位（P2）」。仲裁：medium 与仓库自标 P2 一致（功能不符但可绕过：文件内搜索可定位、手动滚动可达）；与 BUG-18 不同根因。
- **修复后应有行为**（回归验收）：
  1. 点击全局搜索命中行（如 tall-hit.txt 751:1）后，目标文件打开且视口滚动至命中行（以「视口显示哪些行」判定，见 4.3 边界 6——虚拟容器 scrollTop 恒 0，不可作判据）；
  2. 命中行带 .vv-search-hit-line 高亮（对照现状文件内搜索的 rgba(255,213,0,0.18) 行级背景口径）；
  3. 点击后等 2.5s 再抓，定位与高亮均不丢失（沿用报告两种点击变体与延时抓取口径）；
  4. 回归不破坏：结果按文件分组、`<mark>` 预览高亮、点击打开文件（现状已 ✓ 的部分），以及文件内搜索 `/` 的定位与高亮（已 ✓）不得退化。

### BUG-10【medium · verified】显式 remote 策略下 >2MB 文件仍被本地阈值压制为 hljs 分块，状态栏不显示远程执行，缓存加速可忽略

- **涉及测试点**：CMP-02（partial）。复核会话 vv-verify-compute-global-search-CMP-02 独立复现（size_download 恒 17,394,967B 与报告逐字节一致）；截图 cmp02-3mb-remote-localbar.png 等。
- **缺陷现状**（报告 §5 BUG-10）：「计算: 远程」策略下打开 code-3mb.js（3,378,599B），状态栏恒为「高亮: hljs 分块 · 执行: 本地」（复核 2 次、报告 3 次一致），页面网络层无任何 POST /api/compute/highlight；<2MB 的 sample.js 同策略显示「tree-sitter · 执行: 远程」，证明 remote 通道正常、差异确由大小阈值触发。服务端 curl 实测可高亮该文件（200、17,394,967B intervals，时延 1.29~1.43s），二次仅快约 7.6~8% 且顺序间有波动，响应体无缓存相关字段，17MB 传输即 intervals 本体。仲裁：medium（本地 hljs 分块着色完整无损、服务端接口可用，可绕过，非崩溃/错误结果）；与 BUG-06 不同根因——本条是 >2MB 阈值压过显式策略，BUG-06 是本地 wasm 主路径零消费。
- **修复后应有行为**（回归验收）：
  1. 「计算: 远程」下打开 code-3mb.js（3,378,599B），状态栏显示远程执行，网络面板出现 POST /api/compute/highlight（现状为零）；
  2. 同文件关标签重开，二次打开可观测地更快（报告期望缓存键 (path,mtime,size)；现状响应体无缓存相关字段、二次仅快 7.6~8% 且有波动）；
  3. 回归不破坏：<2MB 文件 remote 表现（sample.js「tree-sitter · 执行: 远程」，已 ✓）与 >2MB 文件本地 hljs 分块的着色完整性（现状无损失）不得退化；
  4. 修复不要求本地 wasm 主路径恢复（那是 BUG-06 的范围），两缺陷验收互不替代。

### BUG-11【medium · verified】纯前端搜索超 2000 文件上限只提示「结果不完整，已达上限」，无 spec 要求的「建议改用服务器模式」引导

- **涉及测试点**：CMP-11（partial）。复核独立重建纯前端环境（python3 -m http.server 提供 build 产物、全程零 /api/ 请求），经 `window.__vvOpenDirImpl`（项目 e2e 调试钩子，与真实 input change 同路径）注入同一 2050 文件夹复现；截图 cmp11-verify-06-final-truncated.png。
- **缺陷现状**（报告 §5 BUG-11）：纯前端页向本地文件夹写入 bulk2/ 共 2050 个文件（41 个含 bulkword），Ctrl+Shift+F 搜 bulkword：2000 文件扫描上限与截断提示正常生效（「40 个命中（结果不完整，已达上限）」恰止于第 2000 个文件、第 2001 个含关键词文件缺席），但全程无任何服务器/切换后端引导文案。附带发现：状态栏从「已扫描 2 个文件…」起即过早携带上次搜索遗留的「（结果不完整，已达上限）」。仲裁：medium（设计规定的超限引导功能性缺失，但截断提示本身正常、可经 TopBar「连接服务器」手动绕过）；200MB 上限路径报告与复核均未覆盖。
- **修复后应有行为**（回归验收）：
  1. 超 2000 文件的截断提示保留且止点正确（现状已 ✓：「40 个命中（结果不完整，已达上限）」恰止于第 2000 个文件、第 2001 个含关键词文件缺席）；
  2. 终态提示增加「建议改用服务器模式」类引导（spec L257）；
  3. 附带发现的回归点：新一轮搜索开始后状态栏不再携带上轮遗留的「（结果不完整，已达上限）」（扫描进度阶段如「已扫描 2 个文件…」时不应出现截断字样）；
  4. 回归不破坏：2000 文件上限本身、命中清单止点与 truncated 终态（已 ✓ 部分）。

### BUG-21【low · verified】全局搜索 glob 限定无任何 UI 入口（前缀语法均按字面量处理），仅 API 层支持

- **涉及测试点**：CMP-07（partial）。复核会话 vv-verify-compute-global-search-CMP-07 独立复现全部数值；截图 01~06。
- **缺陷现状**（报告 §5 BUG-21）：Ctrl+Shift+F 面板仅输入框+Aa+.*+关闭按钮，全页 51 个控件扫描无任何 glob/筛选入口；'hello glob:*.txt'、'*.txt hello'、'hello|*.txt' 三种语法均「无结果」（按字面量处理）；Aa 开关（20→7）与 .* 正则开关正常。API 层 glob 真实有效：带 glob 仅返回 case-test.txt 两行小写命中，去掉 glob 返回 7 行跨 .ex/.js/.txt/.md。文档核对：设计规格将 glob 定位为 /api/search 的 API 参数，UI 仅承诺面板打开+分组+跳转，未承诺 glob 控件。仲裁：复核原判 medium，因 actual 与现行设计吻合（测试期望超前于规格），按标尺与低估原则降 low（体验缺失，可经 API 绕过，无错误结果）。
- **修复后应有行为**（回归验收）：
  1. 修复前先对齐规格口径（仲裁降 low 的依据正是现行设计未对 UI 承诺 glob 控件）；
  2. 若按报告原始期望补齐 UI：全局搜索面板提供 glob 限定入口（如 *.txt），启用后结果随参数正确过滤——以 API 已验证口径核对（glob=*.txt 时仅返回 case-test.txt 两行小写命中）；
  3. 无论是否补 UI，均不得以「无结果」误导用户：glob 前缀语法若不支持，应给出可理解反馈而非按字面量静默查空；
  4. 回归不破坏：Aa 大小写开关（20→7）与 .* 正则开关（现状已 ✓）、/api/search 的 glob 参数（已 ✓）。

### BUG-22【low · verified】auto 策略执行位置指示不符期望路由：md 文档级渲染显示「渲染: 远程」、html 渲染/源码视图无执行位置段

- **涉及测试点**：CMP-03（partial）。复核会话 vv-verify-compute-global-search-CMP-03 独立复现逐字一致（cmp03-01~05）。
- **缺陷现状**（报告 §5 BUG-22）：auto 策略下 rust-fence.md 状态栏「渲染: 远程」（围栏仍由本地 hljs 着色：language-rust hljs + 8 span，二级高亮保留）；with-script.html 渲染/源码视图状态栏均无高亮/执行段（源码完整着色不白屏）；13 语言路由矩阵稳定：py/ts/yaml/toml/sh→tree-sitter·远程，rs/go/c/cpp/java/js/vue/sql→hljs 兜底·本地。期望为 auto 下 html 与含围栏 md 留在本地执行（带 injection 的语言留本地保二级高亮）。仲裁：报告 suggested low、复核升 medium，仲裁低估取 low（纯状态栏指示文案与期望路由不符、渲染与着色功能无损、无错误结果，可手动切「计算: 本地」绕过）。
- **修复后应有行为**（回归验收）：
  1. auto 策略下含围栏 md 的执行位置指示与期望路由一致（html 与含围栏 md 留本地执行，偏差 #5 口径），不再显示「渲染: 远程」；
  2. html 渲染/源码视图的状态栏按统一口径显示执行位置段（现状为完全缺失）；
  3. 回归不破坏：rust 围栏本地 hljs 二级高亮（language-rust hljs + 8 span）、html 源码完整着色不白屏、13 语言路由矩阵（现状已 ✓ 的路由结果本身不得回归）、可手动切「计算: 本地」的绕过能力。

## 4. 测试数据与边界

### 4.1 运行形态（报告 §2.1、§2.2）

- 主服务：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；`/api/health` 返回 `capabilities=["file-server","compute"]`；ripgrep 在 PATH（`/usr/sbin/rg`）。
- 前置：测试前执行 `pnpm gen:grammars`（偏差 #10 强制前置；34 项语法 manifest 写入 `apps/web/static/grammars/`，远程 tree-sitter 高亮依赖该资产）。
- 辅助实例：8394（无 rg 环境，CMP-09；同实例承担 tmpfs root 验证）、8395 通道（纯前端 `python3 http.server` 提供 build 产物，CMP-10/11）、8397（无 `--compute`，capabilities 对照）。
- 截图目录：`.temp/e2e-artifacts/compute-global-search/`（20 张）；复核截图在 `.temp/e2e-artifacts/verify/`。

### 4.2 本域输入数据清单

| 数据 | 用于场景 | 构造/来源（均出自报告） |
| --- | --- | --- |
| code-3mb.js（3,378,599B） | CMP-02 | 测试期间另造的大体积 JS 样例（报告实测字节数；各域另造样例存于 `.temp/e2e-data/domain-<域名>/`）；构造目标：单文件 JS 代码超过 2MB 本地阈值 |
| samples/m5/sample.js | CMP-02 对照 | 基础数据集 m5 自带（<2MB） |
| rust-fence.md | CMP-03 | 含 rust 围栏代码块的 markdown（报告以「rust 围栏」件实测 BUG-22） |
| with-script.html | CMP-03 | 基础数据集 HTML/MD 3 件之一（内联+外链 script，报告 §2.3） |
| edge/langs 13 种语言文件 | CMP-03 | py/rs/go/c/cpp/java/ts/js/vue/yaml/toml/sql/sh（报告 §2.3 语言 13 种；BUG-22 以 edge/langs 目录实测） |
| php 文件、.ex 文件 | CMP-04 | 实测触发 /api/compute/highlight 400 的样例（报告未记录 400 成因，仅证实此两类样例触发） |
| samples/m6/sample-gfm.md | CMP-05 | 基础数据集 m6（GFM 样例；不含数学内容，数学一致性属偏差 #6 已裁决范围） |
| tall-hit.txt（801 行） | CMP-06 | 长文本文件 800+ 行，第 751 行第 1 列放关键词 treasure；行数以复核实测 801 行为准（报告原写 800，微小出入） |
| 含 inner 的文件组 | CMP-06 分组检查 | 基础数据集自带（如 samples/m5/sub/inner.txt；Playwright m6 组同以 inner 验证命中 sub/inner.txt 并打开） |
| hello 关键词分布（.ex/.js/.txt/.md） | CMP-07 | 按报告实测数字目标放置：大小写不敏感共 20 处命中、敏感 7 行（跨 .ex/.js/.txt/.md），其中 case-test.txt 含 2 行小写 hello（glob=*.txt 时的唯一返回） |
| >1000 命中文件组 | CMP-08 | 程序化生成足够多含同一关键词行的文本文件使总命中 >1000（报告未记录本轮样例的具体文件构成，仅记录提示口径「1000 个命中」与 NDJSON truncated 终帧） |
| bulk2/（2050 个文件） | CMP-11 | 程序化写入 2050 个小文件、其中 41 个含 bulkword；须保证第 2001 个文件含关键词以验证截断止点（复核重建同口径） |
| 本地文件夹（OPFS 注入） | CMP-10、CMP-11 | headless 无法驱动原生 picker，经 `window.__vvOpenDirImpl`（项目 e2e 调试钩子，与真实 input change 同路径）注入；CMP-10 文件夹另需 ≥1 个 >2MB 文件与 ≥1 个二进制文件验证过滤 |

### 4.3 边界与环境限制（报告 §2.4、§3.1、§5、§6、§7.1）

1. **rg 可用性决定搜索分支**：主实例 rg 在 PATH（/usr/sbin/rg）走远程搜索；无 rg 分支（501+前端降级）须以剔除 rg 的 PATH 单独起实例（本轮 8394）。CMP-09 仅在该分支验证。
2. **2MB 阈值是 remote 策略与本地分块的现役分界**（BUG-10）：>2MB 文件即使显式「计算: 远程」也被压制为本地 hljs 分块，<2MB 才走远程 tree-sitter；布置 CMP-02 数据与验收时按此口径。
3. **偏差 #5（服务端高亮无 injection）**：带注入的 6 种语言在 auto 策略下留在本地执行；仓库 Playwright 套件运行期间 WebServer 日志反复出现 `GET /queries/typescript/injections.scm`、`/queries/_typescript/injections.scm`、`/queries/prolog/injections.scm` 404——前端对带 injection 语言的 queries 资产探测落空，与该偏差背景一致（报告 §6 仅记录现象，未进一步定性）。
4. **偏差 #6（comrak 无数学扩展、无数学掩码）**：数学内容远程渲染与本地 KaTeX 可能不一致，属已裁决偏差；CMP-05 对照样例应避开数学内容（本轮即如此）。
5. **偏差 #9（col 口径）**：跨文件搜索结果列号（col）两端统一为 UTF-16 码元（实现约定记录）；涉及列号断言的场景按此口径。
6. **虚拟渲染容器判据**：`.vv-viewer-scroll` 为虚拟渲染容器，scrollHeight==clientHeight（实测均 473）、scrollTop 恒 0，不构成滚动/定位证据；CMP-06/BUG-09 验收须以「视口显示哪些行」判定（BUG-09 复核要点）。
7. **2000 文件上限与 200MB 累计上限**：本轮仅覆盖 2000 文件分支，200MB 分支未测（报告 §7.1 未覆盖项 6）；BUG-11 验收后应补测该分支。
8. **远程 tree-sitter 覆盖矩阵仅抽样少数语言**（py/ts/sh/rs/yaml/toml 等），34 项 grammar 资产的其余未逐一验证（报告 §7.1 未覆盖项 8）；CMP-03 路由矩阵的验收覆盖面以此为界。
9. **btrfs 主实例的状态栏干扰字样**：8391（btrfs 数据根）状态栏常驻「自动刷新不可用」（BUG-02 表征，SSE 建连时即出现）；观察「高亮/执行/渲染」指示时勿与之混淆。
10. **纯前端环境判定与注入通道**：CMP-10/11 须全程零 /api/ 请求；headless 下原生目录 picker 不可驱动，统一经 `window.__vvOpenDirImpl` 注入（与真实 input change 同路径，BUG-11 复核口径）。
11. **服务端高亮数值基准**：code-3mb.js 服务端高亮响应体 17,394,967B（即 intervals 本体）、时延 1.29~1.43s、二次仅快约 7.6~8%（BUG-10 复核实测）；回归验证缓存改造时先固定此基准再对比。
