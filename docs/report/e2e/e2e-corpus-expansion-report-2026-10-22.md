# e2e 语料基建多源化扩充 — 独立复核验证报告（2026-10-22 批次）

> 复核角色：独立复核员（未参与本批任何编写与修复）。被测状态：`main` @ `51cd3b0` 工作区未提交改动（5 改 + 2 新增，见 §1）。
> 复核时间：2026-10-23。全部证据均为复核会话内实际读到的文件/行与实际执行命令的输出，未采信修复方口头结论。

## 1. 概览

本批改动 = **语料基建多源化**（单源 `bhxch/Markpad@master` → 7 源写死 commit，落地 373 文件）+ **2 个新 e2e spec**（多源 md 渲染域 MS 系、代码/配置/结构化文本分派域 HLD/LCD/CJL 系）+ **2 处测试修复**（e2e 断言下限勘正 + 组合语义固化单测）。

工作区改动清单（`git status --porcelain` 实测）：

| 文件 | 状态 | 内容 |
| --- | --- | --- |
| `tools/fetch-e2e-corpus.mjs` | M | 单源分支名拉取 → 多源 SOURCES 表写死 commit（+357/−93 行） |
| `.gitignore` | M | `fixtures/markpad-md/` → `fixtures/corpus/`（多源语料不入库） |
| `.github/workflows/ci.yml` | M | e2e job 拉取步骤注释同步多源口径（步骤本体不变，脚本路径相同） |
| `apps/web/e2e/b-md-corpus-markpad.spec.ts` | M | 语料路径迁移 `fixtures/markpad-md/` → `fixtures/corpus/markpad-md/`（2 处） |
| `packages/render-text/test/markdownPipeline.test.ts` | M | 新增「表格 $$ 块内 `\\` 转义折叠」单测（+23 行） |
| `apps/web/e2e/b-md-corpus-multisource.spec.ts` | 新增 | MS 系 19 逻辑用例（767 行） |
| `apps/web/e2e/b-corpus-code-text.spec.ts` | 新增 | HLD/LCD/CJL 系 39 逻辑用例（639 行） |

**复核结论：PASS**（无阻断问题）。断言未被不当放宽、动态清单与容错逻辑真实、7 源 commit 全部写死 40 位 sha（非分支名）、两处修复均满足设计要求且有独立管线实证支撑。notes 级发现 7 条见 §6。

## 2. 语料源清单与统计

### 2.1 七源定档核验（manifest.json ↔ SOURCES 表 ↔ ask 定档三方对照）

`apps/web/e2e/fixtures/corpus/manifest.json`（`generatedAt: 2026-10-23T02:03:47.487Z`，`failures: []`）：

| 源 id | repo | commit（写死 sha） | 实落地 | truncatedByMaxFiles | 许可证口径 |
| --- | --- | --- | --- | --- | --- |
| markpad-md | bhxch/Markpad | `8a368a6…` | 27 | 否 | BSD-3-Clause（实测，非 MIT） |
| mermaid-docs | mermaid-js/mermaid | `6d8921f…` | 70 | 是（docs/ 共 104，cap 70） | MIT |
| katex-docs | KaTeX/KaTeX | `8f0d9bc…` | 13 | 否（全量） | MIT |
| k8s-docs | kubernetes/website | `6c42e26…` | 38 | 否（实测恰 38，cap 40） | CC-BY-4.0 |
| hljs-detect | highlightjs/highlight.js | `fc3f063…` | 120 | 是（200，cap 120） | BSD-3-Clause（实测，非 MIT） |
| linguist-samples | github-linguist/linguist | `73ee9a3…` | 100 | 是（白名单 135，cap 100） | MIT |
| cookbook-jsonl | openai/openai-cookbook | `4bb93ce…` | 5 | 否（8.3MB 超限件剔除后全量） | MIT |

