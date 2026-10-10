import { afterEach, describe, expect, it, vi } from 'vitest';
import { HighlightCanceledError, type HighlightInterval } from '@vviewer/highlight';
import type { Detection, FileSource, RenderedInstance } from '@vviewer/core';
import { attachHighlightClient, type CodeFileMeta } from '../src/code';
import { jsonlRenderer, shouldDelegateToCode } from '../src/jsonl/index';

/** jsonlRenderer.render 按 Renderer 接口返回 RenderedInstance；getMeta 为鸭子扩展 */
type JsonlInstance = RenderedInstance & { getMeta(): CodeFileMeta };

const source: FileSource = {
  storeId: 'local',
  storeLabel: 'local',
  path: '/x.jsonl',
  name: 'x.jsonl',
  store: {} as FileSource['store']
};
const det: Detection = { ext: 'jsonl', encoding: 'utf-8' };
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

/** jsdom 无 ResizeObserver，stub 之（code.test.ts 同款） */
function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

afterEach(() => {
  attachHighlightClient(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('shouldDelegateToCode（>200MB 委托 code 的阈值裁决）', () => {
  it('200MB 整不委托，200MB+1 委托', () => {
    expect(shouldDelegateToCode(200 * 1024 * 1024)).toBe(false);
    expect(shouldDelegateToCode(200 * 1024 * 1024 + 1)).toBe(true);
  });
});

describe('renderJsonl 卡片渲染', () => {
  it('ok/failed/oversize 混合：卡片数=非空行数、failed 带 badge+title、oversize 64KB 预览+徽标、状态条计数', async () => {
    stubResizeObserver();
    const oversize = 'x'.repeat(1_048_576); // ≥1MB 阈值即 oversize（不进 JSON.parse）
    const text = '{"a":1}\nnot json\n' + oversize + '\n';
    const host = mount();
    const inst = (await jsonlRenderer.render(enc(text), host, source, det)) as JsonlInstance;
    const cards = host.querySelectorAll('.vv-jsonl-card');
    expect(cards.length).toBe(3); // 尾空行不入列

    const ok = cards[0]!;
    expect(ok.querySelector('.vv-jsonl-gutter')?.textContent).toBe('1');
    expect((ok.querySelector('.vv-jsonl-body') as HTMLElement).textContent).toBe('{\n  "a": 1\n}');

    const failed = cards[1] as HTMLElement;
    expect(failed.classList.contains('vv-jsonl-card-failed')).toBe(true);
    expect(failed.title).not.toBe(''); // reason 写入 title
    expect(failed.querySelector('.vv-jsonl-badge')?.textContent).toBe('解析失败');

    const oversizeCard = cards[2]!;
    expect(oversizeCard.querySelector('.vv-jsonl-badge')?.textContent).toBe('行过大（>1MB）');
    expect((oversizeCard.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.length)
      .toBe(65_536); // 只保留 64KB 预览

    expect(host.querySelector('.vv-jsonl-status')?.textContent).toBe('共 3 行 · 1 行解析失败');
    expect(host.querySelector('.vv-jsonl-status')?.getAttribute('aria-live')).toBe('polite'); // 恒挂
    expect(inst.getMeta()).toEqual({ encoding: 'utf-8', lang: 'json', size: enc(text).length, lines: 3 });
    inst.destroy();
  });

  it('全空行文件：不进窗口循环，空状态「共 0 行」，无卡片', async () => {
    stubResizeObserver();
    const host = mount();
    const inst = (await jsonlRenderer.render(enc('\n\n  \n'), host, source, det)) as JsonlInstance;
    expect(host.querySelector('.vv-jsonl-status')?.textContent).toBe('共 0 行');
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBe(0);
    expect(inst.getMeta().lines).toBe(0);
    inst.destroy();
  });
});

describe('renderJsonl 卡片级高亮', () => {
  it('首屏只高亮可视卡片（调用量=可视卡片数而非全量），lang 恒 json', async () => {
    stubResizeObserver();
    const calls: Array<[string, string]> = [];
    attachHighlightClient({
      highlight: async (text, lang) => {
        calls.push([text, lang]);
        return [];
      }
    });
    const rows = Array.from({ length: 40 }, (_, i) => JSON.stringify({ i }));
    const host = mount();
    const inst = await jsonlRenderer.render(enc(rows.join('\n')), host, source, det);
    const cards = host.querySelectorAll('.vv-jsonl-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(rows.length); // 窗口内而非全量
    expect(calls.length).toBe(cards.length); // 每可视卡片恰好一次
    expect(calls.every(([, lang]) => lang === 'json')).toBe(true);
    inst.destroy();
  });

  it('pretty 超 1M 字符上限：跳过自动高亮保持纯文本，console.debug 仅一次', async () => {
    stubResizeObserver();
    const calls: Array<[string, string]> = [];
    attachHighlightClient({
      highlight: async (text, lang) => {
        calls.push([text, lang]);
        return [];
      }
    });
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // 27 万个数字元素：raw ≈ 0.54MB（<1MB 不判 oversize），pretty ≈ 1.08M 字符（>1M 上限）
    const compact = '[' + '0,'.repeat(269_999) + '0]';
    const host = mount();
    const inst = await jsonlRenderer.render(enc(compact), host, source, det);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0); // 跳过自动高亮
    expect(
      (host.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.startsWith('[\n  0,')
    ).toBe(true); // pretty 纯文本仍在
    expect(dbg).toHaveBeenCalledTimes(1); // 每卡只留痕一次
    dbg.mockRestore();
    inst.destroy();
  });

  it('intervals 转行 span HTML：highlight 到达后卡片着色（复用 renderLineHtml 管线）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 1, capture: 'keyword' }] as HighlightInterval[]
    });
    const host = mount();
    const inst = await jsonlRenderer.render(enc('{"a":1}'), host, source, det);
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-card .ts-keyword')).not.toBeNull();
    });
    expect(host.querySelector('.vv-jsonl-card .ts-keyword')?.textContent).toBe('{');
    inst.destroy();
  });

  it('highlight reject HighlightCanceledError → 不写 DOM 高亮、静默（无未处理 rejection）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new HighlightCanceledError();
      }
    });
    const host = mount();
    const inst = await jsonlRenderer.render(enc('{"a":1}'), host, source, det);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector('.ts-')).toBeNull(); // 取消不写高亮 DOM
    expect((host.querySelector('.vv-jsonl-body') as HTMLElement).textContent).toBe('{\n  "a": 1\n}');
    inst.destroy();
  });

  it('destroy 后在途 reject 被 swallow（不抛未处理 rejection）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: () =>
        new Promise<HighlightInterval[]>((_, reject) =>
          setTimeout(() => reject(new HighlightCanceledError()), 20)
        )
    });
    const host = mount();
    const inst = await jsonlRenderer.render(enc('{"a":1}'), host, source, det);
    inst.destroy();
    await new Promise((r) => setTimeout(r, 50)); // reject 落在 destroy 之后：被 swallow
    expect(host.querySelector('.vv-jsonl-card')).toBeNull();
    expect(host.classList.contains('vv-jsonl')).toBe(false);
  });
});

