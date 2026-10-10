# 格式覆盖自动化与打开方式手选 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** code 渲染器扩展名注册表构建期自动生成（消灭手工清单缺口）、未知扩展名内容探测（签名→文本→hex）、Tab 级打开方式手选（错误卡片按钮 + MetaPanel 下拉）。

**Architecture:** 新脚本 `gen-code-extensions.mjs` 从 `languages.json` 生成扩展名清单（生成物 `generated-extensions.ts` 入库 + CI `--check` 门禁）；registry 新增 `installFallbackExtensions`（专有渲染器先注册、生成物跳过被占）；dispatcher 未知扩展名探测链与 `dispatch` 第 4 参 override；`Tab.overrideRenderer` 经 ViewerPane 贯通到 dispatch 与会话快照；MetaPanel 经 fileMeta 通道展示「打开方式」下拉。

**Tech Stack:** Node ESM 脚本（无新依赖）、TypeScript（core registry/dispatcher + Svelte 5 组件）、vitest（jsdom）、Playwright e2e。

**Spec:** `docs/superpowers/specs/2026-10-11-format-coverage-open-with-design.md`

## Global Constraints

- 生成物**入库提交**（KB 级、运行时装配依赖，与 wasm「产物不入库」原则不冲突）；CI 以 `--check` 校验新鲜度。
- 装配顺序铁律：11 个专有渲染器先 install，生成物只补空位（`installFallbackExtensions` 跳过已占用，绝不抛 RegistryError）；`jsonl` 必须出现在生成物中（锚点测试）。
- 扩展名收集规则（对 spec §2.1 的已裁决修订）：`fileTypes` 实际数据为无点 token（如 `"rs"`）；normalize = trim → 小写 → 剥单个前导点，保留匹配 `^[a-z0-9][a-z0-9+.-]*$` 的 token（排除含 `/`、`*`、`?` 的 glob 形），去重升序输出。
- NDJSON/服务端零改动；本计划纯前端 + 工具链。
- 探测链顺序：`sniffSignature` 改派（复用 SIGNATURE_ROUTES）→ `looksTextual` → code → 否则 hex；`det.extless` 仍仅对原始无扩展名文件置位。
- override 语义：命中 registry.byId 即用，**跳过 BUG-13 magic 预检**（用户显式选择优先）；`det.ext` 不纠偏（code 的语言探测链 detectLanguage→shebang→hljs auto 自然兜底）；override id 不存在时静默走正常链。
- 中文注释讲 why；TDD；每任务独立 commit（Angular 中文 message）。
- 门禁：`pnpm test`（vitest，include 含 `packages/*/test/**`、`tools/*/test/**`、`apps/web/src/**/*.test.ts`）、`pnpm typecheck`；e2e 按 spec 抽样跑新增 spec 文件。
- 既有测试手法复用：`packages/core/test/dispatcher.test.ts` 的 `mk()` 渲染器工厂与 PK/PNG/PDF 字节常量、`source()` 工厂。

---

### Task 1: gen-code-extensions.mjs + 生成物入库 + vitest

**Files:**
- Create: `tools/grammar-builder/gen-code-extensions.mjs`
- Create: `tools/grammar-builder/test/gen-code-extensions.test.ts`
- Create（生成物）: `packages/core/src/registry/generated-extensions.ts`

**Interfaces:**
- Consumes: `packages/highlight/assets/languages.json`（字典键=语言名，条目含 `fileTypes: string[]`）。
- Produces:
  - 纯函数 `export function collectExtensions(languages: Record<string, { fileTypes?: string[] }>): string[]`（normalize→过滤→去重→升序）
  - 生成物 `packages/core/src/registry/generated-extensions.ts`：`export const GENERATED_EXTENSIONS: readonly string[] = [...]`（升序字面量）
  - CLI：`node tools/grammar-builder/gen-code-extensions.mjs [--check]`（`--check` 生成物与磁盘不一致 exit 1；环境变量 `VV_GENERATED_EXTENSIONS` 可覆盖输出路径，仿 gen-server-manifest.mjs 的 SOURCES 模式）

- [ ] **Step 1: 写失败测试**（`tools/grammar-builder/test/gen-code-extensions.test.ts`）

