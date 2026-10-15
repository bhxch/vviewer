# 流式硬化（signal 贯穿 + SUSP 四条 + worker init 探针）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地流式硬化 spec（docs/superpowers/specs/2026-10-15-streaming-hardening-design.md）的六阶段：在飞读取消贯穿、SUSP-01/03/02/06 四条优化、worker init 挂起探针。

**Architecture:** 阶段 A 经 TreeStore/StreamCtx/BlockStream 三层可选 signal 参数实现 destroy 时 abort 在飞读（remote/url 真取消、localFiles 降级丢弃）；B–E 为四条 bounded 修复（探针翻转为验收）；F 为 worker init 阶段化打点 spike。各任务独立提交、独立验收。

**Tech Stack:** TypeScript / vitest（jsdom，仓库根跑）/ Playwright（e2e）/ Svelte 5。

**Spec:** docs/superpowers/specs/2026-10-15-streaming-hardening-design.md（裁决记录：localFiles 降级语义、触新非钉住、abort 错误不上屏等，执行者必读）

## Global Constraints

- vitest 必须在仓库根跑（`pnpm vitest run`，子目录缺 jsdom）。
- e2e 前必须重建产品包：`cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build`（vite preview 伺服 apps/web/build，不重建=白跑）。
- typecheck 门禁：仓库根 `pnpm typecheck`（含 apps/web 的 svelte-check）。
- 探针翻转类验收必须改 b-susp-verify.spec.ts 的既有断言（翻转方向见各任务），不得只加新用例。
- 每任务原子提交（Angular 规范），提交信息含 why 与 what。
- abort 产生的错误不得标 `DispatchReadError`、不得触发错误卡片/读取失败面上屏。
- 长命令（全量门禁/e2e）用后台运行（前台 600s 窗口会被平台中止）。

---

### Task 1: 契约层 signal——types + 三 store + dispatcher

**Files:**
- Modify: `packages/core/src/types.ts`（TreeStore.read opts、StreamCtx.read 签名）
- Modify: `packages/core/src/tree/remote.ts`（request 合并 signal）
- Modify: `packages/core/src/tree/singleFile.ts`（createUrlStore 的 fetch 接 signal；createSingleFileStore 降级语义）
- Modify: `packages/core/src/tree/localFiles.ts`（降级语义：aborted 即 reject）
- Modify: `packages/core/src/dispatch/dispatcher.ts`（DispatchRead 类型 + renderCtx.read 透传与 abort 不标 DispatchReadError）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（read 闭包透传）
- Test: `packages/core/test/`（新增 `tree-signal.test.ts`；若无此目录，放 `packages/core/test/dispatcher.test.ts` 同级新建）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces:
  - `TreeStore.read(path: string, opts?: { range?: ByteRange; signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>>`
  - `StreamCtx.read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>`
  - `DispatchRead = (range?: ByteRange, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>`
  - 语义：signal aborted 时 reject（remote 抛 fetch 原生 AbortError；localFiles/singleFile 抛 `Error('读取已取消')`）；dispatcher 包装层对「signal.aborted 时的 reject」不标 DispatchReadError。

- [ ] **Step 1: 写失败测试**

新建 `packages/core/test/tree-signal.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRemoteStore } from '../src/tree/remote';
import { createLocalFilesStore } from '../src/tree/localFiles';

describe('store read 的 signal 取消语义', () => {
  it('remote：signal 已 abort 时 fetch 被取消（AbortError reject），不发出网络等待', async () => {
    const store = createRemoteStore('http://127.0.0.1:1', null, 't');
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.read('a.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('remote：在飞读被 abort 取消（fetch 挂起中 abort → reject AbortError）', async () => {
    // 挂起服务器：连接保持不响应
    const http = await import('node:http');
    const server = http.createServer(() => {/* 永不应答 */});
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    try {
      const store = createRemoteStore(`http://127.0.0.1:${port}`, null, 't');
      const controller = new AbortController();
      const p = store.read('a.txt', { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it('localFiles：signal 预先 aborted → 立即 reject（降级语义）', async () => {
    const file = new File([new TextEncoder().encode('a\n')], 'a.txt');
    const store = createLocalFilesStore([file]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.read('a.txt', { signal: controller.signal })
    ).rejects.toThrow('读取已取消');
  });
});
```

注意：`createRemoteStore('http://127.0.0.1:1', ...)`——端口 1 无人监听，预 abort 的 signal 使 fetch 在连接尝试前即断，不产生真实网络等待（若环境仍快速 ECONNREFUSED 也满足断言：reject 名为 AbortError 由 signal 优先保证，实现见 Step 3 的 AbortSignal.any 顺序）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/tree-signal.test.ts`
Expected: FAIL——TS 层 `signal` 不在 opts 类型（vitest esbuild 转译可能不报类型错，运行时表现为多余参数被忽略、第一个用例 rejects 收到的是 ECONNREFUSED 而非 AbortError）。

