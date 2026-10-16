# 错误身份与字节映射基建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** core 侧建立 dispatch 错误身份单源模块（errors.ts）并统一三处 catch 面的 abort 过滤，同时为 code 全量模式新增字节域行索引 `lineAtByteOffset`、jsonl 委托锚行换算升级为三级回退，消灭 isAbortError 双镜像与锚行字节直传字符域的两支近似。

**Architecture:** 新建 `packages/core/src/dispatch/errors.ts` 承载 `isAbortError`（自 render-text 迁入）/`DispatchReadError`（自 dispatcher 迁出）/`abortReadError()`（tree 层三处内联抛出的单源化）/`classifyDispatchError`（纯身份三分类）；dispatcher 的主 catch、retry catch、openAsAction catch 全部改走分类层；render-text 的 code.ts 改 re-export 保持导入面零变动。字节域索引在 code 全量模式解码前对原始 buffer 扫描一次（post-BOM、终结符语义对齐 code 字符域行号），jsonl `restoreViewportAfterDegrade` 按 `lineAtByteOffset → lineAtOffset → 内容行号` 三级鸭子探测回退。

**Tech Stack:** TypeScript（core/render-text/web 三包）+ vitest（jsdom，必须仓库根跑：`pnpm vitest run <file>`——包目录直跑缺 jsdom）。

**Spec:** docs/superpowers/specs/2026-10-16-error-identity-byte-mapping-design.md（plan 阶段勘误已并入：classify 为纯身份判定，无 ctx 状态兜底）

## Global Constraints

- 文中行号为 HEAD 7c9415c 参考，实施时以符号定位为准；改动前先读目标代码确认现文。
- vitest 必须在仓库根执行（`pnpm vitest run packages/core/test/errors.test.ts` 形态）；包目录直跑会因缺 jsdom 环境失败。
- 每任务原子提交，commit message 用 Angular 规范、先 why 后 what。
- 判定语义铁律：取消身份判定=纯错误身份（isAbortError），不看 catch 时刻 signal 状态（Task 3 既有裁决，spec §6 勘误）；`dispatcher.ts` 读包装处的 `signal?.aborted` 检查（现 :384）**原位保留不动**。
- 既有测试是契约锚：六形态判定矩阵（code.test.ts）、dispatch abort 不上屏矩阵（dispatcher.test.ts）、tree-signal.test.ts、jsonl 委托锚行两用例（jsonl-render.test.ts:1016-1106）全数保持绿（除本计划显式新增断言外零变更）。

---

### Task 1: core errors.ts 单源模块

**Files:**
- Create: `packages/core/src/dispatch/errors.ts`
- Modify: `packages/core/src/index.ts`（`export * from './dispatch/dispatcher';` 行后追加一行）
- Test: `packages/core/test/errors.test.ts`（新建）

**Interfaces:**
- Consumes: 无（新建基座）。
- Produces（后续任务依赖的精确签名）:
  - `isAbortError(err: unknown): boolean`
  - `class DispatchReadError extends Error { constructor(err: unknown) }`（name='DispatchReadError'）
  - `abortReadError(): Error`（返回 `new DOMException('读取已取消', 'AbortError')`）
  - `classifyDispatchError(err: unknown): 'abort' | 'read' | 'generic'`
  - 以上经 `@vviewer/core` 包根导出。

- [ ] **Step 1: 写失败测试**

新建 `packages/core/test/errors.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  abortReadError,
  classifyDispatchError,
  DispatchReadError,
  isAbortError
} from '../src/dispatch/errors';

describe('classifyDispatchError（错误身份与字节映射：纯身份三分类）', () => {
  it('AbortError 双形态 → abort（jsdom DOMException 非 Error 子类环境兜底形态并判）', () => {
    expect(classifyDispatchError(new DOMException('读取已取消', 'AbortError'))).toBe('abort');
    expect(classifyDispatchError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('abort');
  });

  it('DispatchReadError → read（其 message 来自被包装原始错误，身份由 name 判别）', () => {
    const e = new DispatchReadError(new Error('net down'));
    expect(e.name).toBe('DispatchReadError');
    expect(e.message).toBe('net down');
    expect(classifyDispatchError(e)).toBe('read');
  });

  it('普通 Error / 非 Abort 的 DOMException / 非 Error 值 → generic', () => {
    expect(classifyDispatchError(new Error('boom'))).toBe('generic');
    expect(classifyDispatchError(new DOMException('普通 DOM 异常', 'SyntaxError'))).toBe('generic');
    expect(classifyDispatchError('str')).toBe('generic');
    expect(classifyDispatchError(null)).toBe('generic');
    expect(classifyDispatchError(undefined)).toBe('generic');
  });

  it('abortReadError：统一抛出形态（DOMException AbortError「读取已取消」，isAbortError 恒真）', () => {
    const e = abortReadError();
    expect(e.name).toBe('AbortError');
    expect(e.message).toBe('读取已取消');
    expect(isAbortError(e)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/errors.test.ts`
Expected: FAIL（模块 `../src/dispatch/errors` 不存在）

