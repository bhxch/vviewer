# jsonl 窗口降级链与回看 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）high 缺口②。jsonl 渲染器（spec `docs/superpowers/specs/2026-10-11-jsonl-viewer-design.md` §2.2/§5）与 jsonl 窗口流式（`docs/superpowers/specs/2026-10-12-io-streaming-design.md` §4.2）的失败与降级面只有 happy-path 锚（OPEN-04/05/07、IO-05）。本文档补设：过大行、512MB 流式上限（jsonl 侧）、降级后 meta 转投、回看缓存命中零请求、首屏并行预取、状态条渐进口径、回看重拉停机闩、DOM 有界代理锚。
>
> 口径裁决：jsonl spec §5 验收表的「>200MB 降级纯文本有提示」已被 io-streaming spec §4.3/§8.2 换代——`PLAIN_MAX_BYTES 200MB` 退役，统一为 `STREAM_MAX_BYTES = 512MB`（blockStream.ts:36）零读/停机 + 状态条「已达流式上限，建议以 hex 打开」（jsonl/index.ts:127）。本域按新口径锚定，不按旧 200MB 文案布点。本域缺陷编号 BUG-105 为回归防护缺口编号（9a0aa54 修复已落地）。

## 1. 目的与来源

jsonl 窗口模式（`packages/render-text/src/jsonl/`，块 256KB、块表 LRU 16 块、文本缓存 8 块）的以下行为无 e2e：

- 过大行（≥1MB 单行，parse.ts:7 `JSONL_OVERSIZE_LINE_BYTES`）窗口模式跨块分支——OPEN-05 只测非法行；
- STREAM_MAX_BYTES 的 jsonl 侧零读停机与状态条提示（IO-11 是 code 载体 `.vv-code-oversize-card`）；
- 嗅探降级后 metaSize/行数转投全量实例（9a0aa54：size 未知文件不再停在判脏前缀字节数）；
- 回看缓存命中零新请求（jsonl spec §5「缓存命中可观测」）；
- prefetchThrough 首屏两块并行预取（29c3405）；
- 「已加载 N 行 → 共 N 行」渐进（IO-05 只锚 EOF 终值）；
- 回看重拉失败停机闩（af6a705）；
- 结构级内存有界（io spec §6）的 DOM 代理面。

既有锚点（不重复布点）：IO-05（5MB 首屏 <1MB + 滚动 EOF「共 N 行」+ EOF 零 IO + 末行坏行徽标）、OPEN-04/05/06/07（装配/坏行/override/性能）、IO-03（SSE 免全量重读，jsonl 版归 DEG 域 DEG-07）。

## 2. 场景清单

公共环境同 code-scan-resilience.md 第 2 节（default 套件 + 假服务器 + IoStats 计量）；jsonl 块 256KB、块表 LRU 16 块（4MB）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| JVL-01 | 假服务器 3MB jsonl：第 2 行为 ≥1MB 单行（跨块 0/1），其余为合法行；已打开进窗口模式 | ① 等首屏卡片渲染；② 滚动使第 2 行卡片入视口；③ 检查该行卡片徽标与预览文本；④ 对照其余行卡片正常 | 过大行卡片带「行过大（>1MB）」徽标（window.ts:377），预览为原始文本前 64KB 截断，不 JSON.parse 不撑爆 DOM；跨块行以索引期边界为准不重不丢；其余行卡片正常（合法行 pretty、无错误徽标） | —（jsonl spec §2.2 巨行防护锚） |
| JVL-02 | 假服务器条目 `{ bytes: 100KB 实体, treeSize: 600MB }`（size 客户端唯一事实来源） | ① 打开该 jsonl；② 读 `.vv-jsonl-status`；③ settled 后对照计量 | 零块读停机（除探针外 0 请求，与 IO-11 code 侧同构）；状态条出现「已达流式上限，建议以 hex 打开」（STREAM_LIMIT_NOTICE，jsonl/index.ts:127）；非错误卡片形态（不出现 .vv-error-card） | —（io spec §4.3 防线换代 jsonl 侧锚） |
| JVL-03 | 假服务器条目不带 size；内容 = 前 200KB ASCII 行 + GBK 编码中文块（非法 UTF-8 ≥ 阈值）+ 尾部 GBK 中文行 | ① 打开（head 8KB 纯 ASCII 判 utf-8，窗口流式）；② 滚动使脏块喂入触发嗅探降级；③ 等全量重渲收口；④ 读状态栏「大小」「编码」与状态条行数 | 降级后 meta 转投全量实例（9a0aa54）：状态栏「大小」= 实体精确字节数（非判脏前缀 262144 类值）、「编码」非 utf-8；状态条行数为全量「共 N 行」口径；中文行解码正确无乱码 | BUG-105 |
| JVL-04 | 假服务器 3MB jsonl（12 块 ≤ LRU 16 块，全程驻留） | ① 打开并滚动到底（EOF「共 N 行」）；② settled 后记录计量数；③ 一步滚回顶部；④ settled 对照增量 | 回看零新增 /api/file 请求（块缓存命中可观测，jsonl spec §5）；顶部行内容与构造一致 | —（spec §5 缓存锚） |
| JVL-05 | 假服务器 3MB jsonl + stall 门（minStart=0：块 0/1 应答均挂起） | ① 打开；② 等 500ms 后读计量记录（未放行）；③ releaseStall；④ 等首屏渲染 | 首屏两块并行预取（29c3405 prefetchThrough）：放行前计量已含块 0 与块 1 两条 Range 记录（串行则块 1 请求不可见——blockStream.ts 注释明示夹持断言面）；放行后状态条「已加载 N 行」渐进口径出现 | —（29c3405 行为锚） |
| JVL-06 | 假服务器 5MB jsonl（20 块） | ① 打开读状态条（「已加载 N 行」，N=首两块行数）；② 分三次滚动续读，每次后读状态条；③ 滚到底等 EOF | 「已加载 N 行」随续读单调增长；EOF 确认后翻转「共 N 行」且此后固定（IO-05 只锚终值，本锚补渐进过程）；无全量 200 | —（io spec §4.2 归还口径锚） |
| JVL-07 | 假服务器 6MB jsonl（24 块 > LRU），fail 门放行前块 0 重拉 500 一次 | ① 打开滚到底（块 0 逐出）；② 滚回顶部（回看重拉首拒）；③ 观察 2s 计量增量；④ 滚离再滚回重试 | 回看重拉失败停机不风暴（af6a705：增量有界、已加载内容保留、无崩溃）；重试成功后顶部行内容回填正确 | —（af6a705 回归锚） |
| JVL-08 | 假服务器 5MB jsonl（约 5000+ 行）；打开滚到底 | ① 全程统计视口内 `.vv-jsonl-card` 数量峰值；② 与总行数对照 | 视口外卡片回收（可变高度窗口）：DOM 卡片峰值数远小于总行数（结构性有界的 DOM 代理断言，量级 < 总行数 10%）；滚动无白屏无错位 | —（io spec §6 内存有界的可观测代理面） |

