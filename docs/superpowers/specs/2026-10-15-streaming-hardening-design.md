# 流式硬化设计（signal 贯穿 + SUSP 四条优化 + worker init 挂起探针）

- 日期：2026-10-15
- 状态：待用户审阅 → writing-plans
- 来源：2026-10-14 CI 转绿轮（4c6f5b9..abf52d0）遗留产品立项 + e2e 富化报告 SUSP 定档（docs/report/e2e/e2e-enrichment-report-2026-10-13.md §4.2，四条 confirmed-design 带优化立项候选）
- 用户裁决：缺陷/健壮性 7 项合为一个 spec；阶段顺序缺陷面优先；localFiles 取降级语义（remote 真取消）

## 1. 背景与动机

2026-10-14 CI 转绿轮定位了流式索引三个独立根因并修复两处（同块双喂、视口钳位）。第三处（DEG-08：stall 挂起读不随 destroy 取消，占住同 host 连接致新实例块 0 排队 ~20s）的产品侧修复——在飞读的 AbortSignal 贯穿——因涉跨包契约变更未纳入当轮，trace 取证（run 38588619265 artifact）给出了完整机制与验收路径（DEG-08 断言窗口 60s→30s 回收条件已写在用例注释）。同期 e2e 富化报告定档的 4 条 SUSP 优化候选（confirmed-design）与 worker init 挂起（Parser.init 环境级未知项）的 CI 形态证据（15s 看门狗超时 console）构成其余阶段。

本 spec 将六项工作 + 1 项测试装置配套合为六阶段（A–F，装置配套⑦并入阶段 A），各阶段独立验收、独立提交，任一阶段可中断不阻塞其余。

## 2. 范围与非目标

**范围**：上表 A–F 六阶段（含⑦测试装置配套于阶段 A）。

**非目标**（明确排除，防范围蔓延）：
- hex 渲染器的在飞读取消：hexSource 不走 BlockStream（自持窗口缓存），读模式为按需 64KB 窗口、无扫描式长挂面，后续按需另做。
- worker init 挂起的**修复**本身：阶段 F 只做可观测性探针定位挂点，修复方向按探针结论另行立项。
- SUSP-04 的 io spec §2.3 文字债：域文档路线已执行，不在本 spec。
- 全量实例（非流式）渲染路径的读取消：全量读是单次 await、无扫描式长挂面。

## 3. 阶段 A：signal 贯穿 + 测试装置配套

### 3.1 缺陷机制（取证结论）

SSE rev++ 重渲染摘旧实例时，旧实例在飞的块读（stall 门/慢网挂起）无取消通道：`request()` 仅有 `AbortSignal.timeout(30_000)` 兜底，`localFiles` 的 `blob.arrayBuffer()` 无取消面。在飞读占住同 host 连接直至 30s 超时，新实例的块 0 fetch 被浏览器 socket 池排队（trace 铁证：重渲染块 0 应答完成 44.984Z+9.675s 与旧块 1 abort 24.655Z+30s 同瞬间 54.66/54.67Z 解锁）。

### 3.2 契约变更（全部可选参数，向后兼容）

- `TreeStore.read(path, opts?)` 的 opts 增 `signal?: AbortSignal`（types.ts）；
- `StreamCtx.read(range, signal?)` 增第二可选参（types.ts）；
- dispatcher 的 `DispatchRead` 类型同步增可选 signal 形参。

不传 signal = 现状行为，既有实现与调用方零改动。

### 3.3 取消链实现

| 层 | 实现 |
| --- | --- |
| remote store | `request()` 以 `AbortSignal.any([timeoutSignal, externalSignal])` 合并 30s 超时与外部 signal，fetch 命中任一即断 |
| url store（singleFile.ts） | 同形合并 |
| localFiles store | 降级语义（用户裁决）：调用时 `signal.aborted` 即 reject；晚 abort 则读完丢弃（调用方已销毁不消费结果）。底层 `File.slice().arrayBuffer()` 不改 |
| dispatcher | `renderCtx.read` 透传 signal；`DispatchReadError` 标记不变 |
| BlockStream | options 增 `signal?: AbortSignal`（**构造期传入一次**，`block(i)/has()/ensureBlock()` 公共契约不变，jsonl/hex 零感知）；`fetchBlock`/`prefetchThrough` 的 `ctx.read` 调用透传 |
| 渲染器实例 | `renderCodeWindowed` 与 jsonl 窗口各自持有 `AbortController`，`ctx` 构造期传入 `controller.signal`，`destroy()` 调 `controller.abort()` |

