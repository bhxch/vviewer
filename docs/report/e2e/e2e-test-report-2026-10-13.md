# vviewer E2E 测试报告（2026-10-13）——窗口流式失败面与降级链补充测试轮

> 被测版本：`main` @ `b66a40c`（`git rev-parse HEAD` → `b66a40c0938f4c12022a35304965d5fe896af395`，2026-10-13 20:12:55 +0800「test(e2e): GRF-07 刷屏锚改锚同源 manifest SPA 面」；本轮全部锚定、门禁与 GRF-07 修复在该提交上完成，工作树干净）
> 背景批次：code/jsonl 窗口流式「失败与降级行为」补充测试——该线最近 20+ 条 fix 提交密集修 bug，但 e2e 只有 happy-path 计量锚点（IO-01~11 全走正常 Range/200 通道）。本轮按调研建议顺序补测：①code 扫描进度/同 query 重搜/Range-less 降级（SCAN 域）②jsonl 降级链（JVL 域）③错误卡片「以 hex 打开」入口（OWX 域），并扩展 ④IO 公共防线降级矩阵（DEG 域）⑤grammar SPA-fallback 嗅探回归（GRF 域，050ae69/7fab3a5 真实 bug 修复无回归锚）⑥workspace 多根 file 通道越界防护（MRF 域）。
> 证据根目录：`apps/web/.temp/pw-out-r1|pw-out-r2`（门禁两轮 Playwright 输出）、`apps/web/.temp/pw-out-triage-*` 与 `pw-out-fix-*`（分诊/修复复跑输出，本轮 `ls` 实存 14 个目录）、`docs/e2e/<域>.md`（6 份场景文档）、自动化 spec 6 份 + 共享 helper 1 份。
> 状态标记约定：**verified** = 本轮经分诊/修复会话或本报告撰写时亲手复现/核对证实；**unconfirmed** = 未经独立证实（域材料存疑观察，按规则保留并明确标注，不计入已证实缺陷）。

---

## 1. 执行摘要

### 1.1 本轮流程与总量

本轮为「调研定题 → 域裁决与场景文档 → 自动化落地逐域实跑锚定 → 双套件门禁 2 轮 → 轮 1 失败分诊与修复 → 复门禁全绿 → 交付报告」流程：

1. **调研定题**：明确最该补测的面为 code/jsonl 窗口流式的失败与降级行为（扫描进度条可见性、同 query 重搜、补块失败游标回退、UTF-8 嗅探降级、STREAM_MAX_BYTES 恰界、Range-less 降级矩阵、jsonl 降级链、错误卡片 open-as 入口）；hex 增强、tab 动作、遗留清账、watch-log-flood 判覆盖充分（low）不补。
2. **域裁决**：提交 `40fa2b9` 新增 6 份域场景文档共 52 场景（SCAN 11 / JVL 8 / DEG 9 / GRF 8 / MRF 8 / OWX 8）。两项预裁决：size 未知 STREAM_MAX_BYTES 恰界停机（25c704e）不设 e2e（需真实流过 512MB）；jsonl 旧「>200MB 降纯文本」口径（`packages/render-text/src/jsonl/index.ts:111` `shouldDelegateToCode`，注释自证「计划裁决：阈值单测 + e2e 不覆盖降级路径」）不再布点，jsonl 降级承诺面按 io spec §4.3 换代为 STREAM_MAX_BYTES 512MB 零读停机（JVL-02）。
3. **自动化落地**：7 份文件按域原子提交——`b4bc0f7`(SCAN 11 用例+helper) → `83c0fc4`(JVL 8) → `fd628f3`(DEG 9) → `fbbc31a`(GRF 8) → `8d597a0`(MRF 8，server 套件) → `db9b8ed`(OWX 8) → `b66a40c`(GRF-07 改锚同源，修复假红)。全部场景实跑锚定，零 `test.skip`、零桌面-only 场景（default 套件均双 project）。
4. **门禁 2 轮**：轮 1 default 82 通过/6 失败（exit 1）+ server 8/0（exit 0）；6 个失败全部为 GRF-01/02/07 × chromium/mobile，经分诊定性为**执行侧环境缺失**（门禁构建产物未注入 `VV_GRAMMAR_CDN`，非产品缺陷、非脚本缺陷）。
5. **修复与复门禁**：三件套修复（workflow 构建步骤注入 env + 产物自检；按 CI 同参重建产物；GRF-07 改锚同源 manifest SPA 面 `b66a40c`，断言零弱化）后轮 2 default 88/0、server 8/0，双双 exit 0，无遗留失败。
6. **缺陷计数**：**verified 产品缺陷 0 条**；unconfirmed 存疑观察 10 条（域材料 suspects，§4.2）。

### 1.2 缺陷计数

| 类别 | verified | unconfirmed | 小计 |
| --- | --- | --- | --- |
| 产品缺陷 | **0** | 10（存疑观察，未定档） | 10 |
| 测试脚本缺陷 | 0 | 0 | 0 |
| 门禁失败（执行侧环境） | 6 项失败 / 已修复 | 0 | 6 |

- unconfirmed 10 条中建议档 medium 3（SUSP-04 Range-less 大文件 3 倍传输放大、SUSP-07 多根来源静默空树、SUSP-08 损坏图片无卡片=既有 BUG-53 同现象）、low 6、设计裁决项 1（SUSP-01 清空重搜缓存复用）；severity 均为**建议档**，未经复核定档，见 §4.2。
- 与上轮（2026-10-10，37 条确认缺陷）关系：本轮门禁为**补测集范围**，不含上轮 37 条回归锚点所在的 t-* 文件，**本轮未做上轮缺陷回归复测**（口径见 §2.3/§6.1）。

### 1.3 一句话结论

