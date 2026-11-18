// pdfWorkerUrl.test.ts — pdfjs worker URL 注入缝契约（spec H T3 Step 1）。
//
// 覆盖面（计划 T3 Step 1 明列）：未注入 → URL 形态与现表达式等价
// （`pdfjs-dist/build/pdf.worker.min.mjs` 或 legacy 分支）；注入 → 返回注入值。
//
// 兼容锚（RF 1）：apps/web 不注入 → 默认路径逐字节等价（源码契约锚 + 形态断言双锁）。
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPdfWorkerUrl, setPdfWorkerUrlProvider } from '../src/pdf';

// vitest 下 new URL(rel, import.meta.url) 被 vite 改写成 dev-server URL（探针实测）——
// 按仓内先例单独求值 import.meta.url 取目录（packages/vviewer-render-diagram 的
// diagramEngines.test.ts 同款）。
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '..', 'src', 'pdf.ts'), 'utf8');

afterEach(() => {
  setPdfWorkerUrlProvider(null);
});

describe('pdf worker URL 注入缝', () => {
  it('未注入 → 回退默认表达式（形态为 pdfjs worker 资产路径）', () => {
    const url = getPdfWorkerUrl();
    expect(
      url.endsWith('pdfjs-dist/build/pdf.worker.min.mjs') ||
        url.endsWith('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
    ).toBe(true);
  });

  it('注入 → 返回注入值（宿主资产 URL）', () => {
    setPdfWorkerUrlProvider(() => 'https://webview.internal/ext/dist/webview/pdf/pdf.worker.min.mjs');
    expect(getPdfWorkerUrl()).toBe('https://webview.internal/ext/dist/webview/pdf/pdf.worker.min.mjs');
  });

  it('provider 返回 null → 回退默认表达式', () => {
    setPdfWorkerUrlProvider(() => null);
    const url = getPdfWorkerUrl();
    expect(
      url.endsWith('pdfjs-dist/build/pdf.worker.min.mjs') ||
        url.endsWith('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
    ).toBe(true);
  });

  it('provider 每次调用现取（设置/资产变更后即时生效）', () => {
    let n = 0;
    setPdfWorkerUrlProvider(() => `https://x/${++n}`);
    expect(getPdfWorkerUrl()).toBe('https://x/1');
    expect(getPdfWorkerUrl()).toBe('https://x/2');
  });

  it('解绑（传 null）→ 回退默认表达式', () => {
    setPdfWorkerUrlProvider(() => 'https://x/1');
    expect(getPdfWorkerUrl()).toBe('https://x/1');
    setPdfWorkerUrlProvider(null);
    expect(getPdfWorkerUrl()).not.toBe('https://x/1');
  });

  it('默认表达式逐字未变（源码契约锚——apps/web 兼容锚的一半）', () => {
    expect(SRC).toContain("new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()");
    expect(SRC).toContain(
      "new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()"
    );
  });
});
