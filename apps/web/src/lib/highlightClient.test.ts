// highlightClient.test.ts — 应用级 HighlightClient 单例（apps/web/src/lib/highlightClient.ts）
// 的**代际守卫**与**重建门控**直测（评审 minor：generation 单飞与 detach 相位语义此前
// 无任何直接单测——apps/web/src/lib 下无 highlightClient 直测文件）。
//
// 本文件覆盖：
//   ① 代际守卫：重建（generation+1）后，**在途旧代际** create 落定即废弃——旧产物
//      不落袋（不 attach、不写语法清单），旧 promise 以 superseded 报错；新代际产物
//      才落袋（spec C §3.2「代际计数防在途旧 promise 落袋覆盖新 client 的 attach 面」
//      的行为面锚）。
//   ② 重建门控（限流器）：健康 client + 显式动作（无 force）→ no-op（不 dispose、不
//      重建）；force → 重建并 dispose 旧实例。
//   ③ 相位语义（detach 不放行 waiters）在包侧另有直测：
//      packages/vviewer-render-text/test/attachPhase.test.ts。
//
// 依赖桩（SvelteKit 虚拟模块/runes 模块/资产链/worker 类）见下方 vi.mock —— 本文件
// 只锁「代际与门控」语义，不重复资产链与 worker 行为面。
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** 每次 assembleGrammarLayers 调用的放行器（按调用序） */
  assetResolvers: [] as Array<() => void>,
  /** 构造出的 HighlightClient 桩实例（按构造序） */
  constructed: [] as string[],
  /** dispose 过的实例 id */
  disposed: [] as string[]
}));

vi.mock('./openFlow.svelte', () => ({
  loadCapabilities: async () => ({}),
  loadComputeLanguages: () => [],
  loadLastServer: () => null
}));

vi.mock('./grammarLayers', () => ({
  assembleGrammarLayers: () =>
    new Promise((resolve) => {
      mocks.assetResolvers.push(() =>
        resolve({
          grammars: { rust: { file: 'rust.wasm', base: './', aliases: [] } },
          layers: [{ base: './', source: 'same-origin' }]
        })
      );
    }),
  grammarTableHas: () => true,
  grammarWarmUrl: () => ''
}));

vi.mock('@bhxch/vviewer-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bhxch/vviewer-highlight')>();
  class FakeHighlightClient {
    readonly id: string;
    constructor() {
      this.id = `fake-${mocks.constructed.length + 1}`;
      mocks.constructed.push(this.id);
    }
    async highlight() {
      return { ok: true, intervals: [] };
    }
    isInitFailed(): boolean {
      return false;
    }
    dispose(): void {
      mocks.disposed.push(this.id);
    }
  }
  return { ...actual, HighlightClient: FakeHighlightClient };
});

/** worker 桩（jsdom 无 Worker；本文件不测 worker 行为） */
class FakeWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

describe('应用级 highlightClient 单例 · 代际守卫与重建门控', () => {
  beforeEach(() => {
    mocks.assetResolvers.length = 0;
    mocks.constructed.length = 0;
    mocks.disposed.length = 0;
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules(); // 模块级状态（clientPromise/generation/grammarManifest）复位
  });

  it('① 代际守卫：重建后在途旧代际 create 落定即废弃（不落袋、superseded 报错），新代际产物才 attach', async () => {
    const mod = await import('./highlightClient');
    const stale = mod.ensureHighlightClient(); // 创建在途（资产层 pending）
    expect(stale).not.toBeNull();
    expect(mocks.assetResolvers.length).toBe(1);

    // 重建（force）：代际 +1 → 旧代际产物作废
    mod.recreateHighlightClient({ force: true });
    expect(mocks.assetResolvers.length).toBe(2); // 新代际 create 已起

    // 放行旧代际的资产层 → create 的代际检查命中（gen !== generation）→ 抛 superseded
    mocks.assetResolvers[0]!();
    await expect(stale).rejects.toThrow(/superseded/);
    expect(mocks.constructed).toEqual([]); // 旧代际**未构造**产物（不落袋）

    // 放行新代际 → 产物落袋（attach 面由它接管）
    mocks.assetResolvers[1]!();
    const fresh = await mod.ensureHighlightClient();
    expect(fresh).not.toBeNull();
    expect(mocks.constructed).toEqual(['fake-1']); // 只有新代际产物被构造
    expect(mocks.disposed).toEqual([]); // 无需 dispose（旧代际无产物）
  });

  it('② 重建门控：健康 client + 显式动作（无 force）→ no-op（不 dispose、不重建）', async () => {
    const mod = await import('./highlightClient');
    const pending = mod.ensureHighlightClient();
    expect(pending).not.toBeNull();
    mocks.assetResolvers[0]!();
    const client = await pending;
    expect(client).not.toBeNull();
    expect(mocks.constructed).toEqual(['fake-1']);

    // 显式动作（无 force）：健康态 → 门即限流器 → no-op
    mod.recreateHighlightClient();
    expect(mocks.disposed).toEqual([]); // 旧实例未被 dispose（未重建）
    expect(mocks.constructed).toEqual(['fake-1']); // 未新建实例
    expect(mocks.assetResolvers.length).toBe(1); // 未重跑资产链
  });

  it('③ 重建（force）：旧实例被 dispose，新代际重新起资产链', async () => {
    const mod = await import('./highlightClient');
    const pending = mod.ensureHighlightClient();
    mocks.assetResolvers[0]!();
    await pending;
    expect(mocks.constructed).toEqual(['fake-1']);

    mod.recreateHighlightClient({ force: true });
    expect(mocks.disposed).toEqual(['fake-1']); // 旧实例 dispose
    expect(mocks.assetResolvers.length).toBe(2); // 新代际起资产链
  });
});
