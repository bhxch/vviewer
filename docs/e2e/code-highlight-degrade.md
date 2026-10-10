# 代码查看与高亮降级链（M2） — e2e 场景

> 来源：`docs/report/e2e/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`）。本文将该报告 code-highlight-degrade 域的测试内容忠实转写为可复现场景，不引入报告之外的行为。引用格式：「报告 §n」指该报告章节，「BUG-xx」指该报告第 5 节缺陷清单条目。

## 1. 域描述与覆盖范围

以下摘自报告 §4 功能完成度矩阵 code-highlight-degrade 行与 §8.2 附录明细。

**总体情况**（报告 §4）：11 个测试点，通过 5，缺陷 6（2 fail / 4 partial），受阻 0，域级评级 **部分实现**。报告备注：降级链下游扎实（hljs 兜底/分块零错位、25MB 虚拟滚动流畅行号正确、GB18030/UTF-16LE 解码正确、2MB 解析期 53fps）；但本地 tree-sitter wasm 主路径整链失效（零 .wasm 请求，BUG-06）与无扩展名文件直接拒绝预览（BUG-07）两条缺陷压低评级。failed=HL-01/05，partial=HL-04/06/07/10。

> 口径备注（报告 §4）：各域 results 字段统计与域 summary 口径有 ±1 出入（summary 曾按 4 pass / 5 partial / 2 fail 划分），报告裁决以字段值 5 pass 为准。

**逐点结果**（报告 §8.2，11 点：5 pass / 4 partial / 2 fail）：

| 编号 | 测试点 | 结果 | 简要证据（摘自报告） |
| --- | --- | --- | --- |
| HL-01 | tree-sitter 主路径（sample.rs） | fail | 自动/本地均 hljs 兜底、零 .wasm 请求、manifest abi 全 null；远程 98 个 ts-* span |
| HL-02 | hljs 兜底（sample.pl） | pass | 19 hljs-keyword / 共 50 hljs-* span、无错误卡片 |
| HL-03 | hljs 分块 3MB + 虚拟滚动正确性 | pass | 50%/75%/100% 三处零错位；minified-3mb 362,525 span 保持响应 |
| HL-04 | >20MB 超限 | partial | 25MB 纯文本滚到底 800ms、末行 403,299 正确；无超限文案（BUG-20） |
| HL-05 | shebang 语言识别 | fail | 无扩展名被「不支持的扩展名 "."」拒绝（BUG-07） |
| HL-06 | GB18030/UTF-8 编码 | partial | 中文渲染正常、X-VV-Encoding 正确；状态栏无编码（BUG-04） |
| HL-07 | UTF-16LE BOM | partial | BOM 消费正确（首字符码点 12298）；状态栏无编码（BUG-04） |
| HL-08 | 3MB 滚动到底再回顶 | pass | 末行 54237 与 wc -l 一致；四次折返无白屏 |
| HL-09 | 2MB 解析中切 tab | pass | 切换无报错、新文件正常渲染、无残留错误卡片 |
| HL-10 | rust/ts/bash 三语言 tree-sitter | partial | 远程三语言全过（rs98/ts87/sh23）；自动 rust 失败；零 wasm 请求（BUG-06） |
| HL-11 | 解析期间 UI 响应性 | pass | 解析期交互 1ms、rAF 实测 53fps 不冻结 |

**关联缺陷**（报告 §5，本域涉及的 4 条，均为 verified）：BUG-06（HL-01+HL-10 合并条目，另含 pwa 域 PWA-03）、BUG-07（HL-05 主体）、BUG-04（HL-06+HL-07 并入，另含 SHELL-12/SRV-05）、BUG-20（HL-04 单点）。

## 2. 场景清单

