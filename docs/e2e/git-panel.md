# Git 信息面板 e2e — 场景（GIT 域）

> 来源：spec `docs/superpowers/specs/2026-10-31-git-panel-design.md`（§2 机制 isomorphic-git 纯前端 / §3 四信息面 / §8 实现裁决记档）+ plan `docs/superpowers/plans/2026-10-31-git-panel.md`（Task 2 GIT-01..04、Task 3 GIT-05..08）。本文档为该域收册文档：既有 GIT-01..08 转录现状脚本，GIT-09..12 为测绘差距新增锚（detached HEAD / blame 200 截断 / diff 截断上限 / untracked 无 diff 提示态）。

## 1. 目的与来源

- **现状 e2e 文件**：`apps/web/e2e/b-git-panel.spec.ts`（GIT-01..08；夹具先例：mkdtemp + execSync 真实 git 仓库——三 commit 两作者、CRLF 钉死 `core.autocrlf=false`、未提交改动、untracked、无 .git 对照目录；serverHarness 全链路连接）。
- **实现锚**：探测 `apps/web/src/lib/git/gitProbe.ts`（向上 ≤5 级读 `.git/HEAD`，目录缓存/负缓存）+ `gitWorker.ts:273-280`（probe-head：detached → `ok:true` 无 branch）；信息卡 `apps/web/src/lib/GitSection.svelte:379`（分支位 `{phase.headOk ? (phase.branch ?? '（游离 HEAD）') : '不可用'}`）、`:397-398`（blame 说明行插值 `BLAME_MAX_COMMITS`）、`:76-82`（diffLabel 模式标注）、`:222`（untracked diff empty 态 note「未跟踪文件无 diff（HEAD 树无此路径）」）；截断常量 `apps/web/src/lib/git/gitDiff.ts:20/24`（`DIFF_MAX_ROWS=2000` / `BLAME_MAX_COMMITS=200`）+ `:291-293`（截断尾注文案「diff 过大已截断（上限 N 行 / …KB），仅显示前段」）。
- **测绘差距**（本文档新增面）：GIT-01..08 全部常规分支/干净仓库形态，**detached HEAD（spec §3.1）、blame 200 截断（spec §3.2）、diff 截断（spec §3.3——现仅 `gitDiff.test.ts:227-228` 常量语义单测，e2e 零锚）、untracked 无 diff 提示态（spec §3.3——GIT-03 只锚状态行，diff 折叠区提示态零锚）**四面零覆盖。

## 2. 场景清单

### 2.1 既有面（现状脚本已锚）

| 编号 | 落点 | 锚要 |
| --- | --- | --- |
| GIT-01 | `b-git-panel.spec.ts:184` | 信息卡字段（分支 main / CRLF 文件状态 clean 红线 / 末次提交短 hash=c2 该文件口径 / 作者 / 相对时间 / subject）+ 三元切换器显隐合并、默认落位属性 |
| GIT-02 | `b-git-panel.spec.ts:211` | touched 保持 + modified 黄点（切文件 Git 段随行） |
| GIT-03 | `b-git-panel.spec.ts:230` | untracked：灰点 + 「未跟踪」+ 末次提交「无（未跟踪文件）」 |
| GIT-04 | `b-git-panel.spec.ts:242` | 无 .git 来源：切换器整体不出现 + probe 负缓存（二次打开零新增 .git 请求，route 计数=2） |
| GIT-05 | `b-git-panel.spec.ts:290` | diff modified 模式：工作区 vs HEAD，+/− 行着色计数钉死（1+1−） |
| GIT-06 | `b-git-panel.spec.ts:311` | diff clean 模式：HEAD^ vs HEAD（blobAt 首父链） |
| GIT-07 | `b-git-panel.spec.ts:329` | 文件历史 ≤50 列表 + 展开详情（full hash / 提交者 / 逐提交 diff 基线=文件史前条目）+ 单开互斥 |
| GIT-08 | `b-git-panel.spec.ts:356` | blame hover 浮层字段（作者/日期/subject/未提交哨兵）+ 滚动即收 + 先滚后悬两段式 |

### 2.2 新增面（测绘差距锚）