- **写死 sha 核验**：`tools/fetch-e2e-corpus.mjs:32-97` SOURCES 表 7 源 commit 字段全部为 40 位十六进制 sha，无分支名；与 manifest 落盘值逐一一致。ask 定档 JSON 前 5 源的 sha 与实现完全一致；ask 传参在第 6 条被截断（`"id":"l…` 即 linguist-samples，sha 前缀 `73ee9a3b` 一致），cookbook-jsonl 为定档第 7 源，其 rationale 已写明实测勘误过程（6 个 jsonl 而非定档时 5 个、剔除 8.3MB 超限件）。
- **上游 commit 真实性抽验**（GitHub API 实测 HTTP 200）：mermaid@`6d8921f`、kubernetes/website@`6c42e26`、linguist@`73ee9a3`、openai-cookbook@`4bb93ce` 四个 commit 均真实存在；markpad/katex/hljs 三源 sha 与 ask 定档逐字一致。
- **旧口径清除**：`git diff` 实测旧版脚本 `REF = 'master'`（分支名）已不存在于新版任何位置。

### 2.2 落地完整性与布局

- 目录布局：`apps/web/e2e/fixtures/corpus/<source-id>/<仓库内相对路径>`，共 **373 语料文件 + 1 manifest.json = 374**（`find -type f | wc -l` 实测；与 ask「373 文件」口径一致，manifest 随目录 gitignore 不计入）。
- 磁盘完整性：373 个文件逐一 `existsSync` + `statSync().size` 与 manifest `files[].size` 比对，**零缺失、零 size 不一致**（复核自写脚本实测输出「一致: 373 | 缺失: 0 | size 不一致: 0」）。
- sha256 抽验：supported.md、`test/detect/javascript/default.txt`、`samples/Python/django-models-base.py` 三个文件重算 sha256 与 manifest 一致；脚本落盘时另有 git blob sha1 校验层（见 §2.3）。

### 2.3 下载脚本动态清单与容错逻辑（tools/fetch-e2e-corpus.mjs 逐段核验）

以下均为复核通读 `tools/fetch-e2e-corpus.mjs` 全文（347 行）后的结论：

- **动态清单真实**：`listTree`（:161-184）走 GitHub trees API `recursive=1`；响应 `truncated` 时改分层 BFS 逐目录列举（:167-183），目录级仍 truncated 记入失败清单——「绝不静默截断」实现属实。`listSource`（:191-218）对多段 pathPrefix 逐段下钻解析子树 sha，前缀不存在/非目录/根树 truncated 均按 fatal 处理。
- **容错真实**：`fetchRaw`（:119-142）非 2xx 与 HTML 错误页均按失败，`MAX_ATTEMPTS=3` 线性退避；HTML 嗅探例外（语料正文本身是 HTML 文档的情形）以 git blob sha 与清单一致作仲裁（:131-135），非无脑放行。下载后 `gitBlobSha` 与 trees API sha 比对（:292-294）防 CDN 损坏。
- **确定性截断**：`matched.slice(0, maxFiles)` 按 tree 顺序取前 N（:268-269），`truncatedByMaxFiles` 入 manifest。
- **幂等与并发**：已存在且 size 一致则跳过（:283-288）；`runPool` 有限并发 6 路且结果按入参序回填保证 manifest 顺序确定（:220-230）。
- **退出码语义**：任一源清单拉取失败/清单为空（`hardFail`）或全部文件失败 → `process.exitCode = 1`（:340-343）；部分文件失败仅记 `manifest.failures` 并告警。本次落盘 `failures: []`。
- **防御**：`safeSegments`（:145-149）拒绝绝对路径/`.`/`..`/空段，防越界写。

## 3. 分域用例清单与意图

### 3.1 MS 域：b-md-corpus-multisource.spec.ts（19 逻辑用例 × chromium/mobile = 38）

载体三 md 源（mermaid-docs / katex-docs / k8s-docs；markpad 归既有 MC 系不重复）。`playwright test --list` 实测：

