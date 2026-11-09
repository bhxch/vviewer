// pdf-load-retry.test.ts — pdfjs 加载失败不入单例：chunk 加载失败（网络抖动/离线未缓存）
// 后，下次打开或错误卡「重试」重新加载 pdfjs，而非复用缓存的失败 Promise（否则一次失败
// 即永久「无法预览此文件」，只能刷新页面）。
import { describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, TreeStore } from '@bhxch/vviewer-core';

const load = vi.hoisted(() => ({ attempts: 0 }));

// 首次求值抛错（模拟动态 chunk 加载失败），之后返回可用桩：getDocument 立即以可辨识的
// 打开失败 reject——第二次 render 落到它即证明 pdfjs 被重新加载
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  load.attempts++;
  if (load.attempts === 1) throw new Error('探针：pdfjs chunk 加载失败');
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    PDFDataRangeTransport: class {},
    getDocument: () => ({
      promise: Promise.reject(new Error('探针：文档打开失败')),
      destroy: () => Promise.resolve()
    })
  };
});

const { pdfRenderer } = await import('../src/pdf');

const source: FileSource = { storeId: 's', storeLabel: 's', path: 'a.pdf', name: 'a.pdf', store: {} as TreeStore };
const det = { ext: 'pdf' } as Detection;

describe('loadPdfjs 失败重试', () => {
  it('首次加载失败上抛；再次 render 重新加载 pdfjs（不复用失败单例）', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    // 首次：模块求值失败（vitest 把工厂抛错包装成自身文案，只断言 reject）
    await expect(pdfRenderer.render(bytes, document.createElement('div'), source, det)).rejects.toThrow();
    await expect(pdfRenderer.render(bytes, document.createElement('div'), source, det)).rejects.toThrow(
      /文档打开失败/
    );
    expect(load.attempts).toBe(2);
  });
});