- [ ] **Step 3: 实现 errors.ts**

新建 `packages/core/src/dispatch/errors.ts`（isAbortError 函数体与 doc 自 `render-text/src/code.ts:14-29` 逐字迁入；DispatchReadError 自 `dispatcher.ts:47-52` 迁入并补 doc）：

```ts
/**
 * dispatch 错误身份单源（spec 2026-10-16 错误身份与字节映射 §4.1）：isAbortError /
 * DispatchReadError / abortReadError / classifyDispatchError 四件的唯一实现处。
 * 此前 isAbortError 在 render-text code.ts 与 dispatcher.ts 各有一份逐字镜像（靠
 * 注释 + 双侧测试人工同步），WorkspaceCreateModal 另有第三份内联单支变体；tree 层
 * 统一抛出形态在三处 store 各写一遍。本模块收口后，render-text 以 re-export 保持
 * 导入面零变动（依赖方向 render-text → core 合法，core 不反向依赖）。
 */

/**
 * 取消错误身份判定（deferred 清偿 Task 3 语义原样迁入）：err 是否为取消（AbortError
 * 形态）。双形态兼容：标准环境 DOMException instanceof Error 成立（WHATWG 继承链），
 * 但 jsdom 等环境的 DOMException 未必是 Error 子类，故两支并判。判定=纯错误身份，
 * 不看 catch 时刻 signal.aborted 状态（「真实读失败 + abort 竞态」不误吞）。
 */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * 读失败标记类（自 dispatcher.ts 迁入，形态不变）：dispatch 延迟全量读/流式按需读
 * 失败的标记。包装后由 dispatch catch 识别并向上 reject（调用方既有读取失败面承接，
 * 无重试通道），与策略读的失败语义对齐。
 */
export class DispatchReadError extends Error {
  constructor(err: unknown) {
    super(err instanceof Error ? err.message : String(err));
    this.name = 'DispatchReadError';
  }
}

/** 统一抛出形态（Task 1 既有约定的单源化）：tree 层 localFiles/singleFile/localFs
 * 预 abort 抛出的既定形态（isAbortError 身份判定恒静默不误吞读失败）。 */
export function abortReadError(): Error {
  return new DOMException('读取已取消', 'AbortError');
}

export type DispatchErrorKind = 'abort' | 'read' | 'generic';

/**
 * 错误分类（纯身份，spec §4.1 勘误）：abort=取消（不上屏）；read=读失败（向上
 * reject，无重试通道）；generic=其余渲染失败（错误卡片 + retry/open-as）。
 * 不设 ctx.signal 状态兜底：StreamCtx 无 signal 承载字段（signal 仅按读调用传递），
 * 且状态兜底与六处收紧「身份优先」裁决相抵；dispatcher 读包装处的 signal.aborted
 * 检查留在标注点原位，不进分类层。
 */
export function classifyDispatchError(err: unknown): DispatchErrorKind {
  if (isAbortError(err)) return 'abort';
  if (err instanceof DispatchReadError) return 'read';
  return 'generic';
}
```

`packages/core/src/index.ts` 在 `export * from './dispatch/dispatcher';` 之后追加：

```ts
export * from './dispatch/errors';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/test/errors.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/dispatch/errors.ts packages/core/src/index.ts packages/core/test/errors.test.ts
git commit -m "feat(core): 新增 dispatch 错误身份单源模块 errors.ts

why：isAbortError 在 render-text 与 dispatcher 双镜像靠注释人工同步，
WorkspaceCreateModal 另有单支内联变体已现口径漂移；tree 层统一抛出形态三处复制。
what：errors.ts 收口 isAbortError/DispatchReadError/abortReadError/
classifyDispatchError（纯身份三分类），经包根导出。"
```

---

### Task 2: dispatcher 三处 catch 面接入分类层

**Files:**
- Modify: `packages/core/src/dispatch/dispatcher.ts`（删 :47-66 本地 DispatchReadError/isAbortError；主 catch :391-402 改分类 switch；retry catch :167-173 补 abort 过滤；openAsAction catch :134-138 补 abort 过滤）
- Test: `packages/core/test/dispatcher.test.ts`（abort 不上屏 describe 后新增 retry-abort 用例）

**Interfaces:**
- Consumes: Task 1 的 `classifyDispatchError` / `DispatchReadError` / `isAbortError`（`./errors` 相对导入，不走红包根以保持模块内聚亦可——统一用 `./errors`）。
- Produces: dispatch 行为变更两处——重试被取消不再重画卡片；open-as 重入被取消不再 console.error。对外接口（dispatch 签名）零变化。

- [ ] **Step 1: 写失败测试（retry-abort 不上屏）**

`packages/core/test/dispatcher.test.ts` 的 `describe('dispatch abort 不上屏（deferred 清偿 Task 5）')` 之后新增（沿用文件既有 `createRegistry`/`mk`/`source` helper）：

