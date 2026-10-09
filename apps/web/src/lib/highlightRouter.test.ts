import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// highlightRouter.test.ts — 大文件路由的 policy × path × 服务端可服务性契约矩阵
//（spec §4 阶段 3 + BUG-06c 同源 auto 门）。highlightRouter 依赖 highlightClient
//（$app/env，vitest 不可用）、loadSettings（localStorage）与 openFlow.svelte（svelte
// runes，vitest 无插件不可编译），三者均以 vi.mock 隔离：本测试只验证「策略 → 是否
// 发起远程请求 → 失败分流（remote 抛错错误卡片 / auto warn+null 回退本地分块）」
// 的裁决，decodeHighlightResponse 为 core 纯函数真跑。

const loadSettingsMock = vi.hoisted(() => vi.fn());
const remoteCallMock = vi.hoisted(() => vi.fn());
const loadCapabilitiesMock = vi.hoisted(() => vi.fn());
const loadComputeLanguagesMock = vi.hoisted(() => vi.fn());

vi.mock('./stores/settings', () => ({
  loadSettings: loadSettingsMock
}));

vi.mock('./highlightClient', () => ({
  computeRouter: { remoteCall: remoteCallMock }
}));

vi.mock('./openFlow.svelte', () => ({
  loadCapabilities: loadCapabilitiesMock,
  loadComputeLanguages: loadComputeLanguagesMock
}));

import { routeLargeFileHighlight } from './highlightRouter';

const SRC = { path: 'big.js', storeId: 'remote:abc' } as const;
const LOCAL_SRC = { path: '', storeId: 'localfs:x' } as const;
const ENCODED = { intervals: [[0, 3, 0]], captures: ['keyword'] };
const DECODED = [{ start: 0, end: 3, capture: 'keyword' }];

describe('routeLargeFileHighlight（阶段 3 契约矩阵）', () => {
  beforeEach(() => {
    remoteCallMock.mockReset();
    loadSettingsMock.mockReset();
    // auto 门默认放行（capabilities 含 compute + 语言已宣告）：auto 正路径用例
    // 依赖此默认；门控专项用例各自覆写
    loadCapabilitiesMock.mockReset().mockReturnValue(['compute']);
    loadComputeLanguagesMock.mockReset().mockReturnValue(['javascript']);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('local + 有 path：恒 null，零 fetch', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'local' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    expect(remoteCallMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remote + 有 path：fetch POST /api/compute/highlight（Bearer 头），200 解码为 intervals', async () => {
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
    expect(intervals).toEqual(DECODED);
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

  it('remote + 未连接服务器（remoteCall null）：抛错（渲染端错误卡片，不静默本地）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue(null);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).rejects.toThrow('未连接服务器');
  });

  it('remote + fetch 500：抛错（错误卡片语义，不回退本地）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    await expect(routeLargeFileHighlight(SRC, 'javascript')).rejects.toThrow('HTTP 500');
  });

  it('auto + 有 path（compute 能力 + 语言已宣告）：fetch POST，200 → intervals（server-served 不限大小走服务端）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(ENCODED), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toEqual(DECODED);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('auto + 有 path + 无 compute 能力（file-only 服务器）：恒 null，零 fetch（auto 门）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    loadCapabilitiesMock.mockReturnValue([]); // capabilities 无 compute
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    expect(remoteCallMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto + 有 path + compute 但语言未在服务端宣告集合：恒 null，零 fetch（宣告门）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    loadComputeLanguagesMock.mockReturnValue(['python', 'rust']); // javascript 未宣告
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    expect(remoteCallMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto + 有 path + compute + 宣告集合为空（旧服务端未知）：保持先试远程（空集语义）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    loadComputeLanguagesMock.mockReturnValue([]);
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(ENCODED), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toEqual(DECODED);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('auto + 有 path + 未连接服务器（remoteCall null）：console.warn + null（回退本地，不抛错）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    remoteCallMock.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('回退本地');
    warnSpy.mockRestore();
  });

  it('auto + fetch 500：console.warn 一次 + null（回退本地 hljs 分块，不抛错）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('回退本地');
    warnSpy.mockRestore();
  });

  it('auto + fetch 网络异常：console.warn + null（与 !res.ok 同进 catch 分流）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('auto + 无 path（本地添加文件）：恒 null，零 fetch（回归护栏）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(LOCAL_SRC, 'javascript')).resolves.toBeNull();
    expect(remoteCallMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remote + 无 path：恒 null，零 fetch（现状保持）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(LOCAL_SRC, 'javascript')).resolves.toBeNull();
    expect(remoteCallMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
