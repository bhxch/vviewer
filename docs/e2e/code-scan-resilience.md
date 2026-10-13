# code 后台扫描与重搜韧性 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）high 缺口①。code 窗口流式 + 后台全文扫描搜索（spec `docs/superpowers/specs/2026-10-12-io-streaming-design.md` §4.3）最近 20+ 条 fix 提交密集修残留角，但 e2e 仅有 happy-path 计量锚（b-io-streaming.spec.ts IO-06~10 全部走正常 206 通道），失败/取消/重搜面零防护。本文档为该面补设回归锚。关联提交：7bb8552（扫描进度条）、ffab040（进度条属主）、fa41d30（进度节流）、6076448/c019a1e/9ed0626/4102b26（同键重搜残留角）、e75c59e/5cd1698（补块失败）、d37fcd0（revealLine 续读）、90f4ca5（回看重拉停机闩）。
>
> 本域缺陷编号 BUG-100~102 为「回归防护缺口」编号：产品修复均已落地（commit 为证），本轮补 e2e 防护；第 3 节按既有域文档口径给出可执行判据。

## 1. 目的与来源

code 渲染器窗口模式（`packages/render-text/src/code.ts`）的后台全文扫描搜索在 spec §4.3 承诺：逐块拉取至 EOF、进度可见、令牌取消、命中渐进、gotoMatch ensure 补块。既有 e2e IO-09/IO-10 只锚定「正常 stall 门下的取消与交错」，以下行为无任何 e2e：

- 扫描进度条 UI（7bb8552 新增 `.vv-code-scan-progress`，spec §4.3「进度回调（状态条『扫描中 N%』）」的兑现）——b-io-streaming.spec.ts:847 注释仍写「扫描进度不上 UI」，口径已反转；
- 同 query 重搜的一致性（短路/续扫/不重复入集）；
- 补块失败后的游标回退与恢复；
- revealLine 对未加载行的续读驱动（BUG-09 全局搜索跳大文件）；
- 回看重拉失败的停机闩。

既有锚点（本域不重复布点）：IO-09（扫描至 EOF+命中跳转 ensure）、IO-10（stall 门取消/交错滚动）、IO-06/07（首屏与续读计量）、IO-08（≤2MB 全量守卫）。

## 2. 场景清单

