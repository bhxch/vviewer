// hexWorkerLeak.test.ts — 终审 Minor 3：ensureSearchClient 中 createWorker() 成功
// 但后续动态 import('./client') 抛出时，须 terminate 已建 worker（防泄漏）并照常
// 降级主线程 scanAll。独立文件隔离 vi.mock（client 拒绝加载），不污染同包其他
// 测试文件的模块注册表。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHex } from '../src/hex';

vi.mock('../src/client', () => {
  throw new Error('client unavailable'); // 动态 import 直接拒绝
});

// jsdom 无 ResizeObserver（虚拟滚动依赖），全文件 stub（照 hex.test.ts 惯例）
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 宏任务轮次排空：mock 模块的 import 拒绝经 vitest 模块运行器多跳异步传播，
 * 固定微任务数不可靠，逐轮 setTimeout 直至稳定（同 scanAll 的块间让出粒度）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('renderHex：ensureSearchClient worker 泄漏防护（终审 Minor 3）', () => {
  it('import client 失败 → 已建搜索 worker 被 terminate，降级主线程扫描照常出命中', async () => {
    const b = new Uint8Array(256);
    b.set([0xde, 0xad], 20); // 单一命中 @20
    const target = document.createElement('div');
    document.body.append(target);
    const fake = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn()
    };
    const inst = renderHex(b, target, {
      // 结构树与搜索各调一次 createWorker，均返回同一 fake（记录 terminate 调用；
      // 结构树 import 同样失败 → 其 catch 降级主线程 parseStruct，与本用例无关）
      createWorker: () => fake as unknown as Worker
    });
    await settle(); // structReady 的 import 拒绝先落地（降级主线程解析）
    const search = target.querySelector('.vv-hex-search') as HTMLInputElement;
    const status = target.querySelector('.vv-hex-search-status') as HTMLElement;
    search.value = 'dead';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(fake.terminate).toHaveBeenCalled(); // import 失败路径终止 worker，不泄漏
    expect(status.textContent).toBe('1/1 处命中'); // 兜底主线程 scanAll 照常收尾
    inst.destroy();
    target.remove();
  });
});
