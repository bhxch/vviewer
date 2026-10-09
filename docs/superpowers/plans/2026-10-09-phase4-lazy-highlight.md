# 阶段 4：统一懒高亮（本地+服务端 range 协议）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** >2MB 代码文件改为可视区驱动的 tree-sitter 懒高亮：本地 worker 与服务端共用「子文本 parse + baseLine 偏移」chunk 协议；>20MB 不再纯文本（阈值放宽到参数化 200MB）；hljs 分块退役为 chunk 级回退。

**Architecture:** 协议（spec §5.1）：请求 `range {startLine, lineCount}`，响应 `baseLine` + 相对 chunk 首行的 UTF-16 区间。本地与服务端都按**子文本直接 parse**（不引入 includedRanges，理由见 spec）。渲染层：`resolveStrategy` 三态改为 `tree-sitter(≤2MB 整文件) / lazy(2MB–200MB) / plain(>200MB)`；lazy 路径由 `virtualScroller.onRange` 驱动，chunk = 可视区 ± overscan、重叠 2 行，chunkCache 按 chunk 粒度缓存与逐出（继承 BLOCK_CACHE_MAX_ROWS=5000 行上限语义），chunk 失败行级 hljs 兜底；in-flight 按 chunkKey 去重。服务端 path+range 模式流式扫行定位（内存有界，>20MB 文件可服务），LRU 键扩展 range 维度。

**Tech Stack:** Rust（axum handler + tokio BufReader 流式扫行）、TS（packages/highlight worker API、render-text 渲染模型）、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§5 阶段 4）

## Global Constraints

- ≤2MB 整文件一次算路径行为零变化（首屏预算）；≤20MB 的 markdown/html 富文本管线（MARKUP_MAX_BYTES）零变化。
- 显式 remote 失败语义零变化（错误卡片）；auto 失败回退语义零变化（现在回退到 lazy 的行级 hljs，不再有独立 hljs-block 策略）。
- chunk 重叠 2 行；渲染按行去重取首次结果；多行结构跨 chunk 截断为已知限制（与 hljs-block 现状同级，spec §5.1）。
- 服务端 range 模式：`lineCount` 防御上限 5000；LRU 键含 `(startLine, lineCount)`；text 模式无 range 语义、20MB 上限不变。
- 纯文本上限参数化：`PLAIN_MAX_BYTES` 默认 200MB（与 grep 预算对齐），导出常量便于实测回调。
- commit Angular 规范；每任务独立可验证。

---

### Task 1: 服务端 range 协议

**Files:**
- Modify: `server/src/compute/highlight.rs`（HighlightRequest 加 range 字段 :59-70；path 模式分流：无 range 走原整文件路径，有 range 走流式扫行；HighlightResponse 加 baseLine :53-57；LRU 键 :200 附近扩展；MAX_RANGE_LINES = 5000 常量）
- Modify: `server/tests/compute_highlight.rs`（range 集成用例）

**Interfaces:**
- Produces: `POST /api/compute/highlight` 请求体 `{path?, text?, lang?, range?: {startLine: number, lineCount: number}}`；响应 `{intervals, captures, baseLine}`——range 给定时 intervals 为**相对 chunk 首行**的 UTF-16 区间、baseLine=startLine；不传 range 时 baseLine=0、行为与现状逐字节一致。约束：仅 path 模式接受 range（text+range → 400 bad_request）；lineCount ≤ 5000（超限 400）；startLine 超出文件行数 → 400；lineCount 越界文件尾 → 截断到文件尾（200，实际行数可少于请求）。

- [ ] **Step 1: 写失败集成测试**（compute_highlight.rs 追加）

