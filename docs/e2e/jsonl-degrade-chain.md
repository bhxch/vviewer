# jsonl 窗口降级链与回看 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）high 缺口②。jsonl 渲染器（spec `docs/superpowers/specs/2026-10-11-jsonl-viewer-design.md` §2.2/§5）与 jsonl 窗口流式（`docs/superpowers/specs/2026-10-12-io-streaming-design.md` §4.2）的失败与降级面只有 happy-path 锚（OPEN-04/05/07、IO-05）。本文档补设：过大行、512MB 流式上限（jsonl 侧）、降级后 meta 转投、回看缓存命中零请求、首屏并行预取、状态条渐进口径、回看重拉停机闩、DOM 有界代理锚。
>
> 口径裁决：jsonl spec §5 验收表的「>200MB 降级纯文本有提示」已被 io-streaming spec §4.3/§8.2 换代——`PLAIN_MAX_BYTES 200MB` 退役，统一为 `STREAM_MAX_BYTES = 512MB`（blockStream.ts:36）零读/停机 + 状态条「已达流式上限，建议以 hex 打开」（jsonl/index.ts:127，`STREAM_LIMIT_NOTICE`）。本域按新口径锚定，不按旧 200MB 文案布点。本域缺陷编号 BUG-105 为回归防护缺口编号（9a0aa54 修复已落地）。

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