**本轮补测目标全部达成、主干无新增确认缺陷**：52 场景全部落地并经双 project（chromium + mobile 375×667）或 server 套件实跑锚定，门禁两轮收敛全绿、零遗留失败、typecheck/build/cargo 全部 exit 0（workflow 记录）；轮 1 的 6 个门禁失败经分诊全部定性为构建注入缺失的执行侧环境问题（与上轮报告 §3.1 记录的 b-grammar-layers 同签名同根因先例一致），已从 workflow 构建步骤持久修复并以 GRF-07 同源改锚（`b66a40c`）双保险。值得后续优先复核的是两条 unconfirmed 观察：多根来源 listChildren 失败静默空树（SUSP-07，与既有 BUG-24 提示通道不成对）与 Range-less 大文件 3 倍传输放大（SUSP-04，与 io spec §2.3 回退语义存在形态差）。

---

## 2. 环境与口径

### 2.1 被测版本与构建

- git 基线：`main` @ `b66a40c0938f4c12022a35304965d5fe896af395`（本报告撰写时 `git rev-parse HEAD` 实测，`git status --short` 为空——工作树干净，被测版本即当前 HEAD）。
- 本轮提交链（`git log --oneline -8` 实测）：`40fa2b9` docs(e2e) 域裁决 52 场景 → `b4bc0f7` SCAN → `83c0fc4` JVL → `fd628f3` DEG → `fbbc31a` GRF → `8d597a0` MRF → `db9b8ed` OWX → `b66a40c` GRF-07 改锚。
- **构建产物状态（本报告撰写时实测）**：`apps/web/build/index.html` mtime `2026-10-13 20:15:51`（注入版重建产物）；CDN 注入指纹 `rg -l 'cdn\.grammars\.test' apps/web/build/` → `apps/web/build/_app/immutable/nodes/2.B5EOG6J1.js` 恰 1 处（exit 0）。对照：**轮 1 门禁所用产物（mtime 19:44:54）无注入**（分诊会话实查 `rg -c "cdn\.grammars\.test" apps/web/build/` 零命中 exit 1，且 19:44:54 < 门禁 r1 输出收尾 19:52:58）——即轮 1 六失败的根因现场。
- 注入链（本轮逐行核对在位）：`apps/web/vite.config.ts:225`（define `'import.meta.env.VV_GRAMMAR_CDN': JSON.stringify(process.env.VV_GRAMMAR_CDN ?? '')`，缺省空串）→ `apps/web/src/lib/highlightClient.ts:246`（`|| null`）→ `apps/web/src/lib/grammarLayers.ts:80` 附近（cdnBase 空则 CDN 层不入候选，零请求）；CI 不受影响（`.github/workflows/ci.yml:90` 显式 `VV_GRAMMAR_CDN: https://cdn.grammars.test/grammars/`）。嗅探产品代码本体在位：`apps/web/src/lib/grammarLayers.ts:54-57`（content-type 含 text/html → warn「非 JSON 资产应答（SPA fallback？）」+ 返回 null）。
- **持久修复**：门禁 workflow 构建步骤改为携 `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/` 前缀执行 `pnpm build`，并新增产物注入自检（grep 未命中即 log 预警）；改动位于 `.zcode/workflow-drafts/`（gitignore 内，不产生 git 变更）。本地 `apps/web/package.json` build 脚本仍无注入——任何一次无 env 重建都会令 GRF-01/02 再假红（运行方须知，见 §3.3）。
- typecheck exit 0 / build exit 0 / cargo exit 0：**workflow 门禁记录值，本报告撰写轮未复跑**（构建会覆写共享机器上的 build/ 产物，如实标注）。

### 2.2 运行实例与双套件通道

- **default 套件**：vite preview `:4173`（`apps/web/playwright.config.ts:12`，strictPort）；projects 双份——`chromium` 与 `mobile`（375×667 + hasTouch + Pixel 7 UA，`playwright.config.ts:16-31`）；workers 3、retries 1；headless（Playwright 默认，配置未覆写）；`reuseExistingServer: !CI`（`playwright.config.ts:14`）。
- **server 套件**：release 二进制 `:4174`（`apps/web/playwright.server.config.ts`，`PORT=4174`）；webServer 先跑 `fixtures.mjs` 生成夹具并预检二进制/构建产物，再 `exec server/target/release/vviewer serve --root .temp/e2e-server-fixture --web-dist apps/web/build --port 4174`，readiness 用免鉴权 `/api/health`；workers 1（单实例防 fs 互扰）、retries 1、单 chromium project。

### 2.3 门禁范围口径（重要，防止误读）

门禁两轮的 88 个 default 执行 = **本轮 5 个新 spec 的 44 个用例 × 双 project**（`grep -cE '^\s*test\('` 逐文件实测：b-code-scan-resilience 11 / b-jsonl-degrade-chain 8 / b-io-degrade-matrix 9 / b-grammar-spa-fallback 8 / b-error-card-open-as 8）；server 8 个执行 = b-multiroot-file 8 用例 × 单 project。**全量历史套件本轮未跑**（`rg -c '^\s*test\('` 实测：`apps/web/e2e` 40 文件 235 用例、`apps/web/e2e-server` 14 文件 63 用例）——「轮 2 全绿」是补测集结论，不构成全量回归结论；上轮 37 条缺陷的回归锚点（t-* fixme）不在其内。

### 2.4 测试方法与口径

1. **场景文档先行**：每域先落 `docs/e2e/<域>.md`（场景编号、验收判据、已知裁决与偏差），再落 spec，提交信息一一对应（附录 A）。
2. **计量型断言**：流式行为以网络层计量锚定（请求条数/Range 端点/字节数逐条核对），辅以 `page.on('request')`、console.warn 计数、DOM 形态断言；失败面用 route 拦截构造（500/超长 200/200-only/假 content-type 等）。
3. **夹具自包含**：JVL spec 按夹具自包含原则未依赖三域共享 helper `b-stream-resilience-helpers.ts`（避免并行环节同文件写入竞争；helper 由 SCAN/DEG 域使用，后续整并时迁入，见 §5.2 缺口 (e)）。
4. **分诊纪律**：门禁失败逐项独立复跑取证（产物 grep、失败签名比对、失败面隔离分析），未证实不归因；本报告区分「域材料实测/读码」与「报告撰写时亲手核对」两级证据。

