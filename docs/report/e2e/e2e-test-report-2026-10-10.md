# vviewer E2E 测试报告（2026-10-10）

> 被测版本：`main` @ `7b962e7`（探索/确认时点基线；其后仓库仅追加 e2e 占位编号勘误提交，`git diff 7b962e7..HEAD -- apps/web/src packages server/src` 为空，产品代码零改动；报告落笔时仓库 HEAD 为 `87fcdb2`）
> 背景批次：tree-sitter 全量语法对齐重构（服务端 301 语言宣告、本地 lite 34 语言 wasm、三层 grammar 资产链、>2MiB 懒高亮架构）落地后的第一轮全量回归
> 证据根目录：`.temp/e2e-data/`（共享测试数据集，本轮各域新增 `explore-<域名>/` 子树）、`.temp/e2e-artifacts/<域名>/`（各域截图与结构化输出）、`apps/web/.temp/<用途>/`（探测脚本）、`/tmp/<用途>/`（部分复核脚本与截图，均如实标注）
> 状态标记约定：**verified** = 经独立复核/确认会话亲手复现证实；**unconfirmed** = 未经本轮独立证实（按规则保留并明确标注，不丢弃、不计入已证实缺陷）。

---

## 1. 执行摘要

### 1.1 本轮流程与总量

本轮为「基线套件 → 分诊 → 分域黑盒探索 → 缺陷确认复核 → 编号缺口补测 → 统一串行执行 → 占位编号勘误」七阶段流程：

1. **基线套件**：vitest 685/685 通过（exit=0）；服务端 e2e exit=0；前端 e2e exit=1（4 个失败全部为 `b-grammar-layers.spec.ts` 两个用例 × chromium/mobile，经静态取证定性为执行侧环境缺失——构建未注入 `VV_GRAMMAR_CDN`——非产品缺陷、非脚本缺陷，详见 3.1）。
2. **基线分诊**：产品缺陷候选 1 条（BUG-08 的滚动还原观察，本轮确认为 BUG-64）、测试脚本缺陷 0、flaky 备注 3 条（详见 4.3/6.2）。
3. **分域黑盒探索**：10 个功能域全部完成（各域独立探测脚本、截图与结构化输出归档），产出缺陷候选。
4. **缺陷确认复核**：候选逐条独立复核（多含对照实验与根因源码定位），确认 41 条（合并前清单条目数）、**误报 0 条**（unconfirmed 候选清单为空）。
5. **跨域重复合并**：2 组重复发现合并（4 并 1、2 并 1），最终缺陷 **37 条主条目**：high 3 / medium 15 / low 19，**全部 verified；unconfirmed 为 0**。
6. **编号缺口补测**：新增 **12 个 `t-*` spec 文件**（t-bin、t-media 各按执行通道拆 web/`e2e` 与服务端/`e2e-server` 两处）；最终文件内共 **108 个 test 声明 = 64 个可执行用例 + 44 个 `test.fixme`**（44 = 5 场景受限占位 + 37 条确认缺陷回归锚点 + 2 个场景用例载体，分域实测对账见 §3.3），对应上轮缺口分析的 59 项缺口场景；统一串行执行 **10/10 域全部通过**（域结果字段口径，执行轮次 1~2；`test.fixme` 不执行不计数，Playwright 原始 passed/skipped 计数无归档可转录，见 §3.3「执行结果口径」）。
7. **占位编号勘误**：一次中断的部分执行曾以旧编号（31~48 段等，与本轮权威编号空间重叠但含义错位）提交过部分占位，已按权威编号逐域勘误去重，对照见附录 A。

### 1.2 缺陷计数（合并后口径）

| 严重度 | verified | unconfirmed | 小计 |
| --- | --- | --- | --- |
| high | 3 | 0 | **3** |
| medium | 15 | 0 | **15** |
| low | 19 | 0 | **19** |
| **合计** | **37** | **0** | **37** |

- 三条 high：**BUG-27**（快速打开面板对任一 listChildren 失败目录一票否决，本仓库自带服务端 e2e 数据集开箱即触发）、**BUG-33**（`lang=djot` 单请求即令服务端 SIGSEGV 崩溃退出）、**BUG-55**（hex 虚拟滚动 spacer 超浏览器单元素高度上限：>28.44MiB 文件尾部约 28.9% 数据彻底不可查看且滚到底显示错误偏移）。
- 重复发现合并：**BUG-28（shell）/BUG-41（md）/BUG-43（fsearch）** 三条并入 **BUG-35**（hl 承载，同一 worker 看门狗协议缺口）；**BUG-67（cmp）** 并入 **BUG-66**（md 承载，GFM 删除线双引擎不一致）。被并入编号不独立成条，仅在主条目下注明。
- 与上轮（2026-10-08，26 条缺陷）对照：上轮三大系统性缺口（BUG-06 本地 tree-sitter wasm 主路径整链失效、BUG-03 键盘/快速打开零实现、BUG-04/05 状态栏元数据与设置面板整体缺失）本轮复核**全部确认已修复**（键盘滚动/快速打开/设置面板均有编号断言并在本轮探索与补测中回归通过；本地 tree-sitter 主路径可用且 BUG-06 验收锚点无回退）。

### 1.3 一句话结论

**重构主目标达成、主干扎实，但配套面与边界面欠账集中暴露**：本地/远程 tree-sitter 高亮、懒高亮零错位、服务端 HTTP 契约、主题、Markdown/Office/压缩包渲染与全局搜索主链路可用（10 域 64 个可执行补测用例统一执行通过，域结果字段口径，见 §3.3）；但 3 条 high（快速打开开箱即不可用、djot 单请求崩服、hex 大文件尾部不可达且显示错误偏移）与一批「重构配套未跟随」类 medium（渲染器扩展名白名单、yaml vendored wasm、主题 capture 清单、SW 缓存策略漏 manifest/libarchive）以及四域独立命中同一处看门狗协议缺口（BUG-35），构成当前主要修复优先级。

---

## 2. 环境与口径

### 2.1 被测版本与构建

- git 基线：`main` @ `7b962e7`（占位勘误提交 0790cf9/b148bd1/23cee73/f1d228e/4df85d2/d1eda64/8c39501/88ff85e/d078d27/87fcdb2 仅改动 `apps/web/e2e*` 场景与占位文件及 docs，产品代码与 7b962e7 完全一致）。
- 前端产物：`apps/web/build`（mtime 2026-10-10 16:36:22，早于本轮基线 e2e 16:42:21 起跑）；`apps/web/build/grammars/` 34 个语言 wasm + `manifest.json`（6954B，含 sha256，generatedAt=2026-10-09，source=self-built），`apps/web/static/grammars/` 同样齐备；资产已存在故未运行 `pnpm gen:grammars`（零网络依赖）。
- 服务端：`server/target/release/vviewer`（2026-10-10 构建，release）。

### 2.2 运行实例