所有场景的公共环境（构造方式见第 4 节）：测试服务器以 `vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute` 启动（报告 §2.2），浏览器经 agent-browser 独立会话连接首页，测试前已执行 `pnpm gen:grammars` 生成 grammar 资产（报告 §2.4 偏差 #10 强制前置）。场景编号沿用报告测试点编号 HL-01~HL-11（报告编号齐全，无续编点）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| HL-01 | 连接服务器；网络面板过滤 `.wasm`；计算策略=「自动」 | ① 文件树打开 `samples/m2/sample.rs`，等待 ≥6.5s（复核等待时长）；② 读状态栏高亮段文案，统计预览容器内 `ts-*` 与 `hljs-*` 类名 span 数；③ 查 network 中 `.wasm` 请求条目；④ `curl -s /grammars/manifest.json` 检查各条目 `abi` 字段；⑤ 切「本地」策略，经另一文件中转后（重开已打开文件不触发重载）重复②③；⑥ 切「远程」策略对照打开，重复② | 「自动」「本地」策略下 sample.rs 经本地 tree-sitter 高亮：状态栏引擎段非「hljs 兜底」、出现 `ts-*` span（远程对照实测 98 个）、network 出现 grammar `.wasm` 请求；manifest `abi` 字段非 null | BUG-06（现状 fail：自动/本地均降级 hljs 兜底、零 .wasm 请求、abi 全 null） |
| HL-02 | 连接服务器 | ① 打开 `samples/m2/sample.pl`；② 统计 `hljs-keyword` span 数与全部 `hljs-*` span 数；③ 检查页面无错误卡片/提示浮层 | perl 代码由 hljs 着色：`hljs-keyword` span=19、`hljs-*` span 共 50；无错误卡片 | — |
| HL-03 | 连接服务器；数据集含 minified-3mb.js（3,145,753B 单行） | ① 打开 minified-3mb.js；② 分别滚动至内容 50%、75%、100% 三个位置，将各处渲染文本与源文件对应位置比对；③ 统计 DOM span 总量并测试滚动/交互响应 | 三个位置渲染内容零错位（不重复、不丢行、与源文件一致）；36 万量级 span（实测 362,525）下页面保持响应 | — |
| HL-04 | 连接服务器；数据集含 big-25mb.txt（26,214,435B） | ① 打开 big-25mb.txt；② 在打开后 1.2s、2 分钟、切走再重开 1.3s 三个时点检索全文有无「超限/上限/20MB/过大」类文案，并清点 toast/banner/alert 类元素；③ 滚动条一步到底，读 scrollTop 与末行行号；④ `curl` 查 `/api/tree` 该文件 `size` 字段 | 纯文本虚拟滚动渲染：一步到底无卡死（实测 8,065,527px、约 800ms）、末行行号 403,299 与字节数吻合，**且出现明确超限提示**（报告转述 spec L175「纯文本虚拟滚动+提示」；`/api/tree` 已下发 size，前端可得知超限） | BUG-20（现状 partial：渲染/滚动/行号全过，三时点零超限文案、浮层为 0） |
| HL-05 | 连接服务器；数据集含无扩展名文件 shebang-py（190B，首行 `#!/usr/bin/env python3`，file(1) 识别为 Python script）及同内容副本 shebang-py-verify.py | ① 文件树点击 shebang-py；② 观察渲染结果与任何错误提示；③ 对照打开 shebang-py-verify.py；④ `curl -I`（或 `-sD -`）对照两文件 `/api/file` 响应头中的 `x-vv-lang` | shebang-py 不再被拒绝：经 shebang 检测识别为 python 并按 python 语法高亮预览（报告转述：对齐 helix Loader），不出现「不支持的扩展名 "."」错误页；.py 对照件正常渲染 | BUG-07（现状 fail：直接渲染错误页「无法预览此文件 / 不支持的扩展名 "."」，语言识别未发生即被扩展名派发拦截；对照组正常且服务端仅对 .py 返回 `x-vv-lang: python`） |
| HL-06 | 连接服务器；数据集含 gb18030.txt 与 UTF-8 中文文件 | ① 打开 gb18030.txt，检查中文字符渲染无乱码；② `curl` 该文件 `/api/file` 响应头读 `x-vv-encoding`；③ 打开 UTF-8 中文件重复①②；④ 读取状态栏查找编码字段 | 两种编码下中文渲染正常；`x-vv-encoding` 分别正确返回 `gb18030`/`utf-8`；状态栏显示编码且与响应头一致 | BUG-04（现状 partial：渲染与响应头均正确，状态栏无编码字段） |
| HL-07 | 连接服务器；数据集含 UTF-16LE（带 BOM）中文文件 | ① 打开该文件；② 读取首个渲染字符的码点，断言 BOM 已被消费（实测首字符码点 12298）；③ `curl` 读 `x-vv-encoding`；④ 读取状态栏查找编码字段 | BOM 消费正确（首字符码点 12298）、正文解码无乱码；`x-vv-encoding` 正确返回 `utf-16le`；状态栏显示编码 | BUG-04（现状 partial：BOM 消费与解码正确，状态栏无编码字段） |
| HL-08 | 连接服务器；数据集含 3MB 长文本（先 `wc -l` 确认行数，实测 54,237 行） | ① 打开 3MB 长文本；② 滚动到底读取末行行号；③ 与 `wc -l` 结果比对；④ 连续四次「到底↔回顶」折返，每次观察是否出现白屏 | 末行行号 54,237 与 `wc -l` 一致；四次折返均即时渲染、无白屏 | — |
| HL-09 | 连接服务器；数据集含约 2MB 文件（域内 1.9MB JS）与任一第二文件 | ① 发起打开约 2MB 文件，在解析未完成时立即点击另一文件；② 观察是否出现报错；③ 确认新文件正常渲染；④ 切回大文件 tab 检查有无残留错误卡片 | 切换无报错；新文件正常渲染；无残留错误卡片 | — |
| HL-10 | 连接服务器；数据集含 sample.rs、sample.ts 与 bash 脚本（报告证据名为 deploy.sh） | ① 计算策略=「远程」，依次打开 sample.rs、sample.ts、deploy.sh，分别统计 `ts-*` span 数；② 切「自动」策略（经另一文件中转重载）打开 sample.rs，记录高亮引擎与 span；③ 全程检查 network 的 `.wasm` 请求条目 | 自动与远程策略下 rs/ts/sh 三语言均获 tree-sitter 高亮（远程实测 rs=98、ts=87、sh=23 个 `ts-*` span）；本地策略同样生效；出现 grammar `.wasm` 请求 | BUG-06（现状 partial：远程三语言全过；自动 rust 失败；两轮干净 pass 的 `.wasm` 请求均为 0，高亮全部由服务端 POST /api/compute/highlight 完成） |
| HL-11 | 连接服务器；数据集含约 2MB 文件 | ① 打开约 2MB 文件；② 解析期间执行点击/滚动等交互，页内 eval 计时测响应耗时；③ 以 rAF 计数统计解析期间帧率；④ 观察有无冻结 | 解析期间交互响应保持毫秒级（实测 1ms）；rAF 帧率不掉（实测 53fps）；不冻结 | — |