```rust
// 用例清单（fixture：多行文本文件写临时目录，经 /api/file 语义同款 guard 路径）：
// 1) range 首段：{startLine:0, lineCount:3} → 200，baseLine==0，intervals 非空
// 2) range 中段：{startLine:5, lineCount:3} → 200，baseLine==5；区间相对首行
//    （首行内容的 keyword 捕获区间起点 < 该行 UTF-16 长度）
// 3) lineCount 越界尾段：startLine=末2行, lineCount=10 → 200 截断，baseLine 正确
// 4) startLine 越界 → 400
// 5) lineCount=0 → 400；lineCount=5001 → 400
// 6) text + range → 400
// 7) CRLF 文件 range：区间与 LF 版本一致（归一在切片前/后一致性）
// 8) 多字节行（中文+emoji）：区间 UTF-16 偏移换算正确（相对 chunk）
// 9) 无 range 的旧请求 → baseLine==0 且与改造前响应一致（回归锚）
// 10) 同文件两个不同 range 的 LRU：第二次命中缓存（响应时间/或内部计数不可测则
//     以两次响应相等 + 键扩展的单元断言为准——CacheKey 结构私有，可加 #[cfg(test)]
//     可见性辅助或仅测行为等价）
```

- [ ] **Step 2: 跑测试确认失败**（编译错：range 字段不存在）

Run: `cargo test --test compute_highlight`
Expected: 编译 FAIL

- [ ] **Step 3: 实现**

实现要点（结构给全，细节按现有代码风格）：

```rust
#[derive(Deserialize, Copy, Clone)]
pub struct HighlightRange { pub start_line: u64, pub line_count: u64 }
// HighlightRequest 加 #[serde(default)] pub range: Option<HighlightRange>
// HighlightResponse 加 pub base_line: u64（serde rename baseLine——对齐前端驼峰，
// 注意现有字段 intervals/captures 无 rename，新字段按前端契约用 #[serde(rename="baseLine")]）

// 校验（handler 内、guard 之后）：range.line_count == 0 || > MAX_RANGE_LINES → 400；
// text 模式带 range → 400。

// path+range 模式：tokio::fs::File + BufReader 逐行扫（不需要整体读入内存）：
//   跳过 start_line 行后读 line_count 行拼 chunk 文本（\n join，含尾行判定）；
//   start_line 超过实际行数 → 400；不足 line_count → 截断（自然行为）。
//   CRLF 归一沿用既有 `replace`（对 chunk 文本做，与整文件路径同源语义——
//   Utf16Index 在归一后文本上换算，客户端按归一后行文本渲染，口径一致）。
// run_highlight(lang, &chunk) 复用；intervals 不做偏移平移（相对 chunk 首行
// 即为所求——Utf16Index 以 chunk 文本建表）；base_line = start_line。
// LRU 键：CacheKey 加 (start_line, line_count)（无 range 时 (0, u64::MAX) 占位，
// 与无 range 路径互不命中）。
// path+range 模式不设 HIGHLIGHT_MAX_BYTES 文件大小上限（流式有界）；缓存准入
// CACHE_MAX_INTERVALS 沿用。
```

- [ ] **Step 4: 跑测试通过 + 全量回归**

Run: `cargo test`（长 timeout）
Expected: 新用例全绿 + 既有 133 全绿（无 range 路径回归锚）

- [ ] **Step 5: Commit**

```bash
git add server/src/compute/highlight.rs server/tests/compute_highlight.rs
git commit -m "feat(server): 高亮接口 range 协议（path 模式流式扫行 + baseLine）

why: 大文件懒高亮需要按可视区解析的服务端契约（spec §5.1），整文件
解析与 20MB 上限是 >20MB 文件的服务端死角。
what: path+range 流式扫行（内存有界）、响应加 baseLine（驼峰 rename）、
LRU 键扩展 range 维度、lineCount≤5000 防御；text 模式与无 range 行为不变。"
```

---

### Task 2: 本地 worker chunk 参数