- **主服务端档**：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`，PID 633975（PPID=1 常驻），日志 `.temp/explore-server-8391.log`。健康检查 `curl /api/health` → HTTP 200 JSON，`capabilities=["file-server","compute"]` 含 compute，`computeLanguages` 覆盖 300+ 语言（301 宣告，与各域实测逐项一致）。**遗留状态（报告落笔后复核，见 §2.3）**：该实例在本轮结束后仍常驻（`ps -o pid,etime -p 633975` → ELAPSED 07:07:38），日志已达 13.65GB 且持续增长，处置（进程停止与日志清理）在本轮任务约束内未执行、留待编排方决定。
- **纯前端档**：`apps/web` 下 `pnpm vite preview --host 127.0.0.1 --port 4199 --strictPort`，vite 实际进程 PID 634483，日志 `.temp/explore-web-4199.log`。根路径 HTTP 200（4184B），`/grammars/manifest.json` 经 4199 亦 200。
- 端口 4173/4174/8399（Playwright 专用）启动前确认空闲。
- **各域辅助/自起短命实例**（842x~844x 段，均测毕按 PID 清理，端口冲突时改口并如实记录）：如 hl 域 8433/8434/8435/8436/8440/8441/8443/8445~8449、srv 域 8430/8431/8434/8437/8440/8441、media 域 8431/8441/8442、bin 域 8430/8441、cmp 域 8433/8434/8441/8443、pwa 域 8430/8442、shell 域复用 8391/4199 等。8432 曾有一个先前 smoke 测试遗留的 vviewer 进程 PID 1190058（root 在 /tmp/vv-smoke-khW5），不占用目标端口，未动。

### 2.3 遗留环境告警（不影响本轮结论）

1. 服务端 watcher 对 `.temp/e2e-data/edge/symlink/escape-etc/audit`（历史 symlink 边界测试遗留数据，→ /etc）报 PermissionDenied，已回退 PollWatcher——仅影响文件变更实时推送，不影响 HTTP 服务与 compute；srv 域探索另行实证该 PermissionDenied→后台退避→PollWatcher 降级链路按 BUG-02 修复口径工作，无内容泄露。**报告落笔后遗留状态复核（均为本修订时实测）**：①主实例（PID 633975）仍常驻，`ps -o pid,etime,pcpu -p 633975` → ELAPSED 07:07:38、平均 %CPU 203，`top -bn1 -p 633975` 瞬时 CPU 184.4%；②日志 `.temp/explore-server-8391.log` 已达 13,645,964,047B（≈13.65GB）且持续增长——间隔 5 秒两次 `stat -c %s` 采样为 13,645,964,047 → 13,648,758,732（+2,794,685B/5s ≈ 559KB/s ≈ 47GB/天），`tail` 可见全部为 `notify::poll::data: walkdir error scanning … PermissionDenied` WARN（对 escape-etc → /etc 下大量路径的 PollWatcher 周期扫描重复报错）。**磁盘风险与处置**：按当前速率日志每天增长约 47GB，存在写满磁盘的现实风险；本轮任务约束内未清理任何现场，建议编排方尽快决定——kill 633975、清理或移走该日志、并清理数据根中的 `edge/symlink/escape-etc` 遗留数据后重启实例（三者任一即可止住增长；③中 8432 遗留 smoke 进程同批处置）。
2. 8432 端口遗留 smoke 实例（见上）。
3. vite preview 启动有 vite-plugin-pwa transformIndexHtml 不支持告警，属 preview 模式正常现象（PWA sw.js 已在 build 产物内）；前端与 -server 两轮 Playwright WebServer 均报同类告警，本轮用例不依赖 PWA dev-sw（b-grammar-layers 还显式 `serviceWorkers:'block'`），不影响结果。

### 2.4 测试方法与口径

1. **基线套件交叉验证**：vitest 单测、`apps/web/e2e`（chromium+mobile）、`apps/web/e2e-server`（playwright.server.config.ts，release 二进制 + 4174）三套全量运行，结果见 3.1。
2. **分域黑盒探索**：每域以 chromium headless 独立 node 脚本（Playwright 1.64 / agent-browser）对 8391/4199 及自起实例做只读探索——DOM 断言、网络观测、API 直呼（curl）、源码读码定位根因；脚本存 `apps/web/.temp/explore-<域名>/` 与 `apps/web/.temp/`（复核脚本），截图/JSON 存 `.temp/e2e-artifacts/<域名>/`，自造数据存 `.temp/explore/<域名>/data/` 并同步 `.temp/e2e-data/explore-<域名>/`（服务端根可读）。探索阶段不修改 apps/packages/server/docs 任何文件（各域 git status 复核记录在案）。
3. **缺陷确认复核**：候选逐条由确认人独立复现（不复用上报者脚本，多数附对照实验：正/负对照、根因代码实读、API 与 UI 双通道证据）；severity 按统一标尺校准，原判与校准理由在各条目内如实保留。
4. **补测与执行**：新增 `t-*` spec 仅补上轮缺口分析中的缺口场景、不重复既有 b-*/m* 编号断言；选择器/期望值均经源码核实或以产品代码同源计算（如主题域以 Node 侧实读 themes.json 复刻 resolveCapture）；统一串行执行阶段以 Playwright 实跑，10/10 域通过。
5. **占位编号勘误**：全仓库 rg 盘点 `test.fixme` 占位并与权威缺陷清单逐条内容配对（现象+根因 file:line+复现步骤），就地勘误/删除重复/补缺失，每条确认缺陷全仓库恰有一个以权威编号开头的可发现锚点（对照见附录 A）。

### 2.5 已裁决偏差（沿上轮口径，本轮不重复计缺陷）

上轮十条已裁决偏差（HTML 沙箱 allow-same-origin、token 手动粘贴、X-VV-Type 省去、捏合缩放维持、数学扩展不启用、压缩包前端解包、--web-dist 唯一挂载、搜索 col=UTF-16 码元、grammar 资产构建期生成）本轮全部沿用，未发现需要新增裁决的行为分歧；本轮探索中与偏差边界相关的观察（如压缩协商注释与实现出入、空 zip 无提示、hex 无键盘跳转属规格未承诺等）均按「不构成缺陷」仅记录在各域探索档案，未计入缺陷清单。

---

## 3. 结果分布

### 3.1 基线套件

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| vitest | **exit=0，685/685 通过** | stderr 的 worker init 失败栈、libarchive 原始 message、[self-build] objc skipped 均为通过用例的预期路径输出 |
| 服务端 e2e（playwright.server.config.ts） | **exit=0** | 日志中 `ERROR tower_http` 501 为 CMP-09「无 rg 降级」用例的刻意构造（该用例 ✓ 通过） |
| 前端 e2e（chromium+mobile） | **exit=1** | 4 个失败用例全部为 `b-grammar-layers.spec.ts` 两个用例 × chromium/mobile（含重试共 8 次尝试确定性失败），定性见下 |

**前端 e2e 4 失败的根因与定性（执行侧环境缺失，非产品缺陷、非脚本缺陷）**：被测 bundle 构建期未注入 `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/`。证据链：①用例前提记载于 `apps/web/e2e/b-grammar-layers.spec.ts:9-13`（「未注入时 CDN 层不会发起任何请求」）；②注入链 `vite.config.ts:222`（define 缺省 ''）→ `highlightClient.ts:227`（|| null）→ `grammarLayers.ts:80`（cdnBase 空则 cdn 层不入候选）；③本地产物硬证据：`apps/web/build/_app/immutable/` 全量 grep 零处 `cdn.grammars.test` 字面量（build mtime 16:36:22 早于起跑 16:42:21）；④失败签名吻合：用例 1 实收「高亮: hljs 兜底 · 执行: 本地」（java 无 tree-sitter 来源，大小 133 恰为 JAVA_SRC 字节数，降级路径本身正常）；用例 2「Expected 1 Received 0」（CDN 层不存在 → abort 路由零命中）。跳层/first-wins 源码在位（grammarLayers.ts:29-64）且有单测，「未配置即无第 3 层」为文档化设计（docs/superpowers/plans/2026-10-09-phase2-asset-chain.md:17）；CI 的 e2e job 显式注入同值（`.github/workflows/ci.yml:90-94`）故 CI 不受影响，而本地 build 脚本（`apps/web/package.json:8`）无注入。**建议**：基线 runner 构建时设置该 env，或 webServer 起动后对产物做注入自检使误配 fail-fast。**受限说明**：`apps/web/test-results/` 已清空，chromium 用例 1 的实收状态栏字符串无法从现场快照补读（仅 mobile 两次尝试的实收值在粘贴输出中可见）；未实跑 e2e 复验（本阶段约定不修改任何文件，构建/运行会写产物），上述为静态取证结论。

### 3.2 基线分诊

- **productBugs 候选 1 条**：bug08-scroll-restore——服务端 e2e 运行日志「[BUG-08 观察] 重载后 scrollTop=0（快照值 2500，未还原）」（用例仍 ✓ 通过；`apps/web/e2e-server/b-server-regression.spec.ts:125-129` 注释记录 4 次探针重载实测）。本轮经确认复核独立复现并加深根因（7 次独立运行、/tmp 补丁构建插桩），定档 **BUG-64（low，verified）**，见缺陷清单。
- **testDefects：0 条**。
- **flakyNotes：3 条**：①前端 e2e 4 失败共同根因（见 3.1，归执行侧）；②m3-search mobile「关闭后重开」`.vv-search-input` toBeFocused 为预先存在计时型 flaky（`docs/e2e/README.md:6` 预先记录「套件失败时先区分，勿归为新缺陷」；行号漂移：文档记 :107/:124:50，当前工作树用例在 `apps/web/e2e/m3-search.spec.ts:112`、焦点断言在 :129，同一用例）；③非失败噪音（服务端 e2e 的 501 刻意构造、transform_index_html_unsupported 告警、vitest 预期路径输出）均无需分诊动作。②的本轮重试结果**未能证实**：粘贴输出的汇总段被截断，failed 列表（4 项全为 b-grammar-layers）不含它，与「重试后通过」相容但未经本轮会话证实，按 unconfirmed 归档（见 4.3）。

### 3.3 域覆盖与补测执行

| 域 | 文档场景数 | 既有自动化 | 上轮缺口场景 | 本轮新增（最终文件实测：可执行 test() + test.fixme()） | 执行结果（轮次） | 确认缺陷（合并后） |
| --- | --- | --- | --- | --- | --- | --- |
| 应用外壳 shell | 14 | 9 | 10 | e2e/t-shell.spec.ts：13 + 7 fixme | ✅ 通过（2） | 5 |
| 代码高亮 hl | 11 | 6 | 7 | e2e/t-hl.spec.ts：8 + 7 fixme | ✅ 通过（2） | 7 |
| 主题系统 theme | 7 | 6 | 4 | e2e/t-theme.spec.ts：4 + 3 fixme | ✅ 通过（1） | 3 |
| Markdown 渲染 md | 13 | 10 | 3 | e2e/t-md.spec.ts：4 + 4 fixme | ✅ 通过（2） | 4 |
| 文件内搜索 fsearch | 7 | 3 | 4 | e2e/t-fsearch.spec.ts：4 + 1 fixme | ✅ 通过（1） | 1 |
| 媒体与 Office media | 11 | 8 | 6 | e2e/t-media.spec.ts：5 + 3 fixme；e2e-server/t-media.spec.ts：1 + 0 | ✅ 通过（2） | 3 |
| hex 与压缩包 bin | 10 | 10 | 6 | e2e/t-bin.spec.ts：4 + 1 fixme；e2e-server/t-bin.spec.ts：2 + 0 | ✅ 通过（1） | 1 |
| 服务端文件服务 srv | 13 | 11 | 9 | e2e-server/t-srv.spec.ts：9 + 5 fixme | ✅ 通过（1） | 4 |
| 计算卸载与全局搜索 cmp | 12 | 12 | 4 | e2e-server/t-cmp.spec.ts：2 + 6 fixme | ✅ 通过（2） | 2 |
| PWA 与移动端 pwa | 9 | 9 | 6 | e2e/t-pwa.spec.ts：8 + 7 fixme | ✅ 通过（1） | 6 |
| **合计（12 个文件）** | **107** | **84** | **59** | **64 可执行 + 44 fixme（共 108 个 test 声明）** | **10/10 域通过** | **36 + 套件级 1 = 37** |

补充口径：

**用例数对账说明**：§3.3 表中「本轮新增」为**最终文件实测口径**（`grep -cE '^\s*test\('` 与 `grep -cE '^\s*test\.fixme\('` 对 12 个 t-* 文件逐一分文件统计，本修订时实测）。各域补测**编写阶段**材料曾报「编写时点」用例数（如 t-hl 10 用例含 1 fixme、t-cmp 4 用例含 1 fixme、t-media web 4 用例、t-shell 14 用例），其后占位勘误阶段为 37 条确认缺陷落回归锚点、并把 2 个场景用例载体转/标为 fixme，最终文件因此变为上表实测数（如 t-hl 8+7、t-cmp 2+6、t-shell 13+7）；编写时点数仅反映补测场景用例本身，不代表最终文件全量。本报告一律以实测口径为准。

**fixme 总数披露（44 个，本修订时实测）**：44 = **5 个场景受限占位**（SHELL-07：headless 无法驱动 FS Access picker/requestPermission；HL-10/3：需同源 --compute 辅助实例模式，注明参照 b-compute-global-search-server 的 :4180 模式转正；SRV-06/2：e2e 无法稳定注入 notify 运行期错误，状态机分支已有 mock opener 单测覆盖；CMP-02/2：验收 2「关标签重开二次更快」依赖服务端 intervals 缓存的 spec 未决项，断言体已写好；PWA-06/2：快滑惯性断言已写好，现状必败——虚拟滚动路径惯性恒 0 疑似回归，待人工/真机复核后转正）+ **37 个确认缺陷回归锚点**（合并后 37 条主条目各恰一锚点，逐条编号见 §4.2 与附录 A）+ **2 个场景用例载体**（MD-01/2 [CAND-md-F1]，`e2e/t-md.spec.ts:80`；CMP-05 [BUG-67]，`e2e-server/t-cmp.spec.ts:239`——两者为 BUG-66 的场景判据用例，按「不改场景用例」口径保留 fixme）。`test.fixme` 不执行、不计入通过/失败。

**执行结果口径（如实披露）**：「10/10 域全部通过」指统一串行执行轮次中各域**可执行用例**（非 fixme）的域级结果字段结论（域材料 execRan=true / execPassed=true，执行轮次 1~2），其依据是域材料给定的执行结论字段，**Playwright 原始 passed/skipped/failed 逐项计数未归档、无法在本报告中转录**——复核时 `apps/web/playwright-report` 不存在（`ls: cannot access 'apps/web/playwright-report': No such file or directory`），`apps/web/test-results/` 仅余 BUG-65 确认会话的遗留探针目录（zzz-review-hl02-probe-*），无统一执行轮次的报告产物。基线三套运行（§3.1）的结论同样转录自粘贴输出、无原始日志归档（m3-search flaky 的汇总段截断已在 §3.2 注明）。此为本报告执行数字的口径边界，读者引用 passed/skipped 级别数字时应以复跑为准。

- 域级确认缺陷数为合并后口径；**域探索期原始计数**为 shell 6 / hl 7 / theme 3 / md 5 / fsearch 2 / media 3 / bin 1 / srv 4 / cmp 3 / pwa 6，加套件级 1，共 41 条（= 确认清单原始条目数，41 条候选全部确认、无误报），合并两组后为 37（见 4.1）。
- 各域补测执行要点（示例，完整见各域 writeNotes 档案）：t-shell 覆盖 SHELL-01/02/03/04/06/09/10/12/13（SHELL-07 fixme）；t-hl 覆盖 HL-01/02/03/04/08/10/11（「abi 非 null」判据按过时口径退役改断 file/sha256；HL-04/2 为 >200MiB plain 分支 chromium only）；t-theme 含 214 主题页内全遍历与 hljs 变量逐项断言；t-md 含 MD-12 源码/渲染双视图搜索；t-fsearch 含 pdftotext 外部基准；t-media 含 ffmpeg 生成 HLS 播完；t-bin 含加密混合包 /api/file 护栏（只能落 4174）；t-srv 含 --token/--cors-origin/--hidden 跨源与拒启矩阵（辅助实例 4375-4377）；t-cmp 含 301 语言 computeLanguages 宣告断言与路由矩阵重锚定；t-pwa 含 SW precache/离线 wasm 缓存命中与性能预算硬门。

### 3.4 缺陷分布（合并后 37 条，按域 × 严重度）

| 域 | high | medium | low | 小计 | 条目 |
| --- | --- | --- | --- | --- | --- |
| 应用外壳 | 1 | 1 | 3 | 5 | BUG-27(H) BUG-29(M) BUG-30/31/32(L) |
| 代码高亮 | 1 | 5 | 1 | 7 | BUG-33(H) BUG-34/35/36/37/65(M) BUG-38(L) |
| 主题系统 | 0 | 2 | 1 | 3 | BUG-49/50(M) BUG-51(L) |
| Markdown 渲染 | 0 | 2 | 2 | 4 | BUG-39/40(M) BUG-42/66(L) |
| 文件内搜索 | 0 | 0 | 1 | 1 | BUG-44(L) |
| 媒体与 Office | 0 | 2 | 1 | 3 | BUG-52/53(M) BUG-54(L) |
| hex 与压缩包 | 1 | 0 | 0 | 1 | BUG-55(H) |
| 服务端文件服务 | 0 | 1 | 3 | 4 | BUG-45(M) BUG-46/47/48(L) |
| 计算卸载与全局搜索 | 0 | 0 | 2 | 2 | BUG-56/57(L) |
| PWA 与移动端 | 0 | 2 | 4 | 6 | BUG-58/59(M) BUG-60/61/62/63(L) |
| 套件级（会话滚动恢复） | 0 | 0 | 1 | 1 | BUG-64(L) |
| **合计** | **3** | **15** | **19** | **37** | |

---

## 4. 缺陷清单

> 37 条主条目 = 37 verified + 0 unconfirmed。原始确认清单 41 条，两组跨域重复发现合并后为 37（见 4.1）。每条含：严重度、涉及域、根因位置（where）、现象与校准、复现步骤、证据（关键数值与归档路径）。

### 4.1 跨域重复发现合并说明

| 主条目（承载域） | 被并入编号（发现域） | 共同根因 | 合并依据 |
| --- | --- | --- | --- |
| **BUG-35**（代码高亮，锚点 `apps/web/e2e/t-hl.spec.ts:514`） | BUG-28（应用外壳）、BUG-41（Markdown 渲染）、BUG-43（文件内搜索） | highlight worker init 成功路径无 ack 回包 × client 端 15s 看门狗「收到任意消息才判活」× clientPromise 失败不重试 | 四条独立探索的 what/repro/evidence 指向同一根因链（`packages/highlight/src/client.ts:74-81` + `worker.ts:84-104` + `apps/web/src/lib/highlightClient.ts:87-94`）；各域占位勘误记录均显式「并入 t-hl.spec.ts:514 BUG-35」（附录 A） |
| **BUG-66**（Markdown 渲染，锚点 `apps/web/e2e/t-md.spec.ts:230`） | BUG-67（计算卸载与全局搜索） | GFM 删除线：本地 markdown-it@15.0.2 渲染 `<s>` vs 远程 comrak 渲染 `<del>` | cmp 域占位勘误记录显式「同一删除线缺陷按 md 域权威清单定档 BUG-66，并入他域锚点」；两域锚点互指（md 侧 BUG-66、cmp 侧场景锚点 `CMP-05 [BUG-67]`，t-cmp.spec.ts:239 保留） |

被并入编号不得独立成条；结果分布（3.2/3.4 表）与缺陷总数均按合并后 37 条统计。

### 4.2 确认缺陷（verified，37 条，编号沿用确认时编号、不重排）

#### 应用外壳（5 条）

**BUG-27【high · verified】快速打开面板对 listChildren 失败的目录一票否决：数据集中任一越界 symlink 使整个面板 0 行，功能完全不可用**

- **域/根因位置**：shell｜服务端档 `http://127.0.0.1:8391`（数据根自带 `edge/symlink/escape-etc -> /etc`）；`apps/web/src/lib/quickOpen.ts:28-38`（walk 无单目录容错）、`apps/web/src/lib/QuickOpenPanel.svelte:47-49`（catch 整体置失败态）；服务端 symlink 呈现为 dir 的防护口径见 2026-10-08 报告 §2.3。
- **现象与校准**：walk 任一层 listChildren 403 使整个 listFilesRecursively reject，catch 整体置失败态且 files 保持空数组，列表 0 行。两轮复现均 100% 稳定；排除该目录后同页面同数据集立刻恢复 100 行，证实单目录 403 即整体失败。维持 high：功能完全不可用，且触发面比候选更宽（树中任意一个 listChildren 失败目录即可），本仓库自带 e2e 数据集开箱即触发；减轻因素：左栏树可作替代打开路径（树侧有单目录容错），且可用排除规则规避。
- **复现**：打开 8391 → 「连接服务器」填 `http://127.0.0.1:8391` 连接 → Ctrl+P：状态行「列出文件失败：服务器请求失败: HTTP 403: path escapes root」，列表 0 行。根因对照：`curl '.../api/tree?path=edge'` 可见 symlink 条目 kind=dir；`curl -w '%{http_code}' '.../api/tree?path=edge/symlink/escape-etc'` → 403。恢复对照：`localStorage['vviewer:settings']=JSON.stringify({excludedPatterns:['edge']})` 刷新重连后 Ctrl+P 正常列出 100 行且无 edge 路径。
- **证据**（均为确认会话亲手执行）：API 层 curl 三态（父目录 200 / 越界子目录 403 + `{"error":"path escapes root"}`）；浏览器端到端两轮 `rows:0` + 失败文案（agent-browser 会话 cand-shell-e1-29632ef6cf44）；截图 `.temp/verify-shell-e1/A-quickopen-403.png`、`.temp/verify-shell-e1/B-quickopen-excluded-ok.png`；树侧对照：展开 edge→symlink 正常、点击 escape-etc 展开回滚（与 `TreeNodeRow.svelte:27-38` 单目录 try/catch 容错一致，反证快速打开缺少同等容错）；源码定位如上。

**BUG-29【medium · verified】伺服层对未命中裸路径返回 200+index.html，前端「文件 URL」仅判 res.ok，静默把 SPA 壳源码当目标文件渲染**

- **域/根因位置**：shell｜`server/src/lib.rs:55-85`（serve_index 对非 .scm/.wasm 的一切未命中路径 200 + index.html）；`packages/core/src/tree/singleFile.ts:29-32`（createUrlStore 只判 `!res.ok`）。
- **现象与校准**：粘贴裸路径 URL（如 `http://127.0.0.1:8391/samples/m1/hello.js`，真实 72B/2 行）时静默把 index.html 源码（1610B/36 行）当作该文件渲染，状态栏「语言: javascript · 大小: 1610 · 行: 36」，全程无错误卡片。SHELL-04 的「404 明确提示」仅 /api/file 形态可达。维持 medium：后果属错误结果，但需用户主动粘贴非 /api/file 形态 URL，核心功能不受影响，错误内容肉眼可辨。
- **复现**：连接 8391 → 顶栏 URL 输入裸路径回车 → 新 tab 渲染 index.html 带行号源码。对照：`/api/file?path=samples/m1/hello.js` 正常渲染 72B/2 行；`/api/file?path=no-such-xyz.js` 有正确 404 错误卡片。
- **证据**：`curl -i` 裸路径 → HTTP 200 + text/html + 1610B（SPA 页）；`/api/file` → 200 text/javascript 72B；独立 Playwright 三态对照（A 裸路径 1610/36 无错误卡 / B /api/file 正确 / C 404 卡片）复现两次稳定，截图 `/tmp/vv-reverify-e3/A-barepath-indexhtml.png`（属性面板「大小 1610字节 / 行数 36」可见）。与 SHELL-04（pass）不矛盾的解释：`t-shell.spec.ts:171-196` 两用例均用 page.route 拦截虚构 URL，从未打到真实伺服器的裸路径 fallback。

**BUG-30【low · verified】URL 以 / 结尾时 openUrl 产出空名伪目录 tab，path==='' 语义双向冲突致误渲染与静默误关**

- **域/根因位置**：shell｜`apps/web/src/lib/openFlow.svelte.ts:424-431`（尾斜杠 `split('/').pop()` 得空串，`addTab(createUrlStore(url),'','')`）、`:411-413`（path==='' 替换扫描）；`TabBar.svelte:27`、`ViewerPane.svelte:131,222-223`、`AppShell.svelte:164`。
- **现象与校准**：提交尾斜杠 URL 产出空名伪 tab 且激活，内容区显示「目录来源：文件在左侧树中打开」（URL 内容根本不渲染也不报错）。加重观察：纯前端档空名 tab 为唯一 tab 时，AppShell dirStore 解析命中它，URL store 被误渲染为空根文件树；注入真实目录后被 path==='' 替换扫描静默误关。维持 low：无崩溃/数据丢失/错误结果，需手动提交尾斜杠 URL，单伪 tab 易关闭恢复。
- **复现**：连接 8391 → URL 输入 `http://127.0.0.1:8391/samples/m1/` 回车 → 新 tab 名为空字符串且激活。
- **证据**：Playwright 探针 `node /tmp/verify-shell-e4/probe.mjs`：tabs 从 `[{name:'127.0.0.1:8391',active:true}]` 变为 `[{…},{name:'',active:true}]`，paneEmptyDiv=「目录来源：文件在左侧树中打开」，树未被顶掉；纯前端档 `probe-pure.mjs` 首个动作即产出空名 tab + treeRows=['']（URL store 被误当目录树）；截图 `/tmp/verify-shell-e4/e4-empty-tab.png`、`e4-pure-first.png`。reload 后空 tab 消失（刷新自愈，本轮服务器目录 tab 也未被恢复，无法单独归因于跳过分支）。

**BUG-31【low · verified】快速打开面板打开时再按 Ctrl+P 不关闭也不 preventDefault（真实浏览器将触发打印对话框）**

- **域/根因位置**：shell｜`apps/web/src/lib/AppShell.svelte:232-238`（inField 对 INPUT 提前 return，候选所引 225-229 行号偏差已校准）、`:244-248`（toggle+preventDefault 仅非输入焦点可达）；`apps/web/src/lib/QuickOpenPanel.svelte:27-29`（$effect 自动聚焦）。
- **现象与校准**：面板打开态下再按 Ctrl+P 既不切换关闭也不拦截默认行为；面板输入框 handler（QuickOpenPanel.svelte:81-95）只处理 ↑↓/Enter。维持 low：Esc 与 ✕ 仍可关闭；校准两处：inField 行号实为 232-238；「点击面板外失焦后可关」的对照前置未能以真实点击达成（强制 focus 后 activeElement 仍为 INPUT），改用 BODY 上派发 synthetic 事件等价验证了 target 非 INPUT 时 toggle+preventDefault 正常，根因判定不受影响。
- **复现**：连接后 Ctrl+P 打开面板（输入框自动聚焦）→ 再按 Ctrl+P：面板不关；页内对输入框派发 `new KeyboardEvent('keydown',{key:'p',ctrlKey:true,cancelable:true})` → `ev.defaultPrevented === false`。
- **证据**：`node apps/web/.temp/reverify-shell-e5/reverify.mjs`（8391 与 4199 两档）：s3_panelStillOpenAfter2ndCtrlP=true（两档均 true）、s4_synthetic={defaultPrevented:false,target:'INPUT.vv-quickopen-input'}；对照 `reverify3.mjs`：BODY 派发 defaultPrevented=true 且面板关闭/重开双向正常。

**BUG-32【low · verified】图片状态栏「编码」恒显示 gb18030（文本编码检测对二进制媒体不豁免）**