## 3. 关联缺陷的验收行为

以下 4 条均为报告 §5 中 verified 状态的缺陷。「缺陷现状」为报告证据摘要；「修复后应有行为」作为回归验收依据，仅由报告的期望字段与实测通过部分推导。

### BUG-06 本地 tree-sitter wasm 主路径完全失效（合并：HL-01 + HL-10 + PWA-03；medium · verified）

**缺陷现状**（报告 BUG-06，§5）：

- 自动与本地策略下打开 sample.rs 均降级「hljs 兜底 · 执行: 本地」（`ts-*` span=0、`hljs-*`=36，等待 6.5s 与硬刷新均复现）；全会话零 `.wasm` 网络请求、仅 manifest fetch；manifest 34 项 `abi` 字段全为 null（报告注：疑为本地引擎门控依据）。
- 仅「远程」策略经 POST /api/compute/highlight 获得 tree-sitter（rs=98 个 `ts-*` span）；HL-10 复核：两轮干净 pass 的 `.wasm` 请求均为 0，高亮全部由服务端完成，自动策略 rs 失败、ts=87/sh=23 远程正常。
- sw.js 声明的 `vv-grammars-*` 运行时缓存从未创建（打开 9 语言后 caches 仅 precache）；断网后 8 个 grammar wasm fetch 全部 `Failed to fetch`，离线打开代码文件降级 hljs 兜底，离线高亮承诺不成立。
- 复核操作要点：切策略后重开已打开文件不触发重载，需换文件中转。

**修复后应有行为**（回归验收，对应报告期望字段）：

1. 「自动」「本地」策略打开代码文件时按需 fetch grammar wasm（network 可见 `.wasm` 请求），状态栏高亮引擎段显示 tree-sitter（非「hljs 兜底」），预览出现 `ts-*` span。
2. grammar wasm 按 CacheFirst 写入 `vv-grammars-*` 运行时缓存（`caches.keys()` 可见），断网后打开代码文件仍为 tree-sitter 高亮。
3. `/grammars/manifest.json` 提供有效的引擎门控信息（现状 34 项 `abi` 全 null 为失效表征）。
4. 自动策略下 rs/ts/sh 路由正确（HL-10 现状中「自动 rust 失败」不再发生）。