### 3.4 abort 错误语义

abort 产生的 reject 走既有 catch 分支（`continueFailed`/`reloadFailed` 停机闩）——实例已 destroyed，闩无后续面，无活锁。实现须在 `pullBlock`/`maybeContinue`/`runScan` 的 catch 中识别 abort（`signal.throwIfAborted()` 抛出的 `AbortError`/`TimeoutError` 之外的 abort 名，或 controller 关联判断），**不得标为 `DispatchReadError` 上屏**（destroy 竞态下错误卡片/读取失败面不应触发）。jsonl 同口径。

### 3.5 测试装置配套（⑦）

`startStreamFakeServer`（b-stream-resilience-helpers.ts）的 `serve` 与 rangeless 两分支的 `res.writeHead/res.end` 包 try/catch：客户端已 abort（连接断开）时写入抛出的 `ERR_STREAM_WRITE_AFTER_END` 静默吞掉。阶段 A 落地后 abort 常态化，此为配套卫生。

### 3.6 验收

1. RED 单测（render-text）：可编程挂起 read + `destroy()` → 断言 signal 在 destroy 后一拍内 aborted（而非等读自然结束/超时）；abort 后 `ensureBlock` reject 且不标 `DispatchReadError`。
2. **DEG-08 断言窗口 60s→30s 回收**（b-io-degrade-matrix.spec.ts:517，回收条件见用例注释）——专项验收，CI 实测。
3. 定向回归：SCAN/IO/DEG/JVL 四域 + SUSP 域全绿；全量门禁见 §9。

## 4. 阶段 B：SUSP-01 退出搜索缓存保留

**现状**（code.ts search()，报告 SUSP-01 行 126）：清空输入框/Esc 的 `search('')` 走换键重置分支，短路缓存（`lastScanComplete/lastAcc/lastScanCursor/lastQuery/lastCaseSensitive`）一并作废；重输同词触发全新全文扫描（块级请求 ≥20，增量含末块）。

**设计**：`query === ''` 分支仅做①令牌失效（`scanSeq++` 取消在飞扫描，既有）与②视觉清理（`clearHit` + `scroller.refresh(true)`，既有），**不再重置短路缓存与命中集**。同词重搜命中 `sameKey && lastScanComplete` 短路零读返回。

**陈旧性边界（无新风险）**：remote 文件变更走 SSE rev++ 重建渲染实例，缓存随实例消亡天然失效；本地文件外部变更无 watch 为既有边界，与本阶段无关；退出时在飞扫描被取消 → `lastScanComplete=false` → 重搜走既有断点续扫。

**改动点**：code.ts `search()` 的空 query 分支（换键重置逻辑仅保留给真换键路径）。

**验收**：SUSP-01 探针翻转——b-susp-verify.spec.ts 改断言「退出搜索后重输同词，块级请求 ≤ 对照面同键重搜」（现断言 ≥20）。

## 5. 阶段 C：SUSP-03 jsonl 降级视口锚定

**现状**（jsonl/index.ts 降级装配处，报告 SUSP-03 行 127）：流内嗅探判非 UTF-8 → 降级全量重渲（`onEncodingBroken` → `fullInst`）→ `.vv-jsonl-scroll` scrollTop=0，视口回顶、阅读位置丢失。

**设计**：降级换实例前记录当前窗口流式的**可视首行行号**（窗口实例的行索引，非 scrollTop 换算——窗口与全量两侧行高模型不同：窗口为固定行高、全量为卡片可变高度）；全量实例 mount 后以锚定行在全量实例中的实际 DOM 位置恢复滚动（按行号定位行元素后取其 offsetTop，越界钳到末行）。

**改动点**：jsonl/index.ts 降级出口（记录锚）+ 全量实例 mount 完成时点（恢复锚）。

**验收**：SUSP-03 探针翻转——降级后可视首行 ≈ 降级前首行（现断言 =0）。

## 6. 阶段 D：SUSP-02 扫描期视口块触新

**现状**（code.ts runScan/BlockStream LRU，报告 SUSP-02 行 127）：扫描逐块喂入，新块入块表（LRU 16×256KB）把视口所在块挤出 → 视口行占位化（`lineAvailable` false）→ `pendingReload` 回看重拉 → 可见闪烁；SCAN-08 场景同一次续扫内 ≥2 次。