- **域/根因位置**：shell｜`packages/core/src/detect/encoding.ts:31-37`（UTF-8 校验失败即回退 gb18030）、`packages/core/src/detect/index.ts:16,23`（binary=true 仍保留 encoding）、`packages/render-media/src/image.ts:77`（getMeta 直接透传）、`apps/web/src/lib/ViewerPane.svelte:115`（非空即显示）。
- **现象与校准**：png/jpg 状态栏恒「编码: gb18030」，服务端/纯前端两档、三张图均复现。属误导性呈现缺陷：图片渲染正常，无崩溃/数据丢失/错误结果。
- **复现**：打开 samples/m1/pixel.png、domain-media-office-viewer/exif-rot90.jpg、domain-media-office-viewer/zoom-test.png → 状态栏均「编码: gb18030 · 大小: 70/3657/4022」。
- **证据**：`curl -s -D - ".../api/file?path=samples/m1/pixel.png"` 含 `x-vv-encoding: gb18030`；服务端档 `node /tmp/verify-shell-e6/repro.mjs` 与纯前端档 `repro4199.mjs`（setInputFiles）三文件结果与字节数完全一致。

#### 代码高亮（7 条，含承载 BUG-35）

**BUG-33【high · verified】POST /api/compute/highlight 以 lang=djot 高亮任何含命中内容的文本，服务端进程立即 SIGSEGV（退出码 139）死亡，单请求杀死整个 vviewer 且日志无任何 panic 痕迹**

- **域/根因位置**：hl｜`server/src/compute/highlight.rs:147-156`（run_highlight 直调 tree-sitter-highlight C 层 Highlighter::highlight）、`:525`（spawn_blocking 三模式汇合点）；`:297` 的响应侧超时保护对 SIGSEGV 无效。
- **现象与校准**：text/path/range 三模式均实测触发；崩溃+功能完全不可用（文件服务与 compute 同时不可用直至重启），维持 high。工艺注意：实例启动后 queries 懒编译 301 语言需约 6~8 秒（服务日志可见编译 WARN），复现需等「health 200 + 任一无害高亮请求 200」双就绪。
- **复现**：起 `--compute` 实例 → `curl -X POST :PORT/api/compute/highlight -d '{"text":"# Heading\n","lang":"djot"}'` → curl HTTP=000、shell 打印 Segmentation fault (core dumped)、wait 退出码 139、`/api/health` 随后 000。最小触发文本还有 `'text **bold**\n'`、`` '`code`\n' ``（bisect 4/4 全崩）；纯文本 `'x\n'/'Heading\n'` 不崩。
- **证据**：自起 release 实例（端口 8441/8446/8447/8448/8449/8443，日志 `/tmp/vv-recheck-hl-e1/server*.log`）：text/path/range 三模式各 139；对照组 djot 纯文本 200 零区间、同文本换 lang=markdown 200 正常区间；coredumpctl 记录三个实例 PID 均SIGSEGV present；301 语言全量串行扫描（每语言后 health 存活检查）djot 唯一崩溃（hl 域探索，脚本 `apps/web/.temp/explore-hl/`）。

**BUG-34【medium · verified】codeRenderer.extensions 白名单未跟随 301 语言重构：zig/hs/ex/erl/clj/scala/djot 七类扩展名文件被「不支持的扩展名」错误卡片拒绝，识别与高亮资产齐备却在选路层被拦**

- **域/根因位置**：hl｜`packages/render-text/src/code.ts:1012-1018`（硬编码 ~48 扩展名白名单）+ `packages/core/src/dispatch/dispatcher.ts:100,144-153`（byExtension 未命中即抛「不支持的扩展名」，无扩展名回退链仅在 det.ext==='' 时进入）。
- **现象与校准**：七种语言文件服务端 `x-vv-lang` 全部正确识别（7/7）、本地 wasm 与远程 compute 两路高亮就绪（`packages/highlight/assets/languages.json` 342 条实有对应条目、`apps/web/build/grammars/zig.wasm` 实存），唯 code.ts 白名单拦截。维持 medium：特定语言类文件预览完全不可用（用户可见错误卡片、无降级入口），非崩溃/数据丢失，白名单内语言不受影响。
- **复现**：起 `--compute` 实例（如 :8445，root 含 langs/ 样例）→ UI 点击 sample.zig → 错误卡片「无法预览此文件 / 不支持的扩展名 \".zig\"」。
- **证据**：`curl -s -D - 'http://127.0.0.1:8445/api/file?path=langs/sample.zig'` → 200 + `x-vv-lang: zig`（hs/ex/erl/clj/scala/djot 同法全对）；Playwright `node /tmp/vv-verify-hl-e2e/rep.mjs` 点击 7/7 全部错误卡片（截图 shots/zig.png、shots/djot.png）；正对照 sample2.rs 正常渲染「高亮: tree-sitter · 执行: 远程 · 语言: rust」（shots/rs-control.png）——排除 UI 通路整体不可用。

**BUG-35【medium · verified】highlight worker init 成功路径无 ack 回包 × client 看门狗 15s「无任意回包判死」→ 健康 worker 被静默误杀，全会话本地 tree-sitter 高亮降级 hljs 且刷新前不可恢复**
（同一缺陷重复发现：发现域 应用外壳（编号 BUG-28）、Markdown 渲染（编号 BUG-41）、文件内搜索（编号 BUG-43）已并入本条）

- **域/根因位置**：hl（承载域）｜`packages/highlight/src/client.ts:18,74-81`（INIT_TIMEOUT_MS=15s 看门狗，仅「收到过任何消息」解除）、`:45-46,85-92`（markWorkerAlive 仅 onmessage）、`:104-117,126-128`（initFailed 短路后续 highlight）；`packages/highlight/src/worker.ts:82-107`（serveWorker init 成功分支零 postMessage，仅失败或处理请求时回包）；`apps/web/src/lib/viewer.ts:51-56`（应用启动即预热 client，看门狗自页面加载起算）；`apps/web/src/lib/highlightClient.ts:85-97`（clientPromise 失败不重试）、`:254-256`（报错文案误导为「排查 worker chunk 404/MIME」）。
- **现象与校准**：页面打开后 15s 内无本地高亮请求（服务端档远程命中、或用户先浏览再开文件的自然序列必然命中）时，健康的 worker 被误杀：此后本会话所有本地代码文件与 markdown 围栏静默降级「hljs 兜底 · 执行: 本地」，console 报「初始化超时（15s 无响应）」而实测 worker chunk/tree-sitter.wasm/manifest 全部 200；刷新页面前不可恢复。单测 `packages/highlight/test/client.test.ts:133-163` 只覆盖「worker 从不回包=病态」假设，恰好漏掉健康 worker 的「init 成功+无 ack+无请求」组合。维持 medium：无崩溃/数据丢失/错误结果，hljs 兜底仍可用且状态栏可见；但触发时序常见、降级全会话持续且报错误导排查方向。源码溯源：15s 看门狗由提交 1a95b0a（2026-10-08）引入（并入条 BUG-41 的 git show 证据）。
- **复现**：打开实例首页 → 什么都不做等 ≥15s → 打开任意 .rs 代码文件 → 状态栏「高亮: hljs 兜底 · 执行: 本地」+ console 超时报错；对照：新开页面立即打开同一文件 →「高亮: tree-sitter · 执行: 本地」。
- **证据**（主条目，hl 域确认会话）：`node /tmp/review-cand-hl-e3/repro-watchdog.mjs`（对 4199，注入 wd-a/wd-b.rs）：immediate 对照「tree-sitter · 本地」ts=49/hljs=0 无错误；idle-20s「hljs 兜底」ts=0/hljs=16 + console.error；同页再开 wd-b.rs 仍 hljs（永久短路）；四判据全 true。
- **并入条目补充证据**：BUG-28（shell）：`node apps/web/.temp/review-e2/r1-watchdog.mjs a/b` A/B 对照会话（B 会话 15s 内即 local 开文件则 17s 处零超时报错、之后仍 tree-sitter）排除资产/环境因素、证实误杀纯因静默；`r2-autofallback.mjs` 证实 auto 本地回退同样死亡。BUG-41（md）：`node /tmp/md-e3-reverify/reverify.mjs` 对 8391/4199 复现（A 等 17s 后开 rust-fence.md 围栏 cls="language-rust hljs" ts=0/hljs=8；B 300ms 即开 ts=19 无错误）；`session2.mjs` 证实全会话性。BUG-43（fsearch）：`node apps/web/.temp/verify-fsearch-E1/watchdog-verify.mjs` 六场景（A1 4199 空闲 20s，console.error 在 t+15.1s 早于开文件动作，证明看门狗在空闲期独立触发；B1/B2 8391 同构；C1/C2 markdown 围栏对照）、`watchdog-verify2.mjs` 连开三文件全降级 + console.error 仅一条（永久短路）。四条发现共 10+ 次独立复现全部稳定。

**BUG-36【medium · verified】服务端 compute 高亮对「单行大文本」O(n²)：446KB 单行超 10s 预算 504，且 504 后解析线程继续满核空转；同内容多行 477KB 仅 0.15s**

- **域/根因位置**：hl｜`server/src/compute/highlight.rs:123-133`（Utf16Index::to_utf16 行内逐字符累加 O(行长)）、`:191-192`（每个 Source 事件调用两次）——单行文件行长=全文、区间数亦 O(n)，整体 O(n²)；无前置闸拦截（MAX_INTERVALS=2M 远未触及，range chunk 上限 20MB 不拦）；text/path/range 三模式同病。
- **现象与校准**：梯度实测 50KB=0.28s → 141KB=3.39s → 285KB=8.82s → 446KB 504（尺寸×2.8 耗时×12.3，符合 O(n²)）；504 后 10s 窗口实测 993 ticks ≈99% 单核后台空转。UI 端 server-served 单行 456KB json 打开 11.1s 后远程超时回退本地 wasm 至终态，功能最终可用。维持 medium：客户端回退兜底使功能不完全不可用，但服务端能力对 minified js/json 常见形态实际失效并持续浪费 CPU。**归因甄别（报告落笔后复核补充）**：原稿曾以「8391 实例实测长期 205% CPU」作为本缺陷在野证据，该归因**不成立为单因素证据**——报告发布后复核（§2.3）主实例无任何高亮请求时瞬时 CPU 仍达 184.4%（top -bn1），其来源是 PollWatcher 对 `edge/symlink/escape-etc`（→ /etc）的周期扫描与 ≈559KB/s 的 WARN 日志写盘，与本缺陷的高亮解析空转是**两个相互独立的 CPU 来源**；「长期 205% CPU」系两者叠加的进程均值（ps %CPU），不能单独归因于 BUG-36。本缺陷的空转证据以确认会话的紧贴采样为准（504 返回后 10s 窗口 993 ticks ≈99% 单核，采样窗口内无其它负载干扰）。
- **复现**：POST `{"path":"oneline-446kb.json","lang":"json"}` → 504/10.0s；同内容多行 → 200/0.148s。
- **证据**：自起实例 8441（root=/tmp/hl-verify）梯度全表；8391 夹具复验 `edge/size/minified-3mb.js` 与 range{0,1} 均 504/10.0s；`/proc/PID/stat` 采样 98~99% 单核；UI Playwright 状态栏「解析中…」→T+11.1s→「tree-sitter · 本地」+ console「远程高亮失败，已回退本地高亮」。

**BUG-37【medium · verified】yaml 本地 wasm 高亮全链静默失败：vendored 遗留产物在 Parser.parse 首调外部 scanner 时抛 TypeError，错误被 highlight 外层 catch 吞为 {ok:false}，全链零日志恒降级 hljs**

- **域/根因位置**：hl｜`apps/web/static/grammars/yaml.wasm`（sha256=5dea7cff…d5 与 `tools/grammar-builder/fixtures/yaml.wasm` 完全一致，manifest source="vendored"，非候选所称 gen:grammars self-built——docs/spec-deviations.md:115 记录 yaml 因 C++ 外置 scanner 无法自建而 vendored）× `packages/highlight/src/core-parse.ts:153-186`（highlight 外层 catch 吞 parse 错误）、`:248-260`（console.warn 仅覆盖 doPrepare 拒绝，而 yaml 的 doPrepare 成功）。
- **现象与校准**：本地策略下任何正常 yaml 文件恒降级「hljs 兜底」（ts=0、hljs=9），零 UI 错误、零 console 输出；同批 vue/php/html/python/bash 本地全部正常，远程 compute 路径 yaml 正常——仅本地 wasm 路径坏。失败阶段校准：load 与 setLanguage 均成功，是 Parser.parse 首调外部 scanner 时抛 `TypeError: resolved is not a function`（web-tree-sitter 0.25.10 glue tree-sitter.js:2947 stubs，scanner 符号解析为非函数）。测试缺口：`rg 'yaml' packages/highlight/test/` 零命中。维持 medium：hljs 兜底仍产出着色、语言标签正确，属可用的近似降级，但 yaml 是高频配置语言且零可观测线索。
- **复现**：打开实例 → 15s 内（避开 BUG-35 看门狗）upload 注入正常 yaml 并打开 → 状态栏「高亮: hljs 兜底 · 执行: 本地 · 语言: yaml」。
- **证据**：node 同构 `node /tmp/review-hl-e5/load-check.mjs`：yaml `load OK, PARSE FAIL: TypeError: resolved is not a function`，vue/php/html parse OK（captures 28/15/21）；引擎级 vitest 同构 yaml FAIL / vue/php/html/python/bash OK；UI 端到端 4199/8391 两档 config.yaml → hljs 兜底 + page.on('console') 共捕获 0 条（全链静默）、app.vue 对照 ts=26；curl 两档 `/grammars/yaml.wasm`、`/queries/yaml/highlights.scm` 均 200；远程对照 POST 8391 lang=yaml → 正常区间。

**BUG-38【low · verified】以 \n 结尾的文件多渲染一条虚行：状态栏行数与 gutter 自相矛盾，滚到底发出 {startLine:N} 越界请求必 400**

- **域/根因位置**：hl｜`packages/render-text/src/code.ts:140-142`（buildLineIndex 用 `text.split('\n')`，尾换行多出空元素）、`:672`（虚拟滚动按 lines.length 挂载）、`:939-946`（getMeta 按 wc -l 口径减 1）、`:721-731,757-758`；`server/src/compute/highlight.rs:474-481`（StartBeyondEof → 400）；`apps/web/src/lib/highlightRouter.ts:78,94-99`（auto 策略 catch 后 warn+null）。
- **现象与校准**：'a\nb\nc\n' 渲染 4 行而状态栏「行: 3」；滚到底发出 `{"range":{"startLine":48000,"lineCount":1}}` → 400 + console warn，该虚 chunk 静默落行级 hljs（行内容为空故无可见画质损失）。维持 low：默认 auto 下用户可见影响仅为多余空行、一次必失败请求与告警，真实行内容零错位。加重场景：显式 remote 策略下同一 400 走抛错分支，滚到底会把整个预览替换为「无法预览此文件 / 远程高亮失败: HTTP 400」错误卡片并停机（非默认策略，建议分诊时一并考虑）。
- **复现**：注入 'a\nb\nc\n' 打开 → gutter 4 行/状态栏 3 行；48000 行 server-served big.js 一步到底 → 网络面板 400。
- **证据**：API 直证自起 8440 实例：startLine=48000 → 400「range.startLine 48000 is beyond end of file: 48000 lines」，47999/47800+200 → 200；Playwright `node /tmp/vv-recheck/repro.mjs`：网络捕获恰 3 条（0+200、47800+200、48000+400）+ console 恰 1 条回退 warn，末行 dataLine=48000/gutter=48001/body='' 而状态栏「行: 48000」，底部真实行与源逐字符一致（纯虚行、零错位）；加重场景 `repro-remote.mjs` 复现错误卡片停机。既有套件 t-hl.spec.ts:393 特意用「末行不带 \n」构造避开此口径，佐证未覆盖。

**BUG-65【medium · verified】.pl 扩展名在前端语言检测首表被误识为 prolog（first-wins），hljs 以 prolog 语法着色 Perl 源：关键字零着色、语言标注错误，且与服务端 detect 相悖**

- **域/根因位置**：hl｜`packages/highlight/src/langdetect.ts:22-33`（buildTables 首表 first-wins，languages.json 中 prolog 条目 fileTypes 含 'pl' 排在 perl 之前）→ `packages/render-text/src/code.ts:679-687`（hljs 兜底以检测语言名指定语法）；对照 `server/src/detect.rs:97`（同扩展名映射 perl，注释自证 `perl < prolog` 有序）。
- **现象与校准**：sample.pl 状态栏「语言: prolog」，hljs-keyword=0、hljs-*=9（以 perl 语法应为 19/50），文本内容渲染正确、无崩溃/数据丢失/错误内容。用例已按约定转 `apps/web/e2e/t-hl.spec.ts:848` test.fixme（「HL-02 [CAND-hl-F1]」占位勘误并入，断言原样保留未放宽）。维持 medium：.pl 整类文件高亮静默失效且语言标注错误。
- **复现**：vite preview（4173）打开含 samples/m2/sample.pl 的目录 → 点击 sample.pl → 状态栏「语言: prolog」、无关键字着色。
- **证据**：根因静态核实（node 镜像 buildTables 逻辑输出 `first-wins pl -> prolog`）；浏览器端到端两次运行诊断一致（statusbar 含「语言: prolog」、hljsAll=9、hljsKeyword=0、HL-02 原样断言初跑与 retry #1 均失败于同一处）；语法归因交叉验证：hljs 实跑 `prolog` 得 0/9、`perl` 得 19/50（前者与浏览器逐数吻合，后者与文档判据逐数吻合）；环境错配排除：lite 34 集 manifest 无 perl/prolog，状态栏「hljs 兜底」属预期降级形态。

