// attachPhase.test.ts — 高亮 client 注入相位语义（attach / detach / waiters）直测。
//
// 背景（评审 minor：generation 单飞与 detachHighlightClient「相位回 pending 且不放行
// waiters」语义无任何直接单测）：detachHighlightClient() 全仓**零测试引用**——它只在
// apps/web 的重建路径被调用（highlightClient.ts:199），其契约（重建窗口内挂起的
// waitForAttachedClient 等待者**不被放行**，等新 client attach 时统一放行；与
// attachHighlightClient(null) 的 failed 终态「立即放行 null」成对区分）无行为面锚。
//
// 本文件锁三条：
//   ① attachHighlightClient(client) → 立即放行全部等待者并交付该 client；
//   ② detachHighlightClient() → 相位回 pending：**不放行**等待者（仍挂起），随后
//      attachHighlightClient(新 client) 才放行并交付**新** client（重建窗口语义）；
//   ③ attachHighlightClient(null) → failed 终态：等待者立即放行 null，后续
//      waitForAttachedClient 即刻返回 null（不等待）。
// 超时放行（10s 缺省）另有既有断言面（code.test.ts 的 attach 竞态族），此处不重复。
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  attachHighlightClient,
  detachHighlightClient,
  waitForAttachedClient,
  getHighlightClient,
  __resetAttachPhaseForTest,
  type CodeHighlightClient
} from '../src/code/client';

/** 假 client（只需满足 CodeHighlightClient 的最小面——本文件只验相位与放行语义） */
function fakeClient(id: string): CodeHighlightClient {
  return {
    id,
    highlight: async () => ({ ok: true, intervals: [] }),
    cancelAll: () => undefined,
    dispose: () => undefined,
    isInitFailed: () => false
  } as unknown as CodeHighlightClient;
}

/** 等待者是否已落定（用微任务轮询判定 Promise 状态） */
async function settled<T>(p: Promise<T>): Promise<boolean> {
  const marker = Symbol('pending');
  const result = await Promise.race([
    p.then(() => 'settled' as const),
    Promise.resolve().then(() => Promise.resolve()).then(() => marker)
  ]);
  return result !== marker;
}

describe('高亮 client 注入相位（attach / detach / waiters）', () => {
  beforeEach(() => {
    __resetAttachPhaseForTest(); // 相位回 pending（模拟「client 尚未创建」的启动窗口）
    vi.useRealTimers();
  });

  it('① attachHighlightClient(client)：立即放行等待者并交付该 client', async () => {
    const waiter = waitForAttachedClient(1_000);
    const client = fakeClient('c1');
    attachHighlightClient(client);
    await expect(waiter).resolves.toBe(client);
    expect(getHighlightClient()).toBe(client);
  });

  it('② detachHighlightClient()：相位回 pending 且**不放行**等待者（重建窗口语义）', async () => {
    const waiter = waitForAttachedClient(1_000);
    // 重建：相位回 pending，等待者继续挂起（不放行 → 在途重渲染等的是新 client）
    detachHighlightClient();
    expect(getHighlightClient()).toBeNull();
    // 等待者仍未落定（关键断言：detach 不放行）
    expect(await settled(waiter)).toBe(false);
    // 新 client attach → 统一放行并交付**新** client
    const fresh = fakeClient('c2');
    attachHighlightClient(fresh);
    await expect(waiter).resolves.toBe(fresh);
  });

  it('③ attachHighlightClient(null)：failed 终态——等待者立即放行 null，后续不等待', async () => {
    const waiter = waitForAttachedClient(1_000);
    attachHighlightClient(null);
    await expect(waiter).resolves.toBeNull();
    // 终态：后续 waitForAttachedClient 即刻返回 null（不挂起）
    await expect(waitForAttachedClient(1_000)).resolves.toBeNull();
  });

  it('⑤ 超时放行留痕：10s 上限到点 → console.warn 记明成因（评审 minor：超时路径原零日志——重建慢于上限时本次渲染永久落 hljs 兜底，排查面全无）', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waiter = waitForAttachedClient(10_000);
    vi.advanceTimersByTime(10_000);
    await expect(waiter).resolves.toBeNull(); // 超时放行：仍为 null → 调用方走 hljs 兜底
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain('highlight client attach timed out');
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('④ 相位语义的对照：attach(null) 放行 vs detach 不放行（重建与失败终态成对区分）', async () => {
    const failed = waitForAttachedClient(1_000);
    attachHighlightClient(null);
    expect(await settled(failed)).toBe(true);

    __resetAttachPhaseForTest();
    const detached = waitForAttachedClient(1_000);
    detachHighlightClient();
    expect(await settled(detached)).toBe(false);
  });
});
