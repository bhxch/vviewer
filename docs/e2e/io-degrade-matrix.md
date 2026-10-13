# IO 流式公共防线降级矩阵 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）high 缺口③。IO 级流式公共防线（StreamCtx / rangeCapable / STREAM_MAX_BYTES，spec `docs/superpowers/specs/2026-10-12-io-streaming-design.md` §2.3/§5 降级矩阵/§6）的降级行为整行无 e2e：`!rangeCapable→全量 ctx`、Range-less 服务器 200 回包→客户端全量切换（d3c9e0a）只有单测；b-io-streaming.spec.ts:213-214 注释自认「200 全量是允许形态（客户端自校验）」却无正向降级用例；size 未知流式、流内 UTF-8 嗅探降级（5c92269）、jsonl/code 的 SSE changed 免全量重读（IO-03 只有 hex 版）均无锚。
>
> 裁决说明：STREAM_MAX_BYTES「size 未知恰界停机」（25c704e）不设 e2e——到达该分支需真实流过 512MB 字节（confirmedBytes >= 512MB），传输+索引成本与 8 核 3 worker 套件不成比例，且 io-streaming 计划当时已裁决「阈值单测 + e2e 不覆盖降级路径」（jsonl/index.ts:108）；25c704e 的 size 已知面（构造即知超限零读）已由 IO-11（code 载体 `.vv-code-oversize-card`）锚定，jsonl 侧补于 JVL-02。本域缺陷编号 BUG-103/104 为回归防护缺口编号（d3c9e0a/5c92269 修复已落地）。

## 1. 目的与来源

dispatcher（`packages/core/src/dispatch/dispatcher.ts`）读策略与 BlockStream（`packages/render-text/src/blockStream.ts`）回退语义的矩阵面：

| 来源形态 | 预期行为 | 现有锚 |
| --- | --- | --- |
| rangeCapable + size 已知 + Range 服务器 | 窗口流式 | IO-01~11 |
| rangeCapable + size 未知（tree 无 size） | jsonl/code 仍窗口流式（短读探 EOF）；hex 全量回退 | **无** |
| !rangeCapable（url/single store） | 全量 ctx（=现状，零收益零风险） | **无** |
| Range-less 200-only 服务器（探针即全量） | head 已含全量 → 块全预置、零后续请求 | **无正向用例** |
| 探针 206 + 块读 200 超长 | 抛弃流式缓冲全量重取（宁切全量不错位，blockStream.ts:171-189） | **无** |
| 流内逐块 UTF-8 嗅探判非 | 停喂 + 全量补拉 + redetectWithFull 重渲 | **无** |
| SSE changed 重渲染免全量 | hex 已锚（IO-03），jsonl/code 无 | **无** |

## 2. 场景清单

