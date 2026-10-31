// glue.test.ts — 薄装配层契约测试：attach/dispose 注入缝接线、disposed client 的
// 取消语义透传、区间→行 HTML 纯函数产物形态。协议本身（init 握手/看门狗/去重）
// 属 @bhxch/vviewer-highlight client.ts 的已测面，此处只 mock Worker 骨架。
import { afterEach, describe, expect, it } from 'vitest';
import { HighlightCanceledError, type HighlightInterval } from '@bhxch/vviewer-highlight';
import { getHighlightFence } from '@bhxch/vviewer-markdown';
import {
  attachMarkdownHighlightWorker,
  createMarkdownHighlightFence,
  intervalsToLineHtml,
} from '../src/index';

/** 假 worker：HighlightClient 只对实例做 onmessage/onerror 赋值与 postMessage/terminate 调用。 */
function fakeWorker(): Worker & { terminateCalls: () => number } {
  let terminated = 0;
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
    terminate: () => {
      terminated += 1;
    },
    terminateCalls: () => terminated,
  } as unknown as Worker & { terminateCalls: () => number };
}

const handles: { dispose(): void }[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
});

describe('attachMarkdownHighlightWorker（注入缝接线）', () => {
  it('attach 即接管注入缝，dispose 解绑回默认（null）并终止 worker', () => {
    const w = fakeWorker();
    const handle = attachMarkdownHighlightWorker({ makeWorker: () => w });
    handles.push(handle);
    expect(getHighlightFence()).toBe(handle.fence);
    handle.dispose();
    expect(getHighlightFence()).toBeNull();
    expect(w.terminateCalls()).toBe(1);
  });

  it('重复 attach 为后来者胜（单缝覆盖语义），dispose 各自独立', () => {
    const h1 = attachMarkdownHighlightWorker({ makeWorker: () => fakeWorker() });
    handles.push(h1);
    const h2 = attachMarkdownHighlightWorker({ makeWorker: () => fakeWorker() });
    handles.push(h2);
    expect(getHighlightFence()).toBe(h2.fence);
    h2.dispose();
    expect(getHighlightFence()).toBeNull(); // 后来者解绑后缝为空（不回退到 h1）
    expect(getHighlightFence()).toBeNull();
    h1.dispose();
    expect(getHighlightFence()).toBeNull();
  });
});

describe('createMarkdownHighlightFence（契约语义）', () => {
  it('disposed 后 fence 短路为取消错误重抛（管线跳过、不 hljs 兜底）', async () => {
    const handle = createMarkdownHighlightFence(fakeWorker());
    handle.dispose();
    await expect(handle.fence('x', 'ts')).rejects.toMatchObject({ name: 'HighlightCanceled' });
  });

  it('取消错误身份：reject 的是 HighlightCanceledError 实例（isAbortError 判据同源）', async () => {
    // dispose 后短路路径可确定性触发（未 dispose 会真等 worker 回包，假 worker 不回）
    const handle = createMarkdownHighlightFence(fakeWorker());
    handle.dispose();
    const err = await handle.fence('x', 'ts').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HighlightCanceledError);
  });
});

describe('intervalsToLineHtml（区间→行 HTML 纯函数）', () => {
  it('空区间 → 逐行转义原文（renderLineHtml 无段落形态）', () => {
    expect(intervalsToLineHtml('a<b\nc', [])).toBe('a&lt;b\nc');
    expect(intervalsToLineHtml('', [])).toBe('');
  });

  it('命中区间 → span 类名走 capture 归约（.ts-* 映射段同一来源）', () => {
    const intervals: HighlightInterval[] = [{ start: 0, end: 5, capture: 'keyword' }];
    const html = intervalsToLineHtml('const x', intervals);
    expect(html).toContain('ts-');
    expect(html).toContain('const');
    expect(html).toContain('x');
  });

  it('跨行区间按行分配（内层优先展平，行文本各自独立转义）', () => {
    const intervals: HighlightInterval[] = [{ start: 0, end: 5, capture: 'keyword' }];
    const html = intervalsToLineHtml('const\nx', intervals);
    const [first, second] = html.split('\n');
    expect(first).toContain('ts-');
    expect(second).toBe('x'); // 区间不落到第二行 → 第二行无段落
  });
});