---

## 3. 结果分布

### 3.1 门禁与静态检查总览

| 检查项 | 结果 | 口径 |
| --- | --- | --- |
| default 门禁轮 1 | 82 通过 / 6 失败，exit 1 | 6 失败=GRF-01/02/07 × chromium/mobile，定性见 §3.3 |
| server 门禁轮 1 | 8 通过 / 0 失败，exit 0 | — |
| default 门禁轮 2 | **88 通过 / 0 失败，exit 0** | 修复后复门禁 |
| server 门禁轮 2 | **8 通过 / 0 失败，exit 0** | — |
| typecheck | exit 0 | workflow 记录，本报告未复跑 |
| build | exit 0 | workflow 记录，本报告未复跑 |
| cargo | exit 0 | workflow 记录，本报告未复跑 |
| leftoverFailures | 空 | 无遗留失败 |

### 3.2 域/场景汇总表

| 域 | 场景文档 | 场景（编号） | 套件/通道 | 自动化（test 数实测） | 门禁轮 1 | 门禁轮 2 |
| --- | --- | --- | --- | --- | --- | --- |
| code 后台扫描与重搜韧性 | `docs/e2e/code-scan-resilience.md` | SCAN-01~11（11） | default :4173 | `e2e/b-code-scan-resilience.spec.ts`（11） | 22/22 ✅（双 project） | ✅ 22/22 |
| jsonl 窗口降级链与回看 | `docs/e2e/jsonl-degrade-chain.md` | JVL-01~08（8） | default :4173 | `e2e/b-jsonl-degrade-chain.spec.ts`（8） | 16/16 ✅ | ✅ 16/16 |
| IO 流式公共防线降级矩阵 | `docs/e2e/io-degrade-matrix.md` | DEG-01~09（9） | default :4173 | `e2e/b-io-degrade-matrix.spec.ts`（9，实测 15.3s） | 18/18 ✅ | ✅ 18/18 |
| grammar SPA-fallback 嗅探回归 | `docs/e2e/grammar-spa-fallback.md` | GRF-01~08（8） | default :4173 | `e2e/b-grammar-spa-fallback.spec.ts`（8） | 10/16（**6 失败**=GRF-01/02/07 × 双 project，§3.3） | ✅ 16/16 |
| 多根 file 通道与越界防护 | `docs/e2e/multiroot-file-channel.md` | MRF-01~08（8） | server :4174 | `e2e-server/b-multiroot-file.spec.ts`（8） | 8/8 ✅ | ✅ 8/8 |
| 错误卡片打开方式入口 | `docs/e2e/error-card-open-as.md` | OWX-01~08（8） | default :4173 | `e2e/b-error-card-open-as.spec.ts`（8） | 16/16 ✅ | ✅ 16/16 |
| **合计** | 6 份文档 | **52** | 双套件 | 6 spec + 1 helper（`e2e/b-stream-resilience-helpers.ts`） | **82+8 通过 / 6 失败** | **88+8 通过 / 0 失败** |

> 轮 1 域级拆分依据：gateHistory（82+6=88）× 分诊记录（6 个失败项全为 GRF-01/02/07 × chromium/mobile）。

### 3.3 门禁轮次记录（含轮 1 六失败分诊与修复）

**轮次表**（gateHistory 原始记录）：

| 轮次 | 套件（通道） | 通过 | 失败 | exit | 处置 |
| --- | --- | --- | --- | --- | --- |
| 1 | default（vite preview:4173） | 82 | 6 | 1 | 6 项全部分诊定性执行侧环境缺失，修复见下 |
| 1 | server（release:4174） | 8 | 0 | 0 | — |
| 2 | default（vite preview:4173） | 88 | 0 | 0 | 修复生效，全绿 |
| 2 | server（release:4174） | 8 | 0 | 0 | — |

**轮 1 六失败的根因与定性（6/6 同因，verified）**：门禁构建产物未注入 `VV_GRAMMAR_CDN` → CDN 层不装配（`grammarLayers.ts:80` cdnBase 空不入候选）→ CDN manifest 请求从不发起 → GRF-01/02 的 CDN 面断言与 GRF-07（原版）的 CDN manifest 嗅探 warn 计数恒 0，**假红**。证据链（分诊会话实查，本报告转录并抽验）：

1. 产物硬证据：`rg -c "cdn\.grammars\.test" apps/web/build/` 零命中（exit 1）；构建 mtime 19:44:54 早于门禁输出收尾 19:52:58——门禁跑的就是这份无注入产物。
2. 复跑复现：`pnpm --filter web exec playwright test e2e/b-grammar-spa-fallback.spec.ts -g "GRF-01" → 2 failed`，失败点 spec:287 `probe.spa Expected 1 / Received 0`，与门禁 error-context 逐字一致；GRF-02/07 同法复现同签名。
3. 失败面完美隔离：不依赖 CDN 注入的 GRF-03/04/05/06/08 全部通过（82 通过内），仅 3 个注入依赖用例 × 双 project 挂。
4. 产品代码零缺陷：嗅探修复本体（050ae69）在位（`grammarLayers.ts:54-57`，本报告撰写时核对）且有单测（grammarLayers.test.ts:112）；GRF-02 失败点在 spec:330（ok:false，早于 warn 断言），三失败同因均为 CDN 层缺席。
5. 先例一致：`docs/report/e2e/e2e-test-report-2026-10-10.md:88` 记录 b-grammar-layers 同签名同根因，已定性执行侧环境缺失。

**修复三件套（全部落实验证）**：

