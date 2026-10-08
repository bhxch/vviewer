import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// highlightRouter.test.ts — BUG-10：>2MB 文件远程高亮路由的 policy 硬护栏。
// highlightRouter 依赖 highlightClient（$app/environment，vitest 不可用）与
// loadSettings（localStorage），两者均以 vi.mock 隔离：本测试只验证「策略 → 是否
// 发起远程请求」的裁决，decodeHighlightResponse 为 core 纯函数真跑。

const loadSettingsMock = vi.hoisted(() => vi.fn());
const remoteCallMock = vi.hoisted(() => vi.fn());

vi.mock('./stores/settings', () => ({
  loadSettings: loadSettingsMock
}));

vi.mock('./highlightClient', () => ({
  computeRouter: { remoteCall: remoteCallMock }
}));

import { routeLargeFileHighlight } from './highlightRouter';

const SRC = { path: 'big.js', storeId: 'remote:abc' } as const;
const ENCODED = { intervals: [[0, 3, 0]], captures: ['keyword'] };

describe('routeLargeFileHighlight（BUG-10 硬护栏）', () => {
  beforeEach(() => {
    remoteCallMock.mockReset();
    loadSettingsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto / local 策略：恒返回 null，不触碰远程端点（3MB auto 无 POST 的回归护栏）', async () => {
    for (const policy of ['auto', 'local'] as const) {
      loadSettingsMock.mockReturnValue({ computePolicy: policy });
      await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    }
    expect(remoteCallMock).not.toHaveBeenCalled();
  });

  it('remote 策略：POST /api/compute/highlight（Bearer 头），响应解码为 intervals', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({
      url: 'http://s:8321/api/compute/highlight',
      headers: { authorization: 'Bearer t' }
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(ENCODED), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const intervals = await routeLargeFileHighlight(SRC, 'javascript');
    expect(intervals).toEqual([{ start: 0, end: 3, capture: 'keyword' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://s:8321/api/compute/highlight',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer t' })
      })
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body
    ) as { path: string; lang: string };
    expect(body).toEqual({ path: 'big.js', lang: 'javascript' });
  });

  it('remote 策略 + 未连接服务器（remoteCall null）：抛错（渲染端错误卡片，不静默本地）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue(null);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).rejects.toThrow('未连接服务器');
  });

  it('remote 策略 + 非 2xx：抛错（不回退本地）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    await expect(routeLargeFileHighlight(SRC, 'javascript')).rejects.toThrow('HTTP 500');
  });

  it('无服务端 path（本地文件）：remote 策略也返回 null', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    await expect(routeLargeFileHighlight({ path: '', storeId: 'localfs:x' }, 'javascript')).resolves.toBeNull();
    expect(remoteCallMock).not.toHaveBeenCalled();
  });
});