- [ ] **Step 3: 实现契约与三 store**

`packages/core/src/types.ts`——TreeStore.read：

```ts
  read(path: string, opts?: { range?: ByteRange; signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>>;
```

StreamCtx.read：

```ts
  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
```

`packages/core/src/tree/remote.ts`——request 增 `signal?: AbortSignal` 形参，read 透传：

```ts
  async function request(
    apiPath: string,
    path: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    const query =
      `path=${encodeURIComponent(toServerPath(path))}` +
      (rootIndex !== 0 ? `&root=${rootIndex}` : '');
    const timeoutSignal =
      typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined;
    const merged =
      signal && timeoutSignal ? AbortSignal.any([timeoutSignal, signal]) : (signal ?? timeoutSignal);
    let res: Response;
    try {
      res = await fetch(`${base}${apiPath}?${query}`, { headers, signal: merged });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`服务器请求超时（30s）: ${base}${apiPath}`);
      }
      throw err;
    }
    // ……后续 !res.ok 分支不变
```

read 调用点：

```ts
    async read(path, opts) {
      const r = opts?.range;
      const res = await request(
        '/api/file',
        path,
        r ? { range: `bytes=${r.start}-${r.end}` } : undefined,
        opts?.signal
      );
      // ……其余不变
```

`packages/core/src/tree/localFiles.ts`——read 开头加：

```ts
    async read(path, opts) {
      if (opts?.signal?.aborted) throw new Error('读取已取消');
      // ……其余不变（slice().arrayBuffer() 无 signal 参数，晚 abort 由调用方丢弃结果）
```

`packages/core/src/tree/singleFile.ts`——createUrlStore 的 read（bytes 缓存键不含 signal：取消后重试走新 fetch，需把缓存改为「成功才缓存」）：

```ts
    async read(path, opts) {
      if (path !== name) throw new Error(`未知路径: ${path}`);
      if (opts?.signal?.aborted) throw new Error('读取已取消');
      bytes ??= fetch(url, { signal: opts?.signal }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} 获取 ${url} 失败`);
        return new Uint8Array(await res.arrayBuffer());
      });
      // 取消的尝试不留缓存（失败即出表，memoizedFullRead 同纪律）
      bytes.catch(() => {
        if (bytes !== null) bytes = null;
      }).catch(() => {});
      return bytes;
    }
```

（`bytes.catch(...)` 的第二个 `.catch(() => {})` 防未处理 rejection；createSingleFileStore 的 read 同 localFiles：开头 aborted 即 reject。）

`packages/core/src/dispatch/dispatcher.ts`——DispatchRead 类型与 renderCtx.read：

```ts
export type DispatchRead = (range?: ByteRange, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
```

renderCtx（streaming 分支）：

```ts
          read: (r, signal) =>
            read!(r, signal).catch((err: unknown): never => {
              if (signal?.aborted) throw err; // destroy 取消：非读失败，不标 DispatchReadError
              throw new DispatchReadError(err);
            })
```

`apps/web/src/lib/ViewerPane.svelte`——dispatch 的 read 闭包：

```ts
          read: (range, signal) =>
            current.source.store.read(
              current.source.path,
              (range || signal) ? { ...(range ? { range } : {}), ...(signal ? { signal } : {}) } : undefined
            )
```

（若 store.read 的 opts 类型在调用处报 optional chain 不匹配，等价写法：`range !== undefined || signal !== undefined ? { range, signal } : undefined`——TS 会收窄可选字段。）

- [ ] **Step 4: 跑测试与既有套件**

Run: `pnpm vitest run packages/core/test/tree-signal.test.ts && pnpm vitest run packages/core && pnpm typecheck`
Expected: 新用例 PASS；core 既有套件 PASS；typecheck 0E。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/tree/remote.ts packages/core/src/tree/singleFile.ts packages/core/src/tree/localFiles.ts packages/core/src/dispatch/dispatcher.ts packages/core/test/tree-signal.test.ts apps/web/src/lib/ViewerPane.svelte
git commit -m "feat(core): TreeStore/StreamCtx read 契约增可选 signal——destroy 时取消在飞读的地基"
```

---

### Task 2: BlockStream signal 透传

**Files:**
- Modify: `packages/render-text/src/blockStream.ts`（options 增 signal；fetchBlock/prefetchThrough 的 ctx.read 透传）
- Test: `packages/render-text/test/blockStream.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `StreamCtx.read(range, signal?)`。
- Produces: `BlockStreamOptions { maxBlocks?: number; signal?: AbortSignal }`——构造期传入一次，`block/has/ensureBlock/prefetchThrough/atEnd` 签名全部不变。

- [ ] **Step 1: 写失败测试**

在 `packages/render-text/test/blockStream.test.ts` 追加（沿用该文件既有的直返 ctx 构造风格）：

```ts
it('signal：构造期传入，ensureBlock 的在飞读被 abort 后 reject（AbortError 原样上抛）', async () => {
  const controller = new AbortController();
  const ctx: StreamCtx = {
    size: 1_000_000,
    head: bytes(8192),
    read: (r, signal) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        );
        // 永不 resolve：模拟挂起
      })
  };
  const bs = createBlockStream(ctx, 256 * 1024, { signal: controller.signal });
  const p = bs.ensureBlock(1);
  controller.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
});
```

（`bytes` helper 若该文件无此名，用现有测试的 head 构造方式等价替换。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/blockStream.test.ts`
Expected: FAIL——options 无 signal 字段，read 收不到 signal，promise 永挂导致超时失败。

