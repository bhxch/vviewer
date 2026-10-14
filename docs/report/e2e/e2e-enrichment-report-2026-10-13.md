# vviewer E2E 富化测试报告（2026-10-13）——三域富化、存疑复核定档与全量回归轮

> 被测版本：`main` @ `e0c0951`（`git rev-parse HEAD` → `e0c09518dce2afa17321347c0d1a9e5b56996225`，2026-10-14 09:47「fix(test): 修复 SUSP-06/WSX-12 两处 TS 类型错误使 TYPECHECK 门禁转绿」，`git status --short` 为空——工作树干净，本报告撰写时实测）。**执行版本口径**：本轮提交链 `be8ab79`/`9d3cef6`/`80de937`（10-14 09:36）→ 门禁轮 1（落盘 09:38:45）→ `b56e908`+`e0c0951`（09:37/09:47）→ 门禁轮 2/3（09:48:10/09:48:45）→ 全量回归收尾（10:07:09，以上时点均 `stat` 实测）。**轮 1 的起跑树盘上不可判定，如实标注不裁断**：其落盘时点界于 `80de937`（09:36）之后、`e0c0951`（09:47）之前，无法区分起跑于 `80de937` 抑或 `b56e908`（09:37），且产物已被 10:08:47 重建覆盖（§2.1）；轮 2/3 与全量回归执行于 `e0c0951`（HEAD）。所涉三提交均纯测试侧（`git show --stat` 实测：`b56e908` 仅测试标题 1 行、`e0c0951` 仅 2 个 spec 文件的夹具形参与类型断言 +5/−2），产品代码零差异，定档与分诊结论不受影响。
> 背景批次：本报告为 **2026-10-13 两份姐妹篇之后续**（同日补充轮报告 `docs/report/e2e/e2e-test-report-2026-10-13.md` 交付 52 场景 6 域补测并留下 10 条存疑观察与 §7 复核出口）。本轮三域并行富化：① workspace 多根语义/恢复链/搜索引擎宣告（WSX）② tab 动作撤销栈与拖拽受理边界（TAX）③ 上轮存疑观察 e2e 复核定档探针（SUSP），并以 default 全量回归兑现上轮 §7.2 欠下的「37 条历史缺陷回归复测载体」。
> 证据根目录：`apps/web/.temp/pw-out-r1|r2|r3`（新场景门禁三轮，`.last-run.json` 均 passed）、`apps/web/.temp/pw-full-def`（全量回归，status failed + failedTests 恰 6 + 14 个失败现场目录，均 `stat`/`cat`/`ls` 实测）、`docs/e2e/{workspace-enrichment,tab-actions-enrichment,susp-verification}.md`（3 份域文档）、自动化 spec 4 份（default 3 + e2e-server 1，在盘实测）。
> 状态标记约定（沿姐妹篇）：**verified** = 本轮经复核会话/分诊会话或本报告撰写时亲手复现/核对证实；**转录** = workflow/域材料记录值（逐处标注，不冒充实测）。

---

## 1. 执行摘要

### 1.1 本轮流程与总量

本轮为「三域并行富化（场景文档+spec 同提交）→ 新场景门禁 3 轮 → TYPECHECK 红转绿修复 → default 全量回归与失败分诊 → SUSP 存疑 9 条定档 → 交付报告」流程：

1. **三域富化落地**（`git show --stat` 实测，均为文档+spec 同提交）：`be8ab79` WSX 域 3 文件 +1479 行（`e2e-server/b-wsx-root-channel.spec.ts` 563 行 WSX-01~06 + `e2e/b-wsx-recovery.spec.ts` 793 行 WSX-07~12 + `docs/e2e/workspace-enrichment.md` 123 行）→ `9d3cef6` TAX 域 2 文件 +859 行（`b-tab-actions-enrichment.spec.ts` 773 行 TAX-01~10 + `tab-actions-enrichment.md` 86 行）→ `80de937` SUSP 域 2 文件 +795 行（`b-susp-verify.spec.ts` 700 行 SUSP-01~07/09/10 探针 + `susp-verification.md` 95 行）。共 **31 场景 / 4 spec / 3 文档**（grep 实测各 spec test() 数：6/6/10/9）。
2. **新场景门禁 3 轮**（gateHistory 转录 + `.last-run.json` 实测）：default(:4173) 47 通过 / 0 失败 × 3 轮，exit 0；`.last-run.json` 均 status passed（09:38:45 / 09:48:10 / 09:48:45），盘上无失败现场目录——**本轮新场景门禁零失败、零分诊**。
3. **TYPECHECK 红转绿**：门禁 typecheck 记录 exit 2（转录）→ `e0c0951` 修复 SUSP-06/WSX-12 两处 TS 类型错误（diff 实测：SUSP-06 夹具形参 `content`→`bytes`、WSX-12 类型双跳断言，纯测试侧）→ 本报告撰写时复跑 `pnpm typecheck` **exit 0**（tsc -b + svelte-check 0 errors 0 warnings，实测）。
4. **全量回归（default 全套件）**：481 通过 / 6 终态失败（workflow 转录），盘上 `pw-full-def/.last-run.json`（10:07:09，failedTests 恰 6）+ 14 个失败现场目录实存（实测）；另有 2 条 flaky 转绿记录。8 条失败记录全部完成分诊：**env-flaky 2 / test-issue 5 / product-bug 1（新产品缺陷 BUG-201，verified medium）**——详见 §5。
5. **存疑定档清账**：上轮 10 条存疑观察中的 9 条探针化复核（SUSP-01~07/09/10；SUSP-08 依上轮 §4.2 裁决并入既有 BUG-53 不设探针）——**9/9 探针绿（现象全部运行期复现，probe-negative 0）**；定档 **confirmed-design 8 条（7 条维持现状记录 + SUSP-09 关闭）+ confirmed-bug 1 条（SUSP-07，medium，开修复立项）**。GRF-05 标题随 `b56e908` 修订（上轮 §5.4 缺口③清账）。
6. **缺陷计数**：verified 产品缺陷 **2 条**（SUSP-07 medium、BUG-201 medium，均开修复立项）；新增 unconfirmed 存疑观察 **3 条**（SUS-TAX-1 缺陷候选 + WSX 两条现象记录，§4.3）。

### 1.2 缺陷计数

| 类别 | verified | unconfirmed | 小计 |
| --- | --- | --- | --- |
| 产品缺陷 | **2**（SUSP-07、BUG-201，均 medium） | 0 | **2** |
| 测试脚本缺陷 | 0 | 0 | 0 |
| 缺陷候选（未定档，§4.3） | — | 1（SUS-TAX-1） | 1 |
| 存疑现象记录（非缺陷裁断，§4.3） | — | 2（WSX 观察 1/2）+ 1 条环境注意事项 | 3 |
| 存疑定档（上轮 10 条清账） | confirmed-bug 1（SUSP-07）+ confirmed-design 8 | —（SUSP-08 并入 BUG-53） | 9+1 |
| 全量回归终态失败 | 6（分诊：test-issue 5 + product-bug 1） | 0 | 6（另有 flaky 转绿 2） |

