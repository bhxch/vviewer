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

公共环境同前两域（default 套件 + 假服务器 + IoStats）；helper 假服务器新增 rangeless 模式（全部 /api/file 忽略 Range 回 200 全量）与 rangeless-after-probe 模式（仅 `bytes=0-8191` 探针回 206，其余回 200 全量）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| DEG-01 | TopBar「从 URL 打开」+ page.route 拦截 `https://fake.asset.test/big.jsonl`（200 全量 2MB，ACAO:*） | ① URL 打开该地址；② 读状态条与计量 | url store rangeCapable 缺省 → 全量 ctx：恰 1 请求、无 Range 头、jsonl 全量形态「共 N 行」；渲染内容正确 | —（io spec §2.3/§5 !rangeCapable 行锚） |
| DEG-02 | 假服务器 rangeless=all，10MB jsonl（tree 带 size） | ① 打开；② settled 读计量；③ 滚到底再回顶 | 正向降级：探针请求即 200 全量（Range 头 null、字节数=10MB）且**恰此 1 请求**（head 已含全量→块全预置）；EOF「共 N 行」、末行内容正确、滚动零新增请求（「200 全量是允许形态」的正锚，b-io-streaming:213 自认缺口） | BUG-103 |
| DEG-03 | 假服务器 rangeless=after-probe（探针 206 8KB，块读一律 200 全量），10MB js code | ① 打开；② settled 读计量逐条核对；③ 滚动至 EOF 读末行；④ 对照计量终值 | 全量切换恰 3 请求：探针 206（bytes=0-8191）+ 首块请求 200 超长 + 全量重取 200；此后零增量（fullData 底座一切块零 IO 切片）；末行内容与构造一致**无错位**（宁切全量不错位，d3c9e0a） | BUG-103 |
| DEG-04 | 假服务器 2MB jsonl 条目**不带 size** | ① 打开；② 读状态条；③ 滚到底 | size 未知 jsonl 仍窗口流式：逐块 Range 拉取（无全量 200），短读探 EOF 后「共 N 行」；末行内容正确（io spec §5「jsonl/code 仍可流式（索引/续读到 streamEnd 即知末尾）」） | —（spec §5 size 未知行锚） |
| DEG-05 | 假服务器 900KB jsonl（size 已知 ≤1MB FULL_LIMIT）与 2MB jsonl 各一 | ① 打开 900KB 件读计量与状态条；② 打开 2MB 件读计量 | 读策略边界（dispatcher.ts:279）：≤1MB 直接全量（恰 1 请求无 Range、全量形态「共 N 行」）；>1MB 走 head 探测窗口流式（探针 8KB + 块 Range）（「已加载 N 行」） | —（dispatch 读策略边界锚） |
| DEG-06 | 假服务器 2MB js code：前 1MB ASCII 行 + GBK 中文块 + 尾部 GBK 中文行（head 纯 ASCII 判 utf-8） | ① 打开；② 滚动使脏块喂入；③ 等降级收口；④ 读末行内容与状态栏「编码」；⑤ 对照计量 | 流内嗅探判非 UTF-8 → 停喂 + 全量补拉（计量出现 1 条无 Range 全量记录）+ redetectWithFull 重判重渲（5c92269）：中文行解码正确、无 U+FFFD 扩散上屏、状态栏编码非 utf-8、无错误卡片 | BUG-104 |
| DEG-07 | 假服务器 3MB jsonl 已打开至首屏稳定；改写 files 表该文件中部行内容后 notifyChanged([path]) | ① 注入 changed 帧；② 等重渲染；③ settled 读计量增量；④ 读更新行内容 | SSE rev++ 免全量重读（IO-03 的 jsonl 版）：增量仅探针+受影响窗口块（无全量 200）；更新后行内容可见 | —（IO-03 同构缺口锚） |
| DEG-08 | 同 DEG-07，载体换 10MB js code（改中部一行文本） | 同 DEG-07 三步 | code 版免全量重读同判据；更新行渲染正确 | —（IO-03 同构缺口锚） |
| DEG-09 | TopBar URL 打开 `https://fake.asset.test/blob.bin`（200 全量 1MB 二进制，含 0xde 0xad 布点），page.route 拦截 | ① 打开；② 读 hex 状态行与计量；③ 搜索布点字节 | hex size 未知全量回退（io spec §5「size null → hex 全量回退」）：恰 1 全量请求、hex 视图渲染、状态行「未知二进制」、布点字节搜索命中 | —（spec §5 hex 行锚） |