公共环境（构造见第 4 节）：vite preview :4173 纯前端页面，远端来源由 spec 内 node:http 假服务器模拟（跨源 + CORS + OPTIONS 预检），`/api/file` 请求经 page.on('response') 逐条计量（Range 头 + HTTP 状态 + 字节数）。块大小 256KB（`CODE_WINDOW_BLOCK_BYTES`），块表 LRU 16 块。套件跑 chromium + mobile 双 project。全部 11 场景已实跑锚定（b-code-scan-resilience.spec.ts，双 project 22/22 passed）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SCAN-01 | 假服务器 10MB js（40 块，无布点）；已打开进窗口模式；206 应答统一延迟 60ms（确定性撑采样窗） | ① `/` 打开搜索面板输入无命中词触发全文扫描；② 页内 100ms 间隔采样器抓取 `.vv-code-scan-progress` 文本（条在位才采样）；③ 以 IO 事实收场（块 39 Range 已拉取）后取全部样本 | 扫描期间进度条可见且文本匹配「扫描中 N%（已命中 0 处）」（size 已知 % 形态，code.ts:1926）；N% 随扫描推进单调不减且末样本 >30%（已离开起扫段）；全程无全量 200。注意：面板计数完成制，扫描期间恒「无结果」，不可作完成信号 | BUG-100 |
| SCAN-02 | 假服务器 10MB js（40 块，布点行 1000/21000 分属块 0/5）；已打开 | ① 输入布点词等扫描收场；② 查 `.vv-code-scan-progress`；③ 断言 `.vv-search-count` 终值与 Enter 导航 | 扫描完成后进度条移除（count 0）；计数 1/2→Enter→2/2，active 行号与两布点逐一吻合 | BUG-100 |
| SCAN-03 | 同 SCAN-02，另加 stall 门（块 2+ 应答挂起） | ① 触发扫描，等进度条可见（计量停在探针+块 0+块 1）；② Esc 关闭面板；③ releaseStall 等块 2 应答落地；④ 断言进度条后照常新搜索 | 挂起应答有归宿（块 2 落地）且扫描收场后进度条同步移除（收场在放行后——挂起读不可中断，取消令牌在下一检查点生效；IO-10 只断言面板关闭与 IO 计量，本锚补 UI 面）；放行后新搜索照常完成 | BUG-100 |
| SCAN-04 | 同 SCAN-03 | ① 扫描 A（无命中词）在飞挂在块 2；② fill 替换输入为新 query B（布点词）；③ 断言进度条仍在且文本出现「已命中 1 处」（B 接管后块 0 布点渐进入集）；④ releaseStall 后等块 3 已发出（⇒ A 必已退出）再断进度条仍在；⑤ 等 B 完成 | 在飞换 query 时进度条不被旧扫描的收场清理误删（ffab040 属主 scanSeq 语义：条被 B 接管持续推进、A 收场清理属主不符为 no-op）；B 完成后条移除；计数 1/2 与 B 布点一致（A 零命中不入集） | BUG-100 |
| SCAN-05 | 假服务器条目**不带 size**（2MB js，8 块）；已打开（size 未知仍窗口流式）；206 应答延迟 100ms | ① 触发布点词全文扫描；② 页内采样器抓进度条文本；③ 等计数 1/2 收场 | 进度文本匹配「扫描中 · 已扫描 N KB（已命中 M 处）」（size 未知 KB 形态，code.ts:1927），KB 数单调不减；块 8 出现 0 字节 EOF 短读探测（Range `bytes=2097152-2359295` 应答 0 字节）后收场、条移除 | BUG-100 |
| SCAN-06 | 同 SCAN-02，扫描完整跑完 | ① 记录首次扫描计数；② Enter 步进到第二布点（改变 current/active，使短路重搜的回落可观测）并等 IO 落定；③ 面板保持开启，向输入框重派发**同值 input 事件**（等价全选重贴同词；清空再输入是换键，会重置命中集与游标，不是同键重搜）；④ 对照计量增量 | 同键重搜零扫描 IO（lastScanComplete 短路，4102b26）：新请求至多 1 条且只能是 gotoMatch 的块 0 缺驻补拉（本例视口停在顶部持续触新块 0 时实测为 0 条）；短路回归（重扫全文）时 39+ 块级增量必红；计数回落 1/2、active 回首布点（证明重搜真实跑过且秒回） | BUG-101 |
| SCAN-07 | 同 SCAN-03（stall 门块 2+），布点行 1000/21000 分属块 0/5 | ① 扫描挂起在块 2 时 Esc（部分收场，游标停块 2）；② releaseStall（挂起块 2 落地）；③ 重开面板输入同一 query；④ 等计数 1/2 与 Enter 导航 2/2 | 收场后再搜不短路（9ed0626：异常收场回写完成旗标）：续扫至 EOF（计数落定）；扫描前沿块 1..39 各恰拉取一次（6076448/c019a1e 起扫前截断 + 游标续扫 4102b26：无重复 Range、无重读回环）；块 0 除打开首拉外至多 2 次（视口停在顶部，其所在块被 LRU 逐出后经回看重拉补齐，属合法 backtracking 补块非扫描重读）；终值 2 布点无重复入集 | BUG-101 |
| SCAN-08 | 假服务器 fail 门（块 3 起 Range 应答 500 直至放行），布点行 5000/21000 分属块 1（门前）与块 5（门后） | ① 触发扫描：块 3 补块失败→收场（部分结果）；② 记录终值（缺块 5 命中）与 500 计量；③ releaseFail；④ 同键重搜（同值 input 事件）；⑤ 对照终值与计量 | ① 阶段收场非崩溃、计数 1/1（仅门前布点）、500 恰一条死在块 3（5cd1698 失败块一次请求，无重试风暴）；④ 重搜后块 5 布点被补全（计数 1/2，e75c59e 游标回退失败块起点，缺失行不被永久跳过）；二阶段首请求即块 3 的 206 重试（游标续扫）、块 2 不重读、扫描前沿块 4..39 各恰一次；全程块 3 恰 2 次（500+206）、块 0 恰 1 次 | BUG-102 |
| SCAN-09 | 假服务器 ~19.5MB js（79 块，唯一布点行 300000 ∈ 块 73）+ **POST /api/search 固定 NDJSON 命中帧**（1 起行 300001、text 为该行构造原文）；已连接未开文件 | ① Ctrl+Shift+F 全局搜索布点词（远端 ripgrep 通道）；② 点 `.vv-gsearch-row` 命中行；③ 等渲染完成，断言 `.vv-code-line[data-line="300000"]` 内容含布点词；④ 查无错误卡片 | revealLine 对未加载行驱动续读后跳转（d37fcd0）：目标行真实渲染且内容与构造一致；IO 证据：续读按 256KB 块步进（≥探针+74 块、块 73 在列）、无全量 200。注意：本地全局搜索单文件 >2MB 被过滤（core search.ts GREP_MAX_FILE_BYTES），大文件「命中点击打开」只能走远端通道——这正是 BUG-09 的真实触发形态 | —（d37fcd0 回归锚） |
| SCAN-10 | 假服务器 6MB js（24 块 >16 块 LRU），failOnce 门只对块 0 整块 Range 的第 2 次请求（首轮回看重拉）500 一次（skip=1 放过打开期首拉） | ① 打开并贴底滚动至 EOF（块 0 被逐出）；② 滚回顶部（缺块占位行 + 回看重拉首拒）；③ 观察 1.5s 内计量增量；④ 再次滚离又滚回（用户动作重试） | ② 首次回看重拉 500 恰一次、占位行维持（gutter 无正文）；③ 停机闩 90f4ca5：1.5s 零新增请求（无风暴）、无错误卡片；④ 重试成功后顶部行内容与构造一致（块 0 全程恰 206/500/206 三次） | —（90f4ca5 回归锚） |
| SCAN-11 | 同 SCAN-03，另加 206 应答延迟 120ms（块 1 落地晚于 100ms 进度节流窗，渐进文本可确定性采样） | ① 触发布点词扫描，等计量停在块 2 门上；② 断言进度条文本与面板计数；③ 滚动至布点行 1000 断言行级类与词级命中；④ releaseStall 等终值 | 命中渐进可用：挂起阶段进度条已显示「已命中 1 处」（spec §4.3「命中即时并入命中集并重绘」；对照：面板计数完成制仍「无结果」）；行 1000 具 `.vv-search-hit-line` 行级背景且词级命中可见——先于全文完成上屏；放行后终值 1/2 正确、条移除 | —（spec §4.3 渐进承诺锚） |