#### 主题系统（3 条）

**BUG-49【medium · verified】themeMode=「跟随系统」时 OS 亮暗切换（不刷新）后，代码主题下拉显示值与实际生效主题脱钩，此时切换主题写入错误槽位并污染另一槽位**

- **域/根因位置**：theme｜`apps/web/src/lib/TopBar.svelte:24`（`$derived(effectiveMode(...))`，matchMedia 非响应式信号，derived 仅依赖 settings.themeMode）、`:40-43`（onSystemModeChange 仅重应用样式不更新 state）、`:60-66`（按陈旧 mode 决定写入哪个槽位）；`apps/web/src/lib/theme.ts:210-215`。
- **现象与校准**：light 初始 → 仿真切 dark 后 select 仍显示亮槽位主题而实际已应用暗槽位主题；此时在下拉选主题会持久化到与用户眼前暗态相反的亮槽位，且下拉值跳变；切回亮态后亮槽位被用户从未在亮态选过的主题污染。对照实验：刷新页面（mode 正确初始化）后暗态选主题正确写入暗槽位——缺陷仅限「OS 切换后未刷新」的陈旧 mode 场景。维持 medium：功能行为错误（写错持久化槽位）但可刷新绕过。
- **复现**：见上（colorScheme 仿真 light 打开 → 预写 settings → 不刷新切 dark → 读 select value 与 style#vv-code-theme 注释 → 下拉选 onelight → 读 localStorage）。
- **证据**：`node /tmp/vv-recheck-theme-E1/recheck.mjs`（4199 与 8391 两档、独立脚本）：四项判定全 true（B1 脱钩、B2 写亮槽位 onelight、B3 亮槽位被污染）；细节亦吻合（写槽读陈旧 'light'、注入样式经 derived 重算读到 'dark'，注释确为「onelight（dark）」）。

**BUG-50【medium · verified】代码主题注入清单 CODE_CAPTURES（53 项）与各语言 highlights.scm 实际 capture 集系统性缺口：数字/布尔/keyword.storage/return 等高频 token 在任何主题下恒不着色**

- **域/根因位置**：theme｜`apps/web/src/lib/theme.ts:48-102`（CODE_CAPTURES 53 项）× `apps/web/src/app.css:55-81`（.ts-* 规则与之对齐）× 各语言 `apps/web/static/queries/<lang>/highlights.scm`（实际产出清单外 capture）；span 类名与 CSS 规则两端均无 resolveCapture 式前缀回退（`packages/highlight/src/theme.ts:15-24,31-33` 的回退仅用于变量注入）。
- **现象与校准**：long.rs 视口 413 个 ts-span 中 63 个（15%）三主题下计算色恒为默认前景 rgb(31,35,40)（ts-keyword-storage=18、ts-keyword-control-return=9、ts-constant-numeric-integer=36），对照 string/comment/function/type 正常变色。静态差集：rust 缺 20、go 缺 13、ecma 缺 12、c 缺 8、python 缺 7、java/cpp/kotlin/swift/zig 各缺 6~11；缺口比上报更广——约 240 个语言至少缺 1 个（scss 缺 26、djot 缺 21、markdown 缺 15）。themes.json 三主题表虽无直接键但经前缀回退可解析到色（如 constant.numeric=#0550ae/#79c0ff）——若入清单即可着色，缺口纯在清单与 CSS 对齐层。维持 medium：主题功能局部失效（高频 token 不变色），非崩溃/完全不可用。
- **复现**：8391 打开 domain-theme-system/long.rs → 依次切 github_light→catppuccin_mocha→github_dark → 读三类 span 的 getComputedStyle().color 恒 rgb(31,35,40)。
- **证据**：自跑 python 差集脚本（同口径扫描全部 @capture 与 CODE_CAPTURES 精确差集，逐语言数字与上报一致）；`node apps/web/.temp/review-theme-e2/probe.mjs`：三主题下 style#vv-code-theme 均不含 --vv-ts-keyword-storage/-keyword-control-return/-constant-numeric-integer/-constant-builtin-boolean，--vv-ts-string 等为 true；span 计数与三主题不变色实测；`.ts-string` rgb(10,48,105)→rgb(166,227,161)→rgb(165,214,255) 对照。

**BUG-51【low · verified】系统偏好为暗色的用户每次导航/刷新都先渲染完整亮色首帧（FOUC），暗色恢复唯一入口是 AppShell onMount**

- **域/根因位置**：theme｜`apps/web/src/app.html:2-9`（无内联脚本在 HTML 解析期预置 data-theme-mode）、`apps/web/src/app.css:13,20-27`（暗色规则全依赖 [data-theme-mode] 属性选择器，默认 --ui-bg:#ffffff）、`apps/web/src/lib/AppShell.svelte:51`（data-theme-mode 唯一写入点在 onMount）。
- **现象与校准**：独立复现 6/6 次：白帧期本地实测 17~167ms（首访最长，缓存后 17~49ms；网络越慢越长）。仅影响暗色偏好用户（light 对照组全程白底无闪烁）。维持 low：短暂视觉闪烁，无功能损失。
- **复现**：`newContext({colorScheme:'dark'})` + addInitScript rAF 逐帧采样 body 背景与 html data-theme-mode → 导航 4199/8391：首帧 rgb(255,255,255) 且 mode=null，直至 JS 写入后变暗。
- **证据**：`node /tmp/review-theme-e3/fouc.mjs`：pure4199 firstVisit 60.2→226.9ms、second 20.8→54.1ms、third 32.4→49.1ms；srv8391 firstVisit 12.2→162.2ms 等，6/6 首帧白底；交叉验证 1：route abort 全部 *.js 后页面永久白底（暗色唯一入口在 JS）；交叉验证 2：light 对照无闪烁；视觉证据 `/tmp/review-theme-e3/dark-early.png`（完整亮色 UI）与 `dark-settled.png`。

#### Markdown 渲染（4 条，含承载 BUG-66）

**BUG-39【medium · verified】双引擎 heading id 方案不一致：远程 comrak 统一 user-content- 前缀而前端无 hash→前缀映射，远程档页内锚 16 条中 13 条死链、comrak 自产 anchor 11/12 指向不存在 id**

