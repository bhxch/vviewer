// mermaid 真加载失败分支：自 markdownPipeline.mermaidFail.test.ts 随管线留守 render-text
// 后，该分支语义由本包承接（迁移前 diagramEngines.test.ts 无任何 mermaid 用例，仅
// graphviz 非法源 reject）。mock 模块工厂抛错模拟加载失败 → import('mermaid') 的
// .catch(() => null) 兜住 → renderMermaid 抛「mermaid 加载失败」→ renderDiagramEngine
// reject（分发层降级错误卡）；renderMermaidInto 吞错返回 false（旧图保留语义）。
// 负结果不缓存（diagramEngines 对 mermaid 无失败缓存）：连续两次同败可重试。
import { describe, expect, it, vi } from 'vitest';
import { renderDiagramEngine, renderMermaidInto } from '../src/markdown/diagramEngines';

// 工厂抛错 = 模块初始化失败形态（非 spy 桩）：错误沿动态 import 传播给调用方
vi.mock('mermaid', () => {
  throw new Error('mermaid 模块加载失败');
});

describe('mermaid 加载失败分支（承接 markdownPipeline.mermaidFail 语义）', () => {
  it('renderDiagramEngine("mermaid") reject 且负结果不缓存（连续两次同败）', async () => {
    await expect(renderDiagramEngine('mermaid', 'graph TD; a-->b')).rejects.toThrow('mermaid 加载失败');
    await expect(renderDiagramEngine('mermaid', 'graph TD; a-->b')).rejects.toThrow('mermaid 加载失败');
  });

  it('renderMermaidInto 失败返回 false：就地重渲染保留旧图不抹除', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<svg data-vv-old="1"></svg>';
    await expect(renderMermaidInto(container, 'graph TD; a-->b', 'default')).resolves.toBe(false);
    expect(container.querySelector('[data-vv-old]')).not.toBeNull();
  });
});