- 与姐妹篇（同日补充轮）的关系：其 10 条存疑观察中 9 条本轮定档完毕（§4.2），SUSP-08 维持并入 BUG-53；其 §7.2 欠下的全量回归载体本轮兑现（§5.3）。
- 与上上轮（2026-10-10，37 条确认缺陷）的关系：**37 条历史缺陷的回归验收由本轮 default 全量套件承载**，分诊 8 条记录中无一条定性为「历史缺陷修复回退」——其中 BUG-20（37 条之一，e2e-test-report-2026-10-10.md:594）的契约锚本轮 chromium+mobile **双红**，经分诊定性豁免（断言时代差 + 新缺口 BUG-201，非修复回退；§5.3）。

### 1.3 一句话结论

**本轮三域富化目标全部达成、新场景门禁三轮零失败，存疑清单完成定档清账（8 design + 1 bug），并以 default 全量回归补上了上轮欠下的历史缺陷回归载体——但全量回归暴露 1 条新产品缺陷（BUG-201：窗口流式下大文件行索引无自动推进通道）与 5 处断言时代差，全部完成分诊。** 取舍理由：confirmed-bug 仅 SUSP-07 一条——9 条探针全绿只证「现象在」，定缺陷靠读码裁决（FileTree 根级失败静默与既有 BUG-24 提示通道不成对、且查无静默为设计之裁决），其余 8 条 confirmed-design（**7 条维持现状记录 + SUSP-09 关闭**）均有承诺面注释/矩阵注释在案（其中 **4 条带优化立项候选**〔SUSP-01/02/03/06〕、SUSP-04 附文档债〔io spec §2.3 文字待清〕，§4.2）；BUG-201 定缺陷靠复核复跑与本报告修订时亲手复跑同冻结值 3640 的确定性失败 + 读码证实无索引泵 + 契约面（io spec〔docs/superpowers/specs/2026-10-12-io-streaming-design.md，下同〕§4.3:98「后台逐块推进」不被 §8:131-136 豁免清单〔4 项〕覆盖）。**复核出口建议**（本轮未定，待编排方裁决，§6.2）：SUSP-07 与 BUG-201 开修复立项（SUSP-07 修复后按 `susp-verification.md` §3 翻转探针负向断言；BUG-201 修复后 BUG-20 契约锚应转绿、5 处 test-issue 断言按窗口流式口径重定基）；SUSP-04 的 io spec §2.3 本体文字待清（域文档路线已执行）。

---

## 2. 环境与口径

### 2.1 被测版本与构建（含 VV_GRAMMAR_CDN 注入说明）

