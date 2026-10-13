# IO 级流式设计（Renderer 读上下文演进）

- 日期：2026-10-12
- 状态：已评审（brainstorm 确认，待实施）
- 来源：交接文档 §2.1 跨项架构债（jsonl spec §2.2 裁决偏离）；现状探查（types.ts / remote.ts / dispatcher.ts / ViewerPane / hex / jsonl / code）
- 前置事实：`TreeStore.read` 已声明 `opts.range?: ByteRange`（types.ts:26，end 含）；localFs 已实现 slice；**服务端 /api/file 已完整支持 Range header**（file.rs：parse_range/206/Content-Range/Accept-Ranges，routes/mod.rs:42 Range 请求不进压缩层）——服务端零改动

## 1. 问题陈述与目标

现状：`ViewerPane` 无条件全量 `store.read(path)`，buffer 经 dispatch 交给渲染器闭包持有至销毁；SSE `rev++` 重渲染重新全量 read；12 个渲染器全部消费全量 buffer。jsonl 计划已记录裁决偏离：「IO 级流式需 Renderer 接口演进，独立后续项」。

本设计目标（brainstorm 确认，四项全选）：

1. **内存有界**：hex/jsonl/code 不再全量持有字节与解码文本。
2. **首屏延迟/流量**：首屏只读 head + 首窗口；远端流量从整文件降到 KB 级。
3. **重渲染免全量重读**：SSE rev++ 只重读受影响窗口。
4. **归还 jsonl spec §2.2 口径**：总行数未知、滚动到底才确定、「已加载 N 行」。

范围（brainstorm 确认）：渲染器迁移 **hex + jsonl + code** 三个；code 文件内搜索采用**后台全文扫描**（块拉取、进度、可取消）。

## 2. 接口演进（方案 A：读上下文渐进注入）

### 2.1 StreamCtx（core 新类型，types.ts）

```ts
/** 流式渲染上下文：streaming 渲染器按需取字节的唯一通道（spec IO §2.2）。 */
export interface StreamCtx {
  /** 文件总字节数；null = store 无法预知（渲染器应走全量回退路径） */
  readonly size: number | null;
  /** 已就绪的头部字节（探测块，长度 ≥ HEAD_SIZE；非 rangeCapable 来源=全量） */
  readonly head: Uint8Array<ArrayBuffer>;
  /** 按字节区间读取（end 含，同 ByteRange 语义）；store 无 range 能力时为
   * 全量 buffer 的切片视图（同步 resolve，零拷贝 subarray）。 */
  read(range: ByteRange): Promise<Uint8Array<ArrayBuffer>>;
}
```

### 2.2 Renderer 声明

```ts
export interface Renderer {
  // …既有字段不动
  /** 流式渲染器：dispatcher 只交付 head + ctx（render 第 5 参），不交付全量。
   * 缺省 = 既有全量语义，第 5 参被忽略——9 个非迁移渲染器零改动。 */
  streaming?: boolean;
}
render(buffer, target, source, det, ctx?: StreamCtx): Promise<RenderedInstance>
```

render 签名向后兼容（第 5 参可选）；streaming 渲染器的 `buffer` 形参收到的是 head（探测块），全量字节一律经 `ctx.read`。

### 2.3 TreeStore 能力标记与 store 层补齐

```ts
export interface TreeStore {
  // …既有成员不动
  /** read 支持 opts.range（bytes 区间语义）；缺省 false = 仅全量。
   * dispatcher 据此决定 streaming 渲染器的 ctx 形态。 */
  readonly rangeCapable?: boolean;
}
```

| store | rangeCapable | 改动 |
| --- | --- | --- |
| remote | true | `read(path, {range})` 透传 `Range: bytes=start-end` 头（request() 增 headers 透传）；206 正常；**200（服务器忽略 Range）时返回全量，read 内不切片**——调用方（块读取器）按返回长度自校验并停在该块（回退语义，见 §4.2）；单根 baseURL 不支持 Range 的假服务器场景由该路径兜底 |
| localFs | true | 已实现（既有） |
| localFiles | true | `file.slice(start, end+1)`（File 引用已保留，纯补分支） |
| single / url / zip / libarchive | 缺省 false | 不改——dispatcher 全量构造 ctx |

## 3. dispatch 读控制权下沉