1. **workflow 持久修复**：门禁构建步骤携 `VV_GRAMMAR_CDN=…` 前缀执行 + 产物注入自检（修复会话实测 `VV_GRAMMAR_CDN=… pnpm build` 后 `grep -rl cdn.grammars.test apps/web/build/` 命中 1；e2e 脚本零改动、断言零弱化；产品源码未触碰）。
2. **产物按 CI 同参重建**：GRF-02 修复会话执行 `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build`，重建后 `-g "GRF-02"` 复跑 2 passed (3.8s)；本报告撰写时产物指纹仍为注入版（§2.1）。
3. **GRF-07 改锚同源（`b66a40c`）**：刷屏/单次性锚点与层身份无关，改锚同源 manifest SPA fallback（`blockCdn` + `mockOriginManifestSpa`），在 CDN 注入/未注入两种构建下嗅探 warn 均确定性恰 1 条——断言集（计数/文案/pageErrors）与用例名一字未动；修复会话对两个世界分别复验：注入版 4173 复用 2 passed，未注入产物（快照至 /tmp、4174 临时 preview）2 passed (3.8s)；文档 §2 GRF-07 行同步实跑口径。CDN 面嗅探仍由 GRF-01 锚定（其自带构建注入守卫提示）。

**flaky 噪音记录（不构成缺陷）**：分诊期间一次「2 flaky」系并行会话的孤儿 `vite preview`（PPID=1，`--outDir /tmp/vv-triage-grf02/build-cdn`）占 4173，被 `reuseExistingServer: !CI`（`playwright.config.ts:14`）复用、首轮撞上对方 /tmp 拷贝 torn 状态致页面空白超时；清理孤儿进程独占端口后干净转绿。**运行方须知**：共享机器上 `build/` 与 4173 端口是跨会话可变状态，多会话并发时若再遇 GRF 失败，先 `grep -rl cdn.grammars.test apps/web/build/` 查注入再分诊（本轮轮 2 未复发）。

---

## 4. 缺陷清单

### 4.1 verified（0 条）

本轮 **confirmed 产品缺陷为 0 条**（workflow findings 空、findingsSummary total 0、leftoverFailures 空）。轮 1 的 6 个门禁失败经分诊全部定性为执行侧环境缺失（§3.3），非产品缺陷、非脚本缺陷。52 个新场景覆盖的失败与降级行为——补块失败游标回退（SCAN-08）、回看停机闩（SCAN-10/JVL-07）、嗅探降级（DEG-06/JVL-03）、全量切换三请求序列（DEG-03，BUG-103 回归判据）、越界 400/403（MRF-02/03/04）等——均按预期锚定，未发现行为回退。

### 4.2 unconfirmed（10 条存疑观察，均未定档、未复核）

来源：6 份域材料的 suspects 记录（现象记录与读码推断，域材料明示「是否缺陷不臆断」「复核归后续」）。其中标注「本报告核对」的源码行为本报告撰写时 `sed`/`rg` 亲手核对在位；其余为域材料实测/读码证据的转录。severity 为**建议档**。