## 3. 关联缺陷的验收行为

### BUG-100 后台扫描进度条不可见/收场不清理/换 query 属主误删（回归防护缺口）

**缺陷现状**：进度条 7bb8552 才兑现（spec §4.3 承诺「进度回调（状态条『扫描中 N%』）」），此前的实现注释明写「面板现状无进度挂点——扫描进度不上 UI」（code.ts:1794，历史口径）；b-io-streaming.spec.ts:847 注释沿用旧口径。进度条新增后的三个残留角（ffab040 在飞换 query 旧扫描收场误删新扫描的条、fa41d30 节流前 250Hz 写 DOM）均只有单测。

**修复后应有行为（回归验收）**：
1. 扫描期间 `.vv-code-scan-progress` 可见，size 已知为「扫描中 N%（已命中 M 处）」、size 未知为「扫描中 · 已扫描 N KB（已命中 M 处）」，数值随扫描推进单调不减（SCAN-01/05）。
2. 完成/取消/失败三态进度条均被移除，不残留（SCAN-02/03）。
3. 在飞换 query 进度条不消失，由新扫描接管直至新扫描收场（SCAN-04）。
4. 回归不破坏：扫描终值计数、取消后新搜索、EOF 末行渲染照常（IO-09/IO-10 护栏持续通过）。

### BUG-101 同 query 重搜重复入集/部分结果短路（回归防护缺口）

**缺陷现状**：sameKey 重搜链 4 连 fix——6076448（起扫前截断游标之后既有命中，防重复入集）、c019a1e（startFrom=0 同键重搜截断无条件执行）、9ed0626（异常收场回写完成旗标，防部分结果短路）、4102b26（同键短路纳入完成旗标与进度游标）。全部只有 render-text 单测（e03b997/8896b62），无端到端锚。

**修复后应有行为（回归验收）**：
1. 扫描完整收场后同 query 重搜零新增块请求、计数一致（短路，SCAN-06）。
2. 部分收场（取消/stall）后同 query 重搜必须续扫（不短路），续扫自游标块起（已扫块不重读），终值恰为全部布点且每布点行命中恰一次（SCAN-07）。
3. 回归不破坏：换 query 搜索互斥替换（旧命中不泄漏进新 query）。