公共环境同 code-scan-resilience.md 第 2 节（default 套件 + spec 内 node:http 假服务器 + `/api/file` 计量）；jsonl 块 256KB、块表 LRU 16 块（4MB）、均匀行 256B（每块恰 1024 行，首两块 2048 行）。状态条口径：`.vv-jsonl-status`（jsonl/index.ts:819，EOF 前「已加载 N 行」、EOF 后「共 N 行」）；状态栏元数据段 `.vv-statusbar`（ViewerPane readInstanceMeta：「语言: json · 编码: … · 大小: <原始字节数> · 行: …」，250ms 周期重读）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| JVL-01 | 假服务器 oversize-line.jsonl（≈3.0MB、13 块）：行 1（0 基，即第 2 行）为 1MB+1KB 单行 `{"big":"xxx…"}`（跨块边界 262144/524288/786432/1048576 共 4 处），其余为合法均匀行 | ① 打开进窗口模式；② 续读泵到 EOF（过大行终结符在块 4，喂块后才入索引）；③ 回顶使该行卡片入视口；④ 检查卡片徽标/预览/展开钮；⑤ 对照邻位行卡片 | 过大行卡片带「行过大（>1MB）」徽标（jsonl/index.ts:377），预览为原始文本前 64K 字符（`JSONL_OVERSIZE_PREVIEW_BYTES`，字节域跨块拼装后单次解码截断），不 JSON.parse（无「展开全部」钮）、无 U+FFFD；邻位合法行照常 pretty（含 `"id": 0`）；全程无错误卡 | —（jsonl spec §2.2 巨行防护锚） |
| JVL-02 | 假服务器条目 `{ bytes: 100KB 实体, treeSize: 600MB }`（size 是客户端唯一事实来源，600MB > 512MB 构造即知超限；513MB 实体无法测试内存构造，观测面与真实超限逐字节等价，IO-11 同构造） | ① 打开该 jsonl；② 读 `.vv-jsonl-status`；③ settled 后对照计量 | 零块读停机：/api/file 仅探针 1 请求（`bytes=0-8191`，与 IO-11 code 侧同构）；状态条出现「已加载 0 行 · 已达流式上限，建议以 hex 打开」（`STREAM_LIMIT_NOTICE`，jsonl/index.ts:127/784-787）；非失败态（无 .vv-error-card）；状态栏「大小: 629145600」（ctx.size 原样透传） | —（io spec §4.3 防线换代 jsonl 侧锚） |
| JVL-03 | 假服务器条目**省略 size**；gbk-nosize.jsonl = 前 512KB 纯 ASCII 均匀行（恰块 0/1，首屏嗅探不触发）+ 自 524288 起全 GBK 中文行至 ≈900KB（脏块 = 块 2 起，滚动续读才喂入） | ① 打开（head 8KB 纯 ASCII 判 utf-8，窗口流式，「已加载 2048 行」）；② 滚到底使脏块喂入触发流内嗅探降级；③ 等全量重渲收口；④ 读状态栏「编码」「大小」与状态条行数；⑤ 滚到底检查中文行 | 降级后 meta 转投全量实例（jsonl/index.ts:828/831）：状态栏「编码: gb18030」（全量精判，非 head 误判值）、「大小: <实体精确字节数>」（非判脏前缀 786432 类值——旧缺陷可观测差值面）；状态条翻转全量「共 N 行」口径（N = 2048 + GBK 行数，构造可算）；GBK 中文行解码正确无乱码无 U+FFFD；无错误卡（嗅探降级是降级重渲非失败态）；降级前干净前缀保持可读 | BUG-105 |
| JVL-04 | 假服务器 resident-3mb.jsonl（3MB 均匀行 = 12 块 ≤ 块表 LRU 16，滚到底全程驻留） | ① 打开（「已加载 2048 行」）；② 续读泵到底（EOF「共 12288 行」）；③ settled 后记录计量数；④ 一步滚回顶部；⑤ settled 对照增量与顶部卡片 | 回看零新增 /api/file 请求（块缓存命中可观测，jsonl spec §5「滚动续读无重复解析（缓存命中可观测）」）；顶部行内容与构造一致（`"id": 0` 真实卡片非占位） | —（spec §5 缓存锚） |
| JVL-05 | 同 resident-3mb.jsonl + stall 门（**按请求 end 谓词**：end ≥ 262143 的 Range 应答挂起至 releaseStall——探针与块 0 的 start 同为 0，start 门无法区分；探针 end 8191 放行） | ① 打开（树行点开，探针应答落地即 `bytes=0-8191`）；② 放行前读 request 级计量（`page.on('request')`——挂起应答无 response 事件，response 计量观测不到在途请求）；③ releaseStall；④ 等首屏渲染 | 首屏两块并行预取（29c3405 `prefetchThrough(1)`，blockStream.ts:321「fetchBlock 首个 await 前同步调用 ctx.read，夹持断言可在任一放行前观测到全部请求已发出」）：放行前块 0（`bytes=0-262143`）与块 1（`bytes=262144-524287`）两条请求均已发出——串行实现块 1 请求须等块 0 应答（永不到达）必红；挂起期不渲染（无 .vv-jsonl）；放行后状态条落「已加载 2048 行」渐进口径 | —（29c3405 行为锚） |
| JVL-06 | 假服务器 progressive-5mb.jsonl（5MB 均匀行 = 20480 行 20 块，全合法） | ① 打开读状态条（「已加载 2048 行」）；② 贴底泵续读，每 50ms 采样状态条文本入数组；③ EOF 后再滚动数次对照 | 「已加载 N 行」随续读渐进：采样序列出现 ≥3 个不同「已加载」值且单调不减（一次一块 = 每步 +1024 行）；EOF 确认后翻转「共 20480 行」且此后滚动固定不变（IO-05 只锚终值，本锚补渐进过程与终值锁定）；全程无全量 200 | —（io spec §4.2 归还口径锚） |
| JVL-07 | 假服务器 backtrack-6mb.jsonl（6MB = 24576 行 24 块 > LRU 16）+ fail 门（`bytes=0-262143` 的**第 2 次**请求回 500；第 1 次是首屏合法拉取） | ① 打开滚到底（块 0 已被 LRU 逐出）；② 滚回顶部触发回看重拉（首拒 500）；③ 观察 2s 计量增量；④ 滚离再滚回（用户动作解除停机）对照增量与内容 | 回看重拉失败停机不风暴（af6a705 闩，jsonl/index.ts:704-713/746-750）：失败后 2s 内零自动重试（增量有界=0）、失败请求恰 1 条、无错误卡（自兜底非失败态）、占位卡维持（`[data-line="0"]` 无内容回填）；用户滚动动作后单次重试恰 1 个新块请求（206）且顶部行内容回填正确（`"id": 0`） | —（af6a705 回归锚） |
| JVL-08 | 同 progressive-5mb.jsonl（约 2 万行）；打开后全程贴底泵 | ① 泵续读全程每步采样 `.vv-jsonl-card` 数量取峰值；② EOF 后对照总行数与末行卡片 | 视口外卡片回收（可变高度窗口，jsonl spec §2.3「回收视口外卡片 DOM」）：DOM 卡片峰值远小于总行数（结构性有界的 DOM 代理断言，峰值 < 总行数 10% = 2048，实测为视口高度量级）；EOF 后末行 `[data-line="20479"]` 真实渲染（滚动无白屏无错位的终态证据）；无错误卡 | —（io spec §6 内存有界的可观测代理面） |

## 3. 关联缺陷的验收行为

### BUG-105 jsonl 降级后状态栏 size/行数停留判脏前缀（回归防护缺口）

**缺陷现状**：9a0aa54 修复前，size 未知文件流内嗅探判非 UTF-8 降级全量重渲后，`metaSize` 仍指窗口底座已确认字节（判脏前缀），状态栏「大小」与行数停在降级时点；修复后转投全量实例（jsonl/index.ts:828「降级底座 length 即全量字节数」、jsonl/index.ts:831「降级后行数转投全量实例」）。仅单测（949a0fa 为其测试基建修正）。

