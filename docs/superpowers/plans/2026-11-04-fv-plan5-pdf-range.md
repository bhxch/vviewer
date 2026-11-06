# file-viewer 引入 · 计划 5（vviewer pdf Range transport）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vviewer 自有 pdf 渲染器接 Range 能力（决策⑫/spec §6.6）：声明 streaming，`ctx.rangeCapable && size 已知` 时走 pdfjs `PDFDataRangeTransport(head, size, requestRange→ctx.read)` 渐进加载；回退三路（size 未知→全量 / !rangeCapable→全量 / 本地来源→现 data 路径零变化）；直连 S3 经 store.read 同样适用；e2e 锚编写（实跑移交统一验证）。

**Architecture:** pdf.ts 增加 transport 模式分支——渲染器声明 `streaming: true` 后 dispatcher 交付 head 探测字节 + StreamCtx；transport 的 requestDataRange 回调把 `ctx.read(range)` 的窗段字节交给 pdfjs；生命周期=既有 reload/destroy 链 + `loadingTask.destroy()` + signal 取消在飞窗段（abort 对齐 abortReadError 身份层）。pdfjs-dist 既有依赖（vviewer pdf 已用），零新依赖。

**Tech Stack:** TypeScript / pdfjs-dist（既有）/ vitest / Playwright（编写 only）。

**Spec:** `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md` §6.6（决策⑫）。

## Global Constraints

- e2e 只写不跑（既定裁决）；单测/typecheck 门禁照旧。
- 回退三路语义钉死：ctx 缺失 / size===null / !ctx.rangeCapable → 全量现路径（memoizedFullRead 形态）；本地来源（buffer 全量在手）→ 现 `getDocument({ data: buffer })` 逐字节不变。
- abort：requestRange 在飞窗段随 ctx signal 取消；取消错误统一 `abortReadError` 身份（errors.ts 既有层）。
- 直连 S3/DAV：经 store.read（SigV4/Basic 在 store 层）——transport 不挑 URL 适配性。
- 携带修复（计划 4 终审遗留）：apps/web/vite.config.ts:274 注释「11 个」→「10 个」。
- 每任务原子 commit；中文 Conventional Commits。

## Review Focus

1. **head 传递正确性**：PDFDataRangeTransport 的 initialData 必须是探测头（dispatcher 交付的 head），长度与 lengthHint 关系不得错位——T1 锚。
2. **回退矩阵完整性**：四态（本地/size null/!rangeCapable/ctx 缺失）各自落全量或 data 路径，零遗漏——T1 锚。
3. **abort 竞态**：requestRange 在飞时 destroy/reload → loadingTask.destroy + signal 取消，无孤儿 promise——T1 锚。
4. **渐进语义锚**：e2e linearized 样例「首屏渲染先于全量到达」的请求数/字节量下限断言——T2 编写。
5. **pdf.worker 兼容**：transport 模式与既有 workerSrc 设置共存——T1 验证。

---

### Task 1: pdf.ts transport 模式实装 + 回退矩阵

**Files:**
- Modify: `packages/vviewer-render-doc/src/pdf.ts`（streaming 声明 + render 分支：transport 路径 + 回退矩阵；`packages/vviewer-render-doc/src/pdfText.ts` 如涉文本层联动一并核）
- Test: `packages/vviewer-render-doc/test/pdf*.test.ts`（既有文件就近加；pdfjs mock 形态沿既有）

**Interfaces:**
- Consumes: StreamCtx（core types：head/read/rangeCapable/size/signal）；`PDFDataRangeTransport`（pdfjs-dist 既有导出）。
- Produces: pdf 渲染器 `streaming: true`；transport 分支函数（可测纯装配形态）。

- [ ] **Step 1: 失败测试**（pdfjs getDocument mock）：本地来源 data 路径逐字节不变（既有断言保）；ctx+rangeCapable+size → getDocument 收到 PDFDataRangeTransport 实例（initialData=head 字节、length=size）；requestRange 回调把 ctx.read 窗段交出（mock read 返回窗段字节断言）；size null/!rangeCapable/ctx 缺失三态 → 全量路径；abort → requestRange reject 落 abortReadError 身份；destroy → loadingTask.destroy 调用。
- [ ] **Step 2: 红** → Step 3: 实装（最小分支；render 入口早段分流）→ Step 4: 绿（根 vitest/双 typecheck）+ vite.config.ts:274 注释携带勘误（11→10）→ Step 5: Commit `feat(web): vviewer pdf Range transport——PDFDataRangeTransport 接 ctx.read（spec §6.6）`

### Task 2: e2e 锚编写（PDF-RANGE 域）

**Files:**
- Create: `apps/web/e2e/b-pdf-range.spec.ts`（编写 only：linearized 远端样例渐进锚〔首屏渲染先于全量——以 Range 请求数下限+首窗字节断言〕、回退三路锚〔size 未知/非 Range store/本地〕、S3 直连形态锚〔e2e-server 套件形态则注明落点〕、取消锚）
- Test: 无实跑（统一验证阶段执行）

- [ ] **Step 1: 夹具与锚编写**（linearized PDF 夹具：qpdf 可用则本地生成小体量线性化样例入库〔文本可 commit？PDF 二进制——按 corpus 惯例 gitignore+manifest，或 qpdf 生成确定性小文件经 manifest 圈定〕）→ Step 2: 静态一致性走读 → Step 3: 门禁（根 vitest/双 typecheck/porcelain）→ Step 4: Commit `test(e2e): PDF-RANGE 域锚编写（e2e 实跑移交统一验证）`

### 收口

- [ ] 全量门禁：根 `pnpm vitest run` exit0；双 typecheck 0E；双 --check 绿；porcelain 净空。（e2e 全量移交统一验证）