- `dispatch(source, buffer, target, opts)` 增 `opts.read?: (range?: ByteRange) => Promise<Uint8Array<ArrayBuffer>>`（ViewerPane 传 `store.read` 包装闭包；open-as 重入 redisplay 原样透传）。**opts.read 缺失时用入参 buffer 走现状路径**——既有测试与调用方渐进兼容。
- 新流程：`read(head 8KB)` → detect 选路 →
  - 非 streaming 渲染器：全量 read → render(full)（与现状等价；head 即 full.slice）；
  - streaming 渲染器：`store.rangeCapable === true` → ctx = { size: source.size ?? null, head, read }；`false` → 全量 read 后 ctx = { size: full.length, head: full, read: 同步切片 }；render(head, …, ctx)。
- `source.size`：FileSource 增可选 `size?: number | null`（ViewerPane 从 TreeNode.size / File.size / remote Content-Length 带入——remote 现状读响应头，本期从 TreeNode.size 透传，缺省 null）。
- ViewerPane 不再无条件全量 read：streaming 渲染器的重渲染（rev++）只重走 head + 窗口。

## 4. 渲染器迁移

### 4.1 hex（定长窗口，完美匹配 Range）

- **窗口模式**（ctx 存在且 `size !== null`）：虚拟滚动可视行格式化经块缓存——内部 `blocks: Map<blockIndex, Uint8Array>`（块 64KB，上限 8 块 LRU ≈ 512KB），未命中异步 `ctx.read` 后渲染（短暂 loading 态）；行格式化逻辑不变（对齐 16 字节）。
- **回退**：`size === null`（size 未知的 url/zip 来源）→ 全量模式（ctx 即全量视图，行为=现状）。
- 结构树：head + tail——tail 改 `ctx.read(size-8K, size-1)`（现状全量下 slice，流式下按需拉）。
- **搜索**：worker `search` 的 data 入参在窗口模式下改为**逐块拉取扫描**——复用 searchScan 分块语义（SEARCH_CHUNK_BYTES 1MB → 改为 ctx 块序列），进度/取消协议不变；命中 offset 定位行 → 确保对应块已缓存 → 高亮跳转。全量模式走现状副本语义。

### 4.2 jsonl（行块流式，归还 spec §2.2）

- **索引**：`offsets: number[]`（行起始字节偏移，流式追加）+ `loadedBytes` 游标。首屏读 2 块（2×256KB），滚动接近已加载尾部续读；`streamEnd` 布尔标记「已到文件末尾」。
- **行内容**：块解码缓存 `Map<blockIndex, string>`（上限 8 块 LRU ≈ 2MB 文本）；行文本 = 块文本切片；窗口行渲染命中缓存直取。
- **块边界**：块尾回退到最后一个 `\n`（不含）——残余字节并入下块；**仅 UTF-8/ASCII 流式**（换行 0x0A 在 UTF-8 无歧义、块切不破多字节字符——前提是按行边界切）；`det.encoding` 非 utf-8/undefined → 全量回退（现状路径）。undefined 措辞补笔（终审 A2）：detectEncoding 恒返回四值之一，undefined 实际不可达；实现视 undefined 为 utf-8（ASCII 为其子集）。
- **巨行防护**：索引阶段按字节记录行长，>1MB 行不解析、64KB 预览截断（既有语义保持，跨块行以索引期边界为准）。
- **meta/UI**：总行数未知 → 「已加载 N 行」；`streamEnd` 后显示「共 N 行」；滚动到底自动续读（spec §2.2「总行数未知，滚动到底才确定」）。既有「总行数」断言随 §8 清单更新。

### 4.3 code（行索引流式 + 后台全文搜索）

- **行索引**：按字节扫描 `\n` 流式构建 `offsets`（**不解码**——UTF-8 下换行字节无歧义），后台逐块推进、可取消；首屏只需首块索引即可渲染（可视行解码经块缓存，同 jsonl 形态）。
- **高亮兼容**：`size ≤ 2MB` → 既有 tree-sitter 整文件路径（全量 read，行为不变）；`> 2MB` → 既有 lazy 高亮按已构建索引工作（可视 chunk 解码）。
- **防线调整**：`PLAIN_MAX_BYTES 200MB` 的「全量解码失控」前提消失——替换为 `STREAM_MAX_BYTES = 512MB`（索引内存上限：5 亿字节 ≈ 数百万行 × offsets 数组；超出提示「文件过大，建议 hex 查看」并走 hex 打开动作）。
- **搜索（后台全文扫描）**：`search(query)` 重写——**从文件头起**逐块拉取解码扫描直到 `streamEnd`（不是只扫已加载区间），进度回调（状态条「扫描中 N%」）、令牌取消（新搜索/关面板/tab 切换）；命中即记录行号（行可能尚未进入渲染窗口——gotoMatch 时确保目标块已读后跳转高亮）；未扫完全文时结果标注「扫描中，已命中 N 处」。非流式路径（全量回退）走现状实现。
- **编码**：同 jsonl，仅 UTF-8/ASCII 流式；BOM 在 head 内检出。

