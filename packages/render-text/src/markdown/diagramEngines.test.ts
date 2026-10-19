// packages/render-text/src/markdown/diagramEngines.test.ts
import { describe, expect, it } from 'vitest';
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