- [ ] **Step 3: 实现**

`blockStream.ts` 的 options 与构造：

```ts
export interface BlockStreamOptions {
  maxBlocks?: number;
  /** 构造期传入的取消信号：透传给每次 ctx.read——宿主实例 destroy 时 abort 在飞读 */
  signal?: AbortSignal;
}
```

`createBlockStream` 内取 `const externalSignal = opts?.signal;`，`fetchBlock` 的读调用：

```ts
    const chunk = await ctx.read({ start: i * blockSize, end: i * blockSize + cap - 1 }, externalSignal);
```

200-回退的全量重取同透传：

```ts
      fullReload ??= ctx
        .read({ start: 0, end: Number.MAX_SAFE_INTEGER }, externalSignal)
        .catch((err: unknown) => {
          fullReload = null;
          throw err;
        });
```

`prefetchThrough` 内的 fetchBlock 不需改（经 fetchBlock 已透传）。inflight 语义不变：abort reject 走既有失败清理路径（`inflight.delete` + 上抛）。

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run packages/render-text/test/blockStream.test.ts && pnpm vitest run packages/render-text/test/jsonl-window.test.ts packages/render-text/test/code.test.ts`
Expected: PASS（新用例 + 既有窗口契约用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add packages/render-text/src/blockStream.ts packages/render-text/test/blockStream.test.ts
git commit -m "feat(render-text): BlockStream 构造期 signal 透传 ctx.read——abort 在飞块读"
```

---

### Task 3: 渲染器 AbortController 接线（code + jsonl）