## 3. 关联缺陷的验收行为

### BUG-105 jsonl 降级后状态栏 size/行数停留判脏前缀（回归防护缺口）

**缺陷现状**：9a0aa54 修复前，size 未知文件流内嗅探判非 UTF-8 降级全量重渲后，`metaSize` 仍指窗口底座已确认字节（判脏前缀），状态栏「大小」与行数停在降级时点；修复后转投全量实例（jsonl/index.ts:825-834：「降级底座 length 即全量字节数」「降级后行数转投全量实例」）。仅单测（949a0fa 为其测试基建修正）。

**修复后应有行为（回归验收）**：
1. size 未知 + 头部误判 utf-8 + 中段非法块的构造下，嗅探降级完成后状态栏「大小」等于实体精确字节数，「编码」为全量精判值（非 utf-8）。
2. 状态条行数为全量「共 N 行」口径（行数转投），与构造行数一致。
3. 回归不破坏：降级前的干净前缀保持可读；无错误卡片（嗅探降级是降级重渲非失败态）。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件；spec：`apps/web/e2e/b-jsonl-degrade-chain.spec.ts`；共享 helper `apps/web/e2e/b-stream-resilience-helpers.ts`（见 code-scan-resilience.md §4.1：stall/fail 门、size 省略、IoStats、openRemoteJsonl）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| oversize.jsonl | 3MB；第 2 行 ≥1MB 单行（`{"big":"` + 填充 + `"}`），跨块 0/1 | JVL-01 |
| huge-declared.jsonl | 100KB 实体 + treeSize 600MB | JVL-02 |
| degrade-nosize.jsonl | 300KB；前 200KB ASCII 行 + GBK 中文块（Node Buffer 以 iconv/gbk 序列化构造，落盘字节经 od 抽验非 UTF-8）+ 尾部 GBK 中文行；条目省略 size | JVL-03 |
| resident-3mb.jsonl | 3MB 合法行（12 块 ≤16 块 LRU） | JVL-04/05 |
|渐进-5mb.jsonl | 5MB 约 5000+ 行 | JVL-06/08 |
| backtrack-6mb.jsonl | 6MB（24 块） | JVL-07 |

### 4.3 边界与注意事项

1. GBK 夹具构造：Node 侧无内建 gbk 编码器，用预生成字节序列（常用汉字 GBK 双字节表）内嵌 helper；断言期望文本与字节序列一一对应。
2. JVL-05 夹持断言依赖 prefetchThrough「首个 await 前同步调用 ctx.read」（blockStream.ts 注释），stall 门 minStart=0 保证两请求在放行前均可见；若实现回退串行该断言即红（预期告警）。
3. JVL-08 为结构性有界的代理断言（DOM 面），非精确内存计量；阈值取量级（<10%）而非精确值，避免实现微调误红。
4. 过大行阈值取等号即超限（parse.ts:53 `>=`），夹具行取 1MB+1KB 留裕量。