**Files:**
- Modify: `packages/highlight/src/client.ts`（HighlightClient.highlight 第三参 ctx 扩展 `chunk?: {startLine: number; lineCount: number}`，透传 worker 消息）
- Modify: `packages/highlight/src/worker.ts`（消息类型扩展）
- Modify: `packages/highlight/src/core-parse.ts`（engine.highlight 接收 chunk：`highlight(text, lang, depth, chunk?)`——chunk 模式下调用方已传子文本，engine 无需切分，只需**不做整文本预算放大**：queryBudget 按子文本长度算即现状，确认无需改；真正要改的是返回区间即相对子文本，调用侧语义对齐）
- Test: `packages/highlight/test/`（chunk 用例）

**Interfaces:**
- Produces: `client.highlight(text, lang, { chunk })`——text 即 chunk 子文本，返回区间相对子文本（调用侧负责 baseLine 平移到绝对行号）。**worker/engine 不感知行号**（子文本进出），这是「子文本 parse」裁决的最小实现面。

- [ ] **Step 1: 失败测试**（Node 侧真实 wasm，json fixture 模式沿用 runtime.test.ts 惯例）

```ts
it('chunk 模式：子文本进出的区间相对子文本，ctx.chunk 仅作语义标注透传', async () => {
  // 引擎 A：整文本 5 行 json 高亮 → 行 3 的区间集合 S1
  // 引擎 B：仅行 3-4 子文本高亮（ctx.chunk={startLine:3,lineCount:2}）→ 区间集合 S2
  // 断言：S2 与 S1 中行 3 的区间（相对行内偏移）一致；ctx.chunk 不改变结果
});
```

- [ ] **Step 2: 跑红** → **Step 3: 实现**（client/worker 消息链路扩展；engine 侧若无需改动则只透传并写明理由）→ **Step 4: `pnpm vitest run packages/highlight` 全绿** → **Step 5: Commit**

```bash
git commit -m "feat(highlight): worker 高亮链路支持 chunk 子文本语义标注

why: 懒高亮的本地路径按可视区子文本解析（spec §5.1 子文本 parse 裁决）。
what: client/worker ctx 扩展 chunk 透传；区间相对子文本，行号平移归调用侧。"
```

---

### Task 3: highlightRouter range 契约

**Files:**
- Modify: `apps/web/src/lib/highlightRouter.ts`（契约升级：`routeLargeFileHighlight(src, lang, range?: {startLine: number; lineCount: number})` → `{intervals, baseLine} | null`；body 带 range；decode 后平移？**不平移**——返回相对区间+baseLine 让渲染侧平移（与本地路径对称）；auto 失败 warn+null、remote 抛错语义不变）
- Modify: `apps/web/src/lib/highlightRouter.test.ts`（契约矩阵更新：range 在 body、baseLine 透传、auto/remote 失败语义保持）

**Interfaces:**
- Produces: 大文件路由的 chunk 级契约——渲染层对 >2MB server-served 文件按可视区调 `routeLargeFileHighlight(src, lang, {startLine, lineCount})`。

- [ ] **Step 1: 失败测试**（body 断言含 range、响应 {intervals, baseLine} 解码、失败分流不变）→ **Step 2: 跑红** → **Step 3: 实现**（decodeHighlightResponse 复用；返回 `{intervals, baseLine: resp.baseLine ?? 0}`——兼容旧服务端无 baseLine 字段）→ **Step 4: web lib 测试绿** → **Step 5: Commit**

```bash
git commit -m "feat(web): 大文件路由升级 range 契约（chunk 级远程高亮）

why: 阶段 4 渲染层按可视区请求服务端 chunk（spec §5.1）。
what: routeLargeFileHighlight 加 range 参数、返回 {intervals, baseLine}
（旧服务端缺 baseLine 兼容 0）；auto/remote 失败语义不变。"
```

---

### Task 4: code.ts 渲染层 chunkCache 重构（本阶段最重）