**Files:**
- Modify: `packages/render-text/src/code.ts`（renderCodeWindowed：controller、createBlockStream 传参、destroy abort、catch 静默）
- Modify: `packages/render-text/src/jsonl/index.ts`（renderJsonl 窗口模式同款）
- Test: `packages/render-text/test/code.test.ts`（追加）、`packages/render-text/test/jsonl-render.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `BlockStreamOptions.signal`；Task 1 的 abort-不标-DispatchReadError 包装。
- Produces: 实例 `destroy()` 后在飞读 ≤ 一拍内 abort；abort 后泵/续读/扫描的 catch 静默 return（不置 continueFailed/reloadFailed、不打印错误）。

- [ ] **Step 1: 写失败测试（code 侧）**

`packages/render-text/test/code.test.ts` 追加（参照该文件既有 renderCode + stubResizeObserver 形态）：

```ts
it('destroy 取消在飞读：signal aborted，泵 catch 静默（continueFailed 闩不置位）', async () => {
  stubResizeObserver();
  const debugSpy = vi.spyOn(console, 'debug');
  let sawSignal: AbortSignal | undefined;
  const ctx: StreamCtx = {
    size: 5 * 256 * 1024,
    head: full.slice(0, 8192),
    read: (r, signal) => {
      sawSignal = signal;
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
  };
  const inst = renderCode(full.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
  await vi.waitFor(() => expect(sawSignal).toBeDefined(), { timeout: 2_000 });
  inst.destroy();
  // 断言 1：destroy 后实例持有的 signal 立即 aborted（不等读自然结束）
  await vi.waitFor(() => expect(sawSignal!.aborted).toBe(true), { timeout: 2_000 });
  // 断言 2：泵 catch 静默——不打印「后台索引泵拉块失败」（abort ≠ 读失败）
  expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('后台索引泵拉块失败'), expect.anything());
  debugSpy.mockRestore();
});
```

实现说明给执行者：测试里不需要外部 controller（controller 归实例内部）；断言两点——①destroy 后 `sawSignal.aborted === true`；②泵的 catch 分支静默（console.debug 不含停机文案）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/code.test.ts`
Expected: FAIL——read 收到 undefined signal、destroy 后 signal 不 abort。

- [ ] **Step 3: 实现（code.ts）**

renderCodeWindowed 内（createBlockStream 调用处之前）：

```ts
  const readAbort = new AbortController(); // 实例级：destroy 时取消全部在飞块读
```

createBlockStream 调用：

```ts
  const bs = createBlockStream(ctx, CODE_WINDOW_BLOCK_BYTES, {
    maxBlocks: CODE_STREAM_MAX_BLOCKS,
    signal: readAbort.signal
  });
```

destroy() 开头（`destroyed = true` 之后）：

```ts
      readAbort.abort(); // 在飞块读即时取消（DEG-08 排队根因的修复面）
```

三个 catch 点（pumpTick 的 async 块、maybeContinue 续读、runScan 续读）在 `continueFailed = true` 前加静默分支：

```ts
      } catch (err) {
        if (readAbort.signal.aborted) return; // destroy 取消：静默，闩不动（spec §3.4）
        continueFailed = true;
        console.debug('[code] 后台索引泵拉块失败，已停机（滚动后重试）', err);
      }
```

（maybeContinue 的续读 catch 与回看重拉 catch、runScan 的续读 catch 同型处理；`readAbort.signal.aborted` 时 `return` 前无需 `pulling = false`——finally 已有；回看重拉的 catch 在 abort 时也不回填 pendingReload。）

- [ ] **Step 4: jsonl 同款实现**

`packages/render-text/src/jsonl/index.ts` 的窗口模式（createBlockStream 调用点）：同样建 `readAbort`、传 options.signal、`destroy` 调 abort、续读 catch 静默分支（jsonl 的停机闩名与 code 同构，按该文件现名对接）。

- [ ] **Step 5: 跑测试与门禁**

Run: `pnpm vitest run packages/render-text && pnpm typecheck`
Expected: PASS + 0E（render-text 全部单测含既有窗口契约用例）。

- [ ] **Step 6: 提交**

```bash
git add packages/render-text/src/code.ts packages/render-text/src/jsonl/index.ts packages/render-text/test/code.test.ts packages/render-text/test/jsonl-render.test.ts
git commit -m "feat(render-text): code/jsonl 实例级 AbortController——destroy 取消在飞块读，abort 静默不上屏"
```

---

### Task 4: 装置配套 + DEG-08 窗口回收

**Files:**
- Modify: `apps/web/e2e/b-stream-resilience-helpers.ts`（serve 包 try/catch）
- Modify: `apps/web/e2e/b-io-degrade-matrix.spec.ts:517`（窗口 60s→30s，注释更新）
- Verify: 定向 e2e（SCAN/IO/DEG/JVL 四域）

**Interfaces:**
- Consumes: Task 1–3 的取消链。
- Produces: 阶段 A 完整闭环；DEG-08 在 30s 窗口下 CI 可绿。

- [ ] **Step 1: 装置 try/catch**

`startStreamFakeServer` 的 `serveSlice` 与两处 rangeless 200 分支的 serve 函数体包裹（三个 serve 块同型）：

```ts
        const serve = (): void => {
          try {
            /* 原 writeHead/end 逻辑不变 */
          } catch {
            // 客户端已 abort（destroy 取消常态化后）：断管写入静默
          }
        };
```

- [ ] **Step 2: DEG-08 窗口回收**

`b-io-degrade-matrix.spec.ts` 的 517 断言 `timeout: 60_000` 改回 `30_000`，注释段替换为：

```ts
    // 30s 窗口（signal 贯穿落地后回收，spec 2026-10-15 §3.6）：destroy 即取消旧实例
    // 在飞块读，不再等 30s 读超时释放连接——行上屏回归重渲染自身耗时（探针+块 0 两
    // RTT）。原 60s 宽限（旧读排队机制）已由产品修复消除。
```

- [ ] **Step 3: 重建 + 定向 e2e**

Run: `cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && CI=true npx playwright test e2e/b-io-degrade-matrix.spec.ts e2e/b-code-scan-resilience.spec.ts e2e/b-io-streaming.spec.ts e2e/b-jsonl-degrade-chain.spec.ts --project=chromium --retries=0`
Expected: 全绿（DEG-08 在 30s 窗口下通过）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/e2e/b-stream-resilience-helpers.ts apps/web/e2e/b-io-degrade-matrix.spec.ts
git commit -m "test(e2e): 装置 abort 写入静默 + DEG-08 窗口回收 30s——signal 贯穿闭环"
```

---

### Task 5: SUSP-01 退出搜索缓存保留

**Files:**
- Modify: `packages/render-text/src/code.ts`（search() 空 query 分支）
- Modify: `apps/web/e2e/b-susp-verify.spec.ts`（SUSP-01 探针翻转）
- Test: `packages/render-text/test/code.test.ts`（追加短路缓存单测）

**Interfaces:**
- Consumes: search() 既有的 `sameKey && lastScanComplete` 短路（不改）。
- Produces: 空 query 不再重置 `lastScanComplete/lastAcc/lastScanCursor/lastQuery/lastCaseSensitive/lastMatches`；视觉清理（clearHit + refresh）不变。

- [ ] **Step 1: 写失败单测**

code.test.ts 追加（参照既有 search 单测形态；泵 pause 后驱动）：

```ts
it('SUSP-01：退出搜索（空 query）不作废短路缓存——同词重搜零块级拉取', async () => {
  codeWindowedPumpControls.get(handle)!.pause();
  // 打开 → 首词全文扫描完成（lastScanComplete=true）→ search('') → 再搜同词
  // 断言：第二次同词 search() 的 Promise 立即 resolve（零 IO），IO 计数不变
  const reads0 = readCount();
  await handle.search(NEEDLE);
  const readsAfterFirst = readCount();
  expect(readsAfterFirst).toBeGreaterThan(reads0); // 首扫有真实 IO
  await handle.search('');
  void handle.search(NEEDLE); // 短路：同步 resolve 路径
  expect(readCount()).toBe(readsAfterFirst); // 零新增读
});
```

（`readCount` 用该文件既有的 read 计数 ctx helper；若无则在本用例内以自建计数 ctx 实现——参照同文件首屏最小 IO 用例的计数法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/code.test.ts`
Expected: FAIL——现状 `search('')` 重置缓存，第二次同词发起真实扫描，readCount 增长。

- [ ] **Step 3: 实现**

code.ts `search()`：把换键重置块（`lastAcc = []` 等）移入「真换键」判定——`query !== '' && !sameKey`；空 query 分支保持令牌失效（`const mySeq = ++scanSeq; scan = null;`）与 `clearHit()`，删除其对缓存的间接作废。关键结构：

```ts
    search(query, searchOpts?: { caseSensitive?: boolean }) {
      const caseSensitive = searchOpts?.caseSensitive === true;
      const key = `${caseSensitive ? '1' : '0'}\u0000${query}`;
      if (scan !== null && scan.key === key) return scan.promise;
      const sameKey = scan === null && query === lastQuery && caseSensitive === lastCaseSensitive;
      if (sameKey && lastScanComplete) return Promise.resolve(lastMatches);
      const mySeq = ++scanSeq;
      scan = null;
      if (hitTimer !== null) { clearTimeout(hitTimer); hitTimer = null; }
      hitLine = -1;
      if (query !== '' && !sameKey) {
        // 真换键：命中集/行级背景/进度游标全量重置（空 query 退出不再进入此分支——
        // SUSP-01：退出搜索保留短路缓存，同词重搜零读）
        lastAcc = [];
        lastMatches = lastAcc;
        searchHitsByLine = new Map();
        lastQuery = query;
        lastCaseSensitive = caseSensitive;
        lastScanCursor = 0;
      }
      if (query === '') {
        continueFailed = false; // 退出即用户动作：解除续读停机（既有口径保留）
        if (!sameKey) { lastQuery = ''; lastCaseSensitive = caseSensitive; lastScanCursor = 0; }
        clearHit();
        scroller?.refresh(true);
        return Promise.resolve([]);
      }
      // ……runScan 启动不变
```

语义要点：空 query 时 `lastScanComplete` 保持原值（完成态保留供同词短路；未完成态供续扫）；`lastQuery` 更新为 '' 使「退出后换新词」走换键分支（`sameKey` 为 false）。

- [ ] **Step 4: 探针翻转（e2e）**

`b-susp-verify.spec.ts` 的 SUSP-01 用例：将「重输同词，断言块级请求 ≥20（含末块块 39）」翻转为「重输同词，断言块级新增请求 = 0（≤ 对照面同键重搜）」。用例标题与注释同步改写（SUSP-01 已优化落地）。

- [ ] **Step 5: 跑测试 + 重建 + SUSP 域定向**

Run: `pnpm vitest run packages/render-text/test/code.test.ts && cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && CI=true npx playwright test e2e/b-susp-verify.spec.ts --project=chromium --retries=0`
Expected: PASS（翻转后的 SUSP-01 探针 + SUSP 域其余探针零回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/render-text/src/code.ts packages/render-text/test/code.test.ts apps/web/e2e/b-susp-verify.spec.ts
git commit -m "fix(render-text): 退出搜索保留短路缓存——SUSP-01 同词重搜零读（探针翻转）"
```

---

### Task 6: SUSP-03 jsonl 降级视口锚定

**Files:**
- Modify: `packages/render-text/src/jsonl/index.ts`（renderJsonl 窗口模式：降级出口前记 `curFirst`，新实例 mount 后恢复）
- Modify: `apps/web/e2e/b-susp-verify.spec.ts`（SUSP-03 探针翻转）
- Test: `packages/render-text/test/jsonl-render.test.ts`（追加）

**Interfaces:**
- Consumes: 窗口循环的 `curFirst`（update() 维护的可视首行）；全量实例 DOM 的 `[data-line]`；renderCode 的 `revealLine`。
- Produces: 降级后可视首行 ≈ 降级前首行。

- [ ] **Step 1: 写失败单测**

jsonl-render.test.ts 追加（参照既有嗅探降级用例的脏字节构造）：

```ts
it('SUSP-03：嗅探降级重渲后视口锚定原首行（不回顶）', async () => {
  // 构造：首块干净 utf-8 + 深处脏块（触 sniff）→ 打开 → 滚到中部 → 等降级完成
  // 断言：降级后（.vv-jsonl-scroll 或全量容器）可视内容含降级前 curFirst 对应行文本，
  // 且 scrollTop 对应行号 ≈ 降级前行号（±overscan 容差），非 0
});
```

（执行者按该文件既有降级用例的夹具复用；断言锚定为「data-line≈锚行的卡片在视口内」。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/jsonl-render.test.ts`
Expected: FAIL——降级后 scrollTop=0（现状）。

- [ ] **Step 3: 实现**

renderJsonl 窗口模式的降级调用点（嗅探判脏后调 `opts.onEncodingBroken` 处）：调用前捕获 `const anchorLine = curFirst;`；回调返回新实例后恢复。恢复分两形态：

```ts
      // 委托 code（>200MB）：revealLine 定位（0 基行号同口径）
      const reveal = (inst as { revealLine?: (line: number) => void }).revealLine;
      if (typeof reveal === 'function') reveal.call(inst, anchorLine);
      // 全量 jsonl：按行号定位卡片 offsetTop 恢复滚动（可变行高——不用 scrollTop 直译）
      const el = newScrollHost.querySelector(`[data-line="${anchorLine}"]`);
      if (el) newScrollHost.scrollTop = (el as HTMLElement).offsetTop;
```

（`newScrollHost` = 新实例的滚动容器；全量路径 DOM 的滚动容器名按 renderJsonl 全量分支现状对接。`onEncodingBroken` 签名若需传出锚行，改为内部闭包捕获——实现者按最小侵入选点，锚定语义不变。）

- [ ] **Step 4: 探针翻转（e2e）**

`b-susp-verify.spec.ts` 的 SUSP-03 用例：断言从「降级后 `.vv-jsonl-scroll` scrollTop === 0」翻转为「降级后可视首行 ≈ 降级前首行（±overscan 容差）」。

- [ ] **Step 5: 跑测试 + 重建 + SUSP 域定向**

Run: `pnpm vitest run packages/render-text/test/jsonl-render.test.ts && cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && CI=true npx playwright test e2e/b-susp-verify.spec.ts e2e/b-jsonl-degrade-chain.spec.ts --project=chromium --retries=0`
Expected: PASS（SUSP-03 翻转 + JVL 域零回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/render-text/src/jsonl/index.ts packages/render-text/test/jsonl-render.test.ts apps/web/e2e/b-susp-verify.spec.ts
git commit -m "fix(render-text): jsonl 降级重渲视口锚定原首行——SUSP-03（探针翻转）"
```

---

### Task 7: SUSP-02 扫描期视口块触新

**Files:**
- Modify: `packages/render-text/src/code.ts`（runScan 喂块落地后触新可视块）
- Modify: `apps/web/e2e/b-susp-verify.spec.ts`（SUSP-02 探针翻转）
- Test: `packages/render-text/test/code.test.ts`（追加）

**Interfaces:**
- Consumes: `bs.block(b)`（自带 LRU touch）、`lineBlockSpan(i)`、scroller 的 `curFirst/curLast` 对应物（code 侧为 onRange 维护的 first/last 或 scroller 内部状态——取渲染器实际持有的可视范围变量）。
- Produces: 扫描喂块后视口所需块均在 LRU 表尾（不被扫描新块挤出）。

- [ ] **Step 1: 写失败单测**

code.test.ts 追加：

```ts
it('SUSP-02：扫描推进期视口块被触新——不触发回看重拉（pendingReload 恒空）', async () => {
  // maxBlocks 收紧到最小（如 4）制造挤出压力：打开（视口在块 0）→ 触发全文扫描
  // 断言：扫描全程 pendingReload 不登记视口块（借 lineAvailable 不 false 化视口行）
  // 现状：扫描新块挤出块 0 → 视口行占位化 → 翻转后：视口行恒实卡
});
```

（执行者按既有 SCAN 域单测的 maxBlocks/扫描驱动方式对接；断言核心=扫描完成时视口首行所需块仍驻留、未发生视口行占位化。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/code.test.ts`
Expected: FAIL——现状扫描推进挤出视口块。

- [ ] **Step 3: 实现**

code.ts runScan 内圈「喂块落地」点（`await pullBlock()` 之后、循环 continue 前）加触新：

```ts
        // SUSP-02：扫描新块落地后对可视区所需块 LRU 触新（bs.block 自带 touch）——
        // 视口 2-3 块挪表尾后，扫描前沿新块不再将其挤出（占位化闪烁根因）
        for (let v = visFirst; v <= Math.min(visLast, rows() - 1); v++) {
          const len = index.lengths[v] ?? 0;
          if (len === 0) continue;
          const [b0, b1] = lineBlockSpan(v);
          for (let b = b0; b <= b1; b++) if (bs.has(b)) bs.block(b);
        }
```

（`visFirst/visLast` 为渲染器持有的当前可视行范围变量——对接 code.ts onRange 实际维护的形态；若无现成变量，在 onRange 里补两个模块级let。）

- [ ] **Step 4: 探针翻转（e2e）**

`b-susp-verify.spec.ts` 的 SUSP-02 用例：断言从「同一次续扫内回看重拉 ≥2 次」翻转为「<2 次（0 为理想）」。

- [ ] **Step 5: 跑测试 + 重建 + 定向**

Run: `pnpm vitest run packages/render-text/test/code.test.ts && cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && CI=true npx playwright test e2e/b-susp-verify.spec.ts e2e/b-code-scan-resilience.spec.ts --project=chromium --retries=0`
Expected: PASS（SUSP-02 翻转 + SCAN 域零回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/render-text/src/code.ts packages/render-text/test/code.test.ts apps/web/e2e/b-susp-verify.spec.ts
git commit -m "fix(render-text): 扫描喂块后触新视口块——SUSP-02 去占位闪烁（探针翻转）"
```

---

### Task 8: SUSP-06 doPrepare 顺序微优化

**Files:**
- Modify: `packages/highlight/src/core-parse.ts`（doPrepare：resolveGrammarEntry 前置）
- Modify: `apps/web/e2e/b-susp-verify.spec.ts`（SUSP-06 探针翻转）
- Test: `packages/highlight/test/`（追加；对齐该目录既有 engine 测试文件名）

**Interfaces:**
- Consumes: `resolveGrammarEntry(lang)`（既有私有方法）。
- Produces: grammar 条目缺失时零 query 资产请求；条目存在路径行为逐字节不变。

- [ ] **Step 1: 写失败测试**

highlight 测试目录追加（用同源 manifest 剥离条目的既有夹具形态，报告 SUSP-06 同构）：

```ts
it('SUSP-06：grammar 条目缺失时不发 query 资产请求（resolveGrammarEntry 前置）', async () => {
  // manifest 无 java 条目 → highlight('x', 'java')
  // 断言：query 源的请求计数 =0（现状 expandQueryAsync 先行会 ≥1）；结果仍 ok:false/回退
});
```

（执行者按该目录既有「剥离条目」用例的 manifest/queries 源夹具对接。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/highlight/test/`
Expected: FAIL——query 请求计数 ≥1。

- [ ] **Step 3: 实现**

doPrepare 重排：

```ts
  private async doPrepare(lang: string): Promise<PreparedLanguage | null> {
    // SUSP-06：条目判定前置——grammar 缺失时零 query 资产请求（此前 expandQueryAsync
    // 先行，同源 manifest 剥离条目时 /queries/** 空打）
    const entry = this.resolveGrammarEntry(lang);
    if (!entry) return null;
    let expanded: ExpandedQuery | null;
    if (this.remoteQueries) {
      expanded = await expandQueryAsync(this.remoteQueries, lang);
    } else {
      expanded = expandQuery(this.assets, lang);
    }
    if (!expanded) return null;
    const language = await Language.load(joinPath(entry.base ?? this.grammarsBase, entry.file));
    // ……toQuery 与返回不变
```

- [ ] **Step 4: 探针翻转（e2e）**

`b-susp-verify.spec.ts` 的 SUSP-06 用例：断言从「/queries/java/** 请求 ≥1」翻转为「=0」；「java.wasm 零请求」「java 降级 hljs」对照断言保留。

- [ ] **Step 5: 跑测试 + 重建 + 定向**

Run: `pnpm vitest run packages/highlight/test/ && cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && CI=true npx playwright test e2e/b-susp-verify.spec.ts e2e/b-grammar-spa-fallback.spec.ts --project=chromium --retries=0`
Expected: PASS（SUSP-06 翻转 + GRF 域零回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/highlight/src/core-parse.ts packages/highlight/test/ apps/web/e2e/b-susp-verify.spec.ts
git commit -m "perf(highlight): doPrepare 条目判定前置——SUSP-06 消除 grammar 缺失时的 query 空打（探针翻转）"
```

---

### Task 9: worker init 阶段化探针（spike）

**Files:**
- Modify: `packages/highlight/src/worker.ts`（init-progress 消息类型 + serveWorker 打点）
- Modify: `packages/highlight/src/core-parse.ts`（TreeSitterEngine.create 接可选 onProgress 回调）
- Modify: `packages/highlight/src/client.ts`（构造参数透传 debug 开关；onmessage 处理 init-progress → console.debug）
- Modify: `apps/web/src/lib/`（highlight client 构造处透传 `?vvWorkerDebug=1` 开关——对接现有构造点）
- Test: `packages/highlight/test/client.test.ts`（追加协议用例）

**Interfaces:**
- Consumes: 既有 `{kind:'init'}` 握手协议。
- Produces: 新消息 `{ kind: 'init-progress', stage: string, detail?: string }`；开关关闭（缺省）时零打点零消息，行为逐字节不变。

- [ ] **Step 1: 写失败测试**

client.test.ts 追加：

```ts
it('init-progress：debug 开关下 worker 阶段帧透传为 console.debug；无开关零消息', async () => {
  // 假 worker：serveWorker 直调形态（该文件既有测试装置）
  // 断言 1：create 各阶段回调 → onInitProgress 依序到达（wasm-fetch/parser-init/assets/ready）
  // 断言 2：无 debug 开关时 onInitProgress 恒不被调用
});
```

（执行者按该文件既有的假 worker/engine stub 形态对接。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/highlight/test/client.test.ts`
Expected: FAIL——无 init-progress 通道。

- [ ] **Step 3: 实现**

core-parse.ts——create 增可选回调，各阶段调用：

```ts
export interface EngineInitProgress { stage: 'wasm-fetch' | 'parser-init' | 'assets' | 'ready'; detail?: string }

  static async create(opts: EngineOptions & { onInitProgress?: (p: EngineInitProgress) => void }): Promise<TreeSitterEngine> {
    const report = opts.onInitProgress;
    const runtimeDir = opts.runtimeDir ?? opts.grammarsBase ?? opts.grammarsDir ?? '';
    report?.({ stage: 'wasm-fetch', detail: `runtimeDir=${runtimeDir}` });
    if (!initPromise) {
      initPromise = Parser.init({ locateFile: (file: string) => joinPath(runtimeDir, file) }).catch((e) => {
        initPromise = null;
        throw e;
      });
    }
    await initPromise;
    report?.({ stage: 'parser-init' });
    // ……grammarTable/assets 就绪后：
    report?.({ stage: 'assets', detail: `queries=${assets.size ?? 0}` });
    const engine = new TreeSitterEngine(assets, grammarTable, opts);
    report?.({ stage: 'ready' });
    return engine;
```

worker.ts——init 处理透传：

```ts
      handler = initWorker({
        ...data,
        onInitProgress: (p) => ctx.postMessage({ kind: 'init-progress', stage: p.stage, detail: p.detail })
      } as WorkerInit)
```

（`onInitProgress` 不进 WorkerInit 契约——结构化克隆函数会丢，initWorker 内部以闭包注入；实现时把 data 解构为 init 配置 + 回调两份。）

client.ts——构造 opts 增 `debug?: boolean`：`onmessage` 收到 `{kind:'init-progress'}` 时 `console.debug('[vviewer-worker]', stage, detail)`（markWorkerAlive 不触发——进度帧不计为存活证据，看门狗语义不变）。

apps/web 侧构造点：`debug: new URLSearchParams(location.search).has('vvWorkerDebug')`。

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run packages/highlight/test/ && pnpm typecheck`
Expected: PASS + 0E。

- [ ] **Step 5: 提交**

```bash
git add packages/highlight/src/worker.ts packages/highlight/src/core-parse.ts packages/highlight/src/client.ts apps/web/src/lib/ packages/highlight/test/client.test.ts
git commit -m "feat(highlight): worker init 阶段化探针（vvWorkerDebug 开关）——挂点定位取证面（spike）"
```

- [ ] **Step 6: spike 结论记录（执行时操作）**

本机按已知条件（真实网络 + 完整合并表）复现挂起，`?vvWorkerDebug=1` 读打点，结论写入 spec 的回填节（阶段 F 产出）；若本机不复现，记录「复现条件未触发」并在 CI 下轮观察 artifact console。

---

### Task 10: 收尾全量门禁

**Files:** 无新改动（验证 + 修复面）。

- [ ] **Step 1: 全量门禁（后台跑）**

Run: `pnpm typecheck && pnpm vitest run`（仓库根）
Run: `cd server && cargo test`
Run: `cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && CI=true npx playwright test --project=chromium --retries=0 && CI=true npx playwright test --project=mobile --retries=0`
Expected: 全绿。

- [ ] **Step 2: 有红即修**

任何失败：定位→修复→重跑该域+全量确认，修复单独提交。

- [ ] **Step 3: spec 回填节更新**

阶段 F 结论回填 spec §8（挂点/复现条件/修复建议），若结论为「待 CI 观察」如实记录。
