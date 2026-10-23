// markdownRenderer.mermaidTheme.test.ts — mermaid 主题即时重画事件（spec §9.2，Task 7）。
// 挂载实例监听 vv:diagram-settings-applied（settings 保存路径派发）就地重画本实例
// [data-mermaid] 为 detail.mermaidTheme；与 vv:appearance-applied（外观联动，Task 5
// 既有）同构——引擎经 vi.mock 拦模块边界观察 theme 参数（renderMermaidInto mock）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownRenderer } from './markdownRenderer';
import { setDiagramOptions, getDiagramOptions } from './markdownRenderer';
import { renderMermaidInto } from './diagramEngines';
import { attachHighlightClient } from '../code';

vi.mock('./diagramEngines', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    // 引擎真渲染环境相关（jsdom 无视觉度量）：管线期出图与重画统一桩
    renderDiagramEngine: vi.fn(async () => '<svg data-mock="engine"></svg>'),
    renderMermaidInto: vi.fn(async () => true)
  };
});

const SOURCE = {
  storeId: 's',
  storeLabel: '样本',
  path: 'demo.md',
  name: 'demo.md',
  store: {
    id: 's',
    displayName: () => '样本',
    listChildren: async () => [],
    read: async () => new Uint8Array()
  }
};
const DET = { ext: 'md', encoding: 'utf-8' as const };
const MERMAID_DOC = '```mermaid\ngraph TD; a-->b;\n```\n';

beforeEach(() => {
  attachHighlightClient(null);
  setDiagramOptions(() => ({ krokiHost: '', mermaidTheme: 'default', modeOf: () => 'local' }));
});

afterEach(() => {
  setDiagramOptions(null); // 模块级单例：用后解绑，不污染同进程其他用例
  vi.clearAllMocks();
});

/** 派发后 flush 微任务（renderMermaidInto 桩即刻 resolve，一轮微任务足矣）。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('vv:diagram-settings-applied 即时重画（spec §9.2）', () => {
  it('派发事件触发 [data-mermaid] 重画为设置主题（renderMermaidInto 以 forest 调）', async () => {
    const { renderMermaidInto: intoMock } = await import('./diagramEngines');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    expect(target.querySelector('[data-mermaid]')).not.toBeNull();
    expect(vi.mocked(intoMock)).not.toHaveBeenCalled(); // 派发前零重画（初渲染走管线引擎）
    document.dispatchEvent(
      new CustomEvent('vv:diagram-settings-applied', { detail: { mermaidTheme: 'forest' } })
    );
    await flush();
    expect(vi.mocked(intoMock)).toHaveBeenCalledTimes(1);
    const [el, src, theme] = vi.mocked(intoMock).mock.calls[0]!;
    expect(el).toBe(target.querySelector('[data-mermaid]'));
    expect(src).toBe('graph TD; a-->b;');
    expect(theme).toBe('forest');
    instance.destroy();
  });

  it('destroy 后派发不再重画（per-instance 文档监听随实例摘除）', async () => {
    const { renderMermaidInto: intoMock } = await import('./diagramEngines');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    instance.destroy();
    vi.mocked(intoMock).mockClear();
    document.dispatchEvent(
      new CustomEvent('vv:diagram-settings-applied', { detail: { mermaidTheme: 'forest' } })
    );
    await flush();
    expect(vi.mocked(intoMock)).not.toHaveBeenCalled();
  });

  it('外观事件既有路径回归：vv:appearance-applied detail 仍驱动重画（两监听并存互不挤占）', async () => {
    const { renderMermaidInto: intoMock } = await import('./diagramEngines');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    document.dispatchEvent(
      new CustomEvent('vv:appearance-applied', { detail: { mermaidTheme: 'dark' } })
    );
    await flush();
    expect(vi.mocked(intoMock).mock.calls[0]![2]).toBe('dark');
    instance.destroy();
  });

  it('事件缺 detail 时回退渲染时 ctx 快照（注入通道透传）', async () => {
    setDiagramOptions(() => ({ krokiHost: '', mermaidTheme: 'base', modeOf: () => 'local' }));
    expect(getDiagramOptions()?.mermaidTheme).toBe('base');
    const { renderMermaidInto: intoMock } = await import('./diagramEngines');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    document.dispatchEvent(new CustomEvent('vv:diagram-settings-applied'));
    await flush();
    expect(vi.mocked(intoMock).mock.calls[0]![2]).toBe('base');
    instance.destroy();
  });
});