| 编号 | 前置条件 | 步骤 | 期望 |
| --- | --- | --- | --- |
| GIT-09 | 夹具 repo 追加 `git checkout --detach`（beforeAll 装置期对独立小 repo 或专用文件执行，不污染 GIT-01..08 的 main 分支载体）→ 连接打开该 repo 文件 → 激活 Git 段 | 读信息卡分支位 | detached HEAD（spec §3.1）：分支位显示「（游离 HEAD）」非分支名（`gitWorker.ts:276` currentBranch detached → `{ok:true}` 无 branch → `GitSection.svelte:379` 兜底文案——**注：实现为固定文案，非任务简报所拟「短 hash 标注」，以实读为准**）；状态/末次提交行不受游离态影响（clean + 短 hash 照常） |
| GIT-10 | 夹具 repo3：单文件 201 次快提交（`execSync` 循环 append+commit，beforeAll 一次性构造；末次提交后文件 clean）→ 打开该文件激活 Git 段 | ① 读 blame 说明行；② hover 任一行读浮层包围盒 | ① 说明行文案含「文件历史超 200 提交仅最近 200 参与归属」（`GitSection.svelte:398` 插值 `{BLAME_MAX_COMMITS}`=200，gitDiff.ts:24）；② hover 浮层不越窗：fixed 定位浮层 boundingBox 完整落在视口内（四边 ≤ 视口边界，spec §3.2 浮层不越窗） |
| GIT-11 | 夹具 repo4：文件首提交少量行 + 第二提交追加 >2000 行（如 2500 行）未提交（modified）→ 打开激活 Git 段展开 diff | ① 读折叠钮与 diff 区；② 对比 `.vv-git-diff-stat` 计数与着色行计数 | 截断尾注可见：`.vv-git-diff-trunc` 含「diff 过大已截断（上限 2000 行」（gitDiff.ts:291-293 + DIFF_MAX_ROWS:20）；`+/−` 计数按**窗内**钉死：`.vv-git-diff-stat` 数字与 `.vv-git-diff-row-add`/`-del` 实际着色行数一致（截断后统计=显示集口径，非全 diff 口径）；渲染行数 ≤2000 有界 |
| GIT-12 | GIT-03 装置（untracked `new.txt`）→ 打开激活 Git 段 | ① 读 diff 折叠钮文案；② 点开折叠区读内容 | ① 折叠钮标注「（未跟踪文件无 diff）」（`GitSection.svelte:80` diffLabel `commit === null` 分支）；② 展开后为提示态非空 diff：`.vv-git-diff-row-add`/`-del` 计数 0、note「未跟踪文件无 diff（HEAD 树无此路径）」可见（`GitSection.svelte:222` empty 态）——无截断尾注、无报错卡 |

## 3. 验收行为

- **GIT-09**：游离 HEAD 是只读探测的合法形态（`ok:true` 非 error），分支位文案为行为级验收基准；回归护栏：GIT-01 分支名 main 锚零翻转（同函数正常分支路径）。
- **GIT-10**：截断标注必须**恒显**于 blame 说明行（非仅超限时）——说明行本身是常驻元素（`:397` 注释「仅对有历史的文件」），超限仓库下插值语义为真值呈现；浮层不越窗为 spec §3.2 几何承诺。夹具规模备案：201 commit `execSync` 循环在装置期秒级完成（CI runner 自带 git），单 repo 独立构造防污染既有夹具的 oid 断言（GIT-01/07 短 hash 锚）。
- **GIT-11**：截断是渲染层有界承诺（spec §3.3「>2000 行或 >200KB 截断 + 尾注」），计数窗内钉死防「统计全量、显示截断」的错位；2500 行载体只触发行数门（≈80KB < 200KB），bytes 门由单测向量覆盖不在 e2e 重复。
- **GIT-12**：提示态替代空 diff（spec §3.3「untracked 文件无 diff（提示态）」）；回归护栏：GIT-03 状态行锚、GIT-05/06 两模式折叠钮文案锚零翻转（diffLabel 三分支互斥）。
- **全域回归护栏**：右面板三元切换器为 OUT/GIT 两域共享组件——本文档任何锚落地后与 `b-code-outline` 定向同跑（切换器显隐合并与 touched 台账双域互证）。

## 4. 环境与数据

- **通道**：server 套件形态保持 GIT-01..08 既有口径——`serverHarness.startVviewerServer`（mkdtemp 夹具为 `--root`，preview :4173 前端跨源连接，token/CORS 同款）；双 project 端口错开（chromium 8501 / mobile 8551）；打开文件走树点击真实全链路（连接→树→store→渲染→probe→GitSection）。
- **夹具扩展清单**（`buildGitFixture` 同期装置，均 `execSync` 构造）：repo2（GIT-09：单 commit + `checkout --detach`）；repo3（GIT-10：`e2e-blame.txt` 201 commits——首提交建文件、循环 200 次 `git commit --allow-empty -am` 或 append 空行提交）；repo4（GIT-11：`big-diff.txt` 首提交 1 行、第二提交追加 2500 行后保持未提交）。注意 repo3 循环提交须改文件内容才计入 filepath 过滤 log（`git commit -a` 前追加换行即可）；各 repo 互不共享 HEAD。
- **移动端形态**：mobile ≤600px 右栏在抽屉内——Git 段交互断言保持抽屉展开（GIT-05..07 `openGitSection` 先例：段内交互全在展开态进行，操作代码区前才收抽屉）；GIT-10 浮层几何锚在 mobile 视口同样适用（375px 更易越窗，双 project 都断）。
- **离线确定性**：isomorphic-git 纯前端读 `.git` 字节，全链零网络（spec §2.1——不依赖 health capabilities、服务端零改动）；server 实例仅提供文件通道。构建前置 `pnpm --filter web build:e2e`。