| 编号 | 位置 | 现象 | 证据 | severity（建议档） | status |
| --- | --- | --- | --- | --- | --- |
| SUSP-01 | `apps/web/src/lib/SearchPanel.svelte:105` + `packages/render-text/src/code.ts:2114-2128` | 清空搜索框或 Esc 关面板即以空 query 调 `search('')`，走换键重置分支（lastQuery 清空、命中集与游标清空）——重输同一 query 必然触发全新全文扫描（40 块级重拉），已完成扫描缓存不复用 | 读码定位（本报告核对：SearchPanel.svelte:105 `void instance?.search?.('')`、code.ts:2118-2128 换键重置分支在位）；「清空再重搜同词是否应缓存复用」属设计裁决 | —（设计裁决项） | unconfirmed |
| SUSP-02 | `packages/render-text/src/code.ts:1677-1696` | 长扫描期间视口所在块被块表 LRU 逐出后经 pendingReload 回看重拉补齐，同一次续扫内可发生两次（SCAN-08 实测块 1 Range 在续扫流中段出现 2 次）——扫描推进伴随视口行占位化再补齐的可见闪烁面；行为本身是占位兜底契约 | SCAN-08 实跑观测（域材料）；本报告核对 pendingReload 回拉逻辑 code.ts:1677-1682 在位 | low | unconfirmed |
| SUSP-03 | `packages/render-text/src/jsonl/index.ts:891-898` | 流内嗅探判非 UTF-8 的降级重渲把 target 整体 replaceChildren 换成全量视图，视口回到顶部、用户滚动位置丢失（JVL-03 实跑中降级收口后须重新贴底才能让 GBK 卡片入窗） | JVL-03 实跑观察（域材料）；罕见降级路径的 UX 粗糙面，是否需滚动位置恢复待复核裁决 | low | unconfirmed |
| SUSP-04 | `packages/render-text/src/blockStream.ts:130-138`（evictOverflow）+ `:169-190`（fetchBlock 超长 200-回退） | Range-less（200-only）服务器 + size 已知 >4MB（LRU 16×256KB）时「探针即全量零后续请求」不成立：head 全量预置块被 LRU 逐出，首屏 ensureBlock 对被逐块重拉收 200 全量并触发全量重取——10MB jsonl 实测首屏恰 3 请求共 **3×文件字节**（探针 0-8191 / 被逐块 0-262143 / 全量重取 0-MAX_SAFE_INTEGER，各收 10MB），滚动零新增 | 域材料一次性临时 spec 实测（双 project 一致）；本报告核对 evictOverflow（blockStream.ts:130-138）、超长 200-回退 fullReload 单飞去重（:169-190）、prefetchThrough 驻留检查按 nextBlock 起算（:297-304）在位。属设计内兜底（非错位），但 3 倍传输放大且与 io spec §2.3「调用方按返回长度自校验并停在该块」的回退语义描述存在形态差（实为重取全量） | medium | unconfirmed |
| SUSP-05 | `packages/render-text/src/blockStream.ts`（head 预置部分块语义）+ `packages/core/src/dispatch/dispatcher.ts:277-281` | ≤1MB 全量直读路径在 size 非块对齐时并非「恰 1 请求」：900KB jsonl 实测 2 请求——1 条无 Range 全量 read + 1 条带 Range 的 tail 部分块整块重拉（bytes=786432-921599） | DEG-05 首轮实测（双 project 复现，域材料）；本报告核对 dispatcher.ts:279 `size <= FULL_LIMIT → full = await read!()` 在位；已按块对齐夹具（恰界 1MB）规避并写入域文档 §4.3.2，「≤1MB 全量直读零额外读」口径是否收窄待裁决 | low | unconfirmed |
| SUSP-06 | `packages/highlight/src/core-parse.ts:266-273` | doPrepare 先 expandQueryAsync 后 resolveGrammarEntry：语言不在合并 manifest（如 GRF-01/06/07 中 java 无条目）时仍会发起该语言 `/queries/<lang>/*.scm` fetch 空打 | 代码阅读（本报告核对执行顺序属实：core-parse.ts:267-273 expand 先于 resolve）；域材料明示未布 route 计数实测，不臆断影响 | low | unconfirmed |
| SUSP-07 | `apps/web/src/lib/FileTree.svelte:24-43` | 来源根目录 listChildren 失败被 `.catch(() => [])` 静默吞掉：失败来源渲染标签行但树区零行且无任何错误提示——断网/权限失败下多根来源呈现「静默空树」，与 `TreeNodeRow.svelte:32-38` 子目录展开失败有状态栏提示（BUG-24 通道）不成对 | 读码观察（排查 MRF-07 定位问题时发现，域材料明示未在运行期复现）；本报告核对 FileTree.svelte:35-36 `.catch(() => [] as TreeNode[])` 在位 | medium | unconfirmed |
| SUSP-08 | `packages/render-media/src/image.ts:57-85` | 损坏图片渲染失败无任何错误卡片与 open-as 兜底：imageRenderer.render 恒 resolve（img 元素异步解码失败无人监听、仅裂图），与 av 渲染器 BUG-14 修复后的软失败卡片形态不一致——OWX 域原盘点「损坏 PNG 卡片」场景假设不成立，域文档已改用 broken.svg | 域材料源码+实跑佐证；本报告核对 `rg "addEventListener\('error'|onerror" packages/render-media/src/image.ts` 零命中（exit 1）；与既有 BUG-53 fixme（`e2e/t-media.spec.ts:319`）同现象，**不重复定档** | 关联既有 BUG-53 | unconfirmed |
| SUSP-09 | `packages/render-media/src/av.ts:456-464` + `apps/web/src/lib/ViewerPane.svelte:245-255` | 入口 A 两条链语义不一致：av/pdf 内构卡片「以 hex 打开」直调 `hex.render(buffer)` + takeOver，不经 dispatch 重入、不写 override——上位 hex 后 MetaPanel「打开方式」仍显示「自动」且无生效态标识；与 dispatcher openAsAction（rendererOverride 重入）同按钮不同语义 | 代码阅读 + OWX-03 断言链（域材料）；本报告核对 av.ts:456-464 直调形态在位；OWX-03 断言的「维持自动」在该链实为 ViewerPane 不感知上位（现象记录，是否缺陷不臆断） | low | unconfirmed |
| SUSP-10 | `packages/render-media/src/av.ts:457` | 内构链 hex 动作以手头全量 buffer 渲染（无 StreamCtx 全量形态）：远端来源的截断 mp4 卡片点「以 hex 打开」不产生窗口 Range 流式读——OWX-05 计量面因此改用抛错型渲染器才锚定 dispatcher 级窗口流式；av 非 streaming 故 buffer 恒全量在手，行为正确但绕过 hex streaming 能力（现象记录） | 代码阅读 + OWX-05 计量面现象（域材料）；本报告核对 av.ts:457 `hex.render(buffer, …)` 在位 | low | unconfirmed |

---

## 5. 功能完成度评估（逐域：承诺面 vs 覆盖面 vs 缺口）

### 5.1 code 后台扫描与重搜韧性（SCAN，11 场景）——**达成**

- **承诺面**（spec §4.3 七项）：进度可见双形态（「扫描中 N%」/「已扫描 N KB」+单调推进+完成移除）；令牌取消+属主接管；同键短路/部分收场续扫不重复；补块失败游标回退恢复；命中渐进；revealLine 未加载行续读（d37fcd0）；回看停机闩（90f4ca5）。
- **覆盖面**：SCAN-01~11 全部锚定（双 project 22/22）。进度文本双形态实测确证（`code.ts:1926-1927`，本报告核对「扫描中 N%」/「扫描中 · 已扫描 N KB」双分支在位）；SCAN-04 锚定 ffab040 属主语义（放行后块 3 已发出⇒旧扫描退出时进度条仍在）；SCAN-06 实测同键重搜零扫描 IO（唯 gotoMatch 缺驻补拉 ≤1）；SCAN-07 块 1..39 各恰拉取一次；SCAN-08 锚定二阶段首请求即块 3 的 206+缺块布点补全；SCAN-09 远端 NDJSON 命中帧→点击打开 79 块文件→块 73 行真实渲染；SCAN-10 首拒 500 恰一次+用户滚动重试 206/500/206 三态精确；SCAN-11 挂起阶段进度条先于完成上屏。
- **缺口清单**：(a) e75c59e scanLineText failedBlocks 路径与 pullBlock 失败路径在 e2e 可达面上观测等价（游标都停在失败块边界、失败块都恰一次请求），机制归因仅单测；(b) fa41d30 进度写节流（250Hz→100ms）写频率不外显，e2e 不可观测仅单测；(c) 进度条 destroy 即时收口（code.ts:2050 关 tab 路径）未布点（Esc 通道已覆盖取消面）；(d) 非 UTF-8 流内嗅探降级（5c92269）归 DEG/JVL 域。

### 5.2 jsonl 窗口降级链与回看（JVL，8 场景）——**达成**

