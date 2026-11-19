// noGrammarRemoteNote.test.ts — 「远程 chunk 命中点的清单注记」两分支直测
// （no-grammar-remote）。
//
// 背景（评审 minor：lazy chunk / 窗口流的远程命中点 no-grammar-remote 注记既无单测
// 也无 e2e——取舍仅存于注释）：spec E 修 2 的清单感知注记有三条落点：
//   · 全量 renderCode 路径（renderCode.ts 的 start() 内）——**已有锚**（code.test.ts
//     的「② hasLocalGrammar=false + onWhere remote 成功 → engineNote no-grammar-remote」）；
//   · **chunk 路径**（renderCode.ts 的 highlightChunk 内，>2MB lazy 文件的远程 chunk
//     命中点）——此前无用例；
//   · **窗口流路径**（renderCodeWindowed.ts 的 chunk 命中点）——此前无用例。
// 本文件补后两条分支的注记行为面（清单外 + 远程命中 → 注记 no-grammar-remote）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamCtx } from '@bhxch/vviewer-core';
import {
  attachHighlightClient,
  attachHighlightRouter,
  renderCode,
  renderCodeWindowed
} from '../src/code';

function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

/** 清单外的 client 桩（hasLocalGrammar=false → 远程兜住即注记 no-grammar-remote） */
function attachOutOfManifestClient(): void {
  attachHighlightClient({
    highlight: async () => [],
    hasLocalGrammar: () => false
  } as never);
}

/** 远程 router 桩：任何 range 请求都返回一个命中区间（远程命中点） */
function attachRemoteRouter(): void {
  attachHighlightRouter(async (_src, _lang, range) => ({
    baseLine: range?.startLine ?? 0,
    intervals: [{ start: 0, end: 1, capture: 'keyword' }]
  }));
}

afterEach(() => {
  attachHighlightClient(null);
  attachHighlightRouter(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('远程 chunk 命中点的清单注记（no-grammar-remote）', () => {
  it('chunk 路径（>2MB lazy 文件的远程 chunk 命中）→ engineNote no-grammar-remote', async () => {
    stubResizeObserver();
    attachOutOfManifestClient();
    attachRemoteRouter();
    // >2MB（超过 TREE_SITTER_MAX_BYTES）→ lazy 策略 → chunk 泵路径
    const content = new TextEncoder().encode('let x = 1\n'.repeat(120_000)); // ≈ 1.2MB…见下断言
    const big = new Uint8Array(2 * 1024 * 1024 + 1024);
    big.set(content.subarray(0, content.length), 0);
    big.fill(0x0a, content.length); // 余量补换行（保持行结构）
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(big, host, {
      ext: 'rs',
      lang: 'rust',
      computeSrc: { path: 'a.rs' }
    });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'), { timeout: 30_000 });
    expect(handle.getComputeWhere()).toBe('remote');
    expect(handle.getMeta().engineNote).toEqual({ kind: 'no-grammar-remote', lang: 'rust' });
    handle.destroy();
  });

  it('窗口流路径（renderCodeWindowed 的远程 chunk 命中）→ engineNote no-grammar-remote', async () => {
    stubResizeObserver();
    attachOutOfManifestClient();
    attachRemoteRouter();
    // 窗口流 ctx：head 8KB + 按 range 续读
    const lines = 4000;
    const line = 'let x = 1\n';
    const full = line.repeat(lines);
    const bytes = new TextEncoder().encode(full);
    const ctx: StreamCtx = {
      size: bytes.byteLength,
      head: bytes.subarray(0, 8192),
      read: async (r) => bytes.subarray(r.start, r.end + 1)
    };
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCodeWindowed(ctx, bytes.subarray(0, 8192), host, {
      ext: 'rs',
      lang: 'rust',
      computeSrc: { path: 'a.rs' }
    });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'), { timeout: 30_000 });
    expect(handle.getComputeWhere()).toBe('remote');
    expect(handle.getMeta().engineNote).toEqual({ kind: 'no-grammar-remote', lang: 'rust' });
    handle.destroy();
  });
});
