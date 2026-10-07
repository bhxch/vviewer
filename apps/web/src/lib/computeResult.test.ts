import { describe, expect, it, vi } from 'vitest';
import { createComputeRouter, RemoteComputeError, type HighlightInterval } from '@vviewer/core';
import { resolveHighlightResult } from './computeResult';

/**
 * 跨包链路测试（core router → computeResult 收敛 → render-text 错误卡）：
 * routeMock remote 500 时，显式 remote 策略必须以 RemoteComputeError 浮出
 * （渲染端据此显示错误卡而非静默降级 hljs），auto 策略则回退本地不报错。
 */

/** 显式 remote 策略的 router：远程调用一律尝试（不回退语义由 runRouted 保证） */
function remoteRouter(policy: 'auto' | 'remote') {
  return createComputeRouter({
    hasCompute: () => true,
    policy: () => policy,
    remote: { base: () => 'http://127.0.0.1:8321', token: () => null }
  });
}

const REMOTE_500 = async (): Promise<HighlightInterval[]> => {
  throw new Error('远程高亮失败: HTTP 500');
};

describe('resolveHighlightResult（withDebug 结果收敛点，跨包契约）', () => {
  it('routeMock remote 500 + 显式 remote：不回退本地，抛 RemoteComputeError', async () => {
    const localFn = vi.fn(async () => [{ start: 0, end: 1, capture: 'keyword' }]);
    const res = await remoteRouter('remote').routeHighlight(
      { path: 'src/main.rs', text: 'fn main() {}' },
      'rust',
      localFn,
      REMOTE_500
    );
    expect(res.where).toBe('remote');
    expect(res.ok).toBe(false);
    expect(localFn).not.toHaveBeenCalled(); // 显式 remote 不回退本地
    expect(() => resolveHighlightResult(res)).toThrow(RemoteComputeError);
    try {
      resolveHighlightResult(res);
      expect.unreachable('应抛出 RemoteComputeError');
    } catch (err) {
      expect((err as Error).name).toBe('RemoteComputeFailed');
      expect((err as Error).message).toContain('HTTP 500');
    }
  });

  it('routeMock remote 500 + auto：回退本地成功结果，原样放行不报错', async () => {
    const intervals: HighlightInterval[] = [{ start: 0, end: 2, capture: 'keyword' }];
    const res = await remoteRouter('auto').routeHighlight(
      { path: 'src/main.rs', text: 'fn main() {}' },
      'rust',
      async () => intervals,
      REMOTE_500
    );
    expect(res.where).toBe('local');
    expect(res.ok).toBe(true);
    expect(resolveHighlightResult(res)).toEqual(intervals);
  });

  it('取消身份：message 前缀重建 HighlightCanceledError（优先于 remote 分支）', () => {
    expect(() =>
      resolveHighlightResult({ where: 'local', ok: false, error: 'HighlightCanceled: canceled' })
    ).toThrowError(expect.objectContaining({ name: 'HighlightCanceled' }));
  });

  it('本地失败：普通 Error（渲染端走 hljs 兜底而非错误卡）', () => {
    expect(() => resolveHighlightResult({ where: 'local', ok: false, error: 'boom' })).toThrowError(
      expect.objectContaining({ name: 'Error', message: 'boom' })
    );
  });
});