- git 基线：`main` @ `e0c09518dce2afa17321347c0d1a9e5b56996225`（`git rev-parse HEAD` 实测，工作树干净）。本轮提交链 5 条（`git log --format` 实测）：`be8ab79`(09:36 WSX) → `9d3cef6`(09:36 TAX) → `80de937`(09:36 SUSP) → `b56e908`(09:37 GRF-05 标题) → `e0c0951`(09:47 TS 修复)。
- **VV_GRAMMAR_CDN 注入链（本报告核对在位）**：`apps/web/vite.config.ts:225`（define `'import.meta.env.VV_GRAMMAR_CDN': JSON.stringify(process.env.VV_GRAMMAR_CDN ?? '')`，缺省空串，实测）→ `highlightClient.ts:246`（`|| null`）→ `grammarLayers.ts:80`（cdnBase 空则 CDN 层不入候选，姐妹篇核对转录）；CI 恒注入（`.github/workflows/ci.yml:90` `VV_GRAMMAR_CDN: https://cdn.grammars.test/grammars/`，实测）。本轮门禁构建步骤携 env 注入（workflow 记录 `cdnInjected=true`，**转录**）。
- **产物状态警示（本报告撰写时实测，先例重演）**：盘上 `apps/web/build/` 已被 **2026-10-14 10:08:47** 重建覆盖（`stat` 实测 index.html 与 nodes/*.js mtime），`rg -c 'cdn\.grammars\.test' apps/web/build/` → **exit 1 零命中——当前盘上产物无注入**。时序：三轮门禁（09:38–09:48）→ 全量回归收尾（10:07:09）→ 10:08:47 无 env 重建——即测试全部结束后产物才被覆盖。**测试期间产物为注入版的证据**：① workflow 构建步骤 `cdnInjected=true`（转录）；② 侧证——全量回归 481 通过中含 GRF-01（env 守卫用例，无注入构建必假红），而其不在 6 条终态失败与 2 条 flaky 之列（`pw-full-def` 目录实测无其现场目录、failedTests 无其哈希）；该前提不依赖姐妹篇转录——in-repo 佐证（本报告修订时核对）：`b-grammar-spa-fallback.spec.ts:24` 注释明言「未注入时 CDN 层不发起任何请求——GRF-01/02 的 warn/命中计数断言即构建注入守卫」。**固化诉求（姐妹篇 §7.3）仍未兑现**：`apps/web/package.json:8` build 脚本仍无 env（实测 `rg '"build"'`），任何一次无 env 重建都会令 GRF-01/02 再假红——本轮 10:08:47 重建即为先例重演。
- typecheck：门禁记录 exit 2（转录，SUSP-06/WSX-12 两处 TS 类型错误）→ `e0c0951` 修复 → 本报告撰写时复跑 **`pnpm typecheck` exit 0**（tsc -b packages + svelte-check 0 errors 0 warnings，实测，命令与输出见本节）。build exit 0 / cargo exit 0：**workflow 转录，本报告未复跑**（build 会覆写共享产物；cargo 未执行）。

### 2.2 运行实例与双套件通道

- 沿姐妹篇 §2.2 同一配置（转录；两配置文件本轮零改动，工作树干净佐证）：**default 套件** vite preview `:4173`（strictPort、`reuseExistingServer: !CI`），projects 双份 chromium + mobile（375×667 + hasTouch），workers 3、retries 1；**server 套件** release 二进制 `:4174`（`playwright.server.config.ts`），workers 1、单 chromium project。
- 本轮门禁仅 default 通道 3 轮；**server 通道本轮无门禁轮次**（全量回归 `regression.server=null` 转录；盘上 `pw-srv-out-r1/r2` mtime 10-13 19:53:07/20:18:02 为姐妹篇产物，实测）——WSX server 侧 6 用例（`b-wsx-root-channel`）以**域材料本地实跑**交付：6 passed (19.3s)，拓扑 :4174 主实例 + :4396 双根 / :4397 仅 grep PATH 注入 / :4398 空 PATH / :4399 双根 --compute（转录）。

### 2.3 门禁与回归范围口径（重要，防止误读）

- **新场景门禁集**（47 的构成）：default 侧 3 个新 spec——`b-wsx-recovery` 6 + `b-tab-actions-enrichment` 10 + `b-susp-verify` 9 = 25 声明用例（grep 实测）× 双 project = 50 执行 − 3 条 TAX mobile skip（TAX-02/03/10 按 project 惯例跳过，域材料转录）= **47 通过**。server 侧 `b-wsx-root-channel` 6 用例不在 default 门禁集（§2.2）。
- **全量回归**：default 全套件（含全部 t-\* 既有回归锚与本轮新增 b-\*），执行 481+6=487；声明用例数 `e2e/` 260 + `e2e-server/` 69 = **329**（grep `'^\s*test\('` 实测；其中本轮新增 25+6=31，存量 298 与姐妹篇 §2.3 基线 235+63 严丝合缝）。对账**如实标注未闭合**：潜在执行 260×2=520，实录 481+6=487（另有 flaky 2）——**差 33 条执行未逐项对账**：可点名者仅 TAX 3 条 mobile skip（`b-tab-actions-enrichment.spec.ts:323/:401/:742` 三处 `test.skip(project!=='chromium')`，本报告修订时 grep 实测），其余归于条件 `test.fixme`（`e2e/` 内 32 处声明 × 双 project 的条件展开，哪些条件为真未盘点）及其他运行期 skip；workflow 转录未含 skipped/flaky 汇总行，等号不写死。
- **server 套件全量本轮未跑**（`regression.server=null`）——全量回归结论限于 default 通道，见 §7。

---

## 3. 三域富化结果

### 3.1 门禁与静态检查总览

| 检查项 | 结果 | 口径 |
| --- | --- | --- |
| 新场景门禁轮 1（default:4173） | 47 通过 / 0 失败，exit 0 | gateHistory 转录；`.last-run.json` status passed（09:38:45）实测在盘 |
| 新场景门禁轮 2（default:4173） | 47 通过 / 0 失败，exit 0 | 同上（09:48:10） |
| 新场景门禁轮 3（default:4173） | 47 通过 / 0 失败，exit 0 | 同上（09:48:45）；newGateFinal 47/0 转录一致 |
| server 通道门禁 | 本轮无轮次 | §2.2；WSX server 6 用例为域材料本地实跑（转录） |
| typecheck | 门禁记录 exit 2 → **修复后 exit 0** | exit 2 为转录；exit 0 为本报告复跑实测（`pnpm typecheck`，svelte-check 0 errors 0 warnings） |
| build / cargo | exit 0 / exit 0 | workflow 转录，未复跑 |
| default 全量回归 | 481 通过 / 6 终态失败（+flaky 2 转绿） | 通过/失败计数为 workflow 转录；盘上 `pw-full-def` status failed + failedTests 恰 6 + 14 现场目录实测，分诊见 §5 |

### 3.2 域/场景汇总表

| 域 | 场景文档 | 场景 | 套件/通道 | 自动化（test 数 grep 实测） | 门禁红绿 |
| --- | --- | --- | --- | --- | --- |
| workspace 富化（多根语义、恢复链与搜索引擎宣告） | `docs/e2e/workspace-enrichment.md` | WSX-01~12（12） | server :4174（WSX-01~06）+ default :4173（WSX-07~12） | `e2e-server/b-wsx-root-channel.spec.ts`（6）+ `e2e/b-wsx-recovery.spec.ts`（6） | server 侧 6/6（域材料实跑 19.3s，转录）；default 侧含于门禁 47，三轮全绿 |
| tab 动作富化（撤销栈与拖拽受理边界） | `docs/e2e/tab-actions-enrichment.md` | TAX-01~10（10） | default :4173 | `e2e/b-tab-actions-enrichment.spec.ts`（10） | 17 passed + 3 mobile skip / 0 failed（域材料实跑，转录）；含于门禁 47 |
| 上轮存疑观察 e2e 复核（定档探针） | `docs/e2e/susp-verification.md` | SUSP-01~07/09/10（9 探针；SUSP-08 无探针随 BUG-53） | default :4173 | `e2e/b-susp-verify.spec.ts`（9） | 域材料两轮 18/18（转录）；含于门禁 47；SUSP-07 本报告撰写时复跑 2 passed（4.4s，实测） |
| **合计** | 3 份文档 | **31** | 双套件 | 4 spec（+既有 helper 复用不修改） | **门禁三轮 47/0 ×3，零失败** |

场景编号 WSX/TAX/SUSP 与既有锚点（WS/TA/MRF/SCAN/JVL/DEG/GRF/OWX/CMP/SHELL 等）无重叠（域文档声明，转录）。

### 3.3 新场景门禁轮次记录

| 轮次 | 套件（通道） | 通过 | 失败 | exit | 时点（.last-run.json 实测） | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | default（vite preview:4173） | 47 | 0 | 0 | 2026-10-14 09:38:45 | 全绿（落盘时点界于 80de937/b56e908 与 e0c0951 之间，起跑树盘上不可判定——所涉提交均纯测试侧，§执行版本口径） |
| 2 | default（vite preview:4173） | 47 | 0 | 0 | 2026-10-14 09:48:10 | 全绿（`e0c0951` 后） |
| 3 | default（vite preview:4173） | 47 | 0 | 0 | 2026-10-14 09:48:45 | 全绿；newGateFinal 47/0 |

- **与姐妹篇门禁的差异**：本轮三轮零失败、零分诊、零修复——姐妹篇轮 1 的 6 个 CDN 注入假红未重演（本轮门禁构建步骤携 `VV_GRAMMAR_CDN` 注入，`cdnInjected=true` 转录；且新场景集不含 GRF 用例，注入敏感面为 WSX-03/04 的 PATH 拓扑与 grep 宣告面，不依赖构建期 CDN 注入）。
- **域材料本地实跑记录（均先于门禁、超出 --list 的验证，转录）**：WSX server 6 passed (19.3s)、WSX default 12 passed (9.6s)（--retries=0），过程中修正 4 处脚本侧错误（root0 目录漏建、sub 夹具内容串命中集、search 越界文案按不可达分支断言、allTexts API 误用）；TAX 首轮 9 失败全部根因定位——8 处断言/夹具错误修复 + 1 处真实产品缺陷候选 SUS-TAX-1（改锚现状并记录，§4.3），终态 17 passed/3 skipped；SUSP 两轮 18/18（26.6s/27.0s）+ GRF 全组 8 用例 × 双 project = 16 执行全过（`b56e908` 标题修订后验证不破坏）。
- 诊断用临时 spec（TAX 域 zz-debug-\*）已全部删除、未留仓库（域材料声明，`git status` 干净佐证）。

---

## 4. 缺陷清单与存疑定档

### 4.1 verified（2 条，均 medium，均开修复立项）

**（1）SUSP-07——多根来源根目录加载失败静默空树（confirmed-bug，medium）**

- **现象确认（e2e 实证，两级）**：复核会话探针绿 + 亲自复跑 `pnpm exec playwright test e2e/b-susp-verify.spec.ts -g "SUSP-07"`（apps/web 下）→ **2 passed (4.4s，chromium+mobile)**——/api/tree 一律 500 的假服务器下连接成功、来源标签行（`.vv-tree-src-label`）在场、树区零行（`.vv-tree-row`=0）、服务器侧 500 计数 ≥1、1.5s 观察窗零「加载失败」文案零错误卡片。
- **判缺陷（读码裁决）**：`apps/web/src/lib/FileTree.svelte:35` `.catch(() => [] as TreeNode[])` 静默吞掉（本报告核对在位）；:16 注释仅解释失败隔离意图、未裁决静默。对照 `TreeNodeRow.svelte:32-38` 同一 store.listChildren 失败走 console.error + showStatusNotice + expanded 回滚（BUG-24 通道，复核会话读码转录）——「树加载失败须状态栏显性提示」已是产品既有语义，root 级不成对；查无任何文档裁决静默为设计。影响：断网/权限失败下整来源呈静默空树，用户无法区分「服务器为空」与「加载失败」；不崩溃、重连可自愈，故 medium 而非 high。
- **处置建议（开修复立项，BUG-24 同族）**：根级 listChildren 失败复用 showStatusNotice 通道按源提示「来源 X 加载失败」，保留失败隔离语义；修复后按 `susp-verification.md` §3 复核出口补「提示在场」正向锚并翻转本探针的负向静默断言。

**（2）BUG-201——窗口流式下大文件行索引无自动推进通道（product-bug，medium，verified）**

- **现象确认（两级实证）**：复核会话复跑（转录：chromium+mobile 双 project 2 failed，4 次运行同冻结值）+ **本报告修订时亲手复跑** `pnpm exec playwright test e2e/b-code-highlight-degrade.spec.ts -g "BUG-20"`（apps/web 下）→ **2 failed**，失败点 `b-code-highlight-degrade.spec.ts:179:47`（`Expected "行: 338770"`）；call log 实录——前 4 次轮询「高亮: 解析中… · … · 行: 3640」→ 后 40 次轮询「高亮: tree-sitter · 执行: 本地 · … · 行: 3640」，**着色已完成而行数恒冻结 3640，确定性失败非 flaky**（与转录的 4 次运行同冻结值相互印证；3640=262080/72 即首块 256KB 完整行数，24391439=338770×72−1 与用例页内构造吻合）。
- **判缺陷（读码裁决，转录；本报告未逐行重验）**：`packages/render-text/src/code.ts:1734-1736` start() 排空 while 条件含 `bs.atEnd()`（range 流式恒假、不排空）；:1697-1698 maybeContinue 唯一续读闸「距已加载尾 >WINDOW_CONTINUE_MARGIN_LINES(20) 行即 return」（:1150）；rg 全文件无 requestIdleCallback/setInterval 索引泵——滚动贴近尾 20 行内是唯一 IO 推进通道，不滚动永不自愈。高亮管线正常完成（tree-sitter 着色）而行数冻结——高亮与索引泵相互独立（修订时复跑 call log 再证，见上）。契约：io spec（docs/superpowers/specs/2026-10-12-io-streaming-design.md，路径本报告修订时核对）§4.3:98「行索引后台逐块推进、可取消」+ §8:131-136 豁免清单 4 项无 code 总行数项（修订时核对）；既有契约断言受 io plan（docs/superpowers/plans/2026-10-12-io-streaming-3-code.md）:17「既有断言零变更」保护而必挂。git 考古：断言入库 `678ce2c`（10-10）早于窗口流式引入 `89ca699`（10-13），断言文件此后零改动（`git log` 输出为空，复核会话实测）。
- **处置建议（开修复立项）**：补后台索引泵（如 idle 推进）；修复后 BUG-20 契约锚应转绿。**同锚伴生缺口并入本条定档**（§5.2 #7 上报的「滚动条一步到底停在已加载尾、无贴底跟随」在此落档，回应「一个 issue 还是两个」）：根因同源——无索引泵时一步到底的落点即已加载尾，续读推高 scrollHeight 后视口退离尾部、maybeContinue 续读闸（距尾 >20 行即 return）不再触发，故无贴底跟随；修复验收判据须同时覆盖「行数到达终值」与「贴底跟随」两面。severity medium：核心读阅/滚动/着色不受影响，但状态栏行数误导（无「N+」提示的冻结值）且必挂契约断言。

### 4.2 SUSP 定档表（9 条；现象确认 = 探针 e2e 实证，定档 = 读码裁决）

**总口径**：9 探针全绿（门禁 47 含其 chromium+mobile 双跑 + 复核会话本地 18 passed ×2 轮，转录；SUSP-07 另有本报告复跑实测）——**「现象确认」9/9，probe-negative 0**；「定档」仅 SUSP-07 判缺陷，其余 8 条 confirmed-design（**7 条维持现状记录 + SUSP-09 关闭**，承诺面证据在各条 evidence/域文档）。探针绿只证现象在，不证是缺陷——两层严格分列。SUSP-08（第 10 条）无探针，维持并入既有 BUG-53 随其修复验收。

| 编号 | 位置 | 现象（探针实证确认） | 定档 | 处置建议 |
| --- | --- | --- | --- | --- |
| SUSP-01 | `SearchPanel.svelte:105` + `code.ts:2118-2131` | 清空输入框/Esc 的 `search('')` 走换键重置分支，把同键重搜短路缓存作废——重输同词全新全文扫描（增量含末块块 39、块级请求 ≥20；对照面同键重搜 ≤1） | confirmed-design（design） | 维持现状记录（退出搜索语义的既有设计）；跨空 query 保留 lastScanComplete 缓存可作**性能优化立项候选**（省 40 块级重拉 IO），非缺陷 |
| SUSP-02 | `code.ts:1677-1696` | SCAN-08 布点续扫中视口所在块 1 被块表 LRU（16×256KB）逐出经 pendingReload 回看重拉，同一次续扫内 ≥2 次（双 project）——扫描推进伴随视口行占位化再补齐的可见闪烁面 | confirmed-design（design） | 维持现状记录（内存有界 × 回看补块两显式契约的组合后果）；扫描期视口驻留块 touch/豁免逐出可作**去闪烁 UX 优化候选** |
| SUSP-03 | `jsonl/index.ts:891-898` | 流内嗅探判非 UTF-8 的降级重渲后 `.vv-jsonl-scroll` scrollTop=0（双 project），视口回顶、滚动位置丢失 | confirmed-design（design） | 维持现状记录（复用入口回退同路径的显式设计对称）；降级后锚定首可见行恢复视口可作 **UX 增强候选** |
| SUSP-04 | `blockStream.ts:130-138,169-190` | Range-less(200-only)+size 已知 10MB 首屏恰 3 请求、每条响应体均 10MB（共 3×文件字节；Range 形状 bytes=0-8191 / 0-262143 / 0-MAX_SAFE_INTEGER 逐条吻合），滚动零新增 | confirmed-design（design） | 维持现状记录（对不合规服务器的防御性兜底，内容正确性优先）；补改 io spec §2.3「停在该块」旧表述——**域文档路线已执行、spec 本体文字待清**（姐妹篇二选一裁决的文档路线） |
| SUSP-05 | `dispatcher.ts:277-281` + blockStream head 预置 | 900KB（非 256KB 对齐）jsonl 的 ≤1MB 全量直读实为恰 2 请求——无 Range 全量 read（200，921600B）+ tail 部分块整块重拉（206，bytes=786432-921599） | confirmed-design（design） | 维持现状记录（io 矩阵注释 2 已有案「实现语义而非回归」）；本探针作为非块对齐形态正向锚与 DEG-05 块对齐口径互补，无需进一步动作 |
| SUSP-06 | `core-parse.ts:266-273` | 同源 manifest 剥离 java 条目打开 java 文件，/queries/java/** 空打（≥1）而 java.wasm 零请求——doPrepare 先 expandQueryAsync 后 resolveGrammarEntry 的执行顺序**首次运行期实证**（此前仅读码推断） | confirmed-design（design） | 维持现状记录（低害冗余 IO，整语言降级 hljs 兜底生效）；doPrepare 内将 resolveGrammarEntry 前置可作**微优化立项候选** |
| **SUSP-07** | **`FileTree.svelte:35`** | /api/tree 一律 500 下连接成功、来源标签行在场但树区零行，1.5s 窗零「加载失败」文案零错误卡片——与 TreeNodeRow.svelte:32-38 的 BUG-24 状态栏提示通道不成对，多根来源呈「静默空树」 | **confirmed-bug（medium，verified）** | **开修复立项（BUG-24 同族）**：复用 showStatusNotice 通道按源提示，保留失败隔离；修复后补正向锚并翻转探针负向断言（§4.1） |
| SUSP-09 | `av.ts:456-464` + `ViewerPane.svelte:245-255` | av 内构错误卡片「以 hex 打开」上位后 MetaPanel 打开方式下拉维持 value=''（自动）且无（手动）标记——内构链直调 hex.render+takeOver 不经 dispatch 重入不写 override | confirmed-design（design） | 关闭（与既有 OWX-03 同锚同判据：两条链 UI 语义一致——「临时查看不落 override」，差异仅实现路径，error-card-open-as.md §1 已记录为架构事实；「同按钮不同语义」担忧不成立） |
| SUSP-10 | `av.ts:458`（修订时核对：:457 为 release()，`hex.render(buffer,…)` 调用在 :458；域材料原引 ：457 系行号偏差） | 远端截断 mp4（300B）卡片上位 hex 零新增请求（打开期 1 条全量读后 settle 零增量，双 project）——内构链以手头全量 buffer 渲染，无 StreamCtx 窗口流式 | confirmed-design（design） | 维持现状记录（error-card-open-as.md §1 已有案，行为正确性记录——300B 全量在手零 Range 是正确行为）；内构链流式化属**架构演进项**，非缺陷，暂不立项 |

### 4.3 本轮新增 unconfirmed（未定档；域材料 suspects + 本报告核对）

| 编号 | 位置 | 现象 | 证据与状态 | 处置 |
| --- | --- | --- | --- | --- |
| SUS-TAX-1（缺陷候选） | `openFlow.svelte.ts:868`（注释宣称「先关闭同 base 的旧 remote tab（目录 + 文件）」）+ `packages/core/src/tree/remote.ts`（注册 ：43/:149、**close 清理 ：328**、getRemoteBase :45-47——域材料原引 ：198 不确，:196-199 实为响应 detail 处理，本报告修订时 grep 实测；仓库另有一 `compute/remote.ts`，所指为 tree/） | 同 base 换 token 重连的清扫不彻底：目录 tab+文件 tab 并存时，清扫循环只关掉目录 tab——关目录 tab 使旧 store 实例失去最后持有者 → releaseStoreIfLast 终结实例（SSE#1 关闭、base 登记删除）→ 循环走到文件 tab 时 getRemoteBase 已返回 undefined 匹配落空。幸存文件 tab（同 storeId）不在新连接 watch 内（丢 SSE 自动刷新）但 read 仍可用（非死件） | 域材料实跑取证（2026-10-14 构建 08114d2，MutationObserver tab 增删 + IndexedDB 快照；TAX-09 按现状锚定「幸存+可读+清扫贡献 0 撤销条目」）——转录；本报告核对 `openFlow.svelte.ts:868` 注释（修订时确认首行在 ：868，原稿误引 ：869，:869 为续行）与 ：872-874 清扫循环在位（实测）。**未定档** | 缺陷候选，**挂账待编排方分配分诊轮次**（改法已预写：`tab-actions-enrichment.md` §3.1，修复期回改 TAX-09 期望）。另 TAX-09 假服务器需 OPTIONS 预检（带 authorization 头为非简单请求）属夹具扩展非产品缺陷 |
| WSX 观察 1（现象记录） | `server/src/routes/search.rs:293-299` 对照 `guard.rs:37-38` | parser_roots 的越界 400 分支（文案 `root index {i} out of range`）实跑证实不可达——带 root 请求在 guard::resolve_at 阶段已被前置拒绝，可达文案为 `root index out of range: 2`（WSX-02 初版按 search.rs 文案断言失败、改按 guard 文案通过）——防御式死分支+两处文案不一致 | 本报告核对两处文案确实不一致（search.rs:299 `root index {i} out of range` vs guard.rs:38 `root index out of range: {root_idx}`，sed 实测）；不可达性为 WSX-02 实跑（转录）。无用户可见影响，不裁断危害 | 记录在案，随 server 侧后续改动顺带清理 |
| WSX 观察 2（现象记录） | `TabContextMenu.svelte:63-74`（域材料引 :49-51 系行号漂移，机制在位） | 右键菜单对任意滚动立即关闭（:69 `window.addEventListener('scroll', onGone, true)` capture，:13 注释明示设计意图）：mobile 375px 下 TabBar 溢出（app.css:345 overflow-x:auto）时右键自带的自动滚动尾随 scroll 事件把刚弹出的菜单秒关——WSX-08 mobile 实跑确定性复现（须 scrollIntoViewIfNeeded+250ms 滚动静默才能右键成功；单 tab 无溢出的 WS-06/TA 先例不触发） | 本报告核对 :67-69 监听在位（sed 实测）；溢出复现为 WSX-08 mobile 实跑（转录）。溢出场景触屏用户 tab 右键可用性存疑，不裁断 | 记录在案；如复核立项可考虑滚动来源过滤或右键期豁免 |
| WSX 观察 3（环境注意事项，非产品） | 测试环境 | 同仓库多域 agent 并发跑 playwright 时 `apps/web/test-results/` 互相覆盖（WSX-08 mobile 失败现场 error-context.md 曾被并行域产物替换，需重跑取证）；:4173 preview 经 `reuseExistingServer: !CI` 跨域复用 | 域材料记录（转录） | 并行开发时失败现场须即时收割；门禁统一单入口跑时不存在 |

---

## 5. 全量回归与历史缺陷回归验收（兑现姐妹篇 §7.2 所欠载体）

### 5.1 回归红绿

- **default 全套件：481 通过 / 6 终态失败**（workflow 转录）；盘上 `apps/web/.temp/pw-full-def/.last-run.json`（2026-10-14 10:07:09）status failed、failedTests 恰 6（实测 `cat`）——6 哈希归 2 个 spec 文件：`b-code-highlight-degrade` ×3（BUG-20 chromium、BUG-20 mobile、PERF-LAZY chromium）+ `t-hl` ×3（HL-04/2 chromium、HL-08 chromium、HL-08 mobile）。
- **flaky 转绿 2 条**：`b-app-shell-sources` BUG-04/SHELL-12（chromium）与 `m6` policy=remote（mobile）——现场目录无 -retry1 后缀且不在 failedTests（实测推断）+ 分诊注「复跑即绿」（转录）。
- **失败现场 14 个目录**（`ls pw-full-def` 实测）：6 终态失败 ×（首轮+retry1）12 + 2 flaky 单现场，与上表逐一对应。
- **server 套件全量未跑**（`regression.server=null`）；声明用例 329（存量 298 + 本轮新增 31，§2.3 实测）。

### 5.2 回归失败分诊清单（8 条记录逐条分类）

| # | 失败记录 | 分类 | 分类依据 | 处置建议 |
| --- | --- | --- | --- | --- |
| 1 | `b-app-shell-sources` BUG-04/SHELL-12 状态栏段+属性面板 [chromium] | **env-flaky** | 分诊注「env-flaky 无需修复」；现场无 retry1、不在 failedTests（复跑即绿）；高亮完成时机的等待型断言 | 无需修复；可选放宽 timeout 或等高亮完成信号再断言 |
| 2 | `m6` policy=remote 状态栏「远程」 [mobile] | **env-flaky** | 分诊注「无需修复（复跑即绿）」；同上现场形态 | 无需修复；复发可放宽 m6.spec.ts:135-136 的 20s 窗口（缓解非修复） |
| 3 | `t-hl` HL-04/2 >200MiB plain 分支 [chromium] | **test-issue** | 断言仍锚旧「纯文本零着色+提示条」口径，io spec §4.3 防线换代后 >2MB 走窗口流式 lazy——断言与换代后现实的时代差，非产品故障 | 断言改锚新提示条文案+保留虚拟滚动/行数/gutter 行为面；「纯文本零着色」随 200MiB 档退役；同步修订 `code-highlight-degrade.md` §6 三态表 |
| 4 | `t-hl` HL-08 3MB 折返 [chromium] | **test-issue** | 「行： 48000」断言打在打开即终值——窗口流式下行数为渐进动态值，索引未推进到 EOF 时期望落空 | 行数锚改驱动式（循环滚到底驱动续读至双稳定，实测 ~14 轮收敛）或移到折返后/两段锚定；HL-04/2 的滚动前断言有同样时序隐患一并核对 |
| 5 | `t-hl` HL-08 3MB 折返 [mobile] | **test-issue** | 同 #4（mobile 载体） | 同 #4 |
| 6 | `b-code-highlight-degrade` PERF-LAZY 25MB 性能锚 [chromium] | **test-issue** | 锚点 2 跳滚单次赋值落在流式索引渐进 spacer 上——**确定性复现**（复跑 4 尝试+探针 3 轮全失败），明确非 env-flaky；产品侧连续滚动语义完好（视口内 52/60 行已着色） | 跳滚改两案任一（等索引覆盖目标行后单次赋值 / 循环赋值至稳定，实测均 ~8.6s 可达）；修复后须一并首次验证锚点 3（longtask=0，现状从未被执行）；25MB 级推进性能需单独定档 |
| 7 | `b-code-highlight-degrade` BUG-20 契约锚 [chromium] | **test-issue**（附带产品缺口上报） | 契约断言（20s 内行数=338770）与窗口流式现实冲突；一步到底停在已加载尾、无贴底跟随（scrollTop=scrollHeight 一步到底末行恒 3651≠338770，续读一次即停机） | 断言移至滚动推进完成后/改渐进到达口径；「一步到底」改绝对坐标或多步贴底；附带缺口（滚动条一步到底无贴底跟随）与 #8 合并定档 |
| 8 | `b-code-highlight-degrade` BUG-20 契约锚 [mobile] | **product-bug（verified）** | 同一断言同冻结值 3640 × 4 次运行（轮询 40+ 次）——根因为行索引无自动推进通道（**BUG-201**，§4.1(2)）；对分诊的一处修正：「高亮： 解析中…」仅前 3-4 次轮询出现、随后转 tree-sitter 而行数仍冻结——着色与索引推进相互独立，缺的是索引泵 | **开修复立项**（BUG-201，medium）；修复后本契约锚应转绿，#7 的断言改写随之落地 |

分诊纪律：8 条记录均附命令级证据（复跑输出/轮询 call log/git 考古/一次性探针）——**证据本体为分诊会话记录（转录），未落盘归档**（`ls apps/web/.temp` 实测 10-14 无 triage 目录，pw-out-triage-\* 全为 10-13 姐妹篇产物；一次性探针已清理）；盘上可验的是失败现场本身（`pw-full-def` 14 个目录的 error-context，含各条失败签名与轮询 call log）与 §4.1(2) 修订时补跑。retry 期一次 preview server 死亡（ERR_CONNECTION_REFUSED）经复核复跑未再现，确认为与本病无关的次生环境现象（转录）。

### 5.3 37 条历史缺陷的回归验收结论

**「37 条历史缺陷的回归验收由全量套件承载」——本轮兑现**（姐妹篇 §7.2 明文所欠的载体）：2026-10-10 轮 37 条确认缺陷的回归锚点（t-\* 既有断言）随本轮 default 全量套件实跑，**除 §5.2 的 8 条记录外全绿；8 条记录经分诊无一条定性为「历史缺陷修复回退」**——2 条 env-flaky（环境）、5 条 test-issue（窗口流式换代引发的断言时代差，被换代对象为 io spec §4.3:98 防线而非历史缺陷修复；其中 **PERF-LAZY 的 25MB 级推进性能定档悬置**——§5.2 #6 自注「需单独定档」，未排除「索引泵过慢=产品性能缺陷」，不随归类关账）、1 条 product-bug（**新产品缺陷** BUG-201，非旧修复回退；其挂掉的 BUG-20 契约锚受 io plan〔docs/superpowers/plans/2026-10-12-io-streaming-3-code.md〕:17「既有断言零变更」保护而必挂）。**须点名的事实（防「37 锚全绿」误读）**：BUG-20 本身即 37 条之一（e2e-test-report-2026-10-10.md:594，本报告修订时核对），其契约锚本轮 chromium+mobile **双红**（§5.2 #7/#8，盘上 4 个现场目录实测）——「无修复回退」的成立依据是**分诊定性**（断言时代差 + 新缺口 BUG-201）而非锚绿，本结论含 1 条锚红经分诊豁免的情形。故准确表述为：**37 条历史缺陷的修复在本轮全量实跑中无一条定性为修复回退**。口径限定（如实标注）：本结论限于分诊定性层面——本轮未做 37 条编号与 t-\* 用例的逐条映射盘点（BUG-20 因锚双红而显式点名，其余 36 条按「无定性失败」覆盖）；且承载面为 default 通道，server 通道未跑（§7）。

---

## 6. 功能完成度增量评估（相对姐妹篇缺口清单逐条）

### 6.1 已补上（本轮增量）

| 姐妹篇缺口 | 本轮收口 |
| --- | --- |
| §5.5 MRF 缺口 (a)：/api/compute 的 root 参数无 e2e | **WSX-05**（compute highlight 的 root：path 模式按根解析 baseLine 锐证 / 越界 400 / text 模式不涉 root） |
| §5.5 MRF 缺口 (b)：/api/search 指定 root 限定单根半无锚 | **WSX-01**（指定 root 限定单根：帧退化无 root 字段形状 vs 跨根帧对比、path 相对所选根）+ **WSX-02**（多根 4xx 矩阵：path 歧义/越界/../清洗/404/空 pattern/单根历史形状对照）→ workspace-tabs §2.1 服务端面收口 |
| §5.5 MRF 缺口 (c)：多根 remote 源刷新恢复无 UI e2e | **WSX-07**（根 1 整根源 storeId :r1 段刷新×2 回环）+ **WSX-08**（面板「＋ 添加来源」双根双源并存恢复 + 根 1 pinned 目录 tab M-5 跨根读回；域材料自标注即缺口 c） |
| §5.5 MRF 缺口 (d)：RemoteSourceModal 断线/越界错误卡片语义未布点 | **WSX-09**（断线网络层错误面 + tree 越界 400 detail 透传 + 重试持续 + 切根自愈）/ **WSX-10**（token 会话轮换 401 + 重试持续 + 应用不受伤）→ MRF 缺口清单全收口 |
| search-grep-fallback 设计无 e2e 正例链 | **WSX-03**（rg 缺失 grep 在：PATH 注入 → health searchEngine='grep' → NDJSON col=1 → sessionStorage → 面板徽标+降级 tooltip+服务端执行无降级提示全链）+ **WSX-04**（双缺：501 精确文案 + health 字段整体省略 + 徽标缺失 + 主实例 rg 宣告护栏）→ e2e 可锚面全覆盖（grep --include ERE 方言差异与输出顺序由设计注记/单测承担，不宜 e2e） |
| watch-log-flood（BUG-68）SSE 帧层承诺无锚 | **WSX-06**（500ms debounce 固定窗口聚合：24 连写 → 帧数有界≪24 + 路径并集完整 + 逐根发帧无跨根混入）→ SSE 可锚面收口 |
| §1.3/§7.1 复核出口：10 条存疑未定档 | **9 条定档完毕**（8 confirmed-design + 1 confirmed-bug，§4.2）；SUSP-08 维持并入 BUG-53 |
| §5.4 缺口③：GRF-05 spec 标题与用例体表面矛盾 | **`b56e908`** 修订标题与现行 mock 口径一致（1 行，git show 实测），GRF 全组 16/16 实跑验证不破坏（转录） |
| §7.2：全量回归与历史缺陷回归复测载体欠账 | **本轮兑现**（§5：default 全量 481/6 + 分诊 8 条 + 37 条无修复回退结论） |
| §2.1/§7.1：SUSP-06/07 仅读码推断、无运行期实证 | **两者均首次运行期实证**（§4.2 探针；SUSP-07 更进一步定档 confirmed-bug） |

### 6.2 还剩的（逐条交代）

- **姐妹篇 §7.3 env 注入固化：未兑现**——`apps/web/package.json:8` build 脚本仍无 env（实测），且撰写时产物已被 10:08:47 无 env 重建覆盖（先例重演，§2.1）；三档固化选项仍待裁决。
- **两条 verified 缺陷修复未落地**：SUSP-07、BUG-201 本轮仅定档/立项（§4.1），修复归后续轮。
- **SUSP-04 文档路线半程**：域文档/矩阵注释已对齐现实，io spec §2.3 本体「停在该块」旧文字待清（§4.2）。
- **姐妹篇 SCAN/JVL/DEG/OWX 域缺口清单：本轮未动（非本轮范围），维持原样**——SCAN (a)failedBlocks 机制归因仅单测/(b)进度节流仅单测/(c)destroy 收口未布点/(d)嗅探归 DEG/JVL；JVL (a)25c704e 恰界停机按裁决不设/(b)缓存上限仅单测/(c)JVL-08 DOM 代理面/(e)helper 整并；DEG (a)恰界停机/(c)zip 形态/(e)hex tail 面；OWX ①二进制→hex 排前无 dispatcher 级锚/②image 形态随 BUG-53/③排序窄化设计裁决候选。其中 OWX 相关疑虑经本轮复核**分层收口**：SUSP-09 **关闭**（与既有 OWX-03 同锚同判据）、SUSP-10 **维持现状记录**（行为正确性记录，非关闭）——§4.2，属增量。
- **WSX 域新增剩余缺口**：QuickOpen Ctrl+P 多源扩域（设计承诺扫描全部源、结果带源名前缀）无 e2e；文件树源级操作（折叠/移除源+移除确认连带关 tab）无 e2e；watch-log --log-file 轮转（10MB 阈值运维面）、ErrorLogGate 限频与 EnvFilter 默认——设计原文即归 Rust 单测，非 e2e 缺口。
- **TAX 域剩余缺口**：duplicate 作用于目录 tab / 与手选打开方式（overrideRenderer）组合未布点（后者属 open-with 域交叉）；pinned 目录 tab 跨刷新锚在 workspace 域（WS-06/M-5）不重复；触屏拖拽 spec 明示不做无布点面；跨组移动 tab 为 spec §1 非目标（文档 §1 已记录）；SUS-TAX-1 修复后应回改 TAX-09 期望（文档 §3.1 已预写改法）。
- **SUSP 域后续面**：探针为现状固化器——产品修复落地时须按 `susp-verification.md` §3 改写方向同步转写为回归锚；SUSP-02 断言取 ≥2 下界（记录恰 2 次、容忍刷新节奏差异）；SUSP-08 无探针（随 BUG-53 修复验收）。

---

## 7. 未覆盖范围（如实披露）

1. **server 套件全量回归未跑**（`regression.server=null` 转录；盘上 pw-srv-out-\* 为姐妹篇产物，mtime 实测）——§5 结论限于 default 通道；WSX server 侧 6 用例仅域材料本地实跑（6 passed 19.3s，转录）。
2. **新场景门禁为新场景集口径**（47 = 50 执行 − 3 TAX mobile skip），非全量；全量结论见 §5，且其 6 条终态失败本轮未修复（分诊清单为处置建议，归后续轮）。
3. **本报告撰写轮未复跑**：build/cargo（workflow 转录 exit 0/0）、门禁与回归的通过/失败计数值（workflow 转录；盘上仅 `.last-run.json` 状态与现场目录可验，无逐用例通过明细）、9 探针中除 SUSP-07 外的 8 条（依据门禁双跑 + 复核会话两轮 18/18，转录）、SUS-TAX-1 的取证实跑（域材料转录，本报告仅核对相关代码行在位）、BUG-201 的复核复跑（转录，未重跑）。
4. **盘上构建产物为无注入版**（10:08:47 重建，`rg` exit 1 实测）——本轮测试期间的注入产物证据已被覆盖，注入在位结论依据时序 + GRF-01 通过侧证 + workflow 记录（§2.1）。
5. **e2e 面外（设计裁决归单测/不宜 e2e）**：grep --include ERE 方言差异与输出顺序（设计注记/单测）；watch-log --log-file 轮转、ErrorLogGate、EnvFilter（Rust 单测锁）；size 未知 STREAM_MAX_BYTES 恰界停机（沿姐妹篇裁决不设）。
6. **spec 明示不做面**：TAX 触屏拖拽、跨组移动 tab；SUSP-08 无探针。
7. **37 条历史缺陷未做编号级逐条映射**（§5.3 口径限定）；QuickOpen 多源、文件树源级操作、TAX 组合面等待后续补点（§6.2）。
8. **headless 受限**（沿 docs/e2e/README.md 口径）：本轮场景均不依赖 FS Access/真实触摸，无受阻项。

---

## 8. 附录

### 附录 A：本轮提交清单（`git log --format` / `git show --stat` 实测）

| 提交 | 时点 | 内容 |
| --- | --- | --- |
| `be8ab79` | 10-14 09:36 | test(e2e): workspace 富化——WSX-01~12 双套件补齐（3 文件 +1479：e2e-server/b-wsx-root-channel.spec.ts 563 + e2e/b-wsx-recovery.spec.ts 793 + docs/e2e/workspace-enrichment.md 123） |
| `9d3cef6` | 10-14 09:36 | test(e2e): tab 动作富化——TAX-01~10 恰界与组合边界补锚（2 文件 +859：b-tab-actions-enrichment.spec.ts 773 + tab-actions-enrichment.md 86） |
| `80de937` | 10-14 09:36 | test(e2e): 上轮存疑观察 e2e 复核——SUSP-01~10 定档探针（2 文件 +795：b-susp-verify.spec.ts 700 + susp-verification.md 95） |
| `b56e908` | 10-14 09:37 | fix(test): 修订 GRF-05 标题与现行 mock 口径一致（1 行；姐妹篇 §5.4 缺口③清账） |
| `e0c0951` | 10-14 09:47 | fix(test): 修复 SUSP-06/WSX-12 两处 TS 类型错误使 TYPECHECK 门禁转绿（2 文件 +5/−2，纯测试侧：夹具形参与类型双跳） |

### 附录 B：证据归档索引（均 `ls`/`stat`/`cat` 实测）

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 新场景门禁三轮 | `apps/web/.temp/pw-out-r1|r2|r3/.last-run.json` | 2026-10-14 09:38:45 / 09:48:10 / 09:48:45，均 status passed、failedTests 空；无 error-context 目录（零失败） |
| 全量回归 | `apps/web/.temp/pw-full-def/` | `.last-run.json`（10:07:09，status failed、failedTests 恰 6：b-code-highlight-degrade ×3 + t-hl ×3）+ **14 个失败现场目录**（6 终态 × 含 retry1 + 2 flaky 单现场），与 §5.2 清单逐一对应 |
| 本轮回归分诊证据 | 分诊会话记录（转录；**无盘上归档目录**） | 8 条分诊注的复跑输出/轮询 call log/git 考古/一次性探针**未落盘**（`ls apps/web/.temp` 实测 10-14 无 triage 目录，pw-out-triage-\* 全为 10-13 姐妹篇产物；/tmp 一次性探针已清理）；盘上可验为 `pw-full-def` 14 个现场目录内的失败签名与 call log。**修订时补跑**：BUG-20 `-g` 复跑 2 failed（§4.1(2)，输出在会话内未归档） |
| server 套件输出（姐妹篇产物，非本轮） | `apps/web/.temp/pw-srv-out-r1`（10-13 19:53:07）/ `pw-srv-out-r2`（10-13 20:18:02） | 均 passed——本轮 server 无门禁轮次与全量（§2.2/§7.1） |
| 域三件套 | `docs/e2e/{workspace-enrichment,tab-actions-enrichment,susp-verification}.md` + 4 个 spec | 在盘实测；spec 用例数 6/6/10/9（grep 实测） |
| 构建产物 | `apps/web/build/` | 2026-10-14 10:08:47 重建，**无注入指纹**（rg exit 1）——警示 §2.1，固化诉求未兑现 |
| 姐妹篇证据（沿用） | `apps/web/.temp/pw-out-triage-*`、`pw-out-fix-*`、`pw-out-r1|r2`（10-13） | 姐妹篇分诊/修复/门禁输出，本轮未触碰 |

---

*报告完。被测版本与执行版本口径、提交链与时间线、4 spec 用例数与全量声明数（260/69/329）、构建产物注入指纹（exit 1）、门禁三轮与全量回归的盘上状态文件与现场目录数、typecheck 复跑 exit 0、SUSP-07 探针复跑 2 passed、BUG-20 契约锚修订时补跑（2 failed，冻结值 3640 复现，§4.1(2)）、以及被引源码/文档行（FileTree.svelte:35 / search.rs:293-299 / guard.rs:37-38 / openFlow.svelte.ts:868 / TabContextMenu.svelte:63-74 / av.ts:457-458 / tree/remote.ts:43/149/328 / b-grammar-spa-fallback.spec.ts:24 / io spec §2.3:65·§4.3:98·§8:131-136 / io plan:17 / 姐妹篇：594 / TAX skip :323/:401/:742），为本报告撰写及修订时亲手实测/核对（命令与输出见各节）；门禁与回归的通过/失败计数、cdnInjected/build/cargo、域材料本地实跑明细、SUSP 9 条定档的读码证据、SUS-TAX-1 取证实跑与回归分诊 8 条记录，为 workflow/复核会话/域材料转录（逐处已标注；BUG-201 的复核复跑原为转录，修订时已由本报告亲手复跑坐实）。verified 与 unconfirmed 全程区分——本轮 verified 产品缺陷 2 条（SUSP-07、BUG-201，均 medium 开修复立项），新增缺陷候选 1 条（SUS-TAX-1）与现象记录 2 条均未定档；9 条存疑探针全绿（现象确认）而仅 1 条判缺陷（读码裁决），8 条 confirmed-design 按「7 维持现状记录 + SUSP-09 关闭」口径计。「37 条历史缺陷的回归验收由全量套件承载」已兑现，且无修复回退定性失败——含 BUG-20 锚双红经分诊豁免 1 条与 PERF-LAZY 性能定档悬置（编号级映射未做，§5.3）；server 通道全量未跑、6 条终态回归失败未修复（§7）。*