| 组 | 用例 | 意图与断言要点 |
| --- | --- | --- |
| 滚动批 MS-01~13 | mermaid 7 批 + katex 2 批 + k8s 4 批（13 批） | manifest 运行时读取动态生成（:428-531），每批 ≤10 文件注入 → 逐文件打开 → `.vv-markdown` 可见 → 按源特征下限（mermaid svg 轮询至可渲染围栏数、katex `.katex` ≥ $$ 对全额 + 行内半额、k8s `pre code` ≥ yaml 围栏数）→ 批级累计 `actualSum ≥ boundSum` + 零 pageerror + console error 白名单外为零 |
| 深断言 ×6 | mermaid intro/index、config/accessibility；katex support_table、supported；k8s pod-lifecycle、deployment | 每源 2 代表文件锚具体能力：图表容器/全量 svg、accTitle→svg `<title>`、千级行内公式住 td、源码列字面保留（MATH_SKIP_TAGS）、display 块 td 归属、`\tag` 文本、yaml 高亮、front matter 不泄漏（`math: true`/`janetkuo` 逐行核对锚）、列表内缩进围栏 |

特征下限由 spec 内置语料状态机扫描器运行时实算（`topLevelFences`/`displayMathPairCount`/`inlineMathSpanCount` 等，:127-275），语料漂移自动跟随；mermaid 有 parse 失败修正表（`MERMAID_PARSE_INVALID`，2 文件各 1，:266-269）。缺源占位 skip（:433-443）与逐文件 `existsSync` 容错（:451）逻辑真实。console error 白名单 4 条逐条注明理由（:308-336）。

### 3.2 code-text 域：b-corpus-code-text.spec.ts（39 逻辑用例 × chromium/mobile = 78）

`playwright test --list` 实测展开：HLD 14（hljs-detect 12 批 + 深断言 2）+ LCD 24（linguist 按扩展名 18 批 + 深断言 4）+ CJL 3（cookbook-jsonl 1 批 + 深断言 2，CJL-D2 折叠样本运行时权威解析选定 drone_training.jsonl pretty 350 行）= 39。

- 分派链锚逐一核实：code 渲染器扩展表 `code.ts:2513-2519`（含 txt/js/yaml/…/sh，md/jsonl 排除有注释）；md 路由 `markdownRenderer.ts:459-461`；jsonl 注册 `jsonl/index.ts:950-951`；内容探测链 `dispatcher.ts:200-258` 与 `registry.byExtension` `dispatcher.ts:326` 均与 spec 注释一致。
- 状态栏语言指示锚的确定性依据（扩展名表内容无关）与 `EXT_EXPECTED_LANG` 表（:115-133）成立；表外扩展名「跳过语言锚只断容器，不放宽为猜测值」（:113）。
- jsonl 折叠/展开语义锚 `jsonl/parse.ts:11-13`（40/400 常量）核实；`waitJsonlReady` 的 `[1-9]\d*` 排除「已加载 0 行」瞬态（:204-222）为结构性判据而非放宽。
- manifest 缺失守卫用例 CORPUS-00（:236-240）保证契约缺失时可见性，不静默空转。
- 注入拍平（`/ → __`，:94-97）解决 hljs-detect 199 个 default.txt 大面积重名，扩展名原样保留 ⇒ 分派语义逐字节等价，论证成立（helpers `TextFileSpec.b64` 字节直通实测存在于 `b-markdown-html-docs-helpers.ts:21-44`）。

### 3.3 用例数口径

ask 口径「2 域 / 30 用例」与实测不符：两 spec 实际 **58 逻辑用例**（playwright 两 project 展开 116）。用例由语料清单动态生成，实际落地数高于计划口径，属覆盖更多而非缺失；本报告按实测记录。全套件 `--list` 总量 1052 用例 / 64 文件。

