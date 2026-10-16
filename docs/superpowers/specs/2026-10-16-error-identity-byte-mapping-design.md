# 错误身份与字节映射基建设计（dispatch 分类层 / isAbortError 单源 / lineAtByteOffset）

- 日期：2026-10-16
- 状态：待用户审阅
- 来源：deferred 清偿轮（49cbc26）终审新增三条立项候选 + 本轮 brainstorm 探索发现的缺口收口
- 文中行号为 2026-10-16 HEAD（49cbc26）参考，实施时以符号定位为准。

## 1. 背景与动机

三条候选同源于「取消/错误身份判定」的口径漂移，且探索发现它们共享同一载体（core 侧一个
errors 模块），合并立项：

1. **isAbortError 双镜像**：`render-text/src/code.ts:24-29`（导出版，双支并判）与
   `core/src/dispatch/dispatcher.ts:61-66`（模块私有镜像，逐字相同）靠「注释 + 双侧测试」
   人工同步；`apps/web/src/lib/WorkspaceCreateModal.svelte:79` 还有第三份内联**单支**变体
   （仅判 DOMException 形态，漏 `Error + name` 形态）——口径漂移已经发生。
2. **dispatch 分类层缺失**：dispatch catch 是顺序 if 链（DispatchReadError → isAbortError →
   其余）；同文件两处 catch 面完全没接这套判定——`buildRenderErrorActions` 的 retry catch
   （:167-173）重试被取消时会把 AbortError message 画回错误卡片（与 dispatch catch「abort
   不上屏」裁决不一致，**真实缺口**）；`openAsAction` catch（:138）把 abort 当「重入失败」
   console.error 留痕。`render-text/src/code.ts:2390-2392`（revealLine 未加载行续读 catch）
   无条件落 `continueFailed` 闩，是 Task 3 六处收紧漏掉的第七处同型分支。
3. **字节→字符映射近似**：jsonl 窗口模式流内嗅探降级委托 code 全量实例时，锚行字节偏移
   直传字符域 `lineAtOffset`，残留两支近似（多字节非 ASCII 累计差、CRLF 记账差），中文日志
   类文件锚行可漂出视口粗定位范围（`jsonl/index.ts:576-584` 注释自述）。

## 2. 目标

- T1 core 新建 `packages/core/src/dispatch/errors.ts`：`isAbortError` 单源、`DispatchReadError`
  集中、`abortReadError()` 统一抛出形态、`classifyDispatchError` 分类函数。
- T2 dispatcher 全部 catch 面改走分类层：主 catch 链改 switch；retry catch 与 openAsAction
  catch 获得一致 abort 过滤。
- T3 抛出端统一：core tree 层三处内联 `DOMException('读取已取消','AbortError')`
  （`singleFile.ts` / `localFiles.ts` / `localFs.ts`）改调 `abortReadError()`。
- T4 `lineAtByteOffset`：code 全量模式新增字节域行索引与可选 handle 方法；jsonl 委托锚行
  换算改三级回退，消灭两支近似。
- T5 收口零散面：WorkspaceCreateModal 改用 core 版；code.ts 改 re-export（导入面零变动）；
  code.ts:2390 补 abort 分支。

## 3. 非目标

- notfound / decode 等其余错误的结构化身份（`localFs.ts` 的 `Error('路径不存在: ...')` 维持
  message 形态）——现无消费方需要区分，YAGNI。
- 选路失败（renderer undefined）的错误结构化——维持现有「message 字符串 + renderer 缺席」
  判定，buildRoutingErrorActions 分支不动。
- `HighlightCanceledError`（instanceof 口径）与 AbortError 身份口径的合并——高亮取消与读
  取消是两个概念，各自语义清晰，不动。
- 窗口模式提供 lineAtByteOffset——与 lineAtOffset 同裁决（无全量索引，缺席）。
- code.ts:1897-1898（revealLoadedLine 补块 catch 仅 debug 留痕）——无闩无卡片，无口径问题。

## 4. 设计

### 4.1 errors.ts（core/src/dispatch/）

```ts
export type DispatchErrorKind = 'abort' | 'read' | 'generic';

/** 取消错误身份判定（自 code.ts 迁入，双支并判理由见原文档） */
export function isAbortError(err: unknown): boolean;

/** 读失败标记类（自 dispatcher.ts 迁入，形态不变） */
export class DispatchReadError extends Error { readonly cause?: unknown }

/** 统一抛出形态（Task 1 既有约定的单源化） */
export function abortReadError(): Error; // new DOMException('读取已取消', 'AbortError')

/**
 * 错误分类：身份优先（isAbortError / DispatchReadError），ctx.signal.aborted 仅作
 * 状态兜底（非 AbortError 身份但上下文已取消的竞态，沿 dispatcher 现行 :384 语义）。
 * ctx 可省略（无 signal 可言的 catch 面，如 openAsAction）。
 */
export function classifyDispatchError(
  err: unknown,
  ctx?: { signal?: AbortSignal | null }
): DispatchErrorKind;
```

经 `packages/core/src/index.ts` 导出。kind 集合刻意收窄为三类：'read' 维持 rethrow 语义
（读失败向上走调用方读取失败面）、'abort' 维持 no-op 不上屏、'generic' 走错误卡片。

### 4.2 dispatcher 改造

- 删私有镜像 isAbortError 与本地 DispatchReadError，改从 errors.ts 导入。
- 主 catch（现 :391-429）改 `switch (classifyDispatchError(err, { signal }))`：read →
  rethrow；abort → no-op 实例；generic → 错误卡片（现状不变）。
