// @vitest-environment node
// pdf-legacy-build.test.ts — pdfjs 构建选型锚（问题 #4：电脑上 PDF 报「无法预览此文件
// Iterator is not defined」）。
// 根因：现代构建 pdfjs-dist/build/pdf.mjs 在模块顶层执行
// `typeof Iterator.prototype.join !== "function"`——typeof 只保护裸标识符，无全局 Iterator
// 的浏览器（Chrome/Edge<122、Firefox<131、Safari<18.4）求值 Iterator.prototype 即抛
// ReferenceError，PDF 渲染器整体加载失败；worker 产物同款。legacy 构建由内置 core-js 先
// 注册全局 Iterator 再做同款检查，可安全求值。
// 本文件用真实 pdfjs 模块（不 mock）、在 node 环境删除全局 Iterator 复现旧浏览器条件：
// - 对照：现代构建主模块 / worker 求值即抛（证明删除手法有判别力）；
// - pdf.ts 实际加载链（render → loadPdfjs）越过 pdfjs 加载阶段；
// - legacy worker 求值成功；
// - 浏览器感知构建选择（preferModernBuild 真值表）：特性齐备选现代构建、任一缺失选
//   legacy（core-js polyfill 清单即现代构建的真实特性面）；
// - 源码契约锚：双构建动态 import 与 worker 资产同受 preferModernBuild 门控，渲染根
//   暴露 data-pdf-build 判别面。
// 模块缓存：pdfjs-dist 属 node_modules 依赖，vitest 将其 externalize 交 Node 原生 ESM
// 加载——原生模块缓存不受 vi.resetModules 影响，同一模块 URL 在本文件内只求值一次（求值
// 失败的记录同样缓存）。故各用例导入的模块 URL 互不重叠、首次导入即该例的断言对象
// （现代主模块只在对照例导入；legacy 主模块只经 pdf.ts 加载链导入）；跨文件隔离由
// vitest 默认 isolate 保证。jsdom 环境无必要（render 在加载阶段之后、触达 DOM 之前即落定）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Detection, FileSource, StreamCtx, TreeStore } from '@bhxch/vviewer-core';
import { pdfRenderer, preferModernBuild, resetPdfBuildDecisionForTest } from '../src/pdf';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 进程原生 Iterator 的属性描述符（删除前快照，每例后原样复位） */
const ITERATOR_DESC = Object.getOwnPropertyDescriptor(globalThis, 'Iterator');

/**
 * 非字面量说明符动态导入：pdfjs 的 worker 与现代构建子路径没有 .d.mts 声明，字面量
 * import 过不了 tsc（noImplicitAny 下 TS7016）；运行期经 vitest 解析器按本文件位置解析。
 */
function importById(id: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ id) as Promise<Record<string, unknown>>;
}

describe('pdfjs 构建选型：无全局 Iterator 的旧浏览器条件', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'Iterator');
    // 前置自检：删除确实生效，否则下列判定全部失去判别力
    expect(typeof (globalThis as { Iterator?: unknown }).Iterator).toBe('undefined');
  });

  afterEach(() => {
    // legacy 构建的 core-js 会在缺失时补注册 Iterator：一律以原生描述符覆盖复位
    if (ITERATOR_DESC !== undefined) Object.defineProperty(globalThis, 'Iterator', ITERATOR_DESC);
    else Reflect.deleteProperty(globalThis, 'Iterator');
  });

  it('对照：现代构建主模块求值即抛 ReferenceError: Iterator is not defined', async () => {
    await expect(importById('pdfjs-dist/build/pdf.mjs')).rejects.toThrow(/Iterator is not defined/);
  });

  it('对照：现代构建 worker 同款求值即抛', async () => {
    await expect(importById('pdfjs-dist/build/pdf.worker.min.mjs')).rejects.toThrow(
      /Iterator is not defined/
    );
  });

  it('pdf.ts 实际加载链：render 越过 pdfjs 加载阶段，失败点落在其后的全量读（而非 ReferenceError）', async () => {
    // 让 render 在加载 pdfjs 之后的第一个异步点确定性失败：ctx.size 为 null → 全量守卫
    // 补拉（memoizedFullRead）→ ctx.read reject。加载阶段若抛错（现代构建），render 会先以
    // ReferenceError 失败，到不了读阶段
    const readFailure = new Error('探针：全量读失败');
    const ctx: StreamCtx = {
      size: null,
      head: new Uint8Array(8),
      read: async () => {
        throw readFailure;
      }
    };
    const source: FileSource = {
      storeId: 's-probe',
      storeLabel: '探针 store',
      path: '/probe.pdf',
      name: 'probe.pdf',
      store: {} as TreeStore
    };
    const rendering = pdfRenderer.render(
      new Uint8Array(8),
      {} as HTMLElement, // 失败点早于任何 DOM 操作，target 不会被触达
      source,
      { ext: 'pdf' } as Detection,
      ctx
    );
    await expect(rendering).rejects.toBe(readFailure);
  });

  it('legacy 构建 worker 求值成功（导出 WorkerMessageHandler）', async () => {
    const worker = await importById('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
    expect(typeof worker.WorkerMessageHandler).toBe('function');
  });
});