## 5. 降级矩阵

| 来源 | rangeCapable | size | streaming 渲染器行为 |
| --- | --- | --- | --- |
| remote | true | TreeNode.size（缺省 null） | 窗口流式；size null → hex 全量回退，jsonl/code 仍可流式（索引/续读到 streamEnd 即知末尾） |
| localFs | true | File.size ✔ | 窗口流式 |
| localFiles | true | File.size ✔ | 窗口流式 |
| single / url | false | File.size / Content-Length（可缺） | ctx=全量切片视图（=现状，零收益零风险） |
| zip / libarchive | false | 条目 size | 同上 |

编码非 UTF-8（UTF-16/GBK 等）：jsonl/code 回退全量（hex 不解码，不受影响）。undefined 措辞补笔（终审 A2，同 §4.2）：detectEncoding 恒返回四值之一，undefined 实际不可达；实现视 undefined 为 utf-8（ASCII 为其子集）。

## 6. 测试与验收

- **store 层单测**：remote read 透传 Range 头 + 206/200 双路径；localFiles slice 区间正确；rangeCapable 标记齐全。
- **dispatch 单测**：streaming 渲染器只收到 head + ctx（head 长度断言）；非 streaming 全量路径等价现状；!rangeCapable 全量 ctx；opts.read 缺失兼容路径。
- **渲染器单测**：hex 块缓存 LRU 上限 + 未命中拉块 + 搜索块序列扫描；jsonl 索引流式追加/块边界回退/已加载 N 行/巨行跨块；code 索引字节扫描/搜索进度与取消/2MB 高亮分界/512MB 上限提示。
- **e2e（假服务器字节计量）**：10MB 远端 js 文件首屏总拉取 ≤ head+2 块（<1MB）；滚动触发续读请求；SSE rev++ 重渲染无全量重读请求；hex 搜索在窗口模式命中正确。
- **内存有界断言**：结构级——hex 块缓存 ≤8 块、jsonl/code 文本缓存 ≤8 块、code 不再持全量解码文本（渲染器不引用 size 全 buffer）；「1MB 不再 6.5 万 DOM」既有虚拟滚动用例保持。
- **全量门禁**：vitest / svelte-check 0E0W / cargo / playwright 双通道（默认通道新增计量用例）。

## 7. 不做的事

- 非 streaming 渲染器（image/av/pdf/docx/xlsx/pptx/markdown/html/archive）零改动——天然整包形态维持。
- 服务端零改动（Range header 已支持）。
- 跨重渲染的实例级缓存（SSE 变更后 hex 实例自刷新而非销毁重建）——本期销毁重建但只读窗口，实例化缓存另立后续项。
- gzip/压缩传输的流式解压。

## 8. e2e 断言变更清单（本项目不适用「断言零变更」约束）

1. jsonl meta「总行数」→「已加载 N 行 / 共 N 行（到末尾后）」——t-jsonl 系列对应断言。
2. jsonl 大文件用例（若有 200MB 降级断言）随 STREAM_MAX_BYTES 口径同步。
3. 新增字节计量断言（假服务器响应字节数统计）。
4. code 大文件搜索用例：进度/取消交互锚点新增。

## 9. 实施分期建议（供 writing-plans 参考）

按依赖序：① core 类型 + store 层（remote/localFiles/标记）→ ② dispatch/ViewerPane 读下沉 → ③ hex 迁移（含搜索）→ ④ jsonl 迁移 → ⑤ code 迁移（含搜索）→ ⑥ e2e 计量与验收。每期独立可测可交付；③⑤ 各自可再拆渲染/搜索两步。工程量约等于此前七项流水线中最大单项，建议单会话专注实施，必要时以 handoff 承接。