公共环境同前两域（default 套件 + 假服务器 + IoStats/UrlStats 计量）；helper 假服务器 rangeless 模式为本域新增能力（`all` / `after-probe` 两档）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| DEG-01 | TopBar「粘贴文件 URL」+ page.route 拦截 `https://fake.asset.test/url-big.jsonl`（200 全量 2MB，ACAO:*） | ① URL 打开该地址；② 读状态条与计量 | url store rangeCapable 缺省 → 全量 ctx：恰 1 请求、无 Range 头、响应恰全尺寸；jsonl 全量形态「共 4096 行」；首行卡片内容正确 | —（io spec §2.3/§5 !rangeCapable 行锚） |
| DEG-02 | 假服务器 rangeless=all，3MB jsonl（tree 带 size；≤ 块表 LRU 16×256KB=4MB，见 §4.3.1） | ① 打开；② settled 读计量；③ 滚到底再回顶 | 正向降级：探针请求（Range 头 `bytes=0-8191` 在）被服务器回 200 全量 3MB，且**恰此 1 请求**（head 已含全量→块全预置、首屏排空直达 EOF「共 6144 行」）；末行内容正确、滚动/回顶零新增请求（「200 全量是允许形态」的正锚，b-io-streaming:213 自认缺口） | BUG-103 |
| DEG-03 | 假服务器 rangeless=after-probe（仅 `bytes=0-8191` 探针回 206，其余 Range 一律 200 全量），10MB js code | ① 打开；② settled 逐条核对计量；③ 滚动至 EOF 读末行 | 全量切换恰 3 请求：探针 206（bytes=0-8191 / 8KB）+ 块 0 请求 200 超长（bytes=0-262143 / 10MB）+ 全量重取 200（bytes=0-9007199254740991 / 10MB）；此后滚动零增量（fullData 底座一切块零 IO 切片）；末行内容与构造一致**无错位**（宁切全量不错位，d3c9e0a）、无 U+FFFD | BUG-103 |
| DEG-04 | 假服务器 jsonl 条目**不带 size**（2MB 整块 + 137B 末短块） | ① 打开；② 读状态条；③ 贴底循环至 EOF；④ 对照计量逐条形状 | size 未知 jsonl 仍窗口流式：首屏「已加载 1024 行」（探针+2 块全 Range），逐块 Range 续读、末块 137B 短读即 EOF → 「共 4097 行」；末块请求端点未预钳（`bytes=2097152-2359295`，服务器钳制短读）；末行内容正确（io spec §5「jsonl/code 仍可流式（索引/续读到 streamEnd 即知末尾）」） | —（spec §5 size 未知行锚） |
| DEG-05 | 假服务器 1MB jsonl（恰界 FULL_LIMIT 含，恰 4 整块）与 2MB jsonl 各一 | ① 打开 1MB 件读计量与状态条；② 打开 2MB 件读计量 | 读策略边界（dispatcher.ts:37）：≤1MB 直接全量（恰 1 请求**无 Range 头**、全量形态「共 2048 行」；夹具须块对齐——非对齐尺寸 tail 部分块首拉重拉替换会产生第 2 读，见 §4.3.1）；>1MB 走 head 探测窗口流式（探针 206 8KB + 2 块 Range，恰 3 请求、「已加载 1024 行」） | —（dispatch 读策略边界锚） |
| DEG-06 | 假服务器 2.25MB js code（>2MB 窗口分界）：前 1MB ASCII 行（head 8KB 判 utf-8）+ 块 4 起 GBK 中文注释行 | ① 打开读状态栏基线「编码: utf-8」；② 贴底滚动使脏块喂入；③ 等状态栏编码翻转收口；④ 读末行内容与计量 | 流内嗅探判非 UTF-8 → 停喂 + 全量补拉（恰 1 条 `bytes=0-9007199254740991` / 2.25MB，memoizedFullRead 一次性）+ redetectWithFull 重判重渲（5c92269）：状态栏「编码: gb18030」、GBK 中文行解码正确、无 U+FFFD 扩散、降级后滚动零 IO、无错误卡片 | BUG-104 |
| DEG-07 | 假服务器 3MB jsonl 已打开至首屏稳定（行 3 布点）；updateFile 改该行内容后 notifyChanged([path]) | ① 断言变更前行可见；② 注入 changed 帧；③ 等更新行可见；④ settled 读计量增量 | SSE rev++ 免全量重读（IO-03 的 jsonl 版）：增量仅探针+受影响窗口块（每条 Range ≤256KB、无全量形态、增量 <2MB）；变更前行消失、更新行可见 | —（IO-03 同构缺口锚） |
| DEG-08 | 同 DEG-07，载体换 10MB js code（改块 0 内首屏可见行文本） | 同 DEG-07 步骤 | code 版免全量重读同判据（增量 = 探针+块 0，<2MB）；更新行渲染正确、旧行文本消失 | —（IO-03 同构缺口锚） |
| DEG-09 | TopBar URL 打开 `https://fake.asset.test/url-blob.bin`（200 全量 1MB 二进制，0xde 0xad 双布点），page.route 拦截 | ① 打开；② 读 hex 状态行与计量；③ 搜索布点字节 | hex size 未知全量回退（io spec §5「size null → hex 全量回退」）：恰 1 全量请求（无 Range 头）、hex 视图首行真实渲染、状态行「1.0 MB · 未知二进制」、`de ad` 搜索 1/2→2/2 命中且偏移行正确（00030000/00060000） | —（spec §5 hex 行锚） |

