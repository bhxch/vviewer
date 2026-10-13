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

公共环境（构造见第 4 节）：vite preview :4173 纯前端页面，远端来源由 spec 内 node:http 假服务器模拟（跨源 + CORS），`/api/file` 请求经 page.on('response') 逐条计量（Range 头 + 字节数）。块大小 256KB（`CODE_WINDOW_BLOCK_BYTES`），块表 LRU 16 块。套件跑 chromium + mobile 双 project。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SCAN-01 | 假服务器 10MB js（40 块，布点若干命中）；已打开进窗口模式 | ① `/` 打开搜索面板输入无命中词触发全文扫描；② 轮询读取 `.vv-code-scan-progress` 文本（两次间隔 ≥300ms）；③ `stats.settled()` 后对照已拉块数 | 扫描期间进度条可见且文本匹配「扫描中 N%（已命中 M 处）」（size 已知 % 形态，code.ts:1926）；N% 随块落地单调不减；全程无全量 200 | BUG-100 |
| SCAN-02 | 同 SCAN-01 | ① 等扫描至 EOF 收场（计数终值落定）；② 查 `.vv-code-scan-progress`；③ 断言 `.vv-search-count` 终值与布点一致 | 扫描完成后进度条移除（count 0）；命中计数与构造布点精确一致 | BUG-100 |
| SCAN-03 | 同 SCAN-01，另加 stall 门（块 2+ 应答挂起） | ① 触发扫描，等进度条可见；② Esc 关闭面板；③ 断言进度条；④ releaseStall 后照常新搜索 | 取消后进度条同步移除（IO-10 只断言面板关闭与 IO 计量，本锚补 UI 面）；无悬挂请求（stall 放行后挂起应答有归宿） | BUG-100 |
| SCAN-04 | 同 SCAN-03 | ① 扫描 A 在飞（挂在块 2）；② 输入新 query B；③ 断言进度条仍在；④ releaseStall；⑤ 等扫描 B 完成 | 在飞换 query 时进度条不被旧扫描的收场清理误删（ffab040 属主 scanSeq 语义：条被扫描 B 接管持续推进）；B 完成后条移除；B 命中数与 B 布点一致（A 的布点不入集） | BUG-100 |
| SCAN-05 | 假服务器条目**不带 size**（2MB js）；已打开（size 未知仍窗口流式） | ① 触发全文扫描；② 轮询进度条文本；③ 等收场 | 进度文本匹配「扫描中 · 已扫描 N KB（已命中 M 处）」（size 未知 KB 形态，code.ts:1927）；EOF 短读后收场、条移除 | BUG-100 |
| SCAN-06 | 同 SCAN-01，扫描完整跑完 | ① 记录首次扫描终值与计量数；② 清空搜索再输入同一 query；③ `stats.settled()` 对照计量增量 | 同 query 重搜零新增 /api/file 请求（lastScanComplete 短路，4102b26）；计数与首次完全一致 | BUG-101 |
| SCAN-07 | 同 SCAN-03（stall 门块 2+），布点分属块 0 与块 5 | ① 扫描挂起在块 2 时 Esc（部分收场，游标停块 2）；② releaseStall；③ 重新输入同一 query；④ 等终值并对照计量 | 收场后再搜不短路（9ed0626：异常收场回写完成旗标）：出现块 2 起的续扫请求；续扫起扫前截断游标后既有命中（6076448/c019a1e）：终值计数恰为全部布点、每布点行高亮恰一次（无重复入集）；块 0~1 不重读（游标续扫，4102b26） | BUG-101 |
| SCAN-08 | 假服务器 fail 门（块 3 起 Range 应答 500 直至放行），布点分属块 1 与块 5 | ① 触发扫描：块 3 补块失败→收场（部分结果）；② 记录终值（缺块 5 命中）；③ releaseFail；④ 同 query 重搜；⑤ 对照终值与计量 | ① 阶段收场非崩溃、计数=块 0~2 布点（失败块行以缺失参与，5cd1698 每块收敛不逐行重试——块 3~N 只各失败一次）；④ 重搜后块 5 命中被找到（e75c59e 游标回退失败块起点，缺失行不被永久跳过）；终值=全部布点且无重复；二阶段请求自块 3 起（块 0~2 不重读） | BUG-102 |
| SCAN-09 | 本地目录注入（__vvOpenDirImpl）：10MB js 单文件，唯一深命中词落在约 30 万行处 | ① Ctrl+Shift+F 全局搜索命中词；② 点击该文件命中行；③ 等渲染完成，断言 `.vv-code-line[data-line="<深行号>"]` 内容含命中词；④ 查无错误卡片 | revealLine 对未加载行驱动续读后跳转（d37fcd0）：目标行真实渲染且内容与构造一致（BUG-09 全局搜索跳大文件不因「行未入索引静默丢弃」失效）；无错误卡片 | —（d37fcd0 回归锚） |
| SCAN-10 | 假服务器 6MB js（24 块 >16 块 LRU），fail 门只放行前 1 次块 0 重拉（首轮回看重拉 500 一次） | ① 打开并滚动到底（块 0 被逐出）；② 滚回顶部触发回看重拉（首拒）；③ 观察 2s 内计量增量；④ 再次滚离又滚回（用户动作重试） | ② 首次回看重拉失败不停机不崩溃：无请求风暴（停机闩 90f4ca5：增量有界，前缀行保持占位/已渲染内容）；④ 重试成功后顶部行内容与构造一致 | —（90f4ca5 回归锚） |
| SCAN-11 | 同 SCAN-03 | ① 扫描挂起在块 2 时读取 `.vv-search-count`；② releaseStall；③ 等终值 | 命中渐进可用：挂起阶段计数已反映已扫块布点（spec §4.3「命中即时并入命中集并重绘」）；放行后终值正确 | —（spec §4.3 渐进承诺锚） |

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
- spec：`apps/web/e2e/b-code-scan-resilience.spec.ts`；共享 helper：`apps/web/e2e/b-stream-resilience-helpers.ts`（本域与 JVL/DEG 三域共用，自包含实现，不 import 既有 spec 内未导出的装置）：IoStats 计量类（同 b-io-streaming 口径：过滤 /api/file，记录 Range 头与响应字节数）、startStreamFakeServer（b-io-streaming startIoFakeServer 的扩展版：stall 门 + fail 门（500 直至 release）+ rangeless 模式 + 条目省略 size + notifyChanged SSE 注入）、connectForm/openRemoteCodeFile/panelSearch（b-io-streaming 同名装置的复制适配）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| scan-10mb.js | 10MB（40×256KB 块），行式 `v{n}` 内容，布点词分属块 0/5，无命中词 qqnothingqz 触发全文扫描 | SCAN-01/02/06/07 |
| scan-stall.js | 同上 + 假服务器 stall/fail 门 | SCAN-03/04/07/08/11 |
| scan-nosize.js | 2MB，tree 条目省略 size 字段（FileSource.size null → 短读探 EOF） | SCAN-05 |
| local-10mb.js | 本地注入 10MB js，唯一深命中词落在约 300000 行 | SCAN-09 |
| backtrack-6mb.js | 6MB（24 块 > LRU 16 块） | SCAN-10 |

### 4.3 边界与注意事项

1. 计量 attach 必须先于 goto（b-io-streaming 口径），`stats.settled()` 后再读数。
2. stall/fail 门是确定性时序构造（挂起/拒绝指定 minStart 起的 Range 应答），杜绝真实时序竞态；门一次性放行不复闭。
3. SCAN-09 走本地目录通道（localFiles store rangeCapable，无网络计量），只断言跳转正确性；全局搜索本地扫描上限 2000 文件/200MB 累计（globalSearch.ts:60）单文件 10MB 富余。
4. 全程负向护栏：窗口模式路径不得出现全量 200（Range-less 场景除外，归 DEG 域）。
5. mobile project 断点下树行点击经 `e2e/drawer.ts` openDrawerIfNarrow 适配（既有先例）。