### BUG-07 无扩展名文件被「不支持的扩展名 "."」直接拒绝预览，shebang 语言识别无从发生（HL-05 主体 + SHELL-03 无扩展名观察；medium · verified）

**缺陷现状**（报告 BUG-07，§5）：

- 文件树点击无扩展名文件 shebang-py（首行 `#!/usr/bin/env python3`，190B，file(1) 识别为 Python script）直接渲染错误页「无法预览此文件 / 不支持的扩展名 "."」，无任何代码渲染，语言识别未发生即被扩展名派发拦截。
- 同内容副本 shebang-py-verify.py 正常渲染；curl 对照证实服务端对 .py 返回 `x-vv-lang: python`、对无扩展名文件返回 200 完整正文但不带该头。
- app-shell-sources 域 SHELL-03 复核证实同一根因的通用表现：无扩展名 `Makefile` 与合成 drop 无扩展名 File 表现完全一致（同一「不支持的扩展名 "."」提示）。

**修复后应有行为**（回归验收，对应报告期望字段）：

1. 无扩展名文件（如 shebang-py）可进入代码预览，经 shebang 检测识别为 python 并按 python 语法高亮（报告转述：对齐 helix Loader）。
2. 不出现「不支持的扩展名 "."」错误页；`Makefile` 等无扩展名文件同不再被扩展名派发拦截。

### BUG-04 状态栏通用元数据（编码/语言/大小/行列）整体未实现——服务端检测头正确下发但 UI 不展示（合并：SHELL-12 + HL-06 + HL-07 + SRV-05；medium · verified）

**缺陷现状**（报告 BUG-04，§5；本域对应 HL-06/HL-07）：

- GB18030/UTF-8/UTF-16LE 文件中文渲染与解码均正确、`x-vv-encoding` 正确下发（Range 206 响应同样携带），但状态栏仅「高亮: … · 执行: … · 自动刷新不可用」，outerHTML 中编码/语言/大小/行列四字段均为 Svelte 条件占位 `<!---->` 未渲染；全页检索 gb18030/utf-16 零命中。
- 报告仲裁备注：检测正确、属信息性缺失；「引擎与执行位置」半项已实现（报告注：README:21 承诺范围）。

**修复后应有行为**（回归验收，对应报告期望字段，spec L290 转引自报告）：

1. 状态栏显示编码、语言、大小、行列；本域验收点：gb18030.txt、UTF-8 中文件、UTF-16LE 文件的状态栏编码值与 `x-vv-encoding` 响应头逐字一致。
2. 代码文件额外显示高亮引擎与执行位置（该半项现状已实现，回归时不得回退）。

### BUG-20 >20MB 纯文本降级虚拟滚动后无任何明确超限提示（HL-04 单点；low · verified）

**缺陷现状**（报告 BUG-20，§5）：

- 打开 big-25mb.txt 后渲染/滚动/行号全部正常（scrollTop 一步到底 8,065,527px 无卡死、末行行号 403,299 与字节数吻合），但打开后 1.2s、2 分钟、切走再重开 1.3s 三个时点全文均无「超限/上限/20MB/过大」类文案、浮层元素为 0，仅状态栏隐式显示「纯文本」。
- `/api/tree` 已返回 size=26214435（前端可得知超限但未提示）；`/api/file` Range 206 仅带 `x-vv-encoding` 无上限元数据。

**修复后应有行为**（回归验收，对应报告期望字段，spec L175「纯文本虚拟滚动+提示」转引自报告）：

1. >20MB 文件按纯文本虚拟滚动渲染的同时出现明确超限提示（文案/toast/banner 任一可观察形式），三个时点（刚打开、久置、重开）均可观察到。
2. 渲染性能与行号正确性不回退（滚到底无卡死、末行行号与字节数吻合）。

## 4. 测试数据与边界

### 4.1 资产生成前置（偏差 #10）