**Files:**
- Modify: `packages/render-text/src/code.ts`（strategy 三态、lazy 路径、chunkCache 模型、oversize 提示条阈值、search 兼容）
- Modify: `packages/render-text/test/`（code 相关单测——先 `rg -l "resolveStrategy|BLOCK_CACHE" packages/render-text/test`）

**Interfaces:**
- Produces:
  - `resolveStrategy(size)`：≤2MB `'tree-sitter'`；≤`PLAIN_MAX_BYTES`(新常量 200MB) `'lazy'`；更大 `'plain'`（`'hljs-block'` 类型值保留但不再由 resolveStrategy 产出——若现有单测断言三态，按新映射改写）。
  - lazy 路径：onRange(first,last) → chunk 区间 [first-OVERSCAN-2, last+OVERSCAN+2]（重叠 2 行，夹边界）→ 按 CHUNK 行粒度对齐（建议 CHUNK_LINES = 200：chunk 边界按 200 行对齐减少重复解析）→ chunkKey=startLine；in-flight Map 去重；chunk 完成写 `chunkCache: Map<startLine, Map<line, LineSeg[]>>`（tree-sitter 成功）或 `hljsChunkCache: Map<startLine, Map<line, string>>`（tree-sitter 失败的行级 hljs 回退），行级读值函数 `lineHtml(i)` 统一二路来源 + evictOldestEntries 按 chunk 键粒度裁到 5000 行等价。
  - 来源选择：`opts.computeSrc?.path` 且路由在位 → 服务端 chunk（routeLargeFileHighlight range 契约）；否则本地 worker chunk（client.highlight(chunkText, lang, {chunk})）。`attachedRouter` 大文件链路与本地 client 链路在此合流——server-served 文件本地 fallback：服务端 chunk 失败（warn+null）→ 该 chunk 行级 hljs（不回落本地 wasm，避免 >20MB 本地整块解析成本；≤20MB 本地来源走本地 wasm chunk）。
  - `engine` 状态：lazy 下 'pending' → 首个 chunk 到达置 'tree-sitter'（服务端则 computeWhere='remote'，本地 'local'）；chunk 全失败行级 hljs → 'hljs'。
  - plain 提示条：阈值改用 PLAIN_MAX_BYTES；>HLJS_MAX_BYTES(20MB) 的 lazy 文件在顶部加一次性「大文件懒高亮」提示（可选，若加须轻量不阻断滚动——按既有 BUG-20 提示条模式）。

- [ ] **Step 1: 失败单测**（resolveStrategy 新映射 + chunk 对齐纯函数 + lineHtml 二路来源 + 逐出粒度——纯函数尽量抽出便于测试：`chunkRangeFor(first, last)`、`mergeChunkLines`）

- [ ] **Step 2: 跑红** → **Step 3: 实现**（保留 ≤2MB tree-sitter 与 plain 路径现结构；删除独立 hljs-block 分支、fillBlockCache 由 lazy chunk 管线替代；start() 的 hljs-block 远程分支逻辑移入 lazy chunk 来源选择；destroyed/取消语义保持——HL-09 tab 切换经 cancelAll + destroyed 检查；搜索 overlay 兼容：fillRows 读 lineHtml 统一入口，searchHitsByLine 不变）→ **Step 4: `pnpm vitest run packages/render-text && pnpm typecheck` 全绿**（全仓 vitest 一并跑）→ **Step 5: Commit**

```bash
git commit -m "feat(render): >2MB 代码统一可视区懒高亮（chunkCache 模型）

why: 整文件解析在大文件上不可扩展，hljs 分块质量不足（spec §5.2）。
what: strategy 改 tree-sitter/lazy/plain 三态；lazy 由 onRange 驱动
chunk（200 行对齐、重叠 2 行、in-flight 去重、chunk 粒度逐出），
server-served 走 range 路由、本地走 worker chunk，chunk 失败行级 hljs
兜底；纯文本上限放宽参数化 200MB。"
```

---

### Task 5: e2e 改写与性能锚点