describe('renderJsonl 折叠/封顶', () => {
  it('>40 行初始 40 行可见 + 展开按钮；点击后 ≤400 全显', async () => {
    stubResizeObserver();
    // 39 元素数组 pretty 后 41 行（[ + 39 项 + ]），prettyLines 口径 42 > 40 → 折叠
    const compact = JSON.stringify(Array.from({ length: 39 }, (_, i) => i));
    const host = mount();
    const inst = await jsonlRenderer.render(enc(compact), host, source, det);
    const card = host.querySelector('.vv-jsonl-card')!;
    const body = card.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(body.textContent!.split('\n').length).toBe(40); // 折叠 40 行可见
    const btn = card.querySelector('.vv-jsonl-expand') as HTMLButtonElement;
    expect(btn.textContent).toBe('展开全部');
    btn.click(); // 展开全量重渲染该卡片
    const expandedBody = host.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(expandedBody.textContent!.split('\n').length).toBe(41); // slice 容忍 visibleLines=真实+1
    expect(host.querySelector('.vv-jsonl-expand')).toBeNull(); // 展开后按钮移除
    inst.destroy();
  });

  it('>400 行：折叠初始 40 行；展开封顶 400 行 + .vv-jsonl-cap + 卡片内滚动', async () => {
    stubResizeObserver();
    const compact = JSON.stringify(Array.from({ length: 420 }, (_, i) => i)); // pretty 422 行 > 400 封顶
    const host = mount();
    const inst = await jsonlRenderer.render(enc(compact), host, source, det);
    const card = host.querySelector('.vv-jsonl-card')!;
    // spec：默认折叠显示首 40 行（capped 不改变折叠初始态，不再初始 400 行）
    expect((card.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.split('\n').length)
      .toBe(40);
    expect(card.querySelector('.vv-jsonl-cap')).toBeNull(); // 未展开无截断提示
    (card.querySelector('.vv-jsonl-expand') as HTMLButtonElement).click();
    const body = host.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(body.textContent!.split('\n').length).toBe(400); // 展开仍封顶 400 行
    const cap = host.querySelector('.vv-jsonl-cap');
    expect(cap?.textContent).toBe('已截断显示（400 行）'); // N = min(400, 实际 422) = 400
    expect(body.style.maxHeight).not.toBe(''); // 卡片内 max-height 滚动
    expect(body.style.overflowY).toBe('auto');
    expect(host.querySelector('.vv-jsonl-expand')).toBeNull();
    inst.destroy();
  });

  it('failed 巨行（>64KB）：预览截断 + 截断徽标，仍计入失败数', async () => {
    stubResizeObserver();
    const text = '{"a":1}\n' + '{oops' + 'x'.repeat(70_000) + '\n';
    const host = mount();
    const inst = await jsonlRenderer.render(enc(text), host, source, det);
    const failed = host.querySelector('.vv-jsonl-card-failed') as HTMLElement;
    expect((failed.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.length).toBe(65_536);
    expect(failed.textContent).toContain('已截断');
    expect(host.querySelector('.vv-jsonl-status')?.textContent).toBe('共 2 行 · 1 行解析失败');
    inst.destroy();
  });
});