## 3. 关联缺陷的验收行为

### BUG-103 Range-less 服务器回包处理回归（内容错位/重复全量）（回归防护缺口）

**缺陷现状**：远端 store 恒宣告 rangeCapable（remote.ts:366），Range-less 服务器回 200 全量时「长度/边界校验由调用方自担」（remote.ts:350-352）。BlockStream fetchBlock 的超长 200 分支（终审 F3：抛弃流式缓冲重取全量，blockStream.ts:171-189「subarray 钳制会把文件头错位当本块，宁切全量不错位上屏」）与探针即全量的预置分支均只有单测；e2e 既有断言把 200 一律当回归（b-io-streaming.spec.ts:213-214），无正向降级用例。

**修复后应有行为（回归验收）**：
1. 探针即 200 全量：恰 1 请求、内容正确、后续滚动/回顶零新增请求（DEG-02）。
2. 探针 206 + 块读 200 超长：全量重取后零增量请求、末行内容零错位（DEG-03）。
3. 回归不破坏：Range 服务器下窗口流式逐请求 Range 计量（IO-01~07 护栏）不回退。

### BUG-104 流内非 UTF-8 误判不上报降级（U+FFFD 上屏/编码误标）（回归防护缺口）

**缺陷现状**：5c92269 修复前，head 8KB 误判 utf-8 而流内后续块为非 UTF-8 时，无嗅探无降级通道，U+FFFD 直接上屏且编码误标；修复后每块一次性嗅探（UTF8_SNIFF_ILLEGAL_MIN，blockStream.ts:385/465），超阈停喂走 memoizedFullRead + redetectWithFull 全量重渲（code.ts:1642-1659/2254-2258，jsonl 同款）。仅单测。

**修复后应有行为（回归验收）**：
1. head 纯 ASCII + 块 4 起 GBK 构造：滚动触达脏块后自动降级，中文内容解码正确、无 U+FFFD 扩散、状态栏编码为全量精判值 gb18030（DEG-06；jsonl 侧 meta 转投见 JVL-03）。
2. 降级为一次性：计量中全量补拉恰 1 条（`bytes=0-9007199254740991`），后续滚动零新增。
3. 回归不破坏：纯 UTF-8 文件零嗅探误报（无多余全量补拉）。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件（`apps/web/playwright.config.ts`：vite preview :4173，chromium+mobile 双 project，workers 3，retries 1）；spec：`apps/web/e2e/b-io-degrade-matrix.spec.ts`。
- 共享 helper `apps/web/e2e/b-stream-resilience-helpers.ts`（SCAN/JVL/DEG 三域共用，自包含实现，不 import 既有 spec 内未导出的装置）：`IoStats`（/api/file 计量：Range 请求头 + 响应字节数，b-io-streaming 同口径）、`UrlStats`（URL 打开通道计量，url store 直连 fetch 不经 /api/file）、`startStreamFakeServer`（rangeless 两档 `all`/`after-probe` 为本域新增能力 + stall 门 + fail 门 + 条目省略 size + `notifyChanged` SSE 注入 + `updateFile` 字节表替换）、`waitAppMounted`/`connectForm`/`openTreeFile`（内置 drawer.ts 窄视口适配）/`openRemoteFile`/`openUrlFile`/`settleStats`。
- DEG-01/09 的 URL 打开入口：TopBar「粘贴文件 URL」表单（TopBar.svelte:332-334 → openUrlFlow.svelte.ts:1100 openUrl → createUrlStore，size 显式 null、无 rangeCapable）；page.route 拦截外部域并显式带 `access-control-allow-origin: *`（t-shell SHELL-04 先例：fulfill 绕过 CORS 检查，ACO 头为口径自洽）。