- **承诺面**：jsonl spec §2.2 巨行防护、§4.2 渐进与 EOF 锁定、§4.3 防线换代（STREAM_MAX_BYTES）、§5 回看缓存、§6 代理面。
- **覆盖面**：JVL-01~08 全部落地并实跑通过（双 project 16/16）。JVL-01 过大行徽标「行过大（>1MB）」+64K 预览不解析无 U+FFFD；JVL-02 512MB 零读停机+状态条「已达流式上限，建议以 hex 打开」非失败态；JVL-03 嗅探降级后 metaSize/行数转投全量实例（BUG-105/9a0aa54 回归，夹具判脏前缀 786432≠实体字节数使旧缺陷可观测）；JVL-04 回看缓存命中零新请求（12 块≤LRU 16 全驻留构造）；JVL-05 prefetchThrough 首屏两块并行预取夹持（stall 门+在途观测）；JVL-06「已加载 N 行→共 N 行」+EOF 锁定；JVL-07 回看重拉停机闩零风暴+用户动作单次重试（fail 门 nth=2 精确区分首屏合法拉取）；JVL-08 视口外卡片回收 DOM 有界代理。
- **缺口清单**：(a) size 未知恰界/动态达限停机分支（25c704e）无 e2e——io-degrade-matrix.md 头注裁决不设（需真实流过 512MB），本域沿用；(b) 块表 LRU 16/文本缓存 8 上限本身仅单测锚（jsonlWindowedInternals WeakMap 无 e2e 访问通道），e2e 只锚行为面（JVL-04 零请求、JVL-07 逐出重拉）；(c) JVL-08 是 DOM 代理断言非内存精确计量（域文档 §4.3 注明）；(d) jsonl 全量模式装配/坏行面归 OPEN-04~07 既有锚，本域不重复；(e) 三域共享 helper `b-stream-resilience-helpers.ts` 本轮中途才由并行环节落地，本域 spec 自包含未依赖（后续整并时迁入 startJvlFakeServer/IoStats）；(f) 旧「>200MB 降纯文本」口径按裁决不布点——`jsonl/index.ts:109-115` 注释自证「计划裁决：阈值单测 + e2e 不覆盖降级路径」（本报告核对）。

### 5.3 IO 流式公共防线降级矩阵（DEG，9 场景）——**达成**

- **承诺面**：io spec §5 降级矩阵整行（StreamCtx/rangeCapable/STREAM_MAX_BYTES 三维）。
- **覆盖面**：DEG-01~09 全部被 Playwright 锚定（双 project 18/18，15.3s）。DEG-01/09 !rangeCapable 全量 ctx 双载体（url jsonl/hex：恰 1 请求、无 Range 头、全量形态；url store 无 rangeCapable——`packages/core/src/tree/singleFile.ts:17` `createUrlStore`，本报告核对）；DEG-02 Range-less 200-only 正锚（探针被 200 全量回答、恰 1 请求、滚动零新增——补上 `b-io-streaming:213` 自认缺口；注意该承诺仅 LRU 界内成立，见 SUSP-04）；DEG-03 探针 206+块读 200 超长→全量切换恰 3 请求、末行零错位（BUG-103 回归判据逐条核对）；DEG-04 size 未知 jsonl 仍窗口流式（末块 137B 短读探 EOF、端点未预钳）；DEG-05 FULL_LIMIT 恰界 1MB 含→全量直读 vs 2MB→探针+2 块恰 3 请求；DEG-06 流内 UTF-8 嗅探降级（BUG-104 回归判据：停喂+memoizedFullRead 恰 1 条+redetectWithFull 精判 gb18030 状态栏翻转、无 U+FFFD、降级后滚动零 IO）；DEG-07/08 SSE changed 免全量重读（jsonl/code 版，与 IO-03 hex 版凑齐三载体）。
- **缺口清单**：(a) size 未知 STREAM_MAX_BYTES 恰界停机（25c704e）按裁决不设；(b) jsonl 载体的嗅探降级归 JVL-03（本域 DEG-06 仅 code）；(c) zip/libarchive 的 !rangeCapable+size 已知形态未单独布点——与 url store 同走 dispatcher 全量切片分支（`dispatcher.ts:346-370` 域材料定位），判低风险；(d) DEG-02 承诺面仅 LRU 界内（≤4MB）成立，超界 3 倍传输放大（SUSP-04）；(e) hex size 未知全量回退的结构树 tail 面未单独断言（head=全量时零 IO，与 IO-01 护栏重叠）。

### 5.4 grammar SPA-fallback 嗅探回归（GRF，8 场景）——**达成**

- **承诺面**：三层资产解析链对「资产被 SPA fallback HTML 化」的嗅探与跳层语义（050ae69 manifest 嗅探、7fab3a5 前端层视同缺失）。
- **覆盖面**：GRF-01~08 全部实跑锚定。GRF-01 CDN manifest 200 text/html→嗅探跳层 warn 恰一条含「非 JSON 资产应答（SPA fallback？）」不含「加载失败」+java.wasm 零请求+hljs 兜底不崩（BUG-106/050ae69）；GRF-02 同源 manifest HTML 化→CDN 层兜底照常（first-wins 跨层不受嗅探影响）；GRF-03 wasm 被 HTML 兜底→WebAssembly 实例化失败被捕获（BUG-06a per-language warn 恰一条）整语言降级；GRF-04 injections.scm 200 text/html→视同缺失（7fab3a5）highlights.scm 照常（route 计数确证两条都真被请求）；GRF-05 正常 application/json 零误伤正锚；GRF-06 无 content-type+HTML body→JSON.parse 失败 catch 等价（探针验证 route.fulfill 无 contentType 时页面 fetch 得 content-type:null）；GRF-07 warn 每层每会话恰一条（改锚同源面后对两种构建状态均确定性绿，§3.3）；GRF-08 java/rust 隔离性。
- **缺口清单**：①7fab3a5 server 层（.scm/.wasm 回 404）不在浏览器域，由 cargo 集成用例覆盖；②SW CacheFirst 面被 `serviceWorkers:'block'` 屏蔽（离线行为归 fix-pwa）；③GRF-05「完全不 mock」在 CDN 注入构建下不可满足（三层链恒发 CDN manifest 请求），以合法空 JSON mock 等价达成正锚意图（域文档已记录偏差及理由）；④warn「恰一条」锚定 console.warn 文案字符串，产品文案改动需同步测试；⑤GRF-01/02 对无注入 dist 按 env 守卫设计必败，CI e2e job 注入同参 env 为权威门禁（本地门禁已持久修复，§3.3）。