grammar wasm 资产不入库、构建期生成：测试前必须先执行 `pnpm gen:grammars`（报告 §2.1：本轮 34 个语法缓存全命中，manifest 34 项写入 `apps/web/static/grammars/`）。HL-01/HL-10 的 tree-sitter 主路径场景以此为强制前置。

### 4.2 服务器启动形态（报告 §2.2）

`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；`/api/health` 应返回 `capabilities=["file-server","compute"]`。证据根目录：`.temp/e2e-data/`（数据）、`.temp/e2e-artifacts/code-highlight-degrade/`（本域 16 张截图，报告 §3.1）。

### 4.3 数据清单

基础数据集位于 `.temp/e2e-data/`（报告 §2.3）；本域场景另造样例位于 `.temp/e2e-data/domain-code-highlight-degrade/`（报告 §2.3 末段：「25MB 文本、3MB 长文本×2、1.9MB JS、多语言中文编码件、shebang 无扩展名文件」等，均经 file(1) 等独立验证为合法格式）。报告未记录具体生成命令，重建时按下列规格核对。

| 文件 | 规格（报告实测值） | 来源 | 用于场景 |
| --- | --- | --- | --- |
| samples/m2/sample.rs / sample.ts / sample.pl | 基础样例（m2 三件代码） | 基础数据集 | HL-01/02/10 |
| minified-3mb.js | 3,145,753B 单行；hljs 分块后 362,525 span | 基础数据集（体积 4 件之一） | HL-03 |
| big-25mb.txt | 26,214,435B；末行行号 403,299 | 域内另造 | HL-04 |
| 3MB 长文本 | 54,237 行（与 wc -l 一致）；共 2 件 | 域内另造 | HL-08 |
| 约 2MB 文件 | 1.9MB JS | 域内另造 | HL-09/11 |
| shebang-py | 190B，首行 `#!/usr/bin/env python3`，file(1) 识别为 Python script | 域内另造 | HL-05 |
| shebang-py-verify.py | 与 shebang-py 同内容的 .py 副本（对照组） | 域内另造 | HL-05 |
| gb18030.txt | 中文内容，`x-vv-encoding: gb18030` | 基础数据集（编码 5 件之一） | HL-06 |
| UTF-8 中文文件 | `x-vv-encoding: utf-8` | 基础数据集（编码 5 件之一） | HL-06 |
| UTF-16LE（带 BOM）中文文件 | `x-vv-encoding: utf-16le`；BOM 消费后首字符码点 12298 | 基础数据集（编码 5 件之一） | HL-07 |
| deploy.sh | bash 脚本（报告证据名 HL10-deploy-sh-auto.png） | 报告未注明路径，重建时按 bash 语法文件放置 | HL-10 |
| big-20mb.txt（对照） | 21,027,496B，>20MB 上限行为对照件 | 基础数据集（体积 4 件之一） | HL-04 边界参考 |

### 4.4 边界与注意事项（报告 §3.3 与复核要点，如实转写）

1. **超大 DOM 禁用无障碍 snapshot**：对 36 万 span 超大 DOM 执行 agent-browser 无障碍 snapshot 曾两次致渲染进程无响应/CDP 超时（HL-03、THEME-06），判定为测试工具 AX 遍历副作用、不计应用缺陷；HL-03/HX 类断言改用页内 eval 完成。
2. **策略切换重载要点**（BUG-06 复核补充）：切策略后重开已打开文件不触发重载，需经换文件中转再打开目标文件。
3. **编码验证口径**：gb18030.txt 的 file(1) 会误报 ISO-8859（GB18030 常见现象），须用 python `decode('gb18030')` 回读验证内容；编码对照以服务端 `x-vv-encoding` 响应头为准（报告偏差 #3：仅下发 X-VV-Lang 与 X-VV-Encoding，无 X-VV-Type 头）。
4. **>20MB 阈值**：20MB 为纯文本降级虚拟滚动的上限阈值，big-20mb.txt（21,027,496B）为贴合阈值的对照件，big-25mb.txt 为降级链压力件。
5. **远程策略依赖 compute**：HL-10 远程对照依赖 `--compute` 实例与 POST /api/compute/highlight；无 compute 时该对照不可执行。

## 5. BUG-06 干净 profile 复测裁决记录（2026-10-09）