### 4.2 夹具构造（全部 spec 内生成）

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| url-big.jsonl（route 拦截应答） | 2MB = 4096 行 × 512B（恰 8 块 ≤ LRU 16） | DEG-01 |
| rl-all-3mb.jsonl | 3MB = 6144 行 × 512B（恰 12 块 ≤ LRU 16，head 全预置零逐出） | DEG-02 |
| rl-ap-10mb.js | 10MB = 163840 行 × 64B（40 块） | DEG-03 |
| nosize-2mb.jsonl | 2,097,289B = 4096×512B 整块 + 137B 末短行（条目省略 size） | DEG-04 |
| boundary-1mb.jsonl / boundary-2mb.jsonl | 1048576B（2048×512B，恰 4 整块、恰界 FULL_LIMIT 含）/ 2097152B（4096×512B） | DEG-05 |
| sniff-gbk.js | 2,359,296B（2.25MB = 9 块，>2MB 窗口分界）：前 1MB ASCII 行 + 块 4 起 GBK 行 `// 编码嗅探降级验证 id=N` | DEG-06 |
| sse-3mb.jsonl / sse-10mb.js | 3MB jsonl（行 3 布点）/ 10MB js（行 5 布点），updateFile 前后双态 | DEG-07/08 |
| url-blob.bin（route 拦截应答） | 1MB 0x41 填充 + 0xde 0xad 布点于 0x30000/0x60000 | DEG-09 |

### 4.3 边界与注意事项

1. DEG-02 夹具取 3MB（12 块）而非 10MB：BlockStream 构造期对 head 预置块执行 `evictOverflow`（blockStream.ts:130-137），jsonl/code 块表 LRU 上限 16 块（4MB）——超过则头部预置块被逐出，首屏排空即对被逐块发起新读、在 rangeless=all 下触发 200-回退全量重取（DEG-03 语义），「恰 1 请求」不再成立。「探针即全量零后续请求」的整行锚定以 LRU 界内夹具表达；超界形态归 DEG-03 的回退口径。
2. DEG-05 的 ≤1MB 夹具取恰界 1MB 且块对齐（恰 4 整块）：BlockStream 对 head 预置的**部分块**保留部分字节、首次 ensureBlock 重拉整块替换（blockStream.ts 头注）——非块对齐尺寸（如实测 900KB）的全量直读会追加一条带 Range 的 tail 块重读（实测 DEG-05 首轮 2 请求即此形态，属实现语义而非回归）；「恰 1 请求」判据以块对齐夹具表达。
3. DEG-03 逐请求核对三请求形状（206 8KB / 200 超长 bytes=0-262143 / 200 全量重取 bytes=0-9007199254740991），不允许出现第 4 条；code 首屏只拉块 0（code.ts:1734-1736 start 首块拉取），无并行预取干扰。
4. SSE 注入前必须 `settleStats` 收敛首屏计量，增量窗口才干净（IO-03 同口径）；DEG-07/08 更新行布点在块 0 首屏可见行——窗口级重读判据不受行位影响，且免去中部定位的额外块拉取噪声。
5. DEG-06 的全量补拉是 `bytes=0-9007199254740991` 的 Range 透传（服务器 206 钳制全尺寸），非「无 Range 全量记录」；降级收口信号取状态栏编码翻转（ViewerPane 250ms meta 轮询），避免对降级时序的猜测式等待。
6. GBK 夹具字节为生成期经 gbk 编码+回解校验的定值（`编码嗅探降级验证` 16 字节），每脏块 4096 行 × 16 GBK 字节远超嗅探阈值（UTF8_SNIFF_ILLEGAL_MIN=8 或 1%），判定无边缘性。
7. 全程负向护栏仅对 rangeCapable 形态生效；DEG-01/02/03 的全量 200 是被测形态，不适用「不得出现全量 200」护栏。
8. 计量 attach 必须先于 goto（openRemoteFile 内置该顺序；UrlStats 同），`settleStats`（settled → 300ms → settled）后读数。