### BUG-102 补块失败游标不回退致命中永久丢失（回归防护缺口）

**缺陷现状**：e75c59e 修复前，扫描期补块失败的行被永久跳过（游标不回退失败块起点）；5cd1698 补失败粒度从每行收敛为每块一次（持续失败不逐行重试风暴）。仅单测。

**修复后应有行为（回归验收）**：
1. 补块失败扫描以部分结果收场（不崩溃、不无限重试：失败块至多一次请求）。
2. 失败因素解除后同 query 重搜，此前缺失块的命中被补全，终值=全部布点且无重复（SCAN-08）。
3. 回归不破坏：读失败闩下滚动续读停机语义（「下次用户动作才重试」）不回退。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件（`apps/web/playwright.config.ts`：vite preview :4173，chromium+mobile 双 project，workers 3，retries 1）。
- spec：`apps/web/e2e/b-code-scan-resilience.spec.ts`；共享 helper：`apps/web/e2e/b-stream-resilience-helpers.ts`（SCAN/JVL/DEG 三域共用，自包含实现，不 import 既有 spec 内未导出的装置）：IoStats 计量类（同 b-io-streaming 口径：过滤 /api/file，记录 Range 头、HTTP 状态与响应字节数）、startStreamFakeServer（b-io-streaming startIoFakeServer 的共享扩展版：stall 门 + fail 门（500 直至 release）+ failOnce 精确 Range 自愈门（skip 放过首拉后指定次数 500）+ slowMs 应答统一延迟 + 条目省略 size + POST /api/search 固定 NDJSON 应答（含 OPTIONS 预检）+ notifyChanged SSE 注入）、connectForm/openRemoteFile/settleStats 页面装置。code 侧装置（openCode/panelSearch/replaceSearchQuery/retriggerSameQuerySearch/进度条采样器）在 spec 内自含。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| scan-10mb.js | 10MB（40×256KB 块 = 163840 行×64B），行式 `const v{i} = '…';`，布点词行 1000/21000（分属块 0/5），无命中词 qqnothingqz 触发全文扫描 | SCAN-01/02/03/04/06/07/08/11 |
| scan-nosize.js | 2MB（8 块），tree 条目省略 size 字段（FileSource.size null → 短读探 EOF），布点行 500/9000 | SCAN-05 |
| deep-20mb.js | ~19.5MB（79 块），唯一布点行 300000（块 73）；配套 /api/search NDJSON 命中帧（行 300001、text=构造原文） | SCAN-09 |
| backtrack-6mb.js | 6MB（24 块 > LRU 16 块），无布点 | SCAN-10 |

### 4.3 边界与注意事项

1. 计量 attach 先于 goto（openRemoteFile 内置），`settleStats`（settled → 300ms 静置 → settled）后再读数。
2. stall/fail/failOnce 门是确定性时序构造（挂起/拒绝/首拒指定 Range 的应答），杜绝真实时序竞态；stall/fail 门一次性放行不复闭，failOnce 自愈。
3. SCAN-09 走远端 ripgrep 通道（假服务器 /api/search NDJSON）：本地全局搜索单文件 >2MB 被过滤（core compute/search.ts GREP_MAX_FILE_BYTES，search.ts:158），大文件「搜索命中点击打开」唯一通道是远端——这正是 BUG-09 的真实触发形态；addTab 以 size null 打开 → ctx.size null 窗口流式，revealLine 驱动续读路径与真实场景等价。
4. 全程负向护栏：窗口模式路径不得出现全量 200（Range-less 场景除外，归 DEG 域）。
5. mobile project 断点下树行点击经 `e2e/drawer.ts` openDrawerIfNarrow 适配（helper 的 openTreeFile 内置）；SCAN-09 的 Ctrl+Shift+F 与命中行点击在 375px 视口下无需抽屉适配（浮层面板）。
6. 同键重搜的触发面：面板保持开启下重派发同值 input 事件（等价全选重贴同词）；「清空再输入」是换键（search('') 重置命中集与游标），不构成同键重搜。面板计数为完成制（SearchPanel await 后才写 total），扫描期间恒「无结果」——扫描中的渐进命中数看进度条文本。