// ---------- 浏览器感知构建选择：preferModernBuild 真值表 ----------

/** 特性探针位：legacy 构建 core-js polyfill 清单里的现代特性（即现代构建的真实依赖面） */
interface FeatureSlot {
  host: object;
  key: string;
}
const NOOP = (): void => {};
const SLOTS: Record<string, FeatureSlot> = {
  iterator: { host: globalThis, key: 'Iterator' },
  iteratorMap: { host: (globalThis as unknown as { Iterator: { prototype: object } }).Iterator.prototype, key: 'map' },
  setUnion: { host: Set.prototype, key: 'union' },
  fromBase64: { host: Uint8Array as unknown as object, key: 'fromBase64' },
  getOrInsert: { host: Map.prototype, key: 'getOrInsert' },
  promiseTry: { host: Promise as unknown as object, key: 'try' },
  urlParse: { host: URL as unknown as object, key: 'parse' },
  rawJSON: { host: JSON as unknown as object, key: 'rawJSON' },
  sumPrecise: { host: Math, key: 'sumPrecise' }
};
const stash = new Map<FeatureSlot, PropertyDescriptor | undefined>();

/** 置为函数桩（已是函数则不动；原始描述符记入 stash 供复位） */
function ensure(slot: FeatureSlot): void {
  if (typeof (slot.host as Record<string, unknown>)[slot.key] === 'function') return;
  if (!stash.has(slot)) stash.set(slot, Object.getOwnPropertyDescriptor(slot.host, slot.key));
  Object.defineProperty(slot.host, slot.key, { value: NOOP, writable: true, configurable: true, enumerable: false });
}

/** 删除特性（缺失形态） */
function remove(slot: FeatureSlot): void {
  if (!stash.has(slot)) stash.set(slot, Object.getOwnPropertyDescriptor(slot.host, slot.key));
  delete (slot.host as Record<string, unknown>)[slot.key];
}

function restoreFeatures(): void {
  for (const [slot, desc] of stash) {
    if (desc !== undefined) Object.defineProperty(slot.host, slot.key, desc);
    else delete (slot.host as Record<string, unknown>)[slot.key];
  }
  stash.clear();
}

describe('preferModernBuild 真值表（浏览器感知构建选择）', () => {
  const ALL = Object.values(SLOTS);

  beforeEach(() => {
    // 判定定格复位（首用定格语义——逐例需要干净判定；前序 describe 的 render 已定格 false）
    resetPdfBuildDecisionForTest();
  });

  afterEach(() => {
    restoreFeatures();
    resetPdfBuildDecisionForTest();
    // 前置自检的对称面：复位后探针必须回到真值（桩未漏复原即在此红）
    expect(preferModernBuild()).toBe(true);
  });

  it('全部特性在场 → 现代构建', () => {
    ALL.forEach(ensure);
    expect(preferModernBuild()).toBe(true);
  });

  it('任一特性缺失 → legacy 构建（逐个验证；core-js 清单即现代构建真实依赖面）', () => {
    for (const slot of ALL) {
      restoreFeatures();
      ALL.forEach(ensure);
      remove(slot);
      resetPdfBuildDecisionForTest();
      expect(preferModernBuild(), `缺失 ${slot.key} 时应选 legacy`).toBe(false);
    }
    restoreFeatures();
  });

  it('首用定格：探针读数后续变化不翻转判定（core-js 补回缺失特性后标记不漂移）', () => {
    remove(SLOTS.iterator!);
    resetPdfBuildDecisionForTest();
    expect(preferModernBuild()).toBe(false);
    // 模拟 legacy core-js 加载后补回全局 Iterator：定格的判定不变
    ensure(SLOTS.iterator!);
    ensure(SLOTS.iteratorMap!);
    expect(preferModernBuild()).toBe(false);
  });
});

describe('pdf.ts 源码契约锚：能力感知双构建', () => {
  const src = readFileSync(path.join(here, '../src/pdf.ts'), 'utf8');

  it('动态 import 双构建都在场且同受 preferModernBuild 门控', () => {
    const specs = [...src.matchAll(/\bimport\(\s*'(pdfjs-dist[^']*)'\s*\)/g)].map((m) => m[1]);
    expect(new Set(specs)).toEqual(new Set(['pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs']));
    expect(src).toMatch(/preferModernBuild\(\)\s*\?\s*import\('pdfjs-dist'\)/);
    expect(src).toMatch(/:\s*import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
  });

  it('worker 资产 URL 双构建都在场且同一判定选择', () => {
    expect(src).toContain("'pdfjs-dist/build/pdf.worker.min.mjs'");
    expect(src).toContain("'pdfjs-dist/legacy/build/pdf.worker.min.mjs'");
    // worker 与主模块同一判定（worker 独立全局，主线程 polyfill 带不过去）
    expect(src).toMatch(/preferModernBuild\(\)[^;]*pdf\.worker/);
  });

  it('渲染根暴露构建标记（e2e 判别面 data-pdf-build）', () => {
    expect(src).toMatch(/root\.dataset\.pdfBuild\s*=/);
    expect(src).toMatch(/preferModernBuild\(\)\s*\?\s*'modern'\s*:\s*'legacy'/);
  });
});