**Files:**
- Modify: `apps/web/e2e/b-code-highlight-degrade.spec.ts`（HL-03 3MB 分块滚动零错位——改断言为 lazy chunk 模型下滚动零错位；HL-09 ~2MB 切 tab 取消；HL-11 2MB 响应性；BUG-20 >20MB 纯文本→改为 lazy 生效断言；>200MB 纯文本新档若可构造）
- Modify: `apps/web/e2e-server/b-compute-global-search-server.spec.ts`（CMP-02 双护栏的渲染断言微调——远程 chunk 后「执行： 远程」语义保持）
- 性能锚点：新增用例或复用 HL-11——>20MB 文件（本地构造 25MB 样例）打开首屏 < 1s（纯文本首帧）+ 滚动到可视区后 2s 内出现 tree-sitter 高亮 + 滚动无长任务（performance longtask 计数或帧率断言，沿用 m3-search 计时型断言风格）

**Interfaces:** Consumes: Task 2/3/4 全部。

- [ ] **Step 1: 盘点旧断言**（`rg -n "hljs-block|纯文本|20MB" apps/web/e2e`）→ **Step 2: 改写** → **Step 3: 本地全量 playwright（默认套件 + e2e-server 套件，长 timeout/后台）** → **Step 4: Commit**

```bash
git commit -m "test(e2e): 懒高亮契约断言改写与性能锚点

why: 阶段 4 反转了 >20MB 纯文本与 hljs-block 的旧契约（spec §5.4）。
what: HL/BUG-20 系列断言改写；新增 25MB 本地文件懒高亮性能锚点
（首屏、chunk 到达时延、滚动无长任务）。"
```

---

### Task 6: 文档收口与 spec 回写

**Files:**
- Modify: `docs/e2e/code-highlight-degrade.md`（降级链文档——三态新模型）
- Modify: `server/README.md`（range 协议一节）
- Modify: `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§7.4 回写 + 阶段 3 遗留 minor 勘误：「完全对齐」表述修正为「差集经宣告门前置拦截」，补 jsonc/jsx 事实）
- Modify: `apps/web/e2e-server/`（若阶段 3 遗留的宣告门 e2e 可构造项顺带回补：server-served >2MB .jsonc + auto → 零 POST + 本地分块——评审指出可构造，顺带落地）

- [ ] **Step 1: 文档三处 + 勘误 + 宣告门 e2e 回补** → **Step 2: 全量门禁（vitest/typecheck/cargo test/两套 playwright）** → **Step 3: Commit**

```bash
git commit -m "docs(render): 阶段 4 收口——降级链文档、range 协议与 spec 回写

why: 三态新模型与 range 协议改变对外契约面（spec §5.4）。
what: 降级链与 server README 更新；阶段 3 遗留勘误与宣告门 e2e 回补；
四阶段全量门禁记录。"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§5.1 协议→Task 1/2/3；子文本 parse 裁决→Task 2（engine 不感知行号）；重叠 2 行/去重→Task 4；§5.2 chunkCache/逐出/阈值→Task 4；LRU 键→Task 1；§5.3 错误处理（chunk 级兜底/取消/降级）→Task 4 + Task 5 断言；§5.4 测试与性能锚点→Task 5；纯文本参数化→Task 4。无缺口。
2. **占位符扫描**：Task 4 Interfaces 给出完整结构决策（chunk 对齐/来源选择/状态机/搜索兼容）；Task 1 Step 3 结构代码到位；无 TBD。
3. **类型一致性**：range 形状 `{startLine, lineCount}`（Task 1 Rust serde rename startLine/lineCount ↔ Task 2 ctx.chunk ↔ Task 3 route 参数 ↔ Task 4 调用）一致；`{intervals, baseLine}`（Task 1 响应 ↔ Task 3 返回 ↔ Task 4 平移消费）一致；`baseLine` 缺省 0 的旧服务端兼容点在 Task 3。