**修复后应有行为（回归验收，JVL-03）**：
1. size 未知 + 头部误判 utf-8 + 脏块须滚动续读才触达的构造（脏块 ≥ 块 2，判脏前缀 786432 ≠ 实体精确字节数——差值使旧缺陷可观测）下，嗅探降级完成后状态栏「大小」等于实体精确字节数，「编码」为全量精判值（非 utf-8）。
2. 状态条行数为全量「共 N 行」口径（行数转投），N 与构造行数一致。
3. 回归不破坏：降级前的干净前缀保持可读（「已加载 2048 行」窗口口径先成立）；无错误卡片（嗅探降级是降级重渲非失败态）；GBK 中文内容经 gb18030 解码无乱码。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件（chromium + mobile 双 project）；spec：`apps/web/e2e/b-jsonl-degrade-chain.spec.ts`。
- **spec 自包含**（先例 b-io-streaming.spec.ts：spec 内 node:http 假服务器 + IoStats 计量 + 内联生成文件）：startJvlFakeServer（Range 206 精确切片 + end 谓词 stall 门 + Range 第 n 次请求 fail 门 + 条目可省略 size + SSE notifyChanged）、IoStats（response 计量：Range 头/字节数/状态码 + request 级在途记录）、waitAppMounted/connectForm/openRemoteJsonl（b-io-streaming 同名装置复制适配）、drawer.ts 复用。
- code-scan-resilience.md §4.1 规划的三域共享 helper（`apps/web/e2e/b-stream-resilience-helpers.ts`）截至本文档更新尚未落地，JVL 域不依赖（避免并行轮次同文件写入竞争）；后续整并时可将本 spec 的 startJvlFakeServer/IoStats 迁入共享 helper。

### 4.2 夹具构造（全部 spec 内联生成，均匀行 = `{"id":i,"pad":"a…"}` 恰 256B 含 `\n`，每块恰 1024 行）

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| oversize-line.jsonl | 行 0 合法行 + 行 1 = `{"big":"` + 填充 + `"}` 恰 1MB+1KB（≥ `JSONL_OVERSIZE_LINE_BYTES` 取等即超限，parse.ts:53）+ 合法行补至 ≈3MB（13 块）；过大行跨 4 处块边界 | JVL-01 |
| huge-declared.jsonl | 100KB 均匀行实体 + treeSize 600MB（tree 汇报与实体解耦） | JVL-02 |
| gbk-nosize.jsonl | 2048 行均匀行（恰 512KB = 块 0/1）+ GBK 中文行（`{"zh":"中文","n":M}`，中=D6 D0 文=CE C4，GBK 字节表经 python3 gbk codec 验证回转一致且非法 UTF-8）补至 ≈900KB；条目省略 size | JVL-03 |
| resident-3mb.jsonl | 3MB 均匀行 = 12288 行 12 块 ≤ LRU 16 | JVL-04/05 |
| progressive-5mb.jsonl | 5MB 均匀行 = 20480 行 20 块 | JVL-06/08 |
| backtrack-6mb.jsonl | 6MB 均匀行 = 24576 行 24 块 > LRU 16 | JVL-07 |

### 4.3 边界与注意事项

1. GBK 夹具构造：Node 侧无内建 gbk 编码器，用预生成字节序列（中文 = D6 D0 CE C4，python3 `bytes.decode('gbk')` 回转验证）内嵌 spec；期望解码文本与字节序列一一对应，浏览器侧 `TextDecoder('gb18030')` 为 encoding 标准强制项。
2. JVL-05 夹持断言观测面是 `page.on('request')` 而非 response 计量——stall 门下挂起应答不产生 response 事件；stall 谓词用请求 end（≥262143）而非 start（探针与块 0 start 同为 0，start 门会把探针一并挂起、dispatch 永不返回）。若实现回退串行预取，块 1 请求在放行前不可见，断言即红（预期告警）。
3. JVL-07 fail 门取「块 0 Range 第 2 次请求 500」：第 1 次是首屏 prefetchThrough 的合法拉取；块 0 在贴底泵中被 LRU 逐出（第 17 块入表时逐出最旧），滚回顶部的回看重拉即第 2 次。
4. JVL-08 为结构性有界的代理断言（DOM 面），非精确内存计量；阈值取量级（峰值 < 总行数 10%）而非精确值，避免实现微调误红。
5. 过大行阈值取等号即超限（parse.ts:53 `>=`），夹具行取 1MB+1KB 留裕量；预览断言为 64K **字符**（`rawLine` oversized 分支：4×64KB 字节前缀解码后截 64K 字符，jsonl/index.ts:683-687），夹具为纯 ASCII 故字符数=字节数。
6. 512MB 上限不构造真实 513MB 实体：size 是客户端唯一事实来源，`{bytes, treeSize}` 解耦构造与真实超限文件在客户端观测面等价（IO-11 同裁决，io-degrade-matrix.md 头注）。