**设计**：扫描每块落地后对**可视区所需块做 LRU 触新**——取当前 scroller 可视行范围（`first..last`）各行块 span（`lineBlockSpan`），对驻留块调 `bs.block(b)`（自带 touch 挪表尾）。视口 2–3 块触新后，扫描前沿新块（1–2 块/拍）不再将其挤出。

**否决的备选**：视口块「钉住」语义（BlockStream 加 pin 契约）——需公共契约扩展与逐出算法改造，触新已够，YAGNI。

**改动点**：code.ts runScan 喂块落地后（`remountOrRefresh` 附近），~10 行。

**验收**：SUSP-02 探针翻转——SCAN-08 场景同一次续扫内 pendingReload 回看重拉 <2 次（现断言 ≥2）。

## 7. 阶段 E：SUSP-06 doPrepare 顺序微优化

**现状**（core-parse.ts doPrepare，报告 SUSP-06 行 131）：先 `expandQueryAsync`（发 query 资产请求）后 `resolveGrammarEntry`（查 grammar 条目）——grammar 条目缺失（如同源 manifest 剥离 java 条目）时 query 请求已白发（/queries/java/** ≥1 空打），整语言降级 hljs。

**设计**：`resolveGrammarEntry` 前置——先查 grammar 条目，缺失直接走既有降级返回（零 query 请求）；存在才继续 `expandQueryAsync`。执行顺序语义不变（仍是「先条目后查询」的判定，仅物理前置）。

**改动点**：core-parse.ts doPrepare 数行。

**验收**：SUSP-06 探针翻转——同构造下 /queries/java/** 请求 =0；java 文件整语言降级 hljs 行为不变（对照断言保留）。

## 8. 阶段 F：worker init 挂起探针（spike）

**已知事实**：CI（DEG-08 页面，run 38588619265）与本机（真实网络+完整合并表）均复现 worker 静默挂起——看门狗 15s 超时而非 worker 主动报错（worker.ts 的 init 失败会 console.error+postError，均未出现）→ 挂点在 `TreeSitterEngine.create` 内部且未 reject。同 run 其它页面（m2/PERF-LAZY）tree-sitter 高亮正常，触发条件与页面/环境相关未定位。

**探针设计**：
- worker 内 init 阶段化打点：Parser.init 的 wasm URL（locateFile 解析结果）、wasm fetch 开始/完成（HTTP 状态+字节数）、queries 资产逐个完成、engine ready——经新消息类型 `{ kind: 'init-progress', stage, detail? }` postMessage 到主线程 `console.debug('[vviewer-worker]')`；
- 开关：页面 query `?vvWorkerDebug=1`（HighlightClient 构造参数透传），缺省零噪声；
- 采集路径：本机按已知条件复现挂起读打点；CI 侧经失败 artifact 的 console 自然采集。

**产出与边界**：挂点结论（wasm fetch 挂 / DNS 挂 / Parser.init 内部挂 / queries 串行挂）+ 修复方向建议文档（写入本 spec 回填节）。修复本身另行立项，不在本 spec；打点代码低噪声（开关门控）落地保留。

## 9. 总验收与门禁

- 每阶段：定向探针翻转或新锚 + 定向回归域全绿 + 原子提交（Angular 规范）。
- 收尾全量门禁：typecheck 0E / vitest 全量（仓库根）/ cargo 全量 / playwright 双通道（chromium+mobile）/ CI 流水线全绿。
- 阶段 A 专项：DEG-08 窗口回收（60s→30s）CI 实测通过。

## 10. 风险与裁决记录

| 裁决 | 内容 | 理由 |
| --- | --- | --- |
| localFiles 降级语义 | 不真取消，仅提前 reject/丢弃结果（用户裁决 2026-10-15） | 本地 File 读毫秒级，挂起面实测全在 remote/慢网；避免为它换 ReadableStream 拉高复杂度 |
| 取消走契约级贯穿 | store 级取消（close 时 abort 全部在飞读）被否决 | SSE 重渲染时 store 被新旧实例共享，store 粒度会误杀新实例的读 |
| SUSP-02 取触新非钉住 | 可视块 LRU 触新 | 钉住需 BlockStream 公共契约扩展；16 块容量下触新余量充足 |
| SUSP-01 只保缓存不清视觉 | `clearHit` 照旧 | 用户可见行为零变化，仅省 IO |
| 阶段 F spike 先行 | 修复按探针结论另行立项 | 挂点未定位前修复方向不可知；边界待定不进修复范围 |
| abort 错误不上屏 | 停机闩 catch + 非 DispatchReadError 判定 | destroy 竞态下不应产生错误卡片/读取失败面 |