- **retry catch（现 :167-173）**：`classifyDispatchError(err, { signal: ctx?.signal })` 为
  abort → 静默 return（原错误卡片保留在屏，用户已取消则不重画）；generic → 现行为不变。
  StreamCtx 携带 signal（流式硬化阶段 A 已贯穿），此处免费获得状态兜底。
- **openAsAction catch（现 :138）**：abort → 静默 return（用户取消触发的重入失败不属
  「重入失败」）；generic → 保持 console.error。openAsAction 无 ctx，仅身份判定。

### 4.3 单源迁移

- `render-text/src/code.ts`：删除函数体，改 `export { isAbortError } from '@vviewer/core'`
  ——`jsonl/index.ts:86` 与 `ViewerPane.svelte:4` 的导入路径零变动；原 doc 注释（双支并判
  理由、六处静默分支语义）迁往 core，code.ts 留短注指向。
- `WorkspaceCreateModal.svelte:79` 内联表达式改 `isAbortError(err)`（顺带补齐 Error+name
  形态）。
- 防再镜像：`render-text/test/code.test.ts` 判定矩阵（:2904-2913）改测「core 单源 + render-text
  re-export 同引用」的 identity 断言；`core/test/dispatcher.test.ts`「同源口径」注释级保证
  升级为字面单源。

### 4.4 抛出端统一

tree 层三处 `throw new DOMException('读取已取消', 'AbortError')` 改 `throw abortReadError()`；
`core/src/tree/types.ts:47-49` 的契约注释改为指向 `abortReadError` 单源。render-text 侧等价
抛出点（若有）同批迁移，仅限逐字同形态者。

### 4.5 lineAtByteOffset（字节域行索引）

**域定义（关键裁决）**：字节域 = post-BOM（从 BOM 后起算，与 jsonl 索引逻辑域同基）、
终结符语义对齐 code 字符域（`\r\n` 单终结符记 2 字节、`\n` 记 1、lone `\r` 亦终结记 1）。
两个域维度各自对齐：行号与 code 字符域 revealLine 一致、字节偏移与 jsonl 记账在 `\r\n`/`\n`
文件上逐字节一致。lone `\r` 文件两域天然不可同时对齐，记为已知边界（jsonl 内容按定义
不含裸 `\r` 行尾，现实影响趋零）。

- 构建：全量模式在解码前对原始 buffer 扫描一次（O(n)，从 `bomLen` 后起扫，记行起始字节
  偏移前缀和），与 `buildLineOffsets`（字符域）并行存储。不采用「decode 后逐行 re-encode」
  （成本高且 CRLF 归一已失真）。
- 接口：`RenderCodeHandle`（code.ts:608-613 一带）追加可选 `lineAtByteOffset?(offset:
  number): number`；字符版 `lineAtOffset` 保留，接口 doc 补「域 = UTF-16 字符偏移（非字节）」
  的明示，消除「名字带 Offset 实为字符域」的历史错位。
- 消费端 `restoreViewportAfterDegrade`（jsonl/index.ts:586-600）改三级回退：
  `lineAtByteOffset(anchorByteOffset)` → `lineAtOffset(anchorByteOffset)`（旧近似，兼容旧
  委托实例）→ 内容行号直传。`:576-584` 与 `:731-735` 的近似注释改写为已清偿。
- 锚捕获侧（:727-744）不改：post-BOM 字节域记账原样，仅换算端升级。

## 5. 测试与验收

- dispatcher.test.ts：**新增 retry-abort 不上屏用例（现状红）**——重试 render reject
  AbortError → 不出新卡、原卡保留；generic 重试失败仍出卡（既有锚不翻转）。
  classify 矩阵：AbortError 双形态 / DispatchReadError / signal.aborted 状态兜底 / 普通
  Error → generic。
- code.test.ts：判定矩阵迁 core 单源 + identity 断言；lineAtByteOffset 字节域 describe——
  多字节汉字 / CRLF / BOM / lone `\r`（已知边界断言）四类夹具，含「现状直传漂行」的反例
  形态；lineAtOffset 字符版既有用例（:898-936）全数保持绿。
- jsonl-render.test.ts：`interleavedBlankHeadGbTail` 夹具（:1016-1079）加中文变体（每行嵌
  多字节字符），锚行经 lineAtByteOffset 映射后 `revealArgs` 命中目标物理行；无 lineAtOffset
  回退用例（:1081-1106）保持绿（三级回退兼容）。
- tree-signal.test.ts / 既有 abort 竞态用例（Task 3 Step 1 模板）保持绿。
- 门禁：typecheck + svelte-check 0E0W、vitest 全量、cargo 全套件（tree 层改动涉 Rust 侧
  消费面核查）、playwright 双通道既有锚零翻转。

## 6. 风险与边界

- 全量模式多一次 O(n) 扫描：仅全量模式构建（窗口模式本无此方法），大文件全量模式本就
  持有完整 buffer，可接受；不做惰性化（YAGNI）。
- 状态兜底（signal.aborted）与「真实失败 + abort 竞态」的张力：Task 3 的裁决是**身份优先**
  （真失败不误吞），分类层保持该优先级，signal 兜底仅在其他身份都不命中时生效——与
  dispatcher :384 现行语义逐点等价，不引入新误吞面。
- retry catch 引入 abort 过滤是**行为修复**（现状会把 AbortError 画回卡片），需在测试中
  锚定原卡保留语义，防止误伤「重试确实失败」的正路展示。

## 7. 裁决记录

- 2026-10-16 用户拍板：三条候选合并立项（errors.ts 共同载体）；字节映射取「code 侧持
  字节域索引」方案（jsonl 侧换算不可行——窗口模式从不持有全量文本）；notfound/decode
  结构化身份列非目标；retry/openAs catch 的 abort 过滤纳入本 spec（探索发现的现行不一致）。