## 4. 门禁证据（复核复跑实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 单测（含修复点 2 新单测） | `pnpm vitest run packages/render-text/test/markdownPipeline.test.ts` | **32/32 passed**（1.96s） |
| typecheck | `pnpm typecheck` | **退出码 0**（svelte-check 0 errors 0 warnings） |
| 两个新 spec 全量 | `pnpm --filter web build`（`VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/` CI 同口径注入，退出码 0）→ `pnpm exec playwright test b-md-corpus-multisource b-corpus-code-text` | **116 passed (2.0m)**，退出码 0（chromium+mobile 双 project，含全部滚动批与深断言） |
| 套件清单 | `pnpm exec playwright test --list` | 1052 tests in 64 files；两新 spec 58 逻辑用例展开 116 |
| 语料完整性 | 复核自写脚本（existsSync + size 比对 manifest） | 373/373 一致，零缺失零漂移 |
| sha256 抽验 | 复核自写脚本（3 文件重算） | 与 manifest 一致 |
| 上游 commit 存在性 | `curl api.github.com/repos/<repo>/commits/<sha>` ×4 | 均 HTTP 200 |

修复方提供的门禁证据为「playwright 全量 + typecheck 退出码 0（第 1 轮收敛）」。复核以**两个新 spec 的双 project 全量实跑 + typecheck 复跑**实证该口径可信；全套件其余 62 文件本批未触碰（改动面仅 2 个新 spec + markpad 路径 2 行），未复跑全量套件，此为本报告唯一未覆盖面，风险由改动面隔离兜底。

## 5. 问题与修复（修复清单逐项复核）

### 5.1 修复点 1：MS supported.md display 下限 6→5（b-md-corpus-multisource.spec.ts:674）

**修复描述**：原断言 `min(6, displayPairs)` 因测试预检口径错（原文直喂 katex 9/9 通过，漏了 markdown 转义层）而恒失败；改为 `min(5, displayPairs)` 并同步注释。

**复核实证（独立复现，非采信）**：

