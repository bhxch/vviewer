// packages/render-diagram/src/markdown/diagramEngines.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderDiagramEngine } from './diagramEngines';

// 真渲染（wasm/纯 JS 引擎在 node/jsdom 可运行）；个别环境缺能力时 skipIf 兜底，
// 失败语义（reject）单测不依赖真渲染。
const canViz = await import('@viz-js/viz').then(() => true, () => false);
const canNomnoml = await import('nomnoml').then(() => true, () => false);

describe('renderDiagramEngine', () => {
  it.skipIf(!canViz)('graphviz 渲染含 <svg', async () => {
    const html = await renderDiagramEngine('graphviz', 'digraph { a -> b }');
    expect(html).toContain('<svg');
  });
  it.skipIf(!canNomnoml)('nomnoml 渲染含 <svg', async () => {
    const html = await renderDiagramEngine('nomnoml', '[a] -> [b]');
    expect(html).toContain('<svg');
  });
  it('math 走 katex display（html-math-block 类）', async () => {
    const html = await renderDiagramEngine('math', 'c^2');
    expect(html).toContain('katex');
  });
  it('非法 graphviz 源 reject（不是静默字符串）', async () => {
    await expect(renderDiagramEngine('graphviz', 'digraph { a ->')).rejects.toBeTruthy();
  });
});

// svgbob wasm 引擎（spec §7）：glue 构建期生成（pnpm gen:svgbob-wasm，产物不入库），
// 缺产物环境 skipIf 兜底；CI gen 步前移后 vitest 真跑（本地同样真跑）。
// 注意：文件路径经 fileURLToPath(import.meta.url) 直取而非 new URL(rel, import.meta.url)
// ——后者是 vite 的静态资产引用 pattern，vitest transform 时会被改写成虚拟 URL/data URL
//（探针实测），fileURLToPath 即抛错；单独求值 import.meta.url 保持 file:// 不受改写。
const here = dirname(fileURLToPath(import.meta.url));
const hasGen = existsSync(join(here, 'svgbob-wasm-gen/svgbob_wasm.js'));
// glue（wasm-bindgen --target web）init 经 fetch(new URL(..., import.meta.url)) 取同目录
// wasm：浏览器按 http 拉资产；node/jsdom 的 fetch（undici）不支持 file:// URL——
// 本 describe 内临时兜底 file: 读盘转 Response（application/wasm，走流式实例化），
// afterAll 还原原 fetch，不外溢影响其他用例。
const realFetch = globalThis.fetch;
describe.skipIf(!hasGen)('svgbob wasm 引擎', () => {
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href.startsWith('file:')) {
        return new Response(readFileSync(fileURLToPath(href)), { headers: { 'content-type': 'application/wasm' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  it('渲染 fixture 输入与 native 锚一致', async () => {
    const html = await renderDiagramEngine('svgbob', '+-->+\n| a |\n+<--+\n');
    const fixture = readFileSync(join(here, '__fixtures__/svgbob-sample.svg'), 'utf8');
    expect(html).toContain('<svg');
    expect(html).toContain(fixture.slice(fixture.indexOf('<style'), fixture.indexOf('<style') + 80)); // style 块头部锚
  });
});