### 5.5 多根 file 通道与越界防护（MRF，8 场景）——**达成**

- **承诺面**：workspace-tabs-design §2.1/§2.3/§5（file?root 按根路由、越界 400、../ 清洗、symlink 越界 403、root×Range 共存、单根兼容、UI 全链、watch 帧按 rootIndex 过滤）。
- **覆盖面**：MRF-01~08 全部锚定（server 套件两轮 8/8）。MRF-01 root=0 显式=缺省、root=1 取子树；MRF-02 越界 400「root index out of range」file/tree 双端点（含 root=-1 坏输入 4xx 不 500 化）；MRF-03 `../` 清洗 400（`server/src/guard.rs:22`，本报告核对）+root0-only 路径在 root=1 下 404；MRF-04 root 内 symlink 越界 403「path escapes root」（`guard.rs:46-50` canonicalize 越界校验，本报告核对）；MRF-05 root×Range 共存（206/Content-Range/开口尾段钳制/布点字节/非 UTF-8 octet-stream）；MRF-06 单根兼容三态；MRF-07 UI 全链（双根实例伺服 web-dist→health roots=2→根选择→添加 1 号根→打开文件渲染且 /api/file 带 root=1——root 透传在 `packages/core/src/tree/remote.ts:182`，本报告核对；含 browse 层 root1 树不串 root0 的 BUG-107 回归形态拦截）；MRF-08 watch 帧按来源 rootIndex 过滤（`tree/remote.ts:240`，本报告核对；root0 同名文件负向不重读+root1 正向重读对照证明链路活）。
- **缺口清单**：(a) /api/compute/* 的 root 参数无 e2e（主实例无 --compute，归 CMP 域）；(b) /api/search 指定 root 限定单根语义仅锚缺省跨根半，限定半无锚；(c) 多根 remote 源（storeId :r1 段）刷新恢复无 UI e2e（WS-05 只锚 basePath 源）——后续补点候选；(d) RemoteSourceModal 断线/越界错误卡片语义未布点；(e) 快照 v2 迁移按域计划不布点（t-open-with.spec.ts:254 起 BUG-69 已覆盖）。

### 5.6 错误卡片打开方式入口（OWX，8 场景）——**达成**

- **承诺面**：format-coverage-open-with-design §2.3 入口 A（错误卡片快捷按钮、按探测结果动态排序）+ §5 验收（错误卡片与 MetaPanel 两入口可用、override 经刷新恢复）。
- **覆盖面**：OWX-01~08 全部落地并实跑通过（16/16）。入口 A 两条实现链的点击全链——渲染器内构软失败链（OWX-01/06/07③/08，hex 直调+takeOver 级联）与 dispatcher 抛错链（OWX-02/04/05，openAsAction rendererOverride 重入）；动态排序文本分支（OWX-02 断言 [重试,以纯文本打开,以 hex 打开]）；e183735 重入失败保留卡片且动作可复用（OWX-04 远端读失败注入）；临时查看不落 override 三面（OWX-03 下拉维持自动+无手动标记+快照无 overrideRenderer、OWX-06 刷新回原路由形态）；重试互斥替换无泄漏无 pageerror（OWX-07）；移动 375px 入口 A 不依赖抽屉可达可点（OWX-08）。
- **缺口清单**：①动态排序「二进制→hex 排前」分支无 dispatcher 级锚（二进制内容默认 registry 下无 dispatcher 级卡片自然触发面；该顺序仅由 MEDIA-11 av 内构按钮顺序间接覆盖）；②损坏图片无错误卡片、入口 A 对 image 形态实际不可达（=BUG-53 fixme，域文档已修正原盘点假设，SUSP-08）；③「按探测结果动态排序」实现窄化为 looksTextual 二分（`dispatcher.ts:167`，本报告核对），完整探测链结论不参与排序——语义窄化记录为现状；④「override 经刷新恢复」手选正向面依赖既有 OPEN-03/BUG-69 锚，本域只提供对照面。

---

## 6. 覆盖与未覆盖范围

### 6.1 已覆盖（本轮实测面，摘要）

- **52 场景 / 6 域**全部落地实跑：SCAN 11（含扫描进度双形态、取消收场、属主接管、同键重搜零重复、补块失败回退、revealLine 续读、回看停机闩）、JVL 8（过大行、512MB 零读停机、嗅探降级 metaSize 转投、回看零请求、prefetch 夹持、渐进+EOF、重拉停机闩、卡片回收）、DEG 9（!rangeCapable 双载体、200-only 正锚、全量切换三请求、size 未知窗口流式、FULL_LIMIT 恰界、流内嗅探降级、SSE 免全量重读 ×2）、GRF 8（三层资产链 SPA-fallback 嗅探矩阵）、MRF 8（多根 file 通道与越界 400/403 矩阵+UI 全链+watch 过滤）、OWX 8（open-as 全链双实现通道+动态排序+移动端可达）。
- **门禁 2 轮 × 双套件** + 分诊复跑取证 + 修复验证（含 GRF-07 两种构建状态双世界验证）。
- **回归判据就位**：BUG-103（DEG-03）、BUG-104（DEG-06）、BUG-105（JVL-03）、BUG-106（GRF-01/02/03）、BUG-107（MRF-07）均有编号化回归锚。

### 6.2 未覆盖与受限（如实披露，未跑的检查不写成已验证）

1. **门禁为补测集口径**：全量历史套件（default 40 文件 235 用例 / server 14 文件 63 用例，`rg -c` 实测）本轮未跑；上轮 37 条缺陷的回归锚点不在本轮门禁范围，**本轮未做上轮缺陷回归复测**。
2. **size 未知 STREAM_MAX_BYTES 恰界/动态达限停机（25c704e）**：无 e2e——需真实流过 512MB，域裁决不设（io-degrade-matrix.md 头注），JVL/DEG 两域一致沿用。
3. **缓存上限机制面**：块表 LRU 16/文本缓存 8 上限本身仅 render-text 单测锚（WeakMap 内部状态无 e2e 访问通道），e2e 只锚行为面（JVL-04/JVL-07）。
4. **DEG 尾面**：zip/libarchive 的 !rangeCapable+size 已知形态未单独布点（判低风险）；hex size 未知全量回退的结构树 tail 面未单独断言。
5. **GRF 受限面**：7fab3a5 server 层由 cargo 集成覆盖（域计划明确不设 server 套件 spec）；SW CacheFirst 被 `serviceWorkers:'block'` 屏蔽（离线归 fix-pwa）；GRF-01/02 依赖构建期注入——本地 `pnpm build` 无注入，任何一次无 env 重建都会再假红（workflow 已注入+自检持久修复，CI 为权威门禁）；GRF-05「完全不 mock」物理不可满足，以合法空 JSON mock 等价（偏差已记录）。
6. **MRF 缺口**：/api/compute root 参数（归 CMP 域）；/api/search 限定单根半；多根 remote 源刷新恢复；RemoteSourceModal 错误卡片语义；快照 v2 迁移（既有 BUG-69 覆盖不重复）。
7. **OWX 缺口**：「二进制→hex 排前」动态排序分支无 dispatcher 级锚；损坏图片形态入口 A 实际不可达（BUG-53 修复前无法布点）。
8. **e2e 不可观测面**：fa41d30 进度写节流（250Hz→100ms）仅单测；SCAN 进度条 destroy 收口（code.ts:2050 关 tab 路径）未布点（Esc 通道已覆盖取消面）。
9. **jsonl 旧口径**：「>200MB 降纯文本」委托分支按裁决不布点（窗口模式 buffer 形参是探测头、该分支对真构造不可达；`jsonl/index.ts:109-115` 注释自证）。
10. **本报告撰写轮未复跑**：typecheck/build/cargo 与两轮门禁均为 workflow 记录值 + 盘上产物佐证（`pw-out-r1/r2` 目录实存），本报告仅做只读核对（git/源码行/产物指纹/用例计数），未执行构建或测试。
11. **headless 受限**（沿 docs/e2e/README.md 口径）：本轮场景均不依赖 FS Access/真实触摸，无受阻项。

---

## 7. 附录

### 附录 A：本轮提交清单（`git log --oneline -8` 实测）

| 提交 | 内容 |
| --- | --- |
| `40fa2b9` | docs(e2e): 补充轮域裁决——新增 6 份域场景文档（52 场景） |
| `b4bc0f7` | test(e2e): code 后台扫描与重搜韧性 场景文档与自动化脚本——SCAN-01~11 实跑锚定 |
| `83c0fc4` | test(e2e): jsonl 窗口降级链与回看 场景文档与自动化脚本——JVL-01~08 实跑锚定 |
| `fd628f3` | test(e2e): IO 流式公共防线降级矩阵 场景文档与自动化脚本——DEG 域实跑锚定 |
| `fbbc31a` | test(e2e): grammar SPA-fallback 嗅探回归 场景文档与自动化脚本——GRF-01~08 实跑锚定 |
| `8d597a0` | test(e2e): 多根 file 通道与越界防护 场景文档与自动化脚本——MRF-01~08 server 套件补齐 |
| `db9b8ed` | test(e2e): 错误卡片打开方式入口 场景文档与自动化脚本——OWX-01~08 实跑锚定 |
| `b66a40c` | test(e2e): GRF-07 刷屏锚改锚同源 manifest SPA 面——构建注入缺失不再假红 |

### 附录 B：证据归档索引

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 门禁输出 | `apps/web/.temp/pw-out-r1/`、`apps/web/.temp/pw-out-r2/` | 两轮 default/server 门禁 Playwright 输出（轮 1 含 GRF-01/02/07 error-context） |
| 分诊/修复复跑输出 | `apps/web/.temp/pw-out-triage-{grf01,grf02,grf07,r1-self,grf02-injected,grf02-injected2,grf02-restored,grf02-restored2}/`、`pw-out-fix-{grf01,grf02,grf0207,grf07}/` | 6 项失败的分诊复跑与修复转绿验证（`ls` 实存 14 目录） |
| 域场景文档 | `docs/e2e/{code-scan-resilience,jsonl-degrade-chain,io-degrade-matrix,grammar-spa-fallback,multiroot-file-channel,error-card-open-as}.md` | 52 场景验收判据、裁决与偏差记录 |
| 自动化 | `apps/web/e2e/b-{code-scan-resilience,jsonl-degrade-chain,io-degrade-matrix,grammar-spa-fallback,error-card-open-as}.spec.ts`、`apps/web/e2e/b-stream-resilience-helpers.ts`、`apps/web/e2e-server/b-multiroot-file.spec.ts` | 6 spec（44 default + 8 server 用例，grep 实测）+ 共享 helper |
| 持久修复（gitignore 内，无 git 变更） | `.zcode/workflow-drafts/e2e-场景补充与全量测试.dwf.ts`（构建步骤 env 注入 + 产物自检）、`apps/web/build/`（注入版产物） | 轮 1 假红的根治项 |

---

*报告完。被测版本与工作树状态、门禁产物注入指纹、spec 用例计数、全量套件规模、双套件配置与缺陷清单所引源码行为本报告撰写时亲手实测/核对（命令与输出见各节）；域级实跑细节、门禁轮次数字、分诊取证与 suspects 记录转录自本轮域材料与 workflow 门禁/分诊记录；verified 与 unconfirmed 全程区分——本轮 confirmed 产品缺陷 0 条，10 条存疑观察均未定档待复核；门禁 88+8 全绿为补测集口径，不构成全量回归结论（§2.3/§6.2）。*