```ts
describe('dispatch retry/open-as 的 abort 过滤（错误身份与字节映射 Task 2）', () => {
  it('重试被取消：不重画卡片、原卡保留在屏（现状红——会把「读取已取消」画回卡片）', async () => {
    const reg = createRegistry();
    let calls = 0;
    reg.install(mk('code', ['txt'], {
      render: async () => {
        calls += 1;
        if (calls === 1) throw new Error('首次渲染失败');
        throw new DOMException('读取已取消', 'AbortError');
      }
    }));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(target.querySelector('.vv-error-card'), '前置：首次失败已落卡').not.toBeNull();
    const retryBtn = [...target.querySelectorAll<HTMLButtonElement>('.vv-error-action')]
      .find((b) => b.textContent === '重试');
    expect(retryBtn, '前置：卡片含重试按钮').toBeDefined();
    retryBtn!.click();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(target.textContent, '取消文案不得上屏').not.toContain('读取已取消');
    expect(target.querySelector('.vv-error-card'), '原卡保留（不重画也不清空）').not.toBeNull();
  });

  it('open-as 重入被取消：不 console.error 留痕（现状红）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = createRegistry();
    let calls = 0;
    reg.install(mk('code', ['txt'], {
      render: async () => {
        calls += 1;
        if (calls === 1) throw new Error('首次渲染失败');
        throw new DOMException('读取已取消', 'AbortError');
      }
    }));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(source('a.txt'), new TextEncoder().encode('hi'), target);
    const openAsBtn = [...target.querySelectorAll<HTMLButtonElement>('.vv-error-action')]
      .find((b) => b.textContent === '以纯文本打开');
    expect(openAsBtn, '前置：卡片含以纯文本打开按钮').toBeDefined();
    openAsBtn!.click();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    expect(errSpy).not.toHaveBeenCalledWith('[vviewer] open-as 重入失败', expect.anything());
    errSpy.mockRestore();
  });
});
```

注：第二用例是**止跌锚而非真 RED**——本场景的重入 abort 在 dispatch 主 catch 已被
吞为 no-op（dispatch resolve，不进 openAsAction 的 catch），现状下也应绿；过滤器防的
是 try 块外策略读/未来路径的裸 AbortError reject（:43-45 doc 明言策略读在 try 外天然
reject）。用例保留为防回归锚，Step 2 只要求第一用例红。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts`
Expected: 第一用例 FAIL（现状把「读取已取消」画回卡片）；第二用例（止跌锚）现状即绿；
既有用例全绿。

- [ ] **Step 3: 实现 dispatcher 改造**

`dispatcher.ts` 顶部 import 区追加：

```ts
import { classifyDispatchError, DispatchReadError } from './errors';
```

删除 :47-52 的本地 `class DispatchReadError`（整块含 doc 注释，doc 中与 errors.ts 重复部分随迁；「open-as 重入路径同样 reject…」句保留并入 errors.ts 该类 doc 或此处调用点注释均可）与 :54-66 的本地 `function isAbortError`（含 doc 整块——其「同源同形镜像」说明已过时，单源后作废）。

retry catch（:167-173）改为：

```ts
      .catch((err: unknown) => {
        // 取消 ≠ 重试失败（错误身份与字节映射 Task 2，与主 catch「abort 不上屏」
        // 同裁决）：重试被取消时原卡保留在屏，不以「读取已取消」重画
        if (classifyDispatchError(err) === 'abort') return;
        // 重试仍失败：保留错误详情，按钮随之重建（可继续重试/以其他方式打开）
        const message = err instanceof Error ? err.message : String(err);
        showErrorCard(target, message, source, {
          actions: buildRenderErrorActions(registry, renderer, buffer, source, det, target, onRendered, redisplay, ctx)
        });
      });
```

openAsAction catch（:134-138）改为：

```ts
        .catch((err: unknown) => {
          // 取消不属「重入失败」（错误身份与字节映射 Task 2）：不留 error 级痕
          if (classifyDispatchError(err) === 'abort') return;
          console.error('[vviewer] open-as 重入失败', err);
        });
