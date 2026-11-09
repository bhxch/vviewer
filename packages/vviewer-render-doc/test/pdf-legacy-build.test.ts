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
// - 源码契约锚：pdf.ts 的主模块与 worker 说明符均指向 legacy 构建，防回退。
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
import { pdfRenderer } from '../src/pdf';

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

describe('pdf.ts 源码契约锚：主模块与 worker 走 legacy 构建', () => {
  const src = readFileSync(path.join(here, '../src/pdf.ts'), 'utf8');

  it('动态 import 的 pdfjs 说明符只有 legacy 主模块', () => {
    // 同时覆盖运行期 import(...) 与类型位 typeof import(...)：两者同指一个入口
    const specs = [...src.matchAll(/\bimport\(\s*'(pdfjs-dist[^']*)'\s*\)/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(new Set(specs)).toEqual(new Set(['pdfjs-dist/legacy/build/pdf.mjs']));
  });

  it('worker 资产 URL 只有 legacy worker', () => {
    const urls = [...src.matchAll(/new URL\(\s*'(pdfjs-dist[^']*)'\s*,\s*import\.meta\.url\s*\)/g)].map(
      (m) => m[1]
    );
    expect(urls).toEqual(['pdfjs-dist/legacy/build/pdf.worker.min.mjs']);
  });
});