1. `displayMathPairCount` 同款逻辑实算 `docs/supported.md` → **9 对 $$**（与修复说明一致）。
2. 9 对中含 LaTeX 换行 `\\` 的 7 对、不含的 2 对（`\tag{hi}`/`\tag*{hi}`）。
3. **真实管线复现**（复核自写脚本经 jsdom + repo 真实 `renderMarkdownToHtml → sanitizeHtml → enrichMarkdownDom → runPipeline` 跑全文件）：`.katex-display` 总数恰 **5**（td 内 3：equation+split / align / gather；独立段 2：`\tag`/`\tag*`），`.katex` 总数恰 **943**——与 spec 注释「管线实算 .katex 总 943」「实证 5/9」逐字吻合。非法 4 对恰为 subarray/alignat/CD/substack（`\\` 经 CommonMark 反斜杠转义折叠为 `\`，产生 `\3`、`\@VbVV`、`\0`、`\ ` 未定义控制序列，katex throwOnError 保留原文不产出 display）；含 `\\` 但折叠后 `\&` 合法（& 为可转义标点）的 equation+split/align/gather 3 对照常渲染——修复说明的机理描述精确。
4. 对照组 `support_table.md` 真实管线 `.katex-display` = **6**（spec 注释「6/15」吻合）。
5. e2e 实跑双 project 全过（含该深断言，MS-01~13 批内 katex 下限与深断言均绿）。

**放宽判定：不成立**。原 6 超过管线真实产能 5（恒红），5 为实证值本身；display 排印三重锚（`.katex-display` ≥5 `:672-674` + `td .katex-display` 归属 `:676` + `\tag{hi}` 文本 `:678`）全部保留。头注/扫描器注释（`:39-43`、`:187-191`、`:646-653`）已从「24/24 通过」误导口径修正为管线实证口径（6/15、5/9），与实证一致。

### 5.2 修复点 2：markdownPipeline 新单测（packages/render-text/test/markdownPipeline.test.ts:185-207）

**复核结论：满足设计要求，非放宽**。单测用真实管线断言：(a) 非法格 td 原文逐字符保留（含折叠后 `\3`）且无 `.katex` 标记；(b) 同格对照 `$$x^2$$` 正常产出 `td .katex-display`。把「转义层 × throwOnError 容错」两条既有语义的组合结果固化为产品锚，防产品侧无感变更——方向是**收紧**（新增行为锚）而非放宽。32/32 通过。未改任何产品代码（`git diff` 实测仅 +23 行测试）。

### 5.3 修复点 3：markpad spec 路径迁移（b-md-corpus-markpad.spec.ts:11,40）

仅 2 处 `fixtures/markpad-md` → `fixtures/corpus/markpad-md`（注释 + CORPUS_DIR 常量）；CORPUS 27 文件清单与 manifest markpad-md files 逐一比对**零差异**，磁盘 27 文件零缺失。

### 5.4 修复点 4：.gitignore / ci.yml 接入

`.gitignore:46-50` 旧 `fixtures/markpad-md/` 条目替换为 `fixtures/corpus/`（整目录含 manifest 不入库），注释同步多源口径；`ci.yml:104-108` 拉取步骤保留（`node tools/fetch-e2e-corpus.mjs` + `GITHUB_TOKEN`），仅注释更新——与脚本实际行为（7 源写死 commit、幂等、失败清单）一致。语义接入完整。

## 6. 遗留与建议（notes，均不阻断）

1. **头注「8 源」笔误**：`b-md-corpus-multisource.spec.ts:13` 注释「（基建全 8 源）」与实际 7 源不符（SOURCES 表/manifest 均 7 源）。纯注释口径错误，不影响断言，建议随下次提交勘正。
2. **supported.md display 锚零余量**：下限 5 = 实证值 5，无余量。依赖 pnpm lockfile 锁版本 + manifest sha 锚定语料，属确定性回归锚（spec 头注「预检实证常量」定位自洽），但上游语料 re-pin 或 katex 升版时该锚将精确暴露差异——符合其「回归锚」语义，维护时按注释口径重实证即可。
3. **设计基线回写缺口**：`docs/e2e/markdown-html-docs.md` 场景表止于 §7（MC-01~36），本批 MS/HLD/LCD/CJL 四组场景尚未回写；`docs/superpowers/specs/` 亦无本批设计文档（本批定档以 ask 传参为准）。参照上批惯例（98cb732 事后回写三域场景表），建议本批合入时补 §8 场景表，保持「每批补强必回写」的基线连续性。
4. **幂等跳过校验强度**：跳过仅比 size 不重算 git blob sha（:283-288）——首下时已做 blob sha 校验，size 一致即视为未变是合理设计选择；若需防本地文件同 size 篡改可在跳过分支加 blob sha 校验，当前无需。
5. **ask「30 用例」口径**：实测 58 逻辑用例（116 project 展开），动态清单生成使实际数高于计划口径，报告按实测记录；后续定档建议注明「逻辑用例数为语料落地后的动态值」。
6. **hljs-detect 前提勘误已落档**：ask 原前提「无扩展名文件」已过时（实为 default.txt×199 + default.js×1），脚本 rationale 与 code-text spec 头注（:21-24）均已按实测勘误并保留「扩展名表 × 探测链改派回归网」断言，处理得当。
7. **全套件未复跑**：本批复跑范围为两个新 spec（116 用例）+ typecheck + 单测；其余 62 个 spec 文件未复跑（改动面不触及，见 §4 说明）。

## 7. 结论

PASS。本批语料基建多源化实现与 ask 定档一致且工程质量扎实（写死 sha、确定性截断、绝不静默截断、双重内容校验、幂等、失败清单、非 0 退出码），两新域 58 逻辑用例全绿且断言结构无放宽痕迹，两处修复均经复核独立实证成立（含真实管线复现 display 5/9、support_table 6/15、`.katex` 943 三组关键数值）。