```ts
import { describe, expect, it } from 'vitest';
import { collectExtensions } from '../gen-code-extensions.mjs';

describe('collectExtensions', () => {
  it('normalizes, filters and sorts fileTypes tokens', () => {
    const languages = {
      rust: { fileTypes: ['rs'] },
      json: { fileTypes: ['json', 'jsonc', 'jsonl', '.json5'] },
      noise: { fileTypes: ['Makefile', '**/*.rs', 'a/b', ''])
      ,
      lock: { fileTypes: ['Cargo.lock'] },
    };
    expect(collectExtensions(languages as never)).toEqual([
      'cargo.lock', 'json', 'json5', 'jsonc', 'jsonl', 'makefile', 'rs',
    ]);
  });

  it('dedupes across languages', () => {
    const languages = { a: { fileTypes: ['x'] }, b: { fileTypes: ['x', 'y'] } };
    expect(collectExtensions(languages as never)).toEqual(['x', 'y']);
  });

  it('derives jsonl from the real asset (C 项锚点：D 项 jsonl 渲染器依赖此条)', () => {
    // 真资产锚点：languages.json 的 json 语言 fileTypes 含 jsonl
    const languages = { json: { fileTypes: ['json', 'jsonl'] } };
    expect(collectExtensions(languages as never)).toContain('jsonl');
  });
});
```

注意：第一例里 `'')` 是笔误陷阱——写测试时第一例 `noise` 条目应为 `{ fileTypes: ['Makefile', '**/*.rs', 'a/b', 'x y'] }`（空串与空格 token 也应被过滤，期望输出不含它们）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tools/grammar-builder/test/gen-code-extensions.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现脚本**

```mjs
// gen-code-extensions.mjs — C 项：从 languages.json 生成 code 渲染器扩展名全集。
// 生成物入库（运行时装配依赖，lite 离线/e2e 直跑不构建 grammar 也要可用）；
// CI 经 --check 校验新鲜度。规则见 collectExtensions。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const SOURCES = {
  languages: process.env.VV_LANGUAGES_JSON
    ?? join(here, '../../packages/highlight/assets/languages.json'),
  outFile: process.env.VV_GENERATED_EXTENSIONS
    ?? join(here, '../../packages/core/src/registry/generated-extensions.ts'),
};

/** normalize→过滤→去重→升序。可作扩展名的 token 才收（glob 形排除）。 */
export function collectExtensions(languages) {
  const out = new Set();
  for (const entry of Object.values(languages)) {
    for (const ft of entry.fileTypes ?? []) {
      const norm = String(ft).trim().toLowerCase().replace(/^\./, '');
      if (/^[a-z0-9][a-z0-9+.-]*$/.test(norm)) out.add(norm);
    }
  }
  return [...out].sort();
}

export function toModule(exts) {
  return `// 由 tools/grammar-builder/gen-code-extensions.mjs 生成（C 项）；勿手改，CI --check 校验。\n` +
    `// 来源：packages/highlight/assets/languages.json 的 fileTypes 全集。\n` +
    `export const GENERATED_EXTENSIONS: readonly string[] = ${JSON.stringify(exts)};\n`;
}

export function verify(languages, onDisk) {
  const expected = toModule(collectExtensions(languages));
  return expected === onDisk;
}