## 3. 关联缺陷的验收行为

### BUG-103 Range-less 服务器回包处理回归（内容错位/重复全量）（回归防护缺口）

**缺陷现状**：远端 store 恒宣告 rangeCapable（remote.ts:366），Range-less 服务器回 200 全量时「长度/边界校验由调用方自担」（remote.ts:350-352）。BlockStream fetchBlock 的超长 200 分支（终审 F3：抛弃流式缓冲重取全量，blockStream.ts:171-189「subarray 钳制会把文件头错位当本块，宁切全量不错位上屏」）与探针即全量的预置分支均只有单测；e2e 既有断言把 200 一律当回归（b-io-streaming.spec.ts:213-214），无正向降级用例。

**修复后应有行为（回归验收）**：
1. 探针即 200 全量：恰 1 请求、内容正确、后续滚动/搜索零新增请求（DEG-02）。
2. 探针 206 + 块读 200 超长：全量重取后零增量请求、末行内容零错位（DEG-03）。
3. 回归不破坏：Range 服务器下窗口流式逐请求 Range 计量（IO-01~07 护栏）不回退。

### BUG-104 流内非 UTF-8 误判不上报降级（U+FFFD 上屏/编码误标）（回归防护缺口）

**缺陷现状**：5c92269 修复前，head 8KB 误判 utf-8 而流内后续块为非 UTF-8 时，无嗅探无降级通道，U+FFFD 直接上屏且编码误标；修复后每块一次性嗅探（UTF8_SNIFF_ILLEGAL_MIN，blockStream.ts:385/465），超阈停喂走 memoizedFullRead + redetectWithFull 全量重渲（code.ts:1642-1646/2250-2278，jsonl 同款）。仅单测。

**修复后应有行为（回归验收）**：
1. head 纯 ASCII + 中段 GBK 构造：滚动触达脏块后自动降级，中文内容解码正确、无 U+FFFD 扩散、状态栏编码为全量精判值（DEG-06；jsonl 侧 meta 转投见 JVL-03）。
2. 降级为一次性：计量中全量补拉恰 1 条，后续滚动零新增。
3. 回归不破坏：纯 UTF-8 文件零嗅探误报（无多余全量补拉）。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件；spec：`apps/web/e2e/b-io-degrade-matrix.spec.ts`；共享 helper `apps/web/e2e/b-stream-resilience-helpers.ts`（rangeless 模式为本域新增能力：`all` / `after-probe` 两档）。
- DEG-01/09 的 URL 打开入口：TopBar URL 表单（TopBar.svelte:215-219 openUrl → createUrlStore，size 显式 null）；page.route 拦截外部域并显式带 `access-control-allow-origin: *`（跨源 fetch CORS 检查，b-grammar-layers.spec.ts 先例）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| url-big.jsonl | 2MB 合法行（route 拦截应答） | DEG-01 |
| rl-all-10mb.jsonl / rl-ap-10mb.js | 10MB 行式文件（rangeless 两模式各一） | DEG-02/03 |
| nosize-2mb.jsonl | 2MB、条目省略 size | DEG-04 |
| boundary-900kb.jsonl / boundary-2mb.jsonl | FULL_LIMIT 边界两件 | DEG-05 |
| sniff-gbk.js | 2MB；前 1MB ASCII 行 + GBK 中文块 + 尾部 GBK 行 | DEG-06 |
| sse-3mb.jsonl / sse-10mb.js | SSE 注入载体 | DEG-07/08 |
| url-blob.bin | 1MB 二进制含 0xde 0xad 布点 | DEG-09 |

### 4.3 边界与注意事项

1. DEG-02 的「恰 1 请求」断言依赖窗口渲染全程不触发任何 ensureBlock（head 预置全部块）；若实现改为截断 head 到 8KB 该断言即红——属预期告警面（实现语义变化需同步更新本域口径）。
2. DEG-03 逐请求核对三请求形状（206 8KB / 200 超长 / 200 全量重取），不允许出现第 4 条。
3. SSE 注入前必须 `stats.settled()` 收敛首屏计量，增量窗口才干净（IO-03 同口径）。
4. GBK 夹具同 jsonl-degrade-chain.md §4.3。
5. 全程负向护栏仅对 rangeCapable 形态生效；DEG-01/02/03 的全量 200 是被测形态，不适用「不得出现全量 200」护栏。