> 依据 spec `docs/superpowers/specs/2026-10-08-e2e-fixes.md` §2 BUG-06 方案 2（复测裁决）与 PWA-03 复测子问题执行。原始证据（逐语言 JSON、console 捕获、server 日志）存 `.temp/bug06-retest/`（result.json / probe2.json / server.log，gitignore 内不入库）。

**环境与方法**：工作区当前构建（`pnpm --filter web build`，含本批全部修复；`check-pwa-build` 硬断言过：precache 103 条含 index.html）+ `server/target/release/vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8477 --compute`（数据根 btrfs，与报告 8391 同型）；playwright-core 1.63 chromium 全新实例（launch 默认临时 user-data-dir，无历史 SW，即「干净 profile」）；upload 通道经 `__vvOpenDirImpl`（与真实 input change 同通道）。

### 5.1 HL-01 主路径判定：通过（报告缺陷态不复现，定性「陈旧 SW/环境状态」成立）

- `samples/m2/sample.rs` 本地策略：状态栏「高亮: tree-sitter · 执行: 本地」、`ts-*` span=100、hljs-*=0；network 出现 `/tree-sitter.wasm`、`/grammars/rust.wasm`、`/queries/rust/*.scm`。
- auto 策略同文件亦 tree-sitter（走本地 worker）；`caches.keys()` 出现 `vv-grammars-0.1.0-hryok`（11 条）与 `vv-queries-*`（12 条）——sw.js 运行时缓存路由真实创建（BUG-15 修复后）。
- 报告的「自动/本地均 hljs 兜底、零 .wasm 请求」在干净 profile 下**不可复现**；结合 BUG-15 根因（残缺 SW 静默吞全部路由），报告主体定性为陈旧 SW/环境状态。

### 5.2 PWA-03 子问题 1：在线逐语言覆盖矩阵（12 语言，报告口径为 9 语言 4/9）

| 文件 | 状态栏高亮段 | ts-*/hljs-* span | 判定 |
| --- | --- | --- | --- |
| hello.py | tree-sitter · 远程 | 35/0 | ✓（compute 路由） |
| lib.rs | tree-sitter · 本地 | 53/0 | ✓ |
| main.go | tree-sitter · 本地 | 8/0 | ✓ |
| app.js | tree-sitter · 本地 | 48/0 | ✓ |
| app.ts | tree-sitter · 远程 | 33/0 | ✓ |
| app.toml | tree-sitter · 远程 | 25/0 | ✓ |
| config.yaml | tree-sitter · 远程 | 17/0 | ✓ |
| deploy.sh | tree-sitter · 远程 | 23/0 | ✓ |
| main.c | tree-sitter · 本地 | 21/0 | ✓ |
| main.cpp | tree-sitter · 本地 | 33/0 | ✓ |
| query.sql | hljs 兜底 · 本地 | 0/20 | 合法兜底（34 项 manifest 无 sql grammar） |
| Main.java | hljs 兜底 · 本地 | 0/9 | **真实缺口**（见 5.4） |

「在线仅 4/9」不再存在：10/12 真 tree-sitter；排除无 grammar 的 sql 后为 10/11，唯一缺口是 java。

### 5.3 PWA-03 子问题 2：upload 通道与离线

