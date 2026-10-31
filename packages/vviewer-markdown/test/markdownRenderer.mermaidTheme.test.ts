// markdownRenderer.mermaidTheme.test.ts — mermaid 主题即时重画（spec §9.2，Task 7）。
// 原实现挂载实例监听 vv:appearance-applied / vv:diagram-settings-applied 两事件就地
// 重画本实例 [data-mermaid]；迁入本包时该联动参数化为实例 API applyTheme
// （包内不硬编码 vv:* 事件名，应用切换时由宿主把事件桥接到 API）——本文件锁
// applyTheme 语义：指定主题重画 / destroy 后不再重画 / 缺参回退渲染时快照 /
// 多实例只刷自己的容器。引擎经 vi.mock 拦模块边界观察 theme 参数
//（renderMermaidInto mock）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownRenderer, setDiagramOptions, setHighlightFence } from '../src/markdownRenderer';
import type { MarkdownRenderedInstance } from '../src/markdownRenderer';
import { renderMermaidInto, type MermaidTheme } from '@bhxch/vviewer-render-diagram';

vi.mock('@bhxch/vviewer-render-diagram', async (importOriginal) => {
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
  // 失败终态等价：围栏高亮回调恒 null（本文件夹具无普通围栏，不触发；语义对齐
  // 原 attachHighlightClient(null) 的 hljs 兜底路径）
  setHighlightFence(async () => null);
  setDiagramOptions(() => ({ krokiHost: '', mermaidTheme: 'default', modeOf: () => 'local' }));
});

afterEach(() => {
  setDiagramOptions(null); // 模块级单例：用后解绑，不污染同进程其他用例
  setHighlightFence(null);
  vi.clearAllMocks();
});

/** 渲染联合收窄：正常实例必有 applyTheme（超大降级实例无——鸭子探测）。 */
function applyThemeOf(instance: { destroy(): void }): (opts?: { mermaidTheme?: MermaidTheme }) => void {
  if (!('applyTheme' in instance)) throw new Error('非正常渲染实例（缺 applyTheme）');
  return (instance as MarkdownRenderedInstance).applyTheme.bind(instance);
}

/** flush 微任务（renderMermaidInto 桩即刻 resolve，一轮微任务足矣）。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('applyTheme 即时重画（spec §9.2 参数化形态）', () => {
  it('applyTheme({ mermaidTheme }) 触发本实例 [data-mermaid] 重画（renderMermaidInto 以 forest 调）', async () => {
    const { renderMermaidInto: intoMock } = await import('@bhxch/vviewer-render-diagram');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    const applyTheme = applyThemeOf(instance);
    expect(target.querySelector('[data-mermaid]')).not.toBeNull();
    expect(vi.mocked(intoMock)).not.toHaveBeenCalled(); // 重画前零调用（初渲染走管线引擎）
    applyTheme({ mermaidTheme: 'forest' });
    await flush();
    expect(vi.mocked(intoMock)).toHaveBeenCalledTimes(1);
    const [el, src, theme] = vi.mocked(intoMock).mock.calls[0]!;
    expect(el).toBe(target.querySelector('[data-mermaid]'));
    expect(src).toBe('graph TD; a-->b;');
    expect(theme).toBe('forest');
    instance.destroy();
  });

  it('destroy 后 applyTheme 不再重画（per-instance 钩子随实例失效）', async () => {
    const { renderMermaidInto: intoMock } = await import('@bhxch/vviewer-render-diagram');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    const applyTheme = applyThemeOf(instance);
    instance.destroy();
    vi.mocked(intoMock).mockClear();
    applyTheme({ mermaidTheme: 'forest' });
    await flush();
    expect(vi.mocked(intoMock)).not.toHaveBeenCalled();
  });

  it('applyTheme 缺参回退渲染时 ctx 快照（diagram 注入通道透传）', async () => {
    setDiagramOptions(() => ({ krokiHost: '', mermaidTheme: 'base', modeOf: () => 'local' }));
    const { renderMermaidInto: intoMock } = await import('@bhxch/vviewer-render-diagram');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), target, SOURCE, DET);
    applyThemeOf(instance)();
    await flush();
    expect(vi.mocked(intoMock).mock.calls[0]![2]).toBe('base');
    instance.destroy();
  });

  it('多实例共存：applyTheme 查询锚定本实例 target，只刷自己的容器', async () => {
    const { renderMermaidInto: intoMock } = await import('@bhxch/vviewer-render-diagram');
    const targetA = document.createElement('div');
    const targetB = document.createElement('div');
    const instA = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), targetA, SOURCE, DET);
    const instB = await markdownRenderer.render(new TextEncoder().encode(MERMAID_DOC), targetB, SOURCE, DET);
    vi.mocked(intoMock).mockClear();
    applyThemeOf(instA)({ mermaidTheme: 'dark' });
    await flush();
    expect(vi.mocked(intoMock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(intoMock).mock.calls[0]![0]).toBe(targetA.querySelector('[data-mermaid]'));
    expect(vi.mocked(intoMock).mock.calls[0]![2]).toBe('dark');
    instA.destroy();
    instB.destroy();
  });
});
