// hexWorkerUrl.test.ts — hex 解析 worker URL 注入缝契约（spec H T3 Step 1）。
//
// 覆盖面（计划 T3 Step 1 明列）：未注入 → `new URL('./binary.worker.ts', import.meta.url)`
// 形态；注入 → 注入值；provider 返回 null → 回退默认。
//
// 兼容锚（RF 1）：apps/web 不注入 → 默认路径逐字节等价（源码契约锚 + null 语义双锁）。
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHexWorkerUrl, setHexWorkerUrlProvider } from '../src/hex';

// vitest 下 new URL(rel, import.meta.url) 被 vite 改写成 dev-server URL（探针实测）——
// 按仓内先例单独求值 import.meta.url 取目录（packages/vviewer-render-diagram 的
// diagramEngines.test.ts 同款）。
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '..', 'src', 'hex.ts'), 'utf8');

afterEach(() => {
  setHexWorkerUrlProvider(null);
});

describe('hex worker URL 注入缝', () => {
  it('未注入 → 无注入值（走默认表达式 new URL("./binary.worker.ts", import.meta.url)）', () => {
    expect(getHexWorkerUrl()).toBeNull();
  });

  it('注入 → 返回注入值（宿主资产 URL）', () => {
    setHexWorkerUrlProvider(() => 'https://webview.internal/ext/dist/webview/binary-worker.js');
    expect(getHexWorkerUrl()).toBe('https://webview.internal/ext/dist/webview/binary-worker.js');
  });

  it('provider 返回 null → 回退默认（null 语义）', () => {
    setHexWorkerUrlProvider(() => null);
    expect(getHexWorkerUrl()).toBeNull();
  });

  it('provider 每次调用现取（资产变更后即时生效）', () => {
    let n = 0;
    setHexWorkerUrlProvider(() => `https://x/${++n}`);
    expect(getHexWorkerUrl()).toBe('https://x/1');
    expect(getHexWorkerUrl()).toBe('https://x/2');
  });

  it('解绑（传 null）→ 回退默认', () => {
    setHexWorkerUrlProvider(() => 'https://x/1');
    expect(getHexWorkerUrl()).toBe('https://x/1');
    setHexWorkerUrlProvider(null);
    expect(getHexWorkerUrl()).toBeNull();
  });

  it('默认表达式逐字未变（源码契约锚——apps/web 兼容锚的一半）', () => {
    expect(SRC).toContain("new URL('./binary.worker.ts', import.meta.url)");
  });
});