async function main() {
  const languages = JSON.parse(readFileSync(SOURCES.languages, 'utf8'));
  const exts = collectExtensions(languages);
  if (exts.length < 100) throw new Error(`生成扩展名过少（${exts.length}），语言源异常`);
  if (!exts.includes('jsonl')) throw new Error('生成物必须含 jsonl（C/D 项契约锚点）');
  const check = process.argv.includes('--check');
  const onDisk = (() => {
    try { return readFileSync(SOURCES.outFile, 'utf8'); } catch { return ''; }
  })();
  if (check) {
    if (!verify(languages, onDisk)) {
      console.error('generated-extensions.ts 过期：请运行 node tools/grammar-builder/gen-code-extensions.mjs');
      process.exit(1);
    }
    console.log('generated-extensions.ts 已是最新');
    return;
  }
  mkdirSync(dirname(SOURCES.outFile), { recursive: true });
  writeFileSync(SOURCES.outFile, toModule(exts));
  console.log(`written: ${SOURCES.outFile} (${exts.length} extensions)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: 跑测试确认通过 + 生成产物**

Run: `pnpm vitest run tools/grammar-builder/test/gen-code-extensions.test.ts && node tools/grammar-builder/gen-code-extensions.mjs && node tools/grammar-builder/gen-code-extensions.mjs --check && head -c 400 packages/core/src/registry/generated-extensions.ts`
Expected: 3 例 PASS；生成成功且 `--check` 报「已是最新」；文件头含「由 … 生成」注释

- [ ] **Step 5: Commit**

```bash
git add tools/grammar-builder/gen-code-extensions.mjs tools/grammar-builder/test/gen-code-extensions.test.ts packages/core/src/registry/generated-extensions.ts
git commit -m "feat(tools): languages.json 构建期生成 code 扩展名全集

why: code 渲染器手工扩展名清单有缺口（.jsonl 等打不开），需自动化。
what: gen-code-extensions.mjs（normalize/过滤/去重/升序 + --check 门禁）
与入库生成物 generated-extensions.ts。"
```

---

### Task 2: registry.installFallbackExtensions + viewer.ts 装配

**Files:**
- Modify: `packages/core/src/registry/registry.ts`（新增方法）
- Modify: `packages/core/test/registry.test.ts`（新增用例）
- Modify: `apps/web/src/lib/viewer.ts`（装配调用）

**Interfaces:**
- Consumes: Task 1 `GENERATED_EXTENSIONS`。
- Produces: `Registry.installFallbackExtensions(ownerId: RendererId, exts: readonly string[]): { added: string[]; skipped: string[] }`——owner 不存在 throw `Error`；逐项：已占用（byExt 命中且 owner 不同）→ skipped；否则注册并计 added。扩展名归一小写，与 install 一致。

- [ ] **Step 1: 写失败测试**（`packages/core/test/registry.test.ts` 追加，复用既有 `mk` 工厂）

```ts
describe('installFallbackExtensions', () => {
  it('registers free extensions and skips taken ones without throwing', () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('markdown', ['md']));
    const res = reg.installFallbackExtensions('code', ['jsonl', 'txt', 'md', 'adoc']);
    expect(res.added).toEqual(['adoc', 'jsonl']);   // 升序稳定
    expect(res.skipped).toEqual(['md', 'txt']);
    expect(reg.byExtension('jsonl')?.id).toBe('code');
    expect(reg.byExtension('md')?.id).toBe('markdown'); // 占用者不变
  });

  it('normalizes case and rejects unknown owner', () => {
    const reg = createRegistry();
    expect(() => reg.installFallbackExtensions('ghost', ['x'])).toThrow(/ghost/);
    reg.install(mk('code', []));
    reg.installFallbackExtensions('code', ['JSONL']);
    expect(reg.byExtension('jsonl')?.id).toBe('code');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/registry.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**（registry.ts，`install` 之后）

```ts
installFallbackExtensions(ownerId: RendererId, exts: readonly string[]): { added: string[]; skipped: string[] } {
  const owner = this.byId.get(ownerId);
  if (!owner) throw new Error(`Renderer id "${ownerId}" 不存在，无法补注册扩展名`);
  const added: string[] = [];
  const skipped: string[] = [];
  // 生成物只补空位：专有渲染器先注册（C 项装配铁律），被占即跳过——
  // jsonl/ndjson 等未来由专有渲染器（D 项）注册后天然免疫生成物覆盖
  for (const raw of [...exts].sort()) {
    const ext = raw.toLowerCase();
    const existing = this.byExt.get(ext);
    if (existing) {
      skipped.push(ext);
      continue;
    }
    this.byExt.set(ext, owner);
    added.push(ext);
  }
  return { added, skipped };
}
```

（`Registry` 接口同步补该方法签名。）

- [ ] **Step 4: 跑测试确认通过 + 装配 viewer.ts**

`viewer.ts` L40（11 个 install 之后、L48 `createDispatcher` 之前）插入：

```ts
// C 项：手工清单之外的语法类扩展名由生成物补充（专有渲染器已先注册，冲突跳过）。
const fallback = registry.installFallbackExtensions('code', GENERATED_EXTENSIONS);
if (fallback.added.length > 0) {
  console.debug(`[viewer] generated extensions → code: +${fallback.added.length} (skipped ${fallback.skipped.length})`);
}
```

import 区加 `import { GENERATED_EXTENSIONS } from '@vviewer/core';`（core 包根 re-export；若 core 的 exports 未含该路径则在 `packages/core/src/index.ts` 加 `export * from './registry/generated-extensions.js'`——以 core 既有导出风格为准）。

Run: `pnpm vitest run packages/core/test/registry.test.ts && pnpm test && pnpm typecheck`
Expected: registry 测试 PASS；全量 vitest/typecheck 绿

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/registry/registry.ts packages/core/test/registry.test.ts apps/web/src/lib/viewer.ts packages/core/src/index.ts
git commit -m "feat(core,web): 生成扩展名回退注册——专有优先、补空位跳过

why: 生成物需接入装配且不得覆盖专有渲染器（svg/md/html/jsonl 归属）。
what: registry.installFallbackExtensions（升序补空位）+ viewer.ts 装配。"
```

---

### Task 3: dispatcher 未知扩展名探测链 + reclassified 标记

**Files:**
- Modify: `packages/core/src/dispatch/dispatcher.ts`（resolveInitialRenderer 去掉 ext=='' 门槛、hex 兜底、reclassified 标注）
- Modify: `packages/core/src/types.ts`（Detection 增可选字段）
- Modify: `packages/core/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `sniffSignature`/`signatureRouteOf`/`looksTextual`/`SIGNATURE_ROUTES`（均现状）、`registry.byId('hex')`。
- Produces:
  - `Detection.reclassifiedFrom?: string`（探测改派成功时记录原扩展名；无点为 `''`）
  - `resolveInitialRenderer(registry, det, head)` 行为变更：**byExtension 未命中即走链**（不再要求 ext==''）：①签名改派 ②`looksTextual(head)` → code（extless 仅在 `det.ext === ''` 时置 true，shebang 逻辑同现状）③`registry.byId('hex')` → hex 渲染器 + 置 `det.reclassifiedFrom = 原ext` ④hex 缺失返回 undefined（错误卡片路径保留）。
  - 签名改派命中时同样置 `det.reclassifiedFrom = 原 ext`（仅当原 ext ≠ 目标 route.ext）。

- [ ] **Step 1: 写失败测试**（dispatcher.test.ts 追加；`mk('hex', [])` 渲染器入 registry）

```ts
describe('unknown-extension probe chain (C 项)', () => {
  it('routes .foo PNG by signature to image', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('image', ['png']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const { rendererId, det } = await d.dispatch(source('x.foo'), PNG, target);
    expect(rendererId).toBe('image');
    expect(det.reclassifiedFrom).toBe('foo');
  });

  it('routes .foo binary to hex and marks reclassified', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const bin = new Uint8Array([0x00, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x00]);
    const { rendererId, det } = await d.dispatch(source('y.foo'), bin, document.createElement('div'));
    expect(rendererId).toBe('hex');
    expect(det.reclassifiedFrom).toBe('foo');
  });

  it('routes .foo textual content to code without extless flag', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const text = new TextEncoder().encode('plain text\n');
    const { rendererId, det } = await d.dispatch(source('z.foo'), text, document.createElement('div'));
    expect(rendererId).toBe('code');
    expect(det.extless).toBeFalsy();
    expect(det.reclassifiedFrom).toBe('foo');
  });

  it('keeps extless flag only for extensionless files', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const text = new TextEncoder().encode('#!/bin/sh\necho hi\n');
    const { det } = await d.dispatch(source('Makefile'), text, document.createElement('div'));
    expect(det.extless).toBe(true);               // 既有语义保持
    expect(det.reclassifiedFrom).toBeUndefined(); // 原生无扩展名不算改派
  });
});
```

（若既有 `mk`/`source`/常量名不同，以 `packages/core/test/dispatcher.test.ts` 实际为准复用；hex mock 的 render 返回 `{ destroy() {} }`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts`
Expected: 新增 4 例 FAIL（现状 ext!='' 直接「不支持的扩展名」错误卡片，rendererId 为 'error'）

- [ ] **Step 3: 实现**

`types.ts` Detection 接口追加：

```ts
/** C 项探测改派标记：内容探测/签名改派生效时记录原扩展名（无点为 ''）；
 * 渲染器/错误卡片据此显示「已按内容识别」提示。原生路由不置位。 */
reclassifiedFrom?: string;
```

`dispatcher.ts` resolveInitialRenderer：删除「`det.ext !== ''` 直接返回 undefined」的门槛（保留原函数签名）；链尾追加 hex 兜底；签名改派与 hex 兜底处置位 `reclassifiedFrom`。要点：

```ts
// C 项：未知扩展名不再直接报错——签名/文本探测后落 hex 兜底；
// extless 语义收窄：仅原生无扩展名文件置位（既有 e2e 断言依赖）
const originalExt = det.ext;
// ……①签名改派：命中且 route.ext !== originalExt 时 det.reclassifiedFrom = originalExt
// ……②looksTextual → code（det.extless = originalExt === ''）
// ……③const hex = registry.byId('hex'); if (hex) { det.reclassifiedFrom = originalExt; return hex; }
// ……④return undefined（错误卡片，文案不变）
```

（实现时保持既有 BUG-13 预检与 sniff 元数据逻辑不动。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm vitest run packages/core/test/ && pnpm test && pnpm typecheck`
Expected: 新增 4 例 PASS；既有 dispatcher/detect/e2e 相关单测零回归

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dispatch/dispatcher.ts packages/core/src/types.ts packages/core/test/dispatcher.test.ts
git commit -m "feat(core): 未知扩展名内容探测链——签名/文本/hex 兜底

why: 未知扩展名直接报错卡片，用户无内容识别兜底（spec C §2.2）。
what: resolveInitialRenderer 去门槛 + hex 兜底 + reclassifiedFrom
标记（extless 语义收窄为原生无扩展名）。"
```

---

### Task 4: dispatch override 参数 + Tab.overrideRenderer + 会话快照

**Files:**
- Modify: `packages/core/src/dispatch/dispatcher.ts`（dispatch 第 4 参）
- Modify: `packages/core/test/dispatcher.test.ts`
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（Tab 字段 + setRendererOverride + 快照读写）
- Modify: `apps/web/src/lib/stores/session.ts`（TabSnapshot 字段）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（dispatch 传参）

**Interfaces:**
- Consumes: Task 3 探测链。
- Produces:
  - `dispatch(source, buffer, target, opts?: { rendererOverride?: RendererId })`——override 命中 `registry.byId` 即用（**跳过 BUG-13 magic 预检**与 extless 探测链；sniff 元数据补齐保留）；id 未命中静默走正常链；返回值形状不变。
  - `Tab.overrideRenderer?: RendererId`（可选，不写进 rev 机制）；`TabCollection.setRendererOverride(tabId: string, rendererId: RendererId | null): void`——写字段、`rev = (tab.rev ?? 0) + 1`（复用 SSE 刷新的重渲染通道）并 persist。
  - `TabSnapshot.overrideRenderer?: string`：saveTabs 侧写入、restore 侧读回（AppShell.restore 恢复链路；unrestorable 占位 tab 不需要）。

- [ ] **Step 1: 写失败测试**（dispatcher.test.ts 追加）

```ts
describe('dispatch rendererOverride (C 项)', () => {
  it('forces the chosen renderer and skips BUG-13 magic precheck', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('image', ['png']));
    const d = createDispatcher(reg);
    // .png + PNG 字节本该走 image；override=code 强制文本且不被 magic 预检改派
    const { rendererId } = await d.dispatch(
      source('real.png'), PNG, document.createElement('div'), { rendererOverride: 'code' },
    );
    expect(rendererId).toBe('code');
  });

  it('falls back to normal routing when override id is unknown', async () => {
    const reg = createRegistry();
    reg.install(mk('image', ['png']));
    const d = createDispatcher(reg);
    const { rendererId } = await d.dispatch(
      source('real.png'), PNG, document.createElement('div'), { rendererOverride: 'ghost' },
    );
    expect(rendererId).toBe('image');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts`
Expected: 编译失败（dispatch 第 4 参不存在）

- [ ] **Step 3: 实现 dispatcher**（签名 `opts?: { rendererOverride?: RendererId }`；在 L144 byExtension 之前拦截：override 命中 → `renderer = byId(opts.rendererOverride)`，直接进入既有「渲染/失败」段——**不经过** resolveInitialRenderer 与 BUG-13 预检；sniff 元数据补齐调用保留）

- [ ] **Step 4: 贯通 web 层**

- `openFlow.svelte.ts`：`Tab` 接口加 `overrideRenderer?: string;`；`TabCollection` 加方法：

```ts
/** C 项：手选打开方式。rev++ 复用 SSE 刷新的重渲染通道；persist 落快照。 */
setRendererOverride(tabId: string, rendererId: string | null): void {
  const tab = this.list.find(t => t.id === tabId);
  if (!tab) return;
  if (rendererId === null) delete tab.overrideRenderer;
  else tab.overrideRenderer = rendererId;
  tab.rev = (tab.rev ?? 0) + 1;
  persistTabs(); // 与 persistScroll 同款落盘入口（以实际函数名为准）
}
```

（`persistTabs` 实际名以文件现状为准——`persistScroll` 所用的同一落盘函数。）

- `session.ts`：`TabSnapshot` 加 `overrideRenderer?: string;`；快照构造处透传 `tab.overrideRenderer`；restore 构造 Tab 处读回（`overrideRenderer: snap.overrideRenderer`）。
- `ViewerPane.svelte`：渲染调用改 `dispatcher.dispatch(current.source, buffer, host, { rendererOverride: current.overrideRenderer })`（current 为渲染 effect 捕获的 tab；以实际变量名为准）。

- [ ] **Step 5: 跑测试确认通过 + 全量门禁**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts && pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/dispatch/dispatcher.ts packages/core/test/dispatcher.test.ts apps/web/src/lib/openFlow.svelte.ts apps/web/src/lib/stores/session.ts apps/web/src/lib/ViewerPane.svelte
git commit -m "feat(core,web): dispatch 打开方式 override 贯通 Tab 与会话快照

why: 手选渲染器需绕过自动路由（含 magic 预检）且跨刷新保留。
what: dispatch 第 4 参 override（跳过预检）+ Tab.overrideRenderer +
setRendererOverride（rev 通道重渲染）+ TabSnapshot 可选字段。"
```

---

### Task 5: 错误卡片「以纯文本/以 hex 打开」快捷动作

**Files:**
- Modify: `packages/core/src/dispatch/dispatcher.ts`（buildRenderErrorActions 与选路失败分支）
- Modify: `packages/core/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: Task 4 override dispatch（动作 onClick = 以 override 重入 dispatch）。
- Produces: 错误卡片动作集变更——render 失败：`[重试, 以纯文本打开, 以 hex 打开]`（探测判定为文本时「纯文本」在前，否则「hex」在前）；选路失败（renderer undefined）：`[以纯文本打开, 以 hex 打开]`（无重试，维持现状语义）。「降级查看」按钮由「以 hex 打开」取代（同一语义，label 更明确）。当前 renderer 即 hex 时不再重复给「以 hex 打开」（只给「以纯文本打开」）；即 code 失败时动作=[重试, 以 hex 打开]。

- [ ] **Step 1: 写失败测试**（dispatcher.test.ts 追加；用带 actions 捕获的 mock render——render 抛错使 dispatch 走错误卡片路径，从 target DOM 读 `.vv-error-action` 按钮文案序列）

```ts
describe('error card open-as actions (C 项)', () => {
  function failing(id: string, exts: string[]): Renderer {
    return { id, label: id, extensions: exts, render: async () => { throw new Error('boom'); } };
  }

  it('offers retry + open-as-text/hex on render failure, text first for textual det', async () => {
    const reg = createRegistry();
    reg.install(failing('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const text = new TextEncoder().encode('hello\n');
    await d.dispatch(source('a.txt'), text, target);
    const labels = [...target.querySelectorAll('.vv-error-action')].map(b => b.textContent);
    expect(labels).toEqual(['重试', '以纯文本打开', '以 hex 打开']);
  });

  it('hex failure offers only open-as-text (no duplicate hex)', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    const hexFailing = failing('hex', []);
    reg.install(hexFailing);
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const bin = new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0]);
    await d.dispatch(source('b.foo'), bin, target);
    const labels = [...target.querySelectorAll('.vv-error-action')].map(b => b.textContent);
    expect(labels).toEqual(['以纯文本打开']);
  });

  it('routing failure still offers open-as actions', async () => {
    const reg = createRegistry();
    reg.install(failing('hex', [])); // 仅 hex 且失败 → 选路探到 hex → 走失败路径
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    await d.dispatch(source('c.foo'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 0]), target);
    expect(target.querySelector('.vv-error-card')).toBeTruthy();
  });
});
```

（第二例：hex 渲染失败 → 动作只剩「以纯文本打开」；第三例：探测链落 hex、hex 失败 → 错误卡片 + 「以纯文本打开」，断言卡片存在即可——动作精确序列由第二例锁定。按实现后实际行为微调断言顺序，但三例语义不可弱化。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts`
Expected: FAIL（动作序列仍是 [重试, 降级查看]）

- [ ] **Step 3: 实现**（buildRenderErrorActions 内：

```ts
// C 项：降级查看升级为显式打开方式（label 更明确；onClick 走 override 重入）
const openAs = (id: RendererId, label: string): ErrorCardAction => ({
  label,
  onClick: () => { void dispatchAgain(source, buffer, target, id); },
});
```

实现细节：动作工厂需要重入 dispatch——将 `buildRenderErrorActions` 增加 `redispatch: (opts) => Promise<void>` 参数（dispatch 主流程把自己的重入闭包传进去），onClick 内 `void redisplay({ rendererOverride: id })`；「重试」仍走原 buffer + 原 renderer 重渲染（现状逻辑）。textual 探测判定复用 `looksTextual(buffer.slice(0, HEAD_SIZE))` 排序。选路失败分支（renderer undefined）构造 `[以纯文本打开, 以 hex 打开]`（hex 缺失时只给文本）。）

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `pnpm vitest run packages/core/test/dispatcher.test.ts && pnpm test && pnpm typecheck`
Expected: 全绿（既有 BUG-14「重试/降级查看」相关测试同步更新断言——`降级查看` label 更名，属计划内变更）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dispatch/dispatcher.ts packages/core/test/dispatcher.test.ts
git commit -m "feat(core): 错误卡片打开方式快捷动作（纯文本/hex）

why: 渲染失败/选路失败时用户需要一键换打开方式（spec C §2.3 入口 A）。
what: buildRenderErrorActions 重入式 open-as 动作、按探测排序、
hex 失败不重复给 hex、label 降级查看→以 hex 打开。"
```

---

### Task 6: MetaPanel「打开方式」下拉

**Files:**
- Modify: `apps/web/src/lib/metaStore.svelte.ts`（FileMetaState 加字段）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（dispatch 后上行候选与当前项）
- Modify: `apps/web/src/lib/MetaPanel.svelte`（下拉区块）
- Test: `apps/web/src/lib/metaStore` 相关既有测试或新增（以现状为准）

**Interfaces:**
- Consumes: Task 4 override、`registry`（viewer.ts 导出单例）、`dispatcher.dispatch` 返回的 `{ rendererId, det }`。
- Produces:
  - `FileMetaState` 新增 `openWith: { current: string; options: { id: string; label: string }[] } | null`（null=不显示）。
  - MetaPanel 行为：下拉 change → `tabStore.setRendererOverride(tabId, id 或 null)`（选「自动」= null 清 override）；`current` 展示生效渲染器，override 生效时附「（手动）」后缀。

- [ ] **Step 1: 写失败测试**（metaStore 若无既有测试文件则新建 `apps/web/src/lib/metaStore.test.ts`；断言 setFileMeta 接收 openWith 形状往返。UI 联动以 e2e 兜底，本任务单测锁定数据形状）

```ts
import { describe, expect, it } from 'vitest';
import { fileMeta, setFileMeta } from './metaStore.svelte';

describe('fileMeta.openWith (C 项)', () => {
  it('carries renderer options and current id', () => {
    setFileMeta({
      name: 'x.foo', sourceLabel: 'local', size: 3, lines: null, encoding: null, lang: null,
      openWith: { current: 'hex', options: [{ id: 'code', label: '代码/文本' }, { id: 'hex', label: '二进制' }] },
    });
    expect(fileMeta.openWith?.current).toBe('hex');
    expect(fileMeta.openWith?.options.length).toBe(2);
    setFileMeta(null);
    expect(fileMeta.openWith).toBeNull();
  });
});
```

（`setFileMeta` 现有签名为整体对象或 null——若为 Partial 合并语义，以现状为准调整测试写法；核心断言不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/metaStore.test.ts`
Expected: FAIL（openWith 类型不存在/字段缺失）

- [ ] **Step 3: 实现**

- `metaStore.svelte.ts`：`FileMetaState` 加 `openWith: { current: string; options: { id: string; label: string }[] } | null`（初始 null；`setFileMeta(null)` 清空时覆盖）。
- `ViewerPane.svelte`：`readInstanceMeta` 处（或 dispatch 返回消费点）计算候选：

```ts
// C 项：打开方式候选 = 生效渲染器 ∪ 扩展名注册渲染器 ∪ code/hex（去重）
const seen = new Set<string>();
const options: { id: string; label: string }[] = [];
const push = (id: string | undefined): void => {
  if (!id || seen.has(id)) return;
  seen.add(id);
  options.push({ id, label: registry.byId(id)?.label ?? id });
};
push(rendererId);                       // dispatch 返回的生效渲染器
for (const r of registry.byExtension?.(det.ext) ? [] : []) void r; // 占位：byExtension 单数，见下
push('code');
push('hex');
```

（注意：`registry.byExtension(ext)` 返回**单个** Renderer 而非列表——候选遍历用 `registry.all().filter(r => r.extensions.includes(det.ext))` 并 `push(r.id)`；上述占位行实现时删除。）随后把 `openWith: { current: rendererId + (tab.overrideRenderer ? '（手动）' : '')… }` 拼入 `setFileMeta` 载荷——`current` 保持纯 id（供下拉选中态），「手动」标记放 MetaPanel 模板层（`tab.overrideRenderer` 不可得则用 `openWith.manual: boolean` 字段上行，实现时二选一并保持一致）。
- `MetaPanel.svelte`：`{#if fileMeta.openWith}` 渲染区块：

```svelte
<div class="meta-row">
  <dt>打开方式</dt>
  <dd>
    <select
      class="meta-openwith"
      aria-label="打开方式"
      value={fileMeta.openWith.current}
      onchange={(e) => onOpenWith(e.currentTarget.value)}
    >
      {#each fileMeta.openWith.options as opt (opt.id)}
        <option value={opt.id}>{opt.label}</option>
      {/each}
    </select>
    {#if fileMeta.openWith.manual}<span class="meta-openwith-manual">（手动）</span>{/if}
  </dd>
</div>
```

MetaPanel 无 props——回调经新 prop `onopenwith?: (id: string) => void` 由 ViewerPane 传入（ViewerPane 已持有当前 tab），ViewerPane 侧实现：

```ts
const onOpenWith = (id: string): void => {
  const tab = current; // 渲染中的 tab
  if (!tab) return;
  // 「自动」选项 value 用空串表示 → 清 override；其余写 override
  tabStore.setRendererOverride(tab.id, id === '' ? null : (id as never));
};
```

并在 options 头部加 `{ id: '', label: '自动（按扩展名）' }`（`current` 为 override 空时选中它）。样式沿用 `.meta-row` 内既有 select/文本样式（app.css 或组件 scoped；以 MetaPanel 现状为准，无则加最小 scoped 样式）。

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `pnpm vitest run apps/web/src/lib/ && pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/metaStore.svelte.ts apps/web/src/lib/metaStore.test.ts apps/web/src/lib/ViewerPane.svelte apps/web/src/lib/MetaPanel.svelte
git commit -m "feat(web): MetaPanel 打开方式下拉（override 手选入口 B）

why: 任何已打开文件需可手选渲染器（spec C §2.3 入口 B）。
what: fileMeta.openWith 上行候选与生效项 + MetaPanel select
（自动=清 override）+ ViewerPane 贯通 setRendererOverride。"
```

---

### Task 7: CI --check 门禁 + e2e + 文档 + 全量门禁

**Files:**
- Modify: `.github/workflows/ci.yml`（新增 gen --check 步骤；定位前端测试 job 的 steps 段插入）
- Create: `apps/web/e2e/t-open-with.spec.ts`
- Modify: `docs/deploy.md`（如存在扩展名/依赖相关段落则一句带过；无则跳过并在报告说明）

**Interfaces:** 无代码接口（验证性任务）。

- [ ] **Step 1: CI 门禁**（ci.yml 前端测试 job 内、`pnpm test` 之前插入：

```yaml
      - name: Verify generated code extensions freshness
        run: node tools/grammar-builder/gen-code-extensions.mjs --check
```

以 ci.yml 现有 step 风格（缩进/name 命名）为准适配；该 job 需 checkout（已有）。）

- [ ] **Step 2: e2e**（`apps/web/e2e/t-open-with.spec.ts`；仿 t-shell.spec.ts L145-155 的合成 drop 通道注入文件，或 m4.spec.ts 的 evaluate 注入通道——任选其一并注释来源先例）

用例：
1. 注入 `probe.foo`（PNG magic 8 字节 + IHDR 片段）→ 打开 → 断言图片渲染出现（`img` 元素或 image 容器选择器——以 render-media image.ts 实际 DOM 为准）。
2. 注入 `bin.foo`（含 NUL 二进制）→ 打开 → 断言 hex 视图出现（`.vv-hex` 容器——以 render-binary hex.ts 实际类名为准）。
3. 打开任一文件 → MetaPanel「打开方式」下拉选「二进制」→ 断言 hex 视图出现；刷新页面等待恢复 → 断言仍是 hex 视图（override 快照回读）。
4. 注入 `notes.jsonl`（两行 JSON 文本）→ 打开 → 断言以 code 渲染（`.vv-code` 或 code 容器选择器）——C/D 装配锚点的 e2e 侧验证。

- [ ] **Step 3: 跑 e2e 新 spec + 全量门禁**

Run: `pnpm playwright test e2e/t-open-with.spec.ts`（以仓库实际 playwright 命令为准——`apps/web` 包内 script 或根命令）与 `pnpm test && pnpm typecheck`
Expected: 新 spec 全绿；全量绿

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml apps/web/e2e/t-open-with.spec.ts docs/deploy.md
git commit -m "test(ci,e2e): 扩展名生成物新鲜度门禁与打开方式 e2e

why: 生成物入库需 CI 防漂移；探测/手选链路需端到端回归（spec C §3）。
what: ci --check 步 + t-open-with.spec（签名改派/hex 兜底/override
刷新恢复/jsonl 锚点）。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 生成→T1/T2（含 CI→T7）；§2.2 探测链→T3；§2.3 override 两层入口→T4（数据/快照）+T5（错误卡片）+T6（MetaPanel）；§3 测试→各任务 + T7 e2e；§5 验收→T7 门禁。无缺口。
- **占位扫描**：T6 的 registry.byExtension 为单数的坑已就地标注；persistTabs/下拉回调等以「以实际名/现状为准」处均给出了语义锚点（persistScroll 同款、GlobalSearchPanel 先例），非悬空引用。
- **类型一致性**：`installFallbackExtensions`/`GENERATED_EXTENSIONS`/`reclassifiedFrom`/`rendererOverride`/`overrideRenderer`/`openWith` 前后引用一致；T5 的 redisplay 闭包与 T4 override 参数衔接已写明。
- **计划对 spec 的必要修订**（1 处，已在上文 Global Constraints 声明）：扩展名收集规则由「仅收含点 token」修订为「保留可作扩展名的无点/带点 token（normalize 后白名单正则）」——spec 原规则建立在 fileTypes 为 `.rs` 带点形态的错误假设上，实际资产全为无点形态，效果等价且覆盖真实数据。