- upload（本地 store，auto 策略）：`lib.rs` → tree-sitter 本地（ts=19）✓；`hello.py` → **hljs 兜底（ts=0）**——python.wasm 与 queries/python/*.scm 均 HTTP 200 拉取成功后仍静默回退（~450ms，无 console 错误），对照同会话 `tiny.c` → tree-sitter 本地 ✓。**upload 缺口仍在（python）**。
- 离线（SW activated + 缓存预热后断网，打开未开过的本地文件）：`cold.rs` → tree-sitter 本地（ts=15）✓，离线高亮承诺对 rust 成立；`probe_offline.py` → hljs 兜底——与 python 本地路径缺口同源，非离线/缓存问题。

### 5.4 裁决与后续

1. **BUG-06 不据此整体关闭**（spec 明文）：真实 grammar/queries 覆盖缺口仍在，另行立项，范围——
   - 客户端本地 worker 对 python/java 的 grammar 加载静默失败（资产 200 仍回退 hljs，且无错误上报——BUG-06 可观测性修复只覆盖 worker 脚本加载失败，未覆盖单 grammar 加载失败路径，需一并补上报）；
   - 服务端 compute 内嵌语言集 14 种（`server/src/compute/queries.rs:41-54`，无 java）与客户端 34 项 manifest 不对齐：java 在线走 compute 得 HTTP 400「无可用 grammar 或查询」如实回退本地，而本地路径同样不可用 → java 无任何 tree-sitter 路径。
2. 报告「主路径整链失效」主体（sample.rs 零 wasm/全兜底、vv-grammars 缓存永不创建）按环境定性收口：根因为 BUG-15 残缺 SW，两修复已落地并以 `apps/web/e2e/fix-pwa.spec.ts` 护栏。
3. `docs/deploy.md` 已按 spec 注记「升级部署后需硬刷新/清站点数据」（残缺 SW 的用户侧成因与对策）。

## 6. 阶段 4 三态降级链更新（2026-10-10）

> 第 1-5 节为 M2 报告转写，按历史口径保留不改动。阶段 4 统一懒高亮（spec
> `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md` §5）重写了本域
> 降级链模型：按字节三态，`'hljs-block'`（状态栏「高亮: hljs 分块」）退役，
> HL-03/HL-04 现状反转。本节记录新模型语义与现役护栏位置。

### 6.1 三态降级链（`resolveStrategy`，字节阈值）

| 字节区间 | 策略 | 行为 |
| --- | --- | --- |
| ≤2MiB（`TREE_SITTER_MAX_BYTES`） | `tree-sitter` | 整文件一次解析（失败 → hljs 整文件兜底），首屏路径不变 |
| ≤200MiB（`PLAIN_MAX_BYTES`） | `lazy` | 可视区驱动 chunk 懒高亮：chunk 按 200 行对齐 + overscan/重叠 2 行裕量；来源选择 服务端 range 路由（auto 宣告门 null → 该 chunk 行级 hljs，不回落本地 wasm）→ 本地 worker chunk → 行级 hljs 兜底；chunk 级失败（超时/413/网络）只降该 chunk，切 tab 取消只逐出在-flight、不落 hljs 兜底 |
| >200MiB | `plain` | 纯文本虚拟滚动 + 提示条 |

- **HL-04 现状反转（BUG-20 修复落地）**：>20MiB 不再落纯文本——虚拟滚动 + 懒高亮
  兜底，打开后出现一次性「可视区懒高亮」提示条（轻量不阻断）；「纯文本虚拟滚动」
  提示只属于 >200MiB。
- **状态栏口径**：行级兜底显示「高亮: hljs 兜底 · 执行: 本地」；「高亮: hljs 分块」
  不再产出（`'hljs-block'` 类型值仅为状态栏兼容保留于 `CodeEngine`）。
- **缓存**：`chunkCache`/`hljsChunkCache` 双缓存，chunk 粒度逐出
  （`CHUNK_CACHE_MAX_LINES=5000`，原 hljs-block 的 5000 行等价预算）。

### 6.2 对第 2 节场景的现时语义

| 场景 | M2 口径（第 2 节） | 阶段 4 现时语义 |
| --- | --- | --- |
| HL-03（3MB） | 「hljs 分块」+ 三处零错位 | lazy chunk（tree-sitter），零错位断言沿用；「hljs 分块」文案断言退役 |
| HL-04（25MB） | 纯文本虚拟滚动、无超限提示（BUG-20 partial） | 懒高亮 + 「可视区懒高亮」提示条（BUG-20 修复，断言反转） |
| HL-09（切 tab 取消） | 1.9MB 整文件解析期取消 | 载体改 3.0MB 走 lazy chunk：cancelAll 取消只逐出在-flight、切回后 hljs- span 为 0（不落兜底） |
| HL-11（1.9MB 响应性） | 解析期 rAF 53fps | 不变（≤2MiB 仍整文件路径） |

### 6.3 现役护栏与性能锚点

- 护栏：`apps/web/e2e/b-code-highlight-degrade.spec.ts`——BUG-20 反转（>20MB .js
  载体）、HL-03（3MB chunk 零错位）、HL-09（切 tab 取消不落兜底）、PERF-LAZY
  （25MB：首屏纯文本 <1s、跳滚后 2s 内 chunk 着色、滚动期零长任务，桌面基准 only）。
- 服务端 range 协议与大文件路由契约见 `server/README.md`「高亮 range 协议」与
  `docs/e2e/compute-global-search.md` BUG-10 路由语义更新。