- **域/根因位置**：md｜`server/src/compute/markdown.rs:26`（ext.header_id_prefix=Some("user-content-")）vs `packages/render-text/src/markdown/markdownRenderer.ts`（slugifyHeading 无前缀、重名 -2 起）；comrak 0.56（server/Cargo.toml:22）该形态仿 GitHub（id 加前缀、内嵌锚 href 不加），GitHub 靠自家前端 JS 做映射，本仓库前端无任何此逻辑（rg 'user-content' 全源码零命中）。
- **现象与校准**：远程档下正文作者写的页内锚 3 条中 2 条死链（点击 hash 变化但 scrollTop 不动）；comrak 自产 anchor 12 条中 11 条死链、1 条碰巧命中作者 HTML 的 div id 滚到错误元素。TOC 面板按实际 DOM id 定位不受影响（实测点 TOC scrollTop 0→121 正常）。维持 medium：功能（页内锚导航）在远程档大面积失效但文档浏览正常、可本地策略绕过。
- **复现**：连接 8391 → 打开 explore-md/toc-edge.md（状态栏「渲染: 远程」）→ 点「到中文标题一」→ hash 变化但 scrollTop 保持 0；本地注入对照 scrollTop 0→121 正常。
- **证据**：`node /tmp/md-e1-repro/repro.mjs`：12 个 heading id 全带前缀（含 user-content-/user-content--1/user-content-标题--emoji 边界形态）；deadLinkCheck：远程档 16 条 a[href^=#] 中 13 条目标 id 不存在；本地档 id 为 中文标题一/section 等无前缀；API 直呼 curl POST /api/compute/markdown：comrak 原始输出 id 带前缀而内嵌锚 href 不带——自不一致系 comrak 0.56 输出行为；`toc.mjs` 证实 TOC 不受影响。

**BUG-40【medium · verified】markdown 渲染视图（主文档挂载、无 CSP 兜底）五类等价外联向量未被净化，浏览器真实发起外域请求（跟踪像素级隐私泄漏）；html 沙箱档属性同样保留但被注入 CSP 有效拦死（候选的沙箱档结论被推翻）**

- **域/根因位置**：md｜净化钩子 `packages/render-text/src/markdown/sanitize.ts:54-116`（仅覆盖 IMG 的 src/srcset 与 VIDEO/AUDIO/SOURCE 的 src）、`html.ts:44-57` 二次清洗仅 on*/src/href——放行 video/audio poster、SVG image href/xlink:href、行内 style url(...)、table background、input type=image src。
- **现象与校准（范围校准）**：md 档 8391 与纯前端档 4199 各 6 条向量 DOM 属性全保留且浏览器真实发起外域 GET（失败原因均为 net::ERR_EMPTY_RESPONSE，即请求已进入网络栈；4199 实为 6 条，比候选报的 2 条多）。**被推翻的子结论**：「html 沙箱档同样发出 6 条 GET」「srcdoc 内 CSP meta 不生效」不成立——html 档 6 条全部以 errorText='csp' 失败（CSP 在网络栈之前拦截）；对照实验证明本环境 Chromium 对 srcdoc 内 meta CSP 正常执行（srcdoc 有 CSP→服务器 0 命中，无 CSP→200 命中）；候选基线脚本只监听 page.on('request') 而 CSP 拦截的请求同样触发 request 事件，系误判来源。净结论：缺陷限于 md 档（及一切无 CSP 挂载路径）的真实外联泄漏。维持 medium：隐私类（跟踪像素可回传 IP/会话），回归面（img/srcset/iframe/script 等）经同快照确认完好无回退。
- **复现**：连接 8391 → explore-md/vectors.md 渲染视图 → 网络检索 external.example 命中 6 条 GET（poster/svg-img/svg-xlink/bg/tbg/input.png）。
- **证据**：`node /tmp/vv-repro-cand-md-e2/repro.mjs`（记录 request/requestfailed/requestresponse 三相）：md 档 requests=6 failures 全为网络层错误；DOM 五类属性原样保留、无 data-vv-blocked-external；回归面同快照完好（img[alt=plain] src 已剥且 data-vv-blocked-external='1' 等）；html 档 6 条 failures 全为 'csp'、contentDocument head 首子元素即注入 CSP meta（与 html.ts:27-28,68-71 一致）；纯 srcdoc 基线 5/5 'csp'；对照实验 control.mjs（本地计数服务器）证明 'csp'=网络栈之前拦截。

**BUG-42【low · verified】围栏代码块语言标识大小写不归一：```Rust 不命中小写清单键与别名表，tree-sitter 路径静默丢失降级 hljs；三策略一致**

- **域/根因位置**：md/hl（根因承载锚点 `apps/web/e2e/t-hl.spec.ts:599`）｜`packages/highlight/src/core-parse.ts:243-245`（canonicalLang 两级查找区分大小写）、`:376-382`（buildAliasTable 别名原样入表无 toLowerCase）；`apps/web/build/grammars/manifest.json` 34 键全小写、rust 别名仅 ['rs']。
- **现象与校准**：```Rust 块 cls="language-Rust hljs"（仅 2 个 hljs span），```rust 块 cls="language-rust"（10 个 ts-* span）；server-auto/显式 remote/本地注入三策略逐块一致；别名机制本身正常（```zsh 经别名命中 bash 出 ts-*）。维持 low：hljs 兜底仍提供着色，仅质量降级与同语言大小写行为不一致。
- **复现**：8391 连接 → explore-md/fence-matrix.md → 第 6 块（```Rust）与第 1 块（```rust）对照。
- **证据**：`node /tmp/vv-recheck-md-e4/recheck.mjs`（独立复现）：块1 {ts:10,hljs:0} vs 块6 {ts:0,hljs:2}、块5 zsh {ts:2}；三组逐块输出一致。

**BUG-66【low · verified】GFM 删除线双引擎不一致：本地 markdown-it 渲染 <s> 而远程 comrak 渲染 <del>，违反 MD-01「del 元素」判据与 CMP-05「DOM 指纹一致」判据**
（同一缺陷重复发现：发现域 计算卸载与全局搜索（编号 BUG-67，其侧定档 medium，理由是直接违反 CMP-05 验收①②、结构指纹必差一标签）已并入本条；场景用例载体 MD-01/2 [CAND-md-F1]（t-md.spec.ts:80）与 CMP-05 [BUG-67]（apps/web/e2e-server/t-cmp.spec.ts:239）按场景编号保留）

- **域/根因位置**：md（承载域）｜本地引擎 `packages/render-text/src/markdown/engine.ts:20-24`（markdown-it ^15.0.2，lock 锁定 15.0.2，首次引入即此版本从未升级）+ `package.json:13`；远程 `server/src/compute/markdown.rs:19,126-127`（ext.strikethrough=true，自带单测断言 <del>）；管线排除「殊途同归」：sanitize（DOMPurify 默认允许表 s/del 均存活）与 enrich/pipeline（无 s/del 归一）实测均不改变该差异。
- **现象与校准**：注入目录/纯前端模式（本地引擎路径）~~x~~ 渲染为 <s>；远程 comrak 出 <del>。视觉删除线本身正常（<s> 与 <del> 默认样式同为 line-through），无崩溃/数据丢失/错误内容——缺陷实质为语义标签与场景判据不符 + 双引擎 DOM 一致性偏差。主条目定档 low（md 域口径）；cmp 域口径 medium 分歧如实记录。
- **复现**：本地注入打开含 '~~删除线文本~~' 的 md → .vv-markdown 内 del=0、s=1、innerHTML="<p>正文含 <s>删除线文本</s> 与正常文本。</p>"、状态栏「渲染: 本地」；对照 POST 8391 /api/compute/markdown 同文本 → `<del>删除线文本</del>`。
- **证据**：Node 直载实际包 `node --import ./hook.mjs repro.mjs`（engine.ts 同配置）输出 `<s>`、has <del>: false；浏览器端到端（自起 8440 纯前端档，POST /api/compute/markdown → 404 证实；镜像 t-md MD-01/2 注入通道）del=0/s=1；远程对照活体 8391 → <del>；`node /tmp/cand-s4/repro.mjs`（cmp 并入条证据）：同一夹具 remote 轮 <del>×1 / local 轮 <s>×1，结构指纹必差一标签；jsdom+dompurify 管线复刻排除归一。

#### 文件内搜索（1 条）

**BUG-44【low · verified】HTML 文件源码↔渲染视图切换后搜索面板计数陈旧不刷新，双向复现；渲染视图下 Enter 计数本地空推进而文档内无导航且不报错（校准：数字会变但导航无效，比上报的「无响应」更具误导性）**

- **域/根因位置**：fsearch｜`packages/render-text/src/html.ts:155-163`（setView 切换仅 unmount+mount，不通知 SearchPanel）、`:185-190`（渲染视图 search 恒返回空、gotoMatch 空操作）；`apps/web/src/lib/SearchPanel.svelte:59-92`（runSearch 无视图变化观察者）、`:95-100`（step() 不校验当前视图是否有命中故本地推进计数）；对照 `ViewerPane.svelte:202`（仅 tab 切换 cleanup 才关面板）。
- **现象与校准**：(a) 源码视图搜到 1/5 后切渲染视图，面板仍 1/5（600ms/2100ms 无自我修正），Enter 后 2/5 但无导航效果；(b) 反向：渲染视图「无结果」后切源码视图仍「无结果」（源码实际可得 1/5 且无命中高亮，Enter 因 total=0 直接 return）。重输 query 立即恢复，面板可恢复，问题仅在视图切换不触发重搜。维持 low：状态指示错误但不丢数据、易恢复。
- **复现**：4199（或 8391 同 build）打开恰含 5 处 "section" 的 page.html → 「源码」→ / 搜 section 得 1/5 → 「渲染」→ 读计数并按 Enter/等 600ms 复读。
- **证据**：`cd apps/web && BASE=http://127.0.0.1:4199 node .temp/verify-fsearch-E2/repro.mjs` 七步输出（[2] 切渲染后仍 1/5、[3] Enter 后 2/5 activeLine=0、[5] 渲染视图直接搜「无结果」、[6] 切回源码仍「无结果」、[7] 重输恢复 1/5；pageErrors 无）；BASE=8391 输出逐行一致；文档核实：FSEARCH-05 仅测源码视图计数，无视图切换搜索状态场景，非已知缺陷。

#### 媒体与 Office（3 条）

**BUG-52【medium · verified】损坏/截断音频解码失败后完全静默：原生 <audio> 路径无任何 error 监听，audio.error code=4 但无错误卡片；对照视频分支（ArtPlayer error→错误卡片）与 BUG-14 升级链均正常——唯独音频分支漏接**

- **域/根因位置**：media｜`packages/render-media/src/av.ts:367-384`（音频分支只创建 audio.vv-av + blob src，无 error 监听）vs `:476-479`（视频分支 art.on('error')→showMediaError）；影响全部音频扩展名（mp3/wav/flac/m4a/aac/oga/opus）。
- **现象与校准**：broken.mp3（ffmpeg sine 截断 300B）/broken.wav（44B）均 audio.error code=4（DEMUXER_ERROR_COULD_NOT_OPEN）且 .vv-error-card 为 null、无动作按钮，UI 仅空 0:00/0:00 控件；同条件截断 mp4 走视频分支正常弹「无法播放此媒体」+[重试,降级查看]。维持 medium：非崩溃/数据丢失/错误结果（损坏音频即便有卡片也无法播放），缺的是错误呈现与重试/降级恢复路径，属健壮性/错误处理一致性缺陷。
- **复现**：起实例（root 含 .temp/explore/media/data）→ 树点击 broken.mp3 → 页内 eval `document.querySelector('audio.vv-av').error` → {code:4,…}、`document.querySelector('main .vv-error-card')` → null。
- **证据**：源码对照实读；agent-browser 连接后点击两文件均 {code:4, errorCard:false}；对照 broken.mp4（另一实例 8442，head -c 20000 截断）→ {card:true, detail:「无法播放此媒体：未知错误」, actions:["重试","降级查看"]}；截图对比 `/tmp/cand-media-e1/broken-mp3-8442.png`（空控件无卡片）vs `/tmp/cand-media-e1/broken-mp4-card.png`；rg 全仓无 audio 元素错误兜底；覆盖缺口：现役 e2e 仅 t-pwa.spec.ts:483 正常音频可起播，无损坏音频错误呈现用例。

**BUG-53【medium · verified】损坏图片解码失败无任何兜底：img error 事件已触发（capture 级监听捕获）、naturalWidth=0，但无错误卡片无重试/降级按钮，仅裂图+alt；与 BUG-14 修复后的 av/Office 渲染器行为不一致**

- **域/根因位置**：media｜`packages/render-media/src/image.ts:68-69`（img.src 设置后不监听 error，render 亦不校验解码结果）；BUG-14 修复范围（docs/report/e2e/e2e-fix-report-2026-10-08.md:35）仅 av.test.ts/截断 mp4/PDF，不含 image。
- **现象与校准**：broken.jpg/broken.webp（JPEG/WebP magic 头+垃圾数据）naturalWidth=0、complete=true、无卡片；同一实例损坏 mp4 出统一错误卡片，证实渲染器间兜底不一致。维持 medium：正常图片渲染不受影响（对照 good.png naturalWidth=8），属错误呈现缺失类缺陷，与原 BUG-14 同级。
- **复现**：8431（或自起）实例 → 树点击 broken.jpg → eval naturalWidth=0、.vv-error-card=null。
- **证据**：`cd /tmp/reverify-media-e2 && node verify.mjs <name> img` 三次运行：jpg/webp mediaErrs 含 img error + hasCard=false + naturalWidth=0；对照 good.png 正常渲染排除渲染器整体失效；对照 broken.mp4 → hasCard=true+重试按钮（与 e2e-server/b-media-office-viewer.spec.ts:181-184 断言的修复后行为一致）；截图 shot-broken.jpg.png。

**BUG-54【low · verified】av 渲染器视频运行期错误卡片文案恒为「无法播放此媒体：未知错误」：ArtPlayer 在 emit('error') 前先 sleep→重设源清空 video.error，av.ts 读到的恒为 undefined，错误详情映射表不可达**

- **域/根因位置**：media｜`packages/render-media/src/av.ts:476-478`（回调忽略事件参数、读 art.video?.error）+ `:270-278`（映射表 default 分支）；`node_modules/.pnpm/artplayer@5.4.0/.../artplayer.mjs:2495-2501`（video:error handler：await sleep→art.url=option.url→art.emit("error")，唯一 emit 位置）、`:4976-4977`（RECONNECT_SLEEP_TIME=1e3）。
- **现象与校准**：code=3（解码失败）与 code=4（格式不支持）两场景卡片文案均「未知错误」（按映射表本应分别为「解码失败…（MEDIA_ERR_DECODE）」「媒体源不可达…（MEDIA_ERR_SRC_NOT_SUPPORTED）」）。影响限于错误详情的诊断信息量：卡片本身、重试/降级按钮、播放器摘除均正常；BUG-14 验收「含明确错误信息」达成度被削弱，但现役 e2e（b-media-office-viewer.spec.ts:419）只断言「无法播放此媒体」前缀，不红。维持 low。
- **复现**：8391 打开 domain-media-office-viewer/broken-video.mp4（code=4）等卡片出现读文案；8440 对照 hollow.mp4（mdat 挖空，code=3）同文案。
- **证据**：`node /tmp/vv-review-e3/repro.mjs`（document 捕获级监听记录真实 MediaError + 读卡片）：8391 {"detail":"无法播放此媒体：未知错误","videoErrors":[{code:4,…}]}（截图 broken-mp4-8391.png）；8440 {"…videoErrors":[{code:3,…}]}（截图 hollow-8440.png）；源码链实读如上。

#### hex 与压缩包（1 条）

**BUG-55【high · verified】hex 虚拟滚动用单元素 spacer 表达总行高，超过 Chromium 单元素高度上限 33,554,428px（文件 >≈28.44MiB）后被钳制：尾部数据任何滚动方式无法到达，滚到底停在错误偏移且状态栏无任何末偏移/截断提示**

- **域/根因位置**：bin｜`packages/core/src/virtualScroller.ts:25`（spacer.style.height = rowCount×lineHeight 单元素实现）+ `packages/render-binary/src/hex.ts:76`（rowCount=ceil(len/16)）、`:12`（行高 18px）；阈值推算 33,554,428/18×16≈29,826,144B 与 28/30MB 实测边界吻合；`hex.ts:5` 注释自述「滚动到底即达数据末偏移」。违反 docs/e2e/binary-hex-archive.md:23 BIN-02 期望③与 :99 §4.3 第 3 条。
- **现象与校准**：40MB 文件尾部 12,116,704B（≈28.9%）经唯一查看器彻底不可查看（hex.ts 无偏移跳转输入，binary 域不适用文本跳转），滚到底视口末行停在 0x01c71d10~0x01c71d20（真实末行应为 0x027ffff0）——属「错误结果」+大文件尾部不可查看且无替代通道；状态栏仅「40.0 MB · 未知二进制」，用户会误认为已到文件末尾。数据本身服务端完好（Range 请求末 16B 返回 206/16B），纯 UI 滚动域缺陷；<28.44MiB 不受影响（28MB 对照组末行 0x01bffff0 精确吻合、尾部 0 字节不可达）。维持 high。
- **复现**：准备 big-40mb.bin（41,943,040B 确定性伪随机）→ 实例连接 → 打开 → 滚到底（程序化 scrollTop=scrollHeight 或滚轮循环到底）→ 可视末行偏移停在 0x01c71d10~0x01c71d20。
- **证据**：根因机制直接坐实：空白页设 div height:47185920px 实测 offsetHeight=33554428（Chromium 上限钳制）；40MB 页面内 spacer style 属性 'height: 4.71859e+07px;'（CSSOM 科学计数法序列化）+ offsetHeight=33554428；独立脚本 `node /tmp/cand-bin-e1/verify.mjs`：28MB {clamped:false, lastRowOffset=期望, unreachableTail:0} / 30MB {clamped:true, 期望 0x1dffff0 实得 0x01c71d10, unreachable:1,630,944} / 40MB {scrollTop=33553652=maxScrollTop, 期望 0x27ffff0 实得 0x01c71d10, unreachable:12,116,704}；滚轮通道复验 maxScrollTop=33553656、tailUnreachableBytes:12,116,688；curl `Range: bytes=41943024-41943039` → 206/16B 证明服务端尾部完好；源码与验收口径行号核对一致。

#### 服务端文件服务（4 条）

**BUG-45【medium · verified】`vviewer serve --cors-origin '*'` 在 bind 前急切执行 build_router，'*' 直传 tower-http AllowOrigin::list 触发库内 panic（exit 101），违背项目自身「配置错误返回 exit code（不 panic）」约定**

- **域/根因位置**：srv｜`server/src/lib.rs:131-137`（from_str 校验通过后 `AllowOrigin::list([origin])`）+ `server/src/main.rs:149`（build_router 先于 bind 执行）+ `main.rs:92` 注释明示约定；docs/deploy.md:40 仅提示「填精确 origin」未显式排除通配值。
- **现象与校准**：启动即 panic 退出（exit=101），health 永远 connection refused；正确用法（精确 origin）一切正常。校准为 medium：启动即崩溃但触发面是单一可选参数值、立即响亮失败、无数据丢失，替换解法 trivial。对照：`--allow-lan` 无 token 为干净的 exit=2 + 明确报错（SRV-10 已裁决形态）。
- **复现**：`vviewer serve --root <目录> --web-dist apps/web/build --port <空闲> --cors-origin '*' ; echo $?` → 101。
- **证据**：两轮独立复现（8432/8433 复验轮）exit=101，panic 栈 `tower-http-0.7.1/src/cors/allow_origin.rs:61:13: Wildcard origin (*) cannot be passed to AllowOrigin::list. Use AllowOrigin::any() instead`（日志 `/tmp/vv-review-srv-e1/8441.log`）；事后 curl exit 7 + ss 无监听证实进程确死；正对照 `--cors-origin 'http://127.0.0.1:4199'` 于 8443 正常启动且带 Origin 请求正确回显 ACAO——panic 特异于 '*'；曾出现的「curl 得 200」假信号经 ss/ps 甄别为兄弟域实例占用 8433 的撞车，结论不受影响。

**BUG-46【low · verified】NUL 字节 path、自环 symlink（ELOOP）、超长文件名（ENAMETOOLONG）三类病态输入经 /api/file 与 /api/tree 均归 500 Internal Server Error，而非 4xx 客户端错误归类**

- **域/根因位置**：srv｜`server/src/guard.rs:34-37`（canonicalize 失败仅 NotFound→404，其余一律 AppError::internal→500）、`server/src/error.rs:32-34`、调用点 `routes/file.rs:187`、`routes/tree.rs:44`。
- **现象与校准**：服务不崩溃（异常请求后基线请求仍 200）、错误 body 为纯 errno 文本无路径泄露，但把调用方可构造的病态输入标成服务器内部故障，误导监控与重试语义。维持 low。
- **复现**：`curl '/api/file?path=base.txt%00'` → 500 NUL；root 内 `ln -s loop-self loop-self` 后 `curl '/api/file?path=loop-self'` → 500 ELOOP；`curl "/api/file?path=$(printf 'a%.0s' {1..5000})"` → 500 ENAMETOOLONG；`/api/tree?path=%00` 同 500。
- **证据**：自起实例 8440（二进制新于 guard.rs 改动，基线 200）六条实测（含变体 base.txt%2e%2e%00.png → 500 NUL）；对照 `path=../x` → 400（清洗层正常，错位仅在 canonicalize 错误分支）；上报所引 probe-srv-out.json 的 id=7/8/15/61 记录确实存在且 status 均 500。

**BUG-47【low · verified】多区间 Range 只回第一区间的单区间 206（第二区间静默丢弃、无 multipart/byteranges 也不回 200 全量）；If-Range 完全被忽略（不匹配仍 206 而非 200 全量）**

- **域/根因位置**：srv｜`server/src/routes/file.rs:33`（`spec.split(',').next()` 取第一区间后丢弃其余）、`:201-209`（仅读取 RANGE 头，全函数无 IF_RANGE 分支）、`:222-237`（响应头无 ETag/Last-Modified——验证器缺失时第三方按 RFC 本不应使用 If-Range）。
- **现象与校准**：同矩阵其余 20 条（单区间/后缀/0-0/越界钳制/倒挂/空文件/u64 溢出/HEAD/内容字节校验）全部符合 RFC。维持 low：vviewer 前端不使用这两特性，影响面仅限第三方客户端。
- **复现**：256B range.bin（字节值=偏移）：`curl -s -H 'Range: bytes=0-1,3-4' -D -` → 206 bytes 0-1/256、body hex 0001（非 multipart）；`-H 'Range: bytes=0-9' -H 'If-Range: "etag-xyz"'` → 206（RFC 9110 要求条件不满足回 200 全量）；If-Range HTTP-date 形态同样仍 206。
- **证据**：自起实例 8440（root=/tmp/vv-e3/root）两族实测，换区间 `bytes=100-105,200-205` → body 'defghi' 第二区间确被丢弃；单区间语义正常（`bytes=-4` → 206 bytes 252-255/256 body fcfdfeff）说明非普遍 Range 破坏；源码行号实读定位。

**BUG-48【low · verified】非 UTF-8 文件名经 /api/tree 列出即永久不可经 API 寻址：to_string_lossy 把磁盘字节替换为 U+FFFD，替换名与原始字节两形态请求均恒 404**

- **域/根因位置**：srv｜`server/src/routes/tree.rs:53`（`e.file_name().to_string_lossy()`）+ 下游 /api/file 按 String path 走 guard::resolve→canonicalize；axum Query 的 String 反序列化无法还原非法 UTF-8（%FF%FE 亦 404）。
- **现象与校准**：磁盘上完好的文件一旦被服务端列出便无法通过任何 HTTP 路径名寻址，树中呈现为乱码名；正常名字（空格/中文）不受影响。维持 low：边界场景缺口。
- **复现**：数据根内 `printf 'nonutf8\n' > "$(printf 'bad\xff\xfename.txt')"` → `curl /api/tree?path=.` → name 为 `bad\uFFFD\uFFFDname.txt`；`curl '/api/file?path=bad%EF%BF%BD%EF%BF%BDname.txt'` → 404。
- **证据**：od 确认磁盘名字节 `62 61 64 ff fe …`；列出名 UTF-8 字节含两个 ef bf bd 替换；原始字节 %FF%FE 请求同样 404——不存在可寻址的编码形式；对照 ok.txt → 200。复测后实例已停、端口释放。

#### 计算卸载与全局搜索（2 条）

**BUG-56【low · verified】显式 remote 策略下 ≤2MB 常规链远程高亮失败后状态栏永久停留「高亮: 解析中… · 执行: 远程」（engine 停留初始 'pending'），与既裁决口径「失败后引擎置终值」不一致（大文件 chunk 路径则正确置「纯文本」）**

- **域/根因位置**：cmp｜`packages/render-text/src/code.ts:583`（engine 初始 'pending'）、`:896-903`（RemoteComputeError 分支 showErrorCard 后直接 return 不置终值）vs `:773-778`（大文件 chunk 失败路径 `engine='plain'; computeWhere=null`，注释明言置非 pending 终值）。
- **现象与校准**：t0/t5/t15 三次读状态栏逐字相同（永久驻留，不自愈）；校准细节：t0 读不到「执行: 远程」仅因状态栏 250ms 轮询，实际 computeWhere 在请求期已被 onWhere 回填。维持 low：仅错误场景下状态指示误导，内容展示与错误卡片均正常。
- **复现**：起 `--compute` 实例（root 含 sample.jsonc，301 集外语言）→ localStorage 注入 `{"computePolicy":"remote"}` → 同源连接 → 打开 sample.jsonc → 错误卡片「远程高亮失败: HTTP 400」出现后立即与 5s 后各读状态栏。
- **证据**：自起 8443 实例：服务端 x-vv-lang: jsonc、POST 400 "unsupported language: jsonc"（对照 lang=python 200）；UI 探针 t0=「高亮: 解析中…」t5=「…解析中… · 执行: 远程…」t15 相同，恰 1 次 POST 400，截图 `/tmp/vv-review-cmp-e1/rv-t0.png`、`rv-t5.png`；对照组 2.3MB rv-big.jsonc 走 chunk 路径 t5=「纯文本 · …」置终值，坐实两路径口径不一致；既有 CMP-04 用例（b-compute-global-search-server.spec.ts:379-386）只断言错误卡片与 400，未锚定状态栏终值。

**BUG-57【low · verified】服务端全局搜索单文件命中静默截断至 50（rg --max-count）且终帧 truncated=false、UI 无不完整提示：同一查询双路径结果不一致（服务端 50 vs 纯前端 60）**

- **域/根因位置**：cmp｜`server/src/routes/search.rs:42`（RG_MAX_COUNT="50"）、`:272-286`（终帧 truncated 仅由 1000 命中全局上限驱动，单文件截断无信号）；对照 `packages/core/src/compute/search.ts`（grepStoreLocal 无单文件命中上限，仅 2000 文件/200MB/1000 命中）；UI `GlobalSearchPanel.svelte:126,225`（仅 truncated 时追加「（结果不完整，已达上限）」）。
- **现象与校准**：--max-count 50 是有意设置的参数（注释与单测围绕它设计），缺陷点不在参数本身，而在「截断无信号」与「双路径结果不一致」——1000 全局上限触达有提示，单文件 50 上限触达没有。维持 low：不崩溃、不丢数据，返回的 50 条均为真实命中。
- **复现**：数据 60 行 "needle line N" → `curl -X POST :PORT/api/search -d '{"pattern":"needle"}'` → 该文件恰 50 帧、终帧 {"done":true,"truncated":false}；UI Ctrl+Shift+F → 「50 个命中」无提示。
- **证据**：自起 8441（root=/tmp/cand-cmp-e2/root）API 实测；rg 参数对照（同参直跑 50 / 去 --max-count 60）；node 直跑产品源码 grepStoreLocal → total=60；agent-browser UI「50 个命中」+ 截图 `/tmp/cand-cmp-e2/artifacts/gs-needle-50-hits.png`。未运行项：纯前端档 4199 的 UI 对照未做（本地目录打开依赖浏览器文件选择对话框），但 node 直跑已覆盖纯前端路径行为（UI local 调用即该函数）。

#### PWA 与移动端（6 条）

**BUG-58【medium · verified】/grammars/manifest.json 不在任何 SW 缓存策略内（precache glob 仅 js/css/woff2、三条 runtimeCaching 均不含 .json）：离线启动会话 grammar 资产三层 fetch 全失败，create() 单例固化不重试，全会话本地 tree-sitter 降级 hljs——即使 rust.wasm/queries/tree-sitter.wasm 此前已全部进入运行时缓存**

- **域/根因位置**：pwa｜`apps/web/vite.config.ts:153`（globPatterns）、`:169`（additionalManifestEntries 仅 index.html）、`:174/:189/:199`（三条 runtimeCaching urlPattern 均不匹配 manifest.json）；`apps/web/src/lib/highlightClient.ts:229-238`（create() 装配三层 manifest，单例固化）、`:46,87-97`（失败不重试）。
- **现象与校准**：A 组（离线启动）：在线打开 p1.rs 至 tree-sitter、三份运行时缓存确认含 rust 资产 → CDP 清 HTTP 缓存保留 CacheStorage + setOffline + reload → console 捕获 manifest 两条 ERR_INTERNET_DISCONNECTED + 「grammar 资产三层全部加载失败…降级 hljs」error → 离线注入 rust 打开为「hljs 兜底」，而此时三份缓存经 caches API 复查仍原样完整。B 组对照（先在线后离线、不 reload）离线高亮正常 tree-sitter——缺陷仅在离线启动路径。curl 辅证 manifest 无 Cache-Control（启发式新鲜度过期后离线无法重验证，真实「隔天离线启动」同样命中）。维持 medium：hljs 兜底保证功能可用，但主代码查看引擎离线启动会话全会话不可用且无法恢复。
- **复现**：见上 A 组流程（脚本 `apps/web/.temp/explore-pwa/p3c-manifest-offline.mjs`；独立复核 `apps/web/.temp/recheck-pwa-e1/recheck.mjs`）。
- **证据**：独立复核 A/B 两组对照 + 缓存清单逐项枚举（vv-grammars/vv-queries/vv-runtime 各含 rust 资产）+ 离线后缓存仍在的结构化输出 `.temp/e2e-artifacts/recheck-pwa-e1/{A-offline-startup-rust.png, B-online-then-offline.png, recheck-result.json}`；文档边界核实：docs/e2e/pwa-mobile-performance.md BUG-06/PWA-03 验收序列为同会话「在线打开→set offline→离线打开」，不覆盖离线启动路径。

**BUG-59【medium · verified】libarchive.wasm（约 1MB）无任何 SW 缓存通道（不在 precache 也无 runtimeCaching 路由）：断网后打开 tar/tgz/tbz2/xz/7z/rar 必然 20s 超时报错；zip 不受影响（JS 解包）**

- **域/根因位置**：pwa｜`apps/web/vite.config.ts:153`（globPatterns 不含 .wasm）、`:170-207`（runtimeCaching 无 libarchive 条目）；消费侧 `packages/render-archive/src/libarchiveStore.ts:1-2`（tar 等六格式走 libarchive.js wasm 解包）、`:89`（OPEN_TIMEOUT_MS=20_000）、`:168-169`（超时文案）。
- **现象与校准**：在线功能完全正常（网络层确认 GET /libarchive/libarchive.wasm 200、解包成功）；离线 tar 在 20s 后弹「无法预览此文件 / 打开压缩包超时（20s）…」错误卡片（含重试/降级，失败模式优雅可恢复）。维持 medium：仅 PWA 离线场景归档预览不可用。
- **复现**：在线打开 tar 解包成功 → caches 枚举确认 wasm 不在任何缓存 → 清 HTTP 缓存 + setOffline + 注入同字节 tar → 22s 内错误卡片；恢复在线对照解包成功。
- **证据**：静态层 `curl -sI` 得 wasm 200/1002547B；sw.js grep：registerRoute 共 4 条（Navigation + 语法三条 CacheFirst）、precache 零 .wasm 条目；运行时 `node apps/web/.temp/pwa-review/repro-cand-pwa-e2.mjs`（对 8391，samples/m4/sample.tar）：⑤在线 200 解包 pane=`▸nestedhello.txt（14 B）`、⑥caches 2 缓存 140 条 libarchive 相关仅 worker-bundle.js、⑦离线错误卡片（截图 `/tmp/pwa-review-e2/r2-offline-tar.png`）、⑧恢复在线解包成功、⑨zip 离线对照解包成功（范围断言成立）。

**BUG-60【low · verified】vv-grammars/vv-runtime/vv-queries 三个 runtime 缓存 cacheName 拼 BUILD_REVISION 且无任何跨版本清理：每次部署旧 REV 缓存永久残留、随部署次数线性累积（两版累计 ≈2.5MB）；vite.config.ts 注释「随 expiration 清理」与实现不符**

- **域/根因位置**：pwa｜`apps/web/vite.config.ts:20-23`（注释断言）、`:177/:192/:202`（cacheName 模板拼 BUILD_REVISION）；SW 产物 sw.js 的 cleanupOutdatedCaches 仅清 precache 前缀缓存，runtime 缓存名带 REV 无清理机制（sw.js 中 grep caches.delete/caches.keys 零命中）；ExpirationPlugin 只作用于当前 cacheName 内部条目。
- **现象与校准**：运行时实证三次版本后 precache 始终单份、vv-* 每版残留一份（v1 {runtime 201KB + grammars 1089KB} → v2 旧份原样残留+新增 → v3 四份残留+新增）。纯存储泄漏，无功能影响，维持 low；注释「不再命中」部分正确、「随 expiration 清理」不成立。
- **复现**：仓库 build 干净副本起实例 → 在线打开 rust 触发缓存 → sed 换 sw.js REV（0.1.0→0.1.1→0.1.2）模拟部署 → 每次 reload（autoUpdate 自动接管，页面 marker 证实）后读 caches。
- **证据**：独立从仓库重建副本（上报者副本已被 sed 污染到 0.1.2，未采信其状态）；`node apps/web/.temp/rc/verify.mjs` 三版 caches 全量输出与字节数；sw.js 静态 grep（三个 REV 缓存名 + maxEntries/purgeOnQuotaError + 零 caches.delete）。

**BUG-61【low · verified】≤900px 移动视口（375×667 实测）点击抽屉文件树文件后抽屉不自动收起：无遮罩元素、点抽屉外无效、Escape 无效，唯一收起途径是再点 ☰**

- **域/根因位置**：pwa｜`apps/web/src/lib/AppShell.svelte:207-209`（onTreeOpen 仅 addTab，无 drawerOpen=false）、`:301`（抽屉唯一开关 ☰）、`:351-371`（≤900px 抽屉 fixed、全组件无 overlay/backdrop 元素）、`:232-271`（全局键位无 Escape 处理）；覆盖核对：PWA-05 验收仅「无横向溢出；抽屉开合正常」，drawer.ts 既有模式为「开抽屉点击后手动关回」——「选中后自动收起」系新缺口。
- **现象与校准**：文件已正常打开（tab 与渲染均正常），300px 宽抽屉继续盖住主区（仅右侧 ~75px 窄条可见）。属移动端 UX 缺口，维持 low。
- **复现**：375×667+isMobile+hasTouch → tap ☰ 开抽屉 → tap 树中 p1.txt → .vv-side computed transform 保持 none；对照再 tap ☰ 后恢复 matrix(…,-301,0)。
- **证据**：`node apps/web/.temp/review-pwa-e4/repro.mjs`（对 8391）：[overlay check] mask-like elements=0、[hit test at x=370] 命中 .vv-viewer-scroll（无可点遮罩）、[after file tap] transform="none" pane 含内容、[after Esc] none、[after outside tap] none、[after manual toggle] 收起；截图 `.temp/e2e-artifacts/review-pwa-e4/r-after-file-tap.png`、`r-after-esc.png`。

**BUG-62【low · verified】375px isMobile 视口「连接服务器」内联表单不折行溢出：layout viewport 被撑宽到 465px，令牌框被裁、「连接」按钮完全屏外且页面无法横向滚动、点击必超时；地址框 Enter 可绕过完成连接**

- **域/根因位置**：pwa｜`apps/web/src/app.css:229-231`（.vv-server-form flex 无 flex-wrap，地址 220px + 令牌 150px + 按钮 ≈465px）+ `apps/web/src/lib/TopBar.svelte:166-183`（表单标记）。
- **现象与校准**：isMobile 下 innerWidth=465（clientWidth=375，整页约缩小 19.4% 渲染），scrollTo/scrollLeft 恒 0（layout viewport 本身被撑宽无溢出可滚），click 提交按钮 5s 超时（被令牌 input/header 截获）。**校准修正**：候选「桌面窄窗口（非 isMobile 硬 375）下按钮不可点」未复现——该模式文档可横向滚动 90px，Playwright click 3/3 稳定成功，仅初始态不可见需滚动触达。维持 low：次要功能的响应式布局缺陷，有 Enter 绕过。
- **复现**：375×667+isMobile 打开 4199 → 点「连接服务器」→ 读几何与 innerWidth/scrollWidth → click 按钮。
- **证据**：`node /tmp/cand-pwa-e5/repro.mjs` 与 `diag.mjs`：A 场景实测 innerWidth=465、submitBtn x=418.4 w=46.6 right=465（与候选数值 ±0.4 吻合）、scrollX 恒 0、click 超时 call log「intercepts pointer events」、截图 A-isMobile-375.png；B 场景（非 isMobile）3 次点击均 ok 且触发校验错误证明 submit 真实发生；C 场景 isMobile 地址框 Enter 后 .vv-tree 17 行连接成功。iOS Safari 真机未验证（无真机）。

**BUG-63【low · verified】highlightClient.ts:161 注释承诺「原始实例经 window.__vvHighlightClient 暴露（E2E 语言可用性探测用）」，但全仓库无任何赋值实现，该 E2E 探测通道实际不存在**

- **域/根因位置**：pwa｜`apps/web/src/lib/highlightClient.ts:109`（仅悬空类型声明 __vvHighlightClient?）与 `:161`（注释）；withDebug()（:163-221）仅写 __vvLastHighlight* 三个字段，create()（:223-263）中原始 client 仅经 attachHighlightClient(withDebug(client)) 注入，从未挂 window。
- **现象与校准**：运行时确认属性完全不在 window 上（高亮真实触发后 '__vvHighlightClient' in window 仍为 false，排除懒加载时序；对照钩子 __vvOpenDirImpl 同窗口为 function）。现役 e2e 套件 rg 全量核实未引用该钩子，无现役测试失败；影响为注释与实现失实 + 调试通道缺失（误导后续 E2E 作者）。维持 low。
- **复现**：rg -n '__vvHighlightClient' apps/web/src 仅命中 :109 与 :161；page.evaluate(() => window.__vvHighlightClient) → undefined。
- **证据**：4173 vite preview 一次性 spec（高亮真实触发 __vvLastHighlightMs=97.1 证明 withDebug.record 已执行）+ 4199/8391/8440 三实例各时点 hasClient 均 false；rg 全量无套件引用。附注：复核用裸 launch 脚本曾见 worker 15s 初始化超时，属裸脚本环境现象——现役 HL-10 用例同机 `npx playwright test e2e/t-hl.spec.ts -g 'HL-10:' --project=chromium` 3.0s passed，与本候选无关（该现象本体即 BUG-35）。

#### 套件级（1 条）

**BUG-64【low · verified】服务器模式 tab 重载后滚动位置不还原：恢复链对象引用断裂（AppShell.restore 写入的对象与 ViewerPane 渲染 effect 读到的同 id tab 非同一引用，恢复 rAF 从未调度）+ 快照被 addTab/activate 的 persist 覆写为 0**

- **域/根因位置**：套件级（基线分诊 bug08-scroll-restore 候选的确认版）｜`apps/web/src/lib/AppShell.svelte:102-114`（restore 重连分支 addTab 后赋 tab.scrollTop）、`apps/web/src/lib/openFlow.svelte.ts:62-73,102`（add 初始 scrollTop:0 + persist；activate persist）、`apps/web/src/lib/ViewerPane.svelte:163-180`（渲染后 rAF 恢复，`current.scrollTop > 0` 门槛）；观察点 `apps/web/e2e-server/b-server-regression.spec.ts:125-129`。
- **现象与校准**：IndexedDB tabs 快照中 scrollTop 曾正确落盘 2500，重载后 .vv-code-pre.scrollTop 恒 0、零 scroll 事件。断点两处（均独立复现）：① 应用链断裂——restore 读到 2500 并赋值成功（插桩 P1-RESTORE 确认写入对象 800ms 后仍 2500），但渲染 effect 判定读到同 id 不同底层对象 scrollTop=0（插桩 P3-VIEWER 确认 `===` 为 false），恢复从未应用（主缺口）；② 快照覆写——add/activate 两次 persist 落盘 0（次级放大器：手动把快照改回 2500 再 reload 仍不还原）。维持 low：内容自动重读正常（BUG-08 主修复目标达成，原用例仍通过），仅滚动位置这一会话状态丢失。
- **复现**：连接服务器 → 打开 b08-long.js（400 行）→ 滚至 scrollTop=2500 → 等 IndexedDB 快照持久化 → 重载 → scrollTop 恒 0。
- **证据**：7 次独立运行全部复现：① 复跑原用例 `cd apps/web && npx playwright test -c playwright.server.config.ts e2e-server/b-server-regression.spec.ts -g "BUG-08"` 输出「[BUG-08 观察] 重载后 scrollTop=0（快照值 2500，未还原）」1 passed；②~⑦ 自起 8440 实例 + /tmp 补丁构建插桩（cp build 到 /tmp，未改仓库文件）逐环取证：hook scrollTop setter 零次调用（恢复赋值从未执行）、rafCount=0、hook IDBObjectStore.put('tabs') 的 reload 前后序列（前：…滚动后 745ms:2500；后：仅两条均 0）、实验 B 手动 put 2500 后 reload 仍 finalTop=0。

### 4.3 unconfirmed（0 条确认缺陷之外的保留项）

本轮**未确认候选清单为空**（41 条候选全部经独立复核确认，误报 0）。以下两项按规则如实归档为未经本轮证实/未定论的保留项：

1. **m3-search mobile「关闭后重开」toBeFocused flaky 的本轮重试结果**：粘贴输出的汇总段被截断，无法从中确认其重试结果；failed 列表（4 项全为 b-grammar-layers）不含它，与「重试后通过」相容但未经本会话证实。该计时型 flaky 已由 docs/e2e/README.md:6 与 docs/e2e/in-file-search.md 预先记录（用例现位于 `apps/web/e2e/m3-search.spec.ts:112`、焦点断言 :129，行号较文档记载漂移）。不作为缺陷计入，执行侧如复发按既有 flaky 口径处理。
2. **前端 e2e 4 失败的实跑复验**：静态取证定性为执行侧环境缺失（3.1），按阶段约定未实跑 e2e 复验、未改任何文件；定性本身基于产物 grep 与注入链源码证据，置信度高但非运行验证。

---

## 5. 功能完成度评估

### 5.1 分域评估

| 域 | 场景覆盖情况（文档场景 / 既有自动化 / 本轮补测） | 执行结果 | 已知问题余量 |
| --- | --- | --- | --- |
| 应用外壳 | 14 场景；既有 9；上轮 10 项缺口场景本轮全补（t-shell 14 用例，SHELL-07 headless 受限 fixme） | ✅ 2 轮通过 | BUG-27(H)/29(M)/30(L)/31(L)/32(L) 共 5 条；键盘导航、快速打开、设置面板、双断点抽屉、排除规则、拖放/URL/多 tab 均有编号断言且回归通过；上轮 BUG-03/04/05/07/19 现状过时项全部确认已修复 |
| 代码高亮 | 11 场景；既有 6；7 项缺口场景本轮全补（t-hl 10 用例，HL-10/3 fixme 待服务端落位） | ✅ 2 轮通过 | BUG-33(H)/34(M)/35(M)/36(M)/37(M)/65(M)/38(L) 共 7 条（域内含全仓看门狗唯一锚点 BUG-35 与 301 重构配套缺口 BUG-34/37）；降级链、懒高亮零错位、range 协议 17 项边界、301 全量 round-trip、worker 病态输入稳定性矩阵均通过 |
| 主题系统 | 7 场景；既有 6；4 项缺口本轮全补（t-theme 4 用例） | ✅ 1 轮通过 | BUG-49(M)/50(M)/51(L) 共 3 条；三态循环、214 主题零重解析契约（ts-* 视口指纹口径）、双槽位、围栏同步、hljs 近似映射、BUG-06 验收锚点（离线 wasm 缓存命中）均回归通过 |
| Markdown 渲染 | 13 场景；既有 10；3 项缺口本轮全补（t-md 4 用例） | ✅ 2 轮通过 | BUG-39(M)/40(M)/42(L)/66(L) 共 4 条；TOC/锚点本地引擎边界全套、GFM 围栏矩阵、净化达标面（img/iframe/script 等）、worker 资产链均通过；上轮 BUG-17 回归面同快照确认完好 |
| 文件内搜索 | 7 场景；既有 3；4 项缺口本轮全补（t-fsearch 4 用例） | ✅ 1 轮通过 | BUG-44(L) 1 条；高亮/计数（grep·pdftotext 外部基准）/大小写/跨行跨 chunk/关闭重开/渲染视图还原无损全绿；上轮 BUG-18/23 修复经编号断言回归 |
| 媒体与 Office | 11 场景；既有 8；6 项缺口本轮全补（t-media 4+1） | ✅ 2 轮通过 | BUG-52(M)/53(M)/54(L) 共 3 条（损坏文件兜底矩阵：音频静默/图片无兜底/文案退化；Office 损坏件与视频卡片链正常）；大图缩放矩阵、500 页 PDF 懒渲染、Office 逐格对照、HLS 播完均通过 |
| hex 与压缩包 | 10 场景；既有 10（最全）；6 项缺口本轮全补（t-bin 4+2） | ✅ 1 轮通过 | BUG-55(H) 1 条；7 格式结构树黑盒全对、压缩包边界矩阵（截断/空包/zip64/中文/超 200MB/嵌套限深）全绿、10MB hex 首帧桌面补实测中位 148ms（BUG-16 验收达标） |
| 服务端文件服务 | 13 场景；既有 11；9 项缺口本轮全补（t-srv 10 用例，SRV-06/2 fixme） | ✅ 1 轮通过 | BUG-45(M)/46(L)/47(L)/48(L) 共 4 条；路径穿越/越权 15 变体双数据根全绿、Range 矩阵 22 条、CORS 15 条、token 矩阵 12 条全绿；上轮 CORS expose 缺口已被 d8ba77e 修复（域文档表述过时已记录） |
| 计算卸载与全局搜索 | 12 场景；既有 12（全）；4 项缺口本轮全补（t-cmp 4 用例，CMP-02/2 fixme） | ✅ 2 轮通过 | BUG-56(L)/57(L) 共 2 条；/api/health 301 对齐、301 全量 round-trip、浏览器路由矩阵、range 契约、markdown 端点边界、搜索协议边界、BUG-09 回归均通过 |
| PWA 与移动端 | 9 场景；既有 9（全）；6 项缺口本轮全补（t-pwa 9 用例，PWA-06/2 fixme 疑似回归待真机） | ✅ 1 轮通过 | BUG-58(M)/59(M)/60(L)/61(L)/62(L)/63(L) 共 6 条（离线承诺仍是最薄弱面）；SW 精确 precache 契约、离线 wasm 缓存命中、性能预算硬门（hex 桌面中位 40ms/文本 297ms）全部达标 |

### 5.2 总体结论

1. **重构主目标达成**：与上轮相比，三大系统性缺口全部关闭——本地 tree-sitter wasm 主路径可用（BUG-06 修复经多域回归锚点确认无回退，含 SW 离线缓存命中链）、键盘/快速打开/设置面板全部实现并有编号断言（BUG-03/04/05 关闭）、状态栏元数据四字段齐全（SHELL-12/SRV-05 口径达成）。**上轮 26 条缺陷的回归状态（收窄口径）**：本轮对其中 **19 条**取得了直接回归/修复证据且未发现回退，**2 条**仅部分观察（BUG-02 降级链路、BUG-12 验收⑥通道护栏），**4 条未复测**（BUG-11/21/24/25），**1 条发现疑似回归待复核**（BUG-26 触摸惯性：本轮 harness 实测虚拟滚动路径惯性恒 0，t-pwa PWA-06/2 已 fixme 待真机复核）——即本轮**不是**对 26 条逐一复测后的全量回归结论，「未发现行为回退」仅适用于已复核的 19+2 条范围；逐条对照见附录 D。滚动还原残留缺口独立定档 BUG-64。
2. **主干扎实**：10 域可执行补测用例统一执行 10/10 通过（64 个可执行用例，域结果字段口径，见 §3.3）；基线 vitest 685/685、服务端 e2e 全绿；服务端 HTTP 契约（穿越/越权/Range/CORS/token）、懒高亮零错位、301 语言 round-trip、压缩包与结构树边界矩阵等深水区全部通过。
3. **当前主要风险集中在四处**：①**high×3**——BUG-27（自带数据集开箱即触发的快速打开整体失效）、BUG-33（djot 单请求崩服，公网暴露场景为可用性风险）、BUG-55（>28.44MiB 二进制尾部不可达且显示错误偏移）；②**重构配套未跟随**——code.ts 扩展名白名单（BUG-34）、yaml vendored wasm（BUG-37）、CODE_CAPTURES 清单（BUG-50）、SW 缓存策略漏 manifest/libarchive（BUG-58/59）均属「301 对齐重构与 PWA 策略未同步更新」类，修复面集中；③**看门狗协议缺口**（BUG-35）被四个域独立命中，是服务端档/纯前端档共同的中等严重度体验缺陷，修复点单一（worker init ack 或看门狗判活条件）；④**双引擎一致性**（BUG-39/66/42/65）——远程 comrak 与本地 markdown-it/langdetect 的语义分歧随「执行位置」动态切换暴露给终端用户，宜一次性立「双引擎输出契约」专项。
4. **建议修复顺序**：BUG-33（崩服）→ BUG-27/55（开箱即触发/错误结果）→ BUG-35（四域共因，回归锚点已就位）→ BUG-34/37/50（重构配套）→ BUG-58/59（离线承诺）→ BUG-40（隐私外联）→ 其余 medium/low。

---

## 6. 覆盖与未覆盖范围

### 6.1 已覆盖（本轮实测面，摘要）

- **基线三套**：vitest 685 用例、前端 e2e（chromium+mobile）、服务端 e2e 全量各跑一轮。
- **10 域黑盒探索**（全部实跑）：301 语言 text 模式全量扫描（djot 唯一崩服）、range 协议 17 项 API 边界、shebang 矩阵 9 变体、injection 与 worker 病态输入稳定性矩阵、懒高亮三处逐行比对零错位；TOC/锚点本地引擎 slug 边界全套；文件内搜索六类视图全链（词级/行级高亮、外部基准计数、大小写、跨 chunk、关闭重开、还原无损比对）；损坏媒体兜底矩阵 15 件；大图缩放矩阵与 500 页 PDF；hex 28/30/40MB 边界矩阵 + 7 格式结构树 + 压缩包边界矩阵（截断/空包/zip64/中文/超 200MB/嵌套限深）；服务端 HTTP 97 条矩阵（穿越/越权/编码/特殊文件名/token/CORS）+ Range 22 条 + 真浏览器跨源实证；PWA 离线/更新流/移动端抽屉与表单几何/性能预算（桌面+移动各 5 轮中位）；主题全交互面与 FOUC 逐帧采样。
- **补测**：12 个 t-* spec（最终文件实测 64 个可执行用例 + 44 个 fixme，对账见 §3.3），可执行用例统一执行 10/10 域通过（域结果字段口径，见 §3.3 执行结果口径）。
- **缺陷确认复核**：41 条候选 100% 独立复现（多数含正/负对照实验与根因源码实读），误报 0。

### 6.2 未覆盖与受限（如实披露，未跑的检查不写成已验证）

1. **基线前端 e2e 4 失败的实跑复验**：按阶段约定未实跑（构建/运行会写文件），定性为静态取证结论（3.1）。
2. **m3-search mobile flaky 的本轮重试结果**：输出截断未能证实（4.3）。
3. **已知 headless 限制（沿 docs/e2e/README.md §3.1 口径）**：SHELL-07 FS Access 原生目录选择器与刷新后 requestPermission 权限弹窗无法在 headless 驱动（t-shell 以 test.fixme 占位）；真实 OS 文件夹拖拽通道（webkitGetAsEntry 恒 null）未覆盖；移动端真机触摸/惯性未测——PWA-06/2 快滑惯性用例现状必败（b-pwa 实测虚拟滚动路径惯性恒 0、非虚拟容器 0~1263px 不稳定，兼有疑似产品回归），已 fixme 待人工/真机复核后转正。
4. **CDN 资产层**：VV_GRAMMAR_CDN 本地构建为空串不发起，三层 grammar 资产链的 CDN 层无法黑盒触发（b-grammar-layers 在 CI 才有效）；djot 在浏览器 wasm 侧是否同样崩溃未验证（本地/CDN 均无 djot wasm，服务端 native 已实锤）。
5. **网络与部署形态**：--allow-lan（0.0.0.0 绑定）跨机访问与 CORS 组合未测（无局域网第二机）；子路径托管（VV_BASE_PATH）下 SW scope 未测。
6. **媒体边界**：加密 PDF 未构造成功（gs 10.06 已移除 pdfwrite 加密输出、qpdf 不可用，预期走 render 抛错→卡片链路）；hevc 等浏览器不支持编解码器的视频未构造（本机 ffmpeg 无 libx265，预期走 art error→卡片链路，同 hollow.mp4 已验证）；200MB+ 巨型图片内存边界未测；iOS Safari 真机（BUG-62 的 iOS 分支）未验证；RAR/7z 样例（环境无 rar/7z 命令）未测。
7. **性能与稳定性**：upload 通道 40MB 大文件首帧（报告 §7.1 遗留）未做；SSE 长时间稳定性与写风暴未在本轮重点重测（域文档边界明示短窗口口径）；413 单行超长窗口语义（需 >20MB 单行文件，实测路径 446KB 先触 10s 超时）未测；worker 长时多语言并发与内存泄漏压测未做；20000×15000 JPEG 首次缩放 ~5.3s 卡顿仅为观察记录（无 spec 预算口径，不作为缺陷）。
8. **真实设备输入**：真实 OS 亮暗切换按键（headless 用 CDP emulateMedia 仿真，BUG-51 白帧时长本地实测、真实网络下更长）；BUG-26 触摸惯性按上轮文档口径维持待真机复核。
9. **局部对照**：纯前端档全局搜索 local 路径的 UI 对照未做（以 node 直跑产品代码 grepStoreLocal 覆盖函数行为，UI 调用即该函数）；BUG-57 的 4199 UI 对照未做（同理由）。
10. **探索期未重复的既有覆盖面**：HL-04/2 >200MiB plain 分支由补测用例覆盖但与 HL-08/HL-03/2 并行跑时需注意内存；MEDIA-01~11 文档已覆盖场景（250 行 xlsx 截断、EXIF rot90、HLS 起播等）未重复执行；BUG-16 的 1MB hex 首帧口径本轮以 10MB 桌面档补实测（中位 148ms 达标），1MB 档未重复。
11. **占位转正项**：44 个 `test.fixme` 均为占位而非失败——5 个场景受限占位（SHELL-07、HL-10/3、SRV-06/2、CMP-02/2、PWA-06/2）+ 37 个确认缺陷回归锚点（§4.2 合并后 37 条主条目各一）+ 2 个 BUG-66 场景判据载体（MD-01/2 [CAND-md-F1]、CMP-05 [BUG-67]），待对应前提（真机/辅助实例模式/服务端缓存落地/缺陷修复）满足后转正执行。

---

## 7. 附录

### 附录 A：占位与编号勘误对照

> 背景：一次中断的部分执行曾以旧编号（31~48 段等，与本轮权威编号空间重叠但含义错位）提交过部分占位。占位阶段已按权威缺陷清单完成全仓库 rg 盘点、逐条内容配对（现象+根因 file:line+复现步骤）、就地勘误/删除重复/补缺失，目标状态为「每条确认缺陷全仓库恰有一个以权威编号开头的可发现 test.fixme 锚点」。以下为最终对照（勘误提交均为 test(e2e) 类原子提交）。

**A.1 探索期旧编号 → 权威编号（含最终归属锚点）**

| 勘误提交 | 域 | 旧编号（原占位位置） | 缺陷内容 | 权威编号 | 最终锚点（归属文件） |
| --- | --- | --- | --- | --- | --- |
| d1eda64 | 应用外壳 | BUG-31（t-shell） | 裸路径 200+index.html 静默渲染 | BUG-29 | apps/web/e2e/t-shell.spec.ts:467 |
| d1eda64 | 应用外壳 | BUG-32（t-shell） | 快速打开单目录 403 一票否决 | BUG-27 | apps/web/e2e/t-shell.spec.ts:502 |
| d1eda64 | 应用外壳 | BUG-33（t-shell） | Ctrl+P 面板内再按不关闭 | BUG-31 | apps/web/e2e/t-shell.spec.ts:534 |
| d1eda64 | 应用外壳 | BUG-34（t-shell，看门狗，shell 发现=清单 BUG-28） | worker 15s 看门狗误杀 | BUG-35（hl 承载） | apps/web/e2e/t-hl.spec.ts:514 |
| d1eda64 | 应用外壳 | BUG-35（t-shell） | 图片编码恒 gb18030 | BUG-32 | apps/web/e2e/t-shell.spec.ts:567 |
| d1eda64 | 应用外壳 | BUG-36（t-shell） | 尾斜杠 URL 空名伪 tab | BUG-30 | apps/web/e2e/t-shell.spec.ts:595 |
| d1eda64 | 套件级 | （随提交落位） | 滚动还原不生效 | BUG-64 | apps/web/e2e/t-shell.spec.ts:629 |
| e07827d | 主题系统 | BUG-51（t-shell 主题同源旧占位） | OS 亮暗切换下拉脱钩/错槽 | BUG-49 | apps/web/e2e/t-theme.spec.ts:407 |
| e07827d | 主题系统 | BUG-55（t-shell 主题同源旧占位） | CODE_CAPTURES 缺口 | BUG-50 | apps/web/e2e/t-theme.spec.ts:441 |
| e07827d | 主题系统 | BUG-53（t-shell 主题同源旧占位） | 暗色 FOUC | BUG-51 | apps/web/e2e/t-theme.spec.ts:476 |
| 4df85d2 | 代码高亮 | BUG-43（fsearch 域上轮 23cee73 所记） | 看门狗误杀（fsearch 发现=清单 BUG-43） | BUG-35 | apps/web/e2e/t-hl.spec.ts:514（新旧对照留档注释 t-hl.spec.ts:531-535） |
| 4df85d2 | 代码高亮 | BUG-40（t-md 同源旧占位）、BUG-41（t-hl 同源旧占位） | 看门狗误杀（md 发现=清单 BUG-41） | BUG-35 | 已删除，检索指引 t-hl.spec.ts:531-535 与 t-md.spec.ts:396-400 |
| 4df85d2 | 代码高亮 | HL-02 [CAND-hl-F1]（t-hl 重复占位） | .pl 误识 prolog | BUG-65 | apps/web/e2e/t-hl.spec.ts:848（CAND 占位删除并入，断言未放宽） |
| 4df85d2 | 代码高亮 | （按根因落位） | djot 崩服 / 单行 O(n²)（根因 server/src/compute，落 e2e-server） | BUG-33 / BUG-36 | apps/web/e2e-server/t-cmp.spec.ts:289 / :338 |
| b148bd1 | hex 与压缩包 | （编号已一致，零勘误） | hex spacer 超限 | BUG-55 | apps/web/e2e/t-bin.spec.ts:160 |
| 0790cf9（首提交即正确） | 服务端文件服务 | （无旧编号遗留） | CORS '*' panic / 病态路径 500 / Range 两边界 / 非 UTF-8 名 | BUG-45~48 | apps/web/e2e-server/t-srv.spec.ts:351/413/472/531 |
| 88ff85e | 媒体与 Office | （原位落位，无勘误） | 损坏音频静默 / 损坏图片无兜底 / 错误文案退化 | BUG-52/53/54 | apps/web/e2e/t-media.spec.ts:285/319/353 |
| f1d228e | PWA 与移动端 | （落位，63 为新增） | SW 缓存缺口×2 / 缓存累积 / 抽屉 / 表单溢出 / 悬空钩子 | BUG-58~63 | apps/web/e2e/t-pwa.spec.ts:536/613/676/795/843/893 |
| d078d27 | Markdown 渲染 | BUG-37（t-md 探索期） | heading id 死链 | BUG-39 | apps/web/e2e/t-md.spec.ts:280 |
| d078d27 | Markdown 渲染 | BUG-38（t-md 探索期） | 围栏大小写不归一（=清单 BUG-42，根因 hl 承载） | BUG-42 | apps/web/e2e/t-hl.spec.ts:599（t-md 重复份已删除） |
| d078d27 | Markdown 渲染 | BUG-39（t-md 探索期串号份） | 净化五类向量 | BUG-40 | apps/web/e2e/t-md.spec.ts:313 |
| d078d27 | Markdown 渲染 | BUG-67（t-md:230） | GFM 删除线 | BUG-66（md 域权威定档） | apps/web/e2e/t-md.spec.ts:230 |
| 8c39501 + 87fcdb2 | 计算卸载与全局搜索 | CMP-05 [CAND-cmp-F1]（t-cmp:226→239） | GFM 删除线（cmp 发现=清单 BUG-67，与 BUG-66 同缺陷） | BUG-67（cmp 场景锚点保留） | apps/web/e2e-server/t-cmp.spec.ts:239（与 t-md BUG-66 双向互指注释） |
| 8c39501 | 计算卸载与全局搜索 | （新增占位） | 状态栏停留解析中 / 单文件 50 截断 | BUG-56/57 | apps/web/e2e-server/t-cmp.spec.ts:382/427 |

**A.2 跨域并入关系汇总（重复发现去重的最终归属）**

| 权威条目 | 并入的重复发现 | 全仓库最终锚点 |
| --- | --- | --- |
| BUG-35（hl 承载） | BUG-28（shell 发现）、BUG-41（md 发现）、BUG-43（fsearch 发现） | apps/web/e2e/t-hl.spec.ts:514「BUG-35 [探索]」（全仓唯一同源占位；t-md/t-hl/t-shell 三处旧编号同源占位均已删除并留检索指引） |
| BUG-66（md 承载） | BUG-67（cmp 发现） | apps/web/e2e/t-md.spec.ts:230「BUG-66 [探索]」（主锚点）；场景用例载体 apps/web/e2e/t-md.spec.ts:80「MD-01/2 [CAND-md-F1]」与 apps/web/e2e-server/t-cmp.spec.ts:239「CMP-05 [BUG-67]」按场景编号保留、双向互指 |

**A.3 编号空间说明**：本轮权威缺陷编号为 BUG-27~67 连续 41 段（合并后 37 条主条目）；历史提交中出现的「t-shell BUG-31~36」「t-shell BUG-51/53/55」「t-md BUG-37/38/39」「fsearch BUG-43」等旧编号均已在对应勘误提交中按上表对齐或删除，全仓库 rg 复核无残留、无跨文件撞号（各域勘误 actions 记录在案：srv 域 rg BUG-4[5-8] 仅 t-srv 四处、pwa 域 rg BUG-5[89]|BUG-6[0-3] 仅 t-pwa 六处、md 域 BUG-39/40/66 各恰一锚点等）。

### 附录 B：域文档过时口径勘误清单（供文档维护，不构成缺陷）

- **应用外壳**（docs/e2e/app-shell-sources.md）：BUG-03/04/05/07/08/19 的「缺陷现状」描述均为修复前状态（j/k、gg/G、Ctrl+P、状态栏四字段、设置面板、无扩展名识别、服务器 tab 重读、取消提示均已实现并有编号断言）；SHELL-12 验收「行列」措辞与实现契约不符（CodeFileMeta 为编码/语言/大小/行数四字段）。
- **代码高亮**（docs/e2e/code-highlight-degrade.md）：「manifest abi 非 null」判据退役（abi 恒 null 为构建元数据占位，34 项实测）；「hljs 分块」口径退役（>2MB 一律 lazy chunk）；「服务端 14 语言内嵌集」过时（现为生成式 301）；HL-10「出现 .wasm 请求」对 server-served auto 路径不再成立；HL-02 perl 兜底期望与 CDN 资产链耦合，回归断言宜锚定「着色到达且无错误卡片」。
- **主题系统**（docs/e2e/theme-system.md）：THEME-06/03 的「>2MB hljs 分块」「36 万 span 全量哈希」口径需按懒高亮与视口指纹重述；BUG-06「本地主路径完全失效」现状描述已过时。
- **Markdown 渲染**（docs/e2e/markdown-html-docs.md）：MD-05 以缺陷态实测为基线的表述过时（本地 tree-sitter 主路径已生效）；BUG-06 现状节为报告时点状态；MD-12「渲染视图搜索恒无结果」实为既定设计（沙箱 iframe 不做跨文档搜索）而非待修瑕疵。
- **文件内搜索**（docs/e2e/in-file-search.md）：BUG-18/23「缺陷现状」已过时（词级 mark 与 Aa 开关均已实装并有断言）；「n/N 快捷键」实为计数显示格式非按键序列；「分块」语义已由 hljs 分块变为 tree-sitter lazy chunk；已知 flaky 行号漂移（:107→:112）。
- **媒体与 Office**（docs/e2e/media-office-viewer.md）：/api/health 响应新增 computeLanguages 字段（文档描述信息不全，不构成矛盾）；「video 乱码/黑屏 Reconnect」等缺陷现状已随 BUG-01/14 修复过时（文档已按修复后行为给出回归判据）。
- **hex 与压缩包**（docs/e2e/binary-hex-archive.md）：行为期望无失效；§4.1「8391 主实例 + agent-browser」执行形态与现自动化两通道（4173 注入 / 4174 release）不一致，重建环境按套件通道执行即可；BIN-03 渲染器路由路径描述与实现有出入（可观察结果一致）；BIN-10 期望②留白已由实现闭合（redirected 一次性改派）。
- **服务端文件服务**（docs/e2e/server-file-service.md）：跨源 expose X-VV-Lang/Encoding「预存在缺陷」表述已过时（d8ba77e 已修复，lib.rs expose_headers 在位）；SRV-05「Range 206 路径下打开的文件同样成立」与实现形态不符（前端打开服务端文本文件恒为全量 GET，无 Range 打开路径）。
- **计算卸载与全局搜索**（docs/e2e/compute-global-search.md）：CMP-03 的 13 语言路由矩阵与「rust-fence.md 渲染: 远程」为重构前实测；CMP-04 场景「php/.ex 触发 400」已失效（php 为 301 正例）；CMP-01 期望未含 computeLanguages（301）宣告；BUG-22 验收 1/3 未同步阶段 3 新契约。
- **PWA 与移动端**（docs/e2e/pwa-mobile-performance.md）：PWA-03/BUG-06 abi 因果「未定位」已定案（abi 恒 null 为占位）；「SW 运行时路由承接 wasm」机制表述与实现不符（主线程预热通道）；BUG-26 惯性基准测于 hex 虚拟滚动改造之前不再代表当前基线（兼有疑似回归，PWA-06/2 待真机复核）；「precache 102 条含 manifest」为旧版实测（现契约 precache 不含 manifest.webmanifest，t-pwa 已按现契约断言）；资产口径未覆盖双轨链（CDN 层拉取语言在 SW 缓存/离线承诺下的行为缺口径）。

### 附录 C：证据归档索引

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 各域探索/复核截图与结构化输出 | `.temp/e2e-artifacts/explore-{shell,hl,md,fsearch,srv,theme,media,bin,cmp,pwa}/` | 截图（21/16/15/19/HTTP JSON/12/11/26/结构化/JSON 日志）与探测输出 |
| 探测脚本 | `apps/web/.temp/explore-<域名>/`、`apps/web/.temp/{verify,review,recheck,reverify}-*/`、`apps/web/.temp/explore-{hl,bin,cmp,fsearch,pwa,theme,media,md,srv,shell}/` | 各域黑盒探索与缺陷确认复核的 node+chromium 脚本（如 watchdog-verify.mjs、repro.mjs、verify.mjs 系列） |
| 缺陷确认复核截图 | `.temp/verify-shell-e1/`、`/tmp/vv-reverify-e3/`、`/tmp/verify-shell-e4/`、`/tmp/vv-recheck-hl-e1/`、`/tmp/vv-verify-hl-e2e/`、`/tmp/review-cand-hl-e3/`、`/tmp/vv-recheck{,-md-e4}/`、`/tmp/md-e1-repro/`、`/tmp/vv-repro-cand-md-e2/`、`/tmp/md-e3-reverify/`、`.temp/verify-fsearch-E{1,2}/`、`/tmp/cand-media-e1/`、`/tmp/reverify-media-e2/`、`/tmp/vv-review-e3/`、`/tmp/cand-bin-e1/`、`/tmp/vv-review-cmp-e1/`、`/tmp/cand-cmp-e2/`、`.temp/e2e-artifacts/recheck-pwa-e1/`、`/tmp/pwa-review-e2/`、`.temp/e2e-artifacts/review-pwa-e4/`、`/tmp/cand-pwa-e5/`、`/tmp/vv-recheck-theme-E1/`、`/tmp/review-theme-e3/`、`/tmp/vv-review-srv-e1/`、`/tmp/cand-srv-e{2,4}/`、`/tmp/vv-e3/`、`/tmp/vv-repro-b08/`、`/tmp/review-hl-e5/`、`/tmp/review-e2/`、`/tmp/cand-s4/`、`/tmp/hl-verify/` | 各缺陷条目内引用的截图、日志、插桩输出（/tmp 下证据为本轮会话现场产物） |
| 测试数据集 | `.temp/e2e-data/`（共享根）+ 各域 `explore-<域名>/`、`domain-<域名>/` 子树；`.temp/explore/<域名>/data/` | 基础数据集（含 edge/symlink/escape-etc）与各域自造样例（langs/inj/shebangs/range、toc-edge.md、vectors.md、fence-matrix.md、big-40mb.bin、broken.mp3 等） |
| 服务端/前端实例日志 | `.temp/explore-server-8391.log`、`.temp/explore-web-4199.log` | 主实例运行日志 |
| 占位勘误提交 | 0790cf9 / b148bd1 / 23cee73 / f1d228e / 4df85d2 / d1eda64 / 8c39501 / 88ff85e / d078d27 / 87fcdb2 | 各域 test(e2e) 占位编号勘误与补齐（正文均含新旧编号对照） |

### 附录 D：上轮（2026-10-08 报告）26 条缺陷本轮回归对照表

> 目的：界定 §5.2「未发现行为回退」的实际范围。上轮报告恰含 26 个唯一缺陷编号（BUG-01~26，本修订时 `grep -oE '^### BUG-[0-9]+'` 计数核实）。本轮**未做** 26 条逐一复测，下表按本轮材料中实际存在的回归证据逐条标注：**A = 直接回归/修复证据，未发现回退**；**B = 部分观察（间接证据或仅覆盖部分验收面）**；**C = 本轮未复测**；**D = 发现疑似回归待复核**。证据出处均转录自本轮域材料（staleDocNotes/writeNotes/探索覆盖说明/确认缺陷清单）；标注「随基线套件通过」指该既有编号用例在前端 e2e 套件运行中通过（本轮套件仅 b-grammar-layers 4 项失败，见 §3.1）。

| 上轮编号 | 上轮缺陷（摘要） | 本轮状态 | 本轮证据（出处） |
| --- | --- | --- | --- |
| BUG-01 | HLS 分片 blob: 死循环、ts 乱码（high） | A | t-media MEDIA-04/播完（e2e-server，ffmpeg 生成 2s HLS，断言清单/分片 200、readyState≥3、播放至 ended 无错误卡片）执行通过（media 域 writeNotes） |
| BUG-02 | btrfs 数据根 watcher 持续故障（medium） | B | srv 域探索：PermissionDenied→后台退避→PollWatcher 降级链路按 BUG-02 修复口径工作、无内容泄露；主实例遗留状态见 §2.3（btrfs 特定故障场景与恢复窗口本轮未复测） |
| BUG-03 | 键盘快捷键 j/k/gg/G/Ctrl+P 零实现（medium） | A | shell 域探索实测通过（j×5/k×2 步进、gg/G、Ctrl+P 全链）+ b-app-shell-sources.spec.ts:91-172 编号断言（shell 域 staleDocNotes） |
| BUG-04 | 状态栏元数据四字段缺失（medium） | A | CodeFileMeta 四字段渲染，状态栏/属性面板编号断言（shell 域 staleDocNotes，code.ts:491-498 等行号证据） |
| BUG-05 | 设置面板整体缺失（medium） | A | ⚙ 按钮/Ctrl+,/排除预设/自动刷新/手动刷新均在（TopBar.svelte、SettingsPanel.svelte 行号证据，shell 域 staleDocNotes）+ t-shell SHELL-09/2、SHELL-13/1 执行通过 |
| BUG-06 | 本地 tree-sitter wasm 主路径整链失效（medium） | A | theme 域探索：BUG-06 验收锚点无回退（SW 三缓存建立、断网打开未开过 rust 文件仍 tree-sitter，截图 p4b-offline-rust.png）；md 域：b-markdown-html-docs-bug-regressions.spec.ts:207 实跑通过；hl/theme 多域 ts-* span 正常 |
| BUG-07 | 无扩展名文件被拒（medium） | A | shebang→python、Makefile 文本预览编号断言（b-app-shell-sources.spec.ts:292-329，shell 域 staleDocNotes） |
| BUG-08 | 服务器 tab 刷新误标本地占位（unconfirmed→已修） | A | 服务器来源 tab 刷新后自动重读渲染（b-server-regression.spec.ts:97-130）；BUG-64 条目：「内容自动重读正常（BUG-08 主修复目标达成，原用例仍通过）」；滚动还原残留缺口独立定档 BUG-64 |
| BUG-09 | 全局搜索点击不定位不高亮（medium） | A | cmp 域探索「BUG-09 回归通过」：点击 751:1 后 data-line=750 行在视口内、带 vv-search-hit-line(-active)、gutter=751 |
| BUG-10 | remote >2MB 被本地阈值压制（medium） | A | 阶段 3 后 auto 不限大小走服务端（cmp 域 staleDocNotes）；3.2MB/48000 行 server-served auto 终态「tree-sitter·远程」零错位；t-cmp CMP-03/2 路由矩阵重锚定执行通过 |
| BUG-11 | 纯前端超限无「建议改用服务器模式」引导（medium） | C | 本轮无任何域覆盖此场景 |
| BUG-12 | 加密 zip 整包拒绝（medium） | B | 仅验收⑥通道护栏：t-bin BIN-08/6（/api/file 200 + application/zip + PK 头，e2e-server）执行通过；「整包拒绝」前端 UI 行为本轮未复测 |
| BUG-13 | magic 预检重定向缺失（medium） | B | t-bin BIN-10/2（验收②签名不符分支：.zip 扩展名纯文本 → 错误卡片兜底 + ≤6 无循环改派）执行通过；正路径 magic 识别本轮另有 7 格式结构树黑盒全对（bin 域探索），改派正路径 UI 复测未单列 |
| BUG-14 | 媒体损坏无统一错误卡片（medium） | A | media 域探索：hollow.mp4 解码错误 ~1s 内卡片+按钮出现（升级链正常）、Office 损坏件卡片+按钮齐全；BUG-52/53/54 对照证据同链确认 |
| BUG-15 | 离线 reload 落 chrome-error（medium） | A | 既有 fix-pwa.spec.ts:95 离线 reload 同管线用例随基线套件通过 + t-pwa PWA-02/2（断网地址栏重新导航完整壳）、PWA-02/3（在线 reload 基线）执行通过（pwa 域 writeNotes） |
| BUG-16 | hex 首屏超预算 3~9 倍（medium） | A | bin 域探索：10MB hex 首帧 5 轮中位 148ms（BUG-16 验收第 2 条「≤10MB <300ms 桌面」全轮达标）；pwa 域性能预算：perf-1mb.bin hex 73/74ms（预算 200/500ms） |
| BUG-17 | markdown 外部图片真实外联（medium） | A | md 域探索：img src/srcset 剥除、BUG-17 img[src] 拦截标记正常（MD-10/MD-11 既有验收面无回退）；BUG-40 证据回归面同快照完好（img src 已剥 + data-vv-blocked-external='1'） |
| BUG-18 | 文件内搜索无词级高亮（medium） | A | app.css:219-223 词级/行级类名在位、b-in-file-search.spec.ts:95-97 断言 4 mark+3 行级（fsearch 域 staleDocNotes）+ t-fsearch FSEARCH-01 执行通过 |
| BUG-19 | 「打开文件夹」点击无反馈（low） | A | 取消后状态栏「已取消选择文件夹」提示 + b-app-shell-sources.spec.ts:356/399 编号断言（shell 域 staleDocNotes） |
| BUG-20 | >20MB 无明确超限提示（low） | A | 口径已按阶段 4 反转（>20MiB 懒高亮 + 「可视区懒高亮」一次性提示条，hl 域 staleDocNotes）；既有 HL-04 编号用例随基线套件通过 + t-hl HL-04/2（>200MiB plain 分支）执行通过 |
| BUG-21 | 全局搜索 glob 无 UI 入口（low） | C | 本轮无任何域覆盖此场景 |
| BUG-22 | auto 路由指示不符期望（low） | A | 旧 13 语言矩阵判据随重构反转，cmp 域以新契约重锚定：t-cmp CMP-03/2（rs/go/c/cpp/java/sql auto 下断言「tree-sitter · 远程」）执行通过 |
| BUG-23 | 文件内搜索无大小写开关（low） | A | Aa 开关实装（SearchPanel.svelte:9-11、b-in-file-search.spec.ts:138-149 断言，fsearch 域 staleDocNotes）+ t-fsearch FSEARCH-03 执行通过 |
| BUG-24 | 断网展开未加载目录静默失败（low） | C | 本轮无任何域覆盖此场景 |
| BUG-25 | webkitdirectory 回退通道不存在（unconfirmed，上轮已判误报） | C | 本轮未复测（SHELL-07 仍为 headless 受限 fixme；上轮复核判误报的结论维持） |
| BUG-26 | 触摸滑动无惯性（unconfirmed） | **D** | pwa 域 staleDocNotes：当前 harness 实测虚拟滚动路径惯性恒 0、非虚拟容器 0~1263px 不稳定（b-pwa-mobile-performance.spec.ts:14-16），上轮复核基准不再代表当前基线——**疑似虚拟滚动改造回归**，既有 spec 已记录待人工复核；t-pwa PWA-06/2（快滑惯性断言）现状必败，fixme 待真机复核后转正 |

**汇总**：A 19 条、B 2 条、C 4 条（BUG-11/21/24/25）、D 1 条（BUG-26）。§5.2 的「未发现行为回退」仅覆盖 A（及 B 的已观察面）；BUG-26 的疑似回归不在「未发现回退」范围内，需按 t-pwa PWA-06/2 的转正路径（真机/人工复核）闭环。

---

*报告完。所有数字、结论与证据路径均转录自本轮探索、确认复核、补测执行与占位勘误的实跑材料；verified 与 unconfirmed 全程明确区分；跨域重复发现按合并后口径统计（被并入编号不独立成条）；执行计数为修订时对最终文件的实测对账口径（§3.3），passed/skipped 级原始计数无归档已如实披露；除本文档外未改动任何文件。*