```

主 catch（:391-402）前两分支改为分类 switch（语义逐点等价，注释合并保留）：

```ts
    } catch (err) {
      const kind = classifyDispatchError(err);
      // 读失败 ≠ 渲染失败（T3 评审）：重跑 render 无意义且 catch 手头只有 8KB head
      // 探测块（headOnly 时）——重试会静默截断渲染。向上 reject 走调用方读取失败面。
      if (kind === 'read') throw err;
      // abort 不上屏（deferred 清偿 Task 5 裁决）：（原注释两段保留原样粘贴在此）
      if (kind === 'abort') {
        return { instance: { destroy() {} }, rendererId: errorRenderer.id, det };
      }
```

（其余 generic 分支与函数尾不动。:380-386 读包装的 `signal?.aborted` 检查与注释**原样保留**。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts packages/core/test/errors.test.ts`
Expected: 全 PASS（新增 2 用例转绿，既有矩阵零翻转）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/dispatch/dispatcher.ts packages/core/test/dispatcher.test.ts
git commit -m "fix(core): dispatch 三处 catch 面统一走错误分类层

why：retry/openAs catch 未接 abort 判定——重试被取消会把「读取已取消」画回
错误卡片、open-as 重入被取消留 error 级假痕，与主 catch「abort 不上屏」裁决
不一致；isAbortError/DispatchReadError 本地镜像随单源退役。
what：主 catch 改 classifyDispatchError switch（语义逐点等价），retry/openAs
补 abort 静默过滤；读包装 signal 检查原位保留。"
```

---

### Task 3: 单源迁移（render-text re-export / web / code.ts 第七处 / tree 抛出端）

**Files:**
- Modify: `packages/render-text/src/code.ts`（:14-29 isAbortError 函数体删改 re-export；:2390-2392 revealLine catch 补 abort 分支）
- Modify: `apps/web/src/lib/WorkspaceCreateModal.svelte`（:79 内联判定改 isAbortError）
- Modify: `packages/core/src/tree/singleFile.ts`（:11、:30）、`packages/core/src/tree/localFiles.ts`（:58）、`packages/core/src/tree/localFs.ts`（:63）三处抛出端
- Modify: `packages/core/src/types.ts`（:47 一带 signal 契约注释补单源指引）
- Test: `packages/render-text/test/code.test.ts`（判定矩阵 describe 补 identity 断言）

**Interfaces:**
- Consumes: Task 1 的 `isAbortError`/`abortReadError`（core 包根导出）。
- Produces: `import { isAbortError } from '@vviewer/render-text'` 与 `from '@vviewer/core'` 同引用；jsonl/index.ts:86 与 ViewerPane.svelte:4 导入面零改动。

- [ ] **Step 1: 写失败测试（identity 断言）**

`packages/render-text/test/code.test.ts` 判定矩阵 describe 内追加用例（文件需新增 `import { isAbortError as coreIsAbortError } from '@vviewer/core';`——放既有 import 区）：

```ts
  it('单源 identity：render-text re-export 与 core 同引用（防再镜像）', () => {
    expect(isAbortError).toBe(coreIsAbortError);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/code.test.ts -t '单源 identity'`
Expected: FAIL（当前两份独立实现非同引用）

- [ ] **Step 3: 实现迁移**

`code.ts` :14-29 整块替换为（原 doc 注释迁移至 core/errors.ts，此处留短注）。注意
`export { x } from '...'` 不绑定本地名，而 code.ts 内部六处调用仍需 `isAbortError`
可引用——必须 import + 再导出两行。:2 既有值导入行追加 `isAbortError`：

```ts
import { getRemoteBase, getRemoteMeta, redetectWithFull, RemoteComputeError, showErrorCard, isAbortError } from '@vviewer/core';
```

原 :14-29 位置改：

```ts
/**
 * 取消错误身份判定（单源，spec 2026-10-16 错误身份与字节映射 §4.3）：实现与契约
 * 文档在 @vviewer/core（dispatch/errors），此处再导出保持本包内 jsonl 与
 * web 层 ViewerPane 的既有导入路径零变动。
 */
export { isAbortError };
```

`WorkspaceCreateModal.svelte`：import 区追加 `import { isAbortError } from '@vviewer/core';`，:79 改：

```ts
      if (isAbortError(err)) {
```

（顺带补齐 `Error + name='AbortError'` 形态——原内联仅判 DOMException。）

`code.ts` revealLine 续读 catch（:2390-2392）改为：

```ts
          } catch (err) {
            // 取消（destroy 在飞读 abort）不置闩（六处收紧同款第七处收口，spec
            // §2 T5）：停机闩仅属真实读失败——abort 后 destroyed 即将成立或由
            // 用户滚动动作重启，闩上会把取消当失败冻结续读
            if (!isAbortError(err)) {
              continueFailed = true; // 与滚动续读同口径：停机闩，用户滚动动作解除
              console.debug('[code] revealLine 续读失败（跳转静默兜底，滚动后重试）', err);
            } else {
              console.debug('[code] revealLine 续读被取消（destroy）', err);
            }
          } finally {
```

tree 三处（`singleFile.ts:11/:30`、`localFiles.ts:58`、`localFs.ts:63`）：各文件 import 区追加 `import { abortReadError } from '../dispatch/errors';`，抛出行改为：

```ts
      if (opts?.signal?.aborted) throw abortReadError();
```

（localFs.ts:61-62 既有两行注释保留，句尾「isAbortError 同源判定」语义不变。）

`types.ts` :47 注释块末尾补一句：

```
// 本地实现统一经 core/dispatch/errors 的 abortReadError() 抛出（单源形态）。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-text/test/code.test.ts packages/core/test/tree-signal.test.ts packages/core/test/errors.test.ts`
Expected: 全 PASS（identity 断言转绿；tree-signal 与六形态矩阵零翻转）

- [ ] **Step 5: typecheck 验证导入面**

Run: `pnpm typecheck`
Expected: 0 error（jsonl/ViewerPane 导入面零变动的证明）

- [ ] **Step 6: 提交**

```bash
git add packages/render-text/src/code.ts packages/render-text/test/code.test.ts apps/web/src/lib/WorkspaceCreateModal.svelte packages/core/src/tree/singleFile.ts packages/core/src/tree/localFiles.ts packages/core/src/tree/localFs.ts packages/core/src/types.ts
git commit -m "refactor(core,render-text,web): isAbortError/abortReadError 单源迁移

why：双镜像+内联变体靠人工同步已成漂移源（WorkspaceCreateModal 单支漏
Error+name 形态）；code.ts revealLine 续读 catch 是六处收紧漏掉的第七处
同型分支（abort 误置停机闩）。
what：code.ts 改 core re-export（导入面零变动）+identity 断言防再镜像；
WorkspaceCreateModal 改 core 版；revealLine catch 补 abort 分支；tree 三处
抛出端统一 abortReadError()。"
```

---

### Task 4: code 全量模式 lineAtByteOffset 字节域行索引

**Files:**
- Modify: `packages/render-text/src/code.ts`（`buildLineOffsets` 后新增 `buildByteLineOffsets`；全量闭包 :658 后构建索引；handle :1122-1124 后挂方法；`RenderCodeHandle` :613 后加接口成员；`lineAtOffset` doc 补域明示）
- Test: `packages/render-text/test/code.test.ts`（lineAtOffset describe 后新增字节域 describe）

**Interfaces:**
- Consumes: 无新依赖（`lineOf` 二分为同文件既有模块私有函数，直接复用）。
- Produces: `RenderCodeHandle.lineAtByteOffset?(offset: number): number`（仅全量模式；Task 5 消费）+ 导出纯函数 `buildByteLineOffsets(buffer: Uint8Array): number[]`。

**字节域定义（spec §4.5，实现前必读）：** post-BOM（首行起算剥 3 字节 BOM，与 jsonl 索引 offsets 同基）；终结符 `\r\n` 单终结符记 2 字节、`\n` 记 1、lone `\r` 亦终结记 1（与 code 字符域行号一致；与 jsonl 记账在 \r\n/\n 文件上逐字节同基）。返回数组含末尾伪起始（trailing 终结符后的空串行），与 `split('\n')` 语义对齐。

- [ ] **Step 1: 写失败测试**

`code.test.ts` 的 `describe('renderCode lineAtOffset…')` 之后新增（复用该 describe 内既有的 `stubResizeObserver`——若其为 describe 局部函数则在新 describe 内复制同款）：

```ts
describe('renderCode lineAtByteOffset（错误身份与字节映射 Task 4：字节域行索引）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  function byteAtOf(handle: ReturnType<typeof renderCode>): ((o: number) => number) | undefined {
    return (handle as { lineAtByteOffset?: (o: number) => number }).lineAtByteOffset;
  }

  it('CRLF：\\r\\n 记 2 字节单终结符，行号与字符域一致', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(enc('ab\r\ncd\r\n'), host, { highlight: false });
    const f = byteAtOf(handle);
    expect(f, '全量模式 handle 应提供 lineAtByteOffset').toBeTypeOf('function');
    if (f === undefined) return;
    expect(f.call(handle, 0)).toBe(0);
    expect(f.call(handle, 2)).toBe(0); // 恰在 \r 上：归本行
    expect(f.call(handle, 4)).toBe(1); // \r\n 后 = 下一行起始（字节域 4）
    expect(f.call(handle, 8)).toBe(2);
    expect(f.call(handle, 99)).toBe(2); // 超尾钳末行
    handle.destroy();
  });

  it('BOM：post-BOM 逻辑域（首行起算剥 3 字节，与 jsonl offsets 同基）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(enc('\uFEFFab\ncd\n'), host, { highlight: false });
    const f = byteAtOf(handle);
    if (f === undefined) return;
    expect(f.call(handle, 0)).toBe(0); // BOM 后首字节 = 首行起始
    expect(f.call(handle, 3)).toBe(1); // 'ab\n' 后
    expect(f.call(handle, 6)).toBe(2);
    handle.destroy();
  });

  it('多字节 UTF-8：字节偏移含 3 字节/汉字的行距（字符域近似的反例面）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(enc('中\n文\n'), host, { highlight: false });
    const f = byteAtOf(handle);
    if (f === undefined) return;
    expect(f.call(handle, 0)).toBe(0);
    expect(f.call(handle, 4)).toBe(1); // '中'=3 字节 + \n
    expect(f.call(handle, 7)).toBe(2);
    handle.destroy();
  });

  it('lone \\r：终结记 1 字节（行号与字符域归一语义一致）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(enc('a\rb\nc'), host, { highlight: false });
    const f = byteAtOf(handle);
    if (f === undefined) return;
    expect(f.call(handle, 2)).toBe(1);
    expect(f.call(handle, 4)).toBe(2);
    handle.destroy();
  });

  it('窗口流式模式缺席（鸭子探测 undefined，与 lineAtOffset 同裁决）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const bytes = enc('ab\ncd\n');
    const handle = renderCode(bytes, host, { highlight: false, ctx: streamCtx({ size: bytes.length, content: bytes, head: bytes }) });
    expect((handle as { lineAtByteOffset?: unknown }).lineAtByteOffset).toBeUndefined();
    handle.destroy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/code.test.ts -t 'lineAtByteOffset'`
Expected: FAIL（handle 无此方法，`toBeTypeOf('function')` 断言红）

- [ ] **Step 3: 实现**

`code.ts` 在 `buildLineOffsets`（:177-185）之后新增导出纯函数：

```ts
/**
 * 字节域行起始偏移（spec 2026-10-16 错误身份与字节映射 §4.5）：在原始 buffer 上扫
 * 终结符记行起始——\r\n 单终结符记 2 字节、\n 记 1、lone \r 亦终结记 1（与字符域
 * 归一语义的行号一致）；BOM 从偏移剔除（post-BOM 逻辑域，与 jsonl 索引 offsets
 * 同基）。返回数组含末尾伪起始（trailing 终结符后的空串行），与 buildLineOffsets
 * 的 split('\n') 语义对齐。lone \r 文件两域不可同时逐字节对齐（jsonl 记账不终结），
 * 属已知边界（jsonl 内容按定义不含裸 \r 行尾）。
 */
export function buildByteLineOffsets(buffer: Uint8Array): number[] {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const starts: number[] = [0];
  let i = bom;
  while (i < buffer.length) {
    const b = buffer[i]!;
    if (b === 0x0d) {
      i += buffer[i + 1] === 0x0a ? 2 : 1;
    } else if (b === 0x0a) {
      i += 1;
    } else {
      i += 1;
      continue;
    }
    starts.push(i - bom);
  }
  return starts;
}
```

全量闭包 :658 `const lineOffsets = buildLineOffsets(lines);` 之后追加：

```ts
  const byteLineOffsets = buildByteLineOffsets(buffer); // 字节域行索引（lineAtByteOffset 用，post-BOM）
```

`RenderCodeHandle` 接口 :613 `lineAtOffset?...;` 之后追加成员：

```ts
  /** 字节偏移 → 物理行号（spec 2026-10-16 错误身份与字节映射 §4.5，可选扩展）：与
   * lineAtOffset 同款二分与边界语义（行尾终结符归本行、超尾钳末行），域为 post-BOM
   * 逻辑字节偏移（\r\n 记 2 字节单终结符、\n 记 1、lone \r 终结记 1）——与 jsonl
   * 索引 offsets 在 \r\n/\n 文件上逐字节同基，委托锚行映射的精确通道。仅全量模式
   * 提供（窗口模式无全量索引，缺席）；消费方鸭子探测（三级回退首级）。 */
  lineAtByteOffset?(offset: number): number;
```

handle 字面量 :1122-1124 `lineAtOffset` 之后追加：

```ts
    // 字节域行索引二分（域与边界语义见 RenderCodeHandle.lineAtByteOffset 注）
    lineAtByteOffset(offset: number) {
      return lineOf(byteLineOffsets, offset);
    }
```

`lineAtOffset` 接口 doc（:608-612）首行「字节偏移 → 物理行号」订正为「**字符**偏移 → 物理行号」（消除名字带 Offset 实为字符域的历史错位，域定义句已有、不改）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-text/test/code.test.ts`
Expected: 全 PASS（新增 5 用例转绿；lineAtOffset 字符版既有用例 :898-936 零翻转）

- [ ] **Step 5: 提交**

```bash
git add packages/render-text/src/code.ts packages/render-text/test/code.test.ts
git commit -m "feat(render-text): 全量模式 lineAtByteOffset 字节域行索引

why：jsonl 委托锚行字节偏移直传字符域 lineAtOffset 有两支近似（多字节
累计差、CRLF 记账差），中文日志类文件锚行可漂出粗定位范围。
what：解码前扫原始 buffer 建 post-BOM 字节域行起始索引（\\r\\n 记 2 字节
单终结符、lone \\r 终结记 1，行号与字符域一致），handle 挂可选
lineAtByteOffset；接口 doc 订正 lineAtOffset 字符域明示。"
```

---

### Task 5: jsonl 委托锚行三级回退（精确映射）

**Files:**
- Modify: `packages/render-text/src/jsonl/index.ts`（`restoreViewportAfterDegrade` :586-600 三级回退；:571-584 行号域换算 doc 与 :731-735 锚捕获注释改写）
- Test: `packages/render-text/test/jsonl-render.test.ts`（委托锚行 describe 内新增两用例）

**Interfaces:**
- Consumes: Task 4 的 `lineAtByteOffset?`（鸭子探测）。
- Produces: 行为变更——委托降级视口恢复优先字节域精确映射；无新导出。

- [ ] **Step 1: 写失败测试（两用例）**

`jsonl-render.test.ts` 委托锚行 describe（既有 :1016 用例之后）新增，夹具构造器与 helper（`mount`/`streamCtx`/`enc`/`RangeCall`/`JsonlInstance`）沿用文件既有：

```ts
  it('委托降级锚行映射优先 lineAtByteOffset（字节域精确）：lineAtOffset 不再被调用', async () => {
    stubResizeObserver();
    const content = interleavedBlankHeadGbTail(500, 100);
    const physicalStarts: number[] = [];
    {
      let start = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === 0x0a) {
          physicalStarts.push(start);
          start = i + 1;
        }
      }
      physicalStarts.push(start);
    }
    const lineByOffset = (offset: number): number => {
      let line = 0;
      for (let i = 0; i < physicalStarts.length; i++) {
        if ((physicalStarts[i] ?? 0) <= offset) line = i;
        else break;
      }
      return line;
    };
    const byteCalls: number[] = [];
    const charCalls: number[] = [];
    const revealArgs: number[] = [];
    const fakeCode = {
      destroy(): void {},
      getMeta: () => ({ encoding: 'utf-8' as const, lang: null, size: content.length, lines: 600 }),
      lineAtByteOffset: (offset: number): number => {
        byteCalls.push(offset);
        return lineByOffset(offset);
      },
      lineAtOffset: (offset: number): number => {
        charCalls.push(offset);
        return lineByOffset(offset);
      },
      revealLine: (line: number): void => {
        revealArgs.push(line);
      }
    };
    const calls: RangeCall[] = [];
    const host = mount();
    const localDet: Detection = { ext: 'jsonl', encoding: 'utf-8' };
    const inst = await renderJsonl(content.slice(0, 8192), host, localDet,
      streamCtx({ size: null, content, head: content.slice(0, 8192), calls }),
      { onEncodingBroken: async () => fakeCode as unknown as JsonlInstance });
    await vi.waitFor(() => expect(host.querySelector('[data-line="0"]')).not.toBeNull());
    const loaded = Number(/已加载 (\d+) 行/.exec(host.querySelector('.vv-jsonl-status')!.textContent!)?.[1]);
    const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
    scroll.scrollTop = 120 * (loaded - 11);
    scroll.dispatchEvent(new Event('scroll'));
    const anchor = loaded - 16;
    const expectedPhysical = 2 * anchor;
    await vi.waitFor(() => expect(revealArgs.length).toBeGreaterThan(0));
    expect(byteCalls.length, '应优先走字节域精确通道').toBe(1);
    expect(byteCalls[0]).toBe(physicalStarts[expectedPhysical]);
    expect(charCalls.length, '字节域命中后不得回退字符域近似').toBe(0);
    expect(revealArgs[0]).toBe(expectedPhysical);
    inst.destroy();
  });

  it('多字节中文夹具：锚行经 lineAtByteOffset 映射物理行号精确命中（字节域与字符域差随行累计的反例）', async () => {
    stubResizeObserver();
    // 每数据行嵌中文（每汉字 3 字节）+ 空行交织：字符域近似随锚行前累计漂移
    const parts: number[] = [];
    for (let k = 0; k < 500; k++) {
      for (let b = 0; b < 100; b++) parts.push(0x0a);
      parts.push(...enc(`{"n":${k},"t":"中文内容每字三字节"}\n`));
    }
    const content = Uint8Array.from(parts);
    const physicalStarts: number[] = [];
    {
      let start = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === 0x0a) {
          physicalStarts.push(start);
          start = i + 1;
        }
      }
      physicalStarts.push(start);
    }
    const lineByOffset = (offset: number): number => {
      let line = 0;
      for (let i = 0; i < physicalStarts.length; i++) {
        if ((physicalStarts[i] ?? 0) <= offset) line = i;
        else break;
      }
      return line;
    };
    const revealArgs: number[] = [];
    const byteCalls: number[] = [];
    const fakeCode = {
      destroy(): void {},
      getMeta: () => ({ encoding: 'utf-8' as const, lang: null, size: content.length, lines: 600 }),
      lineAtByteOffset: (offset: number): number => {
        byteCalls.push(offset);
        return lineByOffset(offset);
      },
      revealLine: (line: number): void => {
        revealArgs.push(line);
      }
    };
    const calls: RangeCall[] = [];
    const host = mount();
    const localDet: Detection = { ext: 'jsonl', encoding: 'utf-8' };
    const inst = await renderJsonl(content.slice(0, 8192), host, localDet,
      streamCtx({ size: null, content, head: content.slice(0, 8192), calls }),
      { onEncodingBroken: async () => fakeCode as unknown as JsonlInstance });
    await vi.waitFor(() => expect(host.querySelector('[data-line="0"]')).not.toBeNull());
    const loaded = Number(/已加载 (\d+) 行/.exec(host.querySelector('.vv-jsonl-status')!.textContent!)?.[1]);
    const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
    scroll.scrollTop = 120 * (loaded - 11);
    scroll.dispatchEvent(new Event('scroll'));
    const anchor = loaded - 16;
    const expectedPhysical = 2 * anchor; // 数据行 k 前各有 k 个空行
    await vi.waitFor(() => expect(revealArgs.length).toBeGreaterThan(0));
    expect(byteCalls.length).toBe(1);
    expect(byteCalls[0]).toBe(physicalStarts[expectedPhysical]);
    expect(revealArgs[0]).toBe(expectedPhysical);
    inst.destroy();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/jsonl-render.test.ts -t 'lineAtByteOffset'`
Expected: 第一用例 FAIL（现状只探测 lineAtOffset——双方法 fake 下 charCalls 命中而 byteCalls 空；第二用例 fake 仅挂 byte 方法时回退内容行号直传）。既有两用例（:1016/:1081）保持绿。

- [ ] **Step 3: 实现**

`restoreViewportAfterDegrade`（:586-600）改为：

```ts
function restoreViewportAfterDegrade(
  full: RenderedInstance & { getMeta(): CodeFileMeta },
  anchorLine: number,
  anchorByteOffset = -1
): void {
  if (anchorLine < 0) return;
  const reveal = (full as { revealLine?: (line: number) => void }).revealLine;
  if (typeof reveal !== 'function') return;
  // 三级回退（spec §4.5）：字节域精确（lineAtByteOffset，post-BOM 与 jsonl offsets
  // 同基）→ 字符域旧近似（lineAtOffset，兼容旧委托实例——多字节/CRLF 两支累计差
  // 残留）→ 内容行号直传（现状行为，向后兼容）
  const lineAtByteOffset = (full as { lineAtByteOffset?: (offset: number) => number }).lineAtByteOffset;
  if (anchorByteOffset >= 0 && typeof lineAtByteOffset === 'function') {
    reveal.call(full, lineAtByteOffset.call(full, anchorByteOffset));
    return;
  }
  const lineAtOffset = (full as { lineAtOffset?: (offset: number) => number }).lineAtOffset;
  if (anchorByteOffset >= 0 && typeof lineAtOffset === 'function') {
    reveal.call(full, lineAtOffset.call(full, anchorByteOffset));
    return;
  }
  reveal.call(full, anchorLine);
}
```

:571-584 doc 块改写为：

```
 * 行号域换算（spec 2026-10-16 错误身份与字节映射，三级回退）：anchorLine 是 jsonl
 * 内容行号（索引层剔空行），code revealLine 收物理行号（含空行）——含空行文件直传
 * 会向上漂移「锚行前空行数」。故委托 code 分支以锚行偏移（anchorByteOffset =
 * index.offsets[anchorLine]，调用方在索引可见处换算）映射物理行号再 reveal，优先
 * lineAtByteOffset（post-BOM 字节域行索引，与 jsonl offsets 同基逐字节精确——
 * 多字节/CRLF 两支历史近似消灭），次选 lineAtOffset（字符域旧近似，兼容旧委托
 * 实例），实例两者皆无（旧产物/非全量形态）或偏移不可得（anchorByteOffset <0）
 * 回退内容行号直传（现状行为，向后兼容）。偏移不做 +bomLen 补偿（终审 Minor 1：
 * 两域同为 post-BOM，补偿反引 +3 使 BOM 文件短数据行漂 1 行）。
```

:731-735 锚捕获注释中「委托 code 形态经实例 lineAtOffset 映射物理行号…不做 +bomLen 补偿…」句同步改为「经实例 lineAtByteOffset（字节域精确，次选 lineAtOffset 旧近似）映射物理行号；offsets 为 post-BOM 逻辑字节空间与字节域索引同基，不做 +bomLen 补偿（终审 Minor 1）」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-text/test/jsonl-render.test.ts packages/render-text/test/code.test.ts`
Expected: 全 PASS（新增 2 用例转绿；既有委托锚行/回退两用例零翻转）

- [ ] **Step 5: 提交**

```bash
git add packages/render-text/src/jsonl/index.ts packages/render-text/test/jsonl-render.test.ts
git commit -m "feat(render-text): jsonl 委托锚行字节域精确映射——三级回退

why：锚行字节偏移直传字符域 lineAtOffset 的多字节/CRLF 两支累计差使中文
日志类文件锚行漂移；Task 4 的 lineAtByteOffset 提供同基精确通道。
what：restoreViewportAfterDegrade 改 lineAtByteOffset → lineAtOffset →
内容行号三级鸭子探测；域换算/锚捕获两处注释改写为已清偿口径。"
```

---

### Task 6: 收口门禁

**Files:** 无新改动（发现回归时修复并单独提交）

- [ ] **Step 1: 全量单测**

Run: `pnpm vitest run`
Expected: 全 PASS（零翻转）

- [ ] **Step 2: typecheck + svelte-check**

Run: `pnpm typecheck`
Expected: 0 error（根脚本 = tsc -b 全包 + e2e 工程 + `--filter web typecheck`〔svelte-kit
sync && svelte-check〕；勿在仓库根直跑 svelte-check——会扫 tools/ 产物误报）

- [ ] **Step 3: playwright 默认通道回归**

Run: `pnpm --filter web exec playwright test`（本 spec 无 e2e 新增，跑默认通道验既有锚零翻转）
Expected: 全 PASS

- [ ] **Step 4: 收口提交（如有修复）**

若门禁暴露问题：修复后按Angular 规范单独提交；无问题则本任务无提交，SDD 任务收口记录门禁数字。
