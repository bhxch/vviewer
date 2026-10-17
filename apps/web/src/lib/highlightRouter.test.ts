import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// highlightRouter.test.ts — 大文件路由的 policy × path × 服务端可服务性契约矩阵
//（spec §4 阶段 3 + BUG-06c 同源 auto 门；阶段 4 升级 range 契约）。highlightRouter
// 依赖 highlightClient（$app/env，vitest 不可用）、loadSettings（localStorage）与
// openFlow.svelte（svelte runes，vitest 无插件不可编译），三者均以 vi.mock 隔离：
// 本测试只验证「策略 → 是否发起远程请求 → body 形状（range 随参透传）→ 响应解码
//（{intervals, baseLine}，旧服务端缺 baseLine 兜 0）→ 失败分流（remote 抛错错误
// 卡片 / auto warn+null 回退本地分块）」的裁决，decodeHighlightResponse 为 core
// 纯函数真跑。

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

describe('routeLargeFileHighlight（阶段 3+4 契约矩阵）', () => {
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

  it('remote + 有 path：fetch POST /api/compute/highlight（Bearer 头），200 解码为 { intervals, baseLine }（缺 baseLine 兜 0，兼容旧服务端）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({
      url: 'http://s:8321/api/compute/highlight',
      headers: { authorization: 'Bearer t' }
    });
    // ENCODED 无 baseLine 字段 = 旧服务端（--compute 301 部署新二进制前）响应形状
    // mock 按 fetch 签名类型化：mock.calls 元组带 init，避免无参 vi.fn 的 [] 元组索引
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify(ENCODED), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await routeLargeFileHighlight(SRC, 'javascript');
    expect(result).toEqual({ intervals: DECODED, baseLine: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://s:8321/api/compute/highlight',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer t' })
      })
    );
    // 严格 toEqual：不传 range 时 body 不含 range 字段（旧请求语义，服务端按
    // 全文件 text 模式应答 baseLine=0）
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]![1]?.body)
    ) as { path: string; lang: string };
    expect(body).toEqual({ path: 'big.js', lang: 'javascript' });
  });

  it('remote + range：body 带 range {startLine, lineCount}，响应 baseLine 透传（区间相对 chunk，渲染侧平移）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({ ...ENCODED, baseLine: 5 }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await routeLargeFileHighlight(SRC, 'javascript', {
      startLine: 5,
      lineCount: 3
    });
    expect(result).toEqual({ intervals: DECODED, baseLine: 5 });
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]![1]?.body)
    ) as { path: string; lang: string; range: { startLine: number; lineCount: number } };
    expect(body).toEqual({
      path: 'big.js',
      lang: 'javascript',
      range: { startLine: 5, lineCount: 3 }
    });
  });

  it('CMP-02/2 会话缓存：首响应带 cacheId → 重开同 (path,lang,range) 请求携带令牌，服务端 cached:true 极小帧复用会话 intervals', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const range = { startLine: 0, lineCount: 200 };
    const full = { ...ENCODED, baseLine: 0, cacheId: 'tok-1' };
    const hit = { cached: true, cacheId: 'tok-1', baseLine: 0 };
    const responses = [
      new Response(JSON.stringify(full), { status: 200 }),
      new Response(JSON.stringify(hit), { status: 200 })
    ];
    let call = 0;
    const fetchMock = vi.fn(async () => responses[call++]!);
    vi.stubGlobal('fetch', fetchMock);
    // 首次：完整 intervals + 令牌入库（body 不带 cacheId——会话尚无条目）
    await expect(routeLargeFileHighlight(SRC, 'javascript', range)).resolves.toEqual({
      intervals: DECODED,
      baseLine: 0
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      path: 'big.js',
      lang: 'javascript',
      range
    });
    // 重开：请求携带令牌；极小帧无 intervals，返回会话缓存的同一 intervals
    await expect(routeLargeFileHighlight(SRC, 'javascript', range)).resolves.toEqual({
      intervals: DECODED,
      baseLine: 0
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      path: 'big.js',
      lang: 'javascript',
      range,
      cacheId: 'tok-1'
    });
  });

  it('CMP-02/2 会话缓存按 (path,lang,range) 键隔离：异 range 不携带令牌、不误命中', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const full = { ...ENCODED, baseLine: 0, cacheId: 'tok-2' };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify(full), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await routeLargeFileHighlight(SRC, 'javascript', { startLine: 0, lineCount: 200 });
    // 换一个 range：键不同，body 不携带上一次的令牌
    await routeLargeFileHighlight(SRC, 'javascript', { startLine: 200, lineCount: 200 });
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { cacheId?: string };
    expect(second.cacheId).toBeUndefined();
  });

  it('CMP-02/2 令牌过期（服务端回完整响应带新 cacheId）：客户端如实刷新会话条目', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'remote' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const STALE_SRC = { path: 'stale.js', storeId: 'remote:abc' } as const; // 独立键，不与前测会话串扰
    const bodies = [
      { ...ENCODED, baseLine: 0, cacheId: 'tok-a' },
      { ...ENCODED, intervals: [[0, 5, 0]], baseLine: 0, cacheId: 'tok-b' }, // 文件已变更
      { ...ENCODED, intervals: [[0, 5, 0]], baseLine: 0, cacheId: 'tok-b' } // 第三次仅观测请求体
    ];
    let call = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify(bodies[call++]!), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const range = { startLine: 0, lineCount: 200 };
    await routeLargeFileHighlight(STALE_SRC, 'javascript', range);
    // 服务端令牌不匹配仍回完整响应：解码生效（非 cached 帧）+ 新令牌入库
    await expect(routeLargeFileHighlight(STALE_SRC, 'javascript', range)).resolves.toEqual({
      intervals: [{ start: 0, end: 5, capture: 'keyword' }],
      baseLine: 0
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({
      cacheId: 'tok-a'
    });
    // 第三次请求携带刷新后的令牌
    await routeLargeFileHighlight(STALE_SRC, 'javascript', range);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toMatchObject({
      cacheId: 'tok-b'
    });
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

  it('auto + 有 path（compute 能力 + 语言已宣告）：fetch POST，200 → { intervals, baseLine }（server-served 不限大小走服务端）', async () => {
    loadSettingsMock.mockReturnValue({ computePolicy: 'auto' });
    remoteCallMock.mockReturnValue({ url: 'http://s:8321/api/compute/highlight', headers: {} });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(ENCODED), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toEqual({
      intervals: DECODED,
      baseLine: 0
    });
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
    await expect(routeLargeFileHighlight(SRC, 'javascript')).resolves.toEqual({
      intervals: DECODED,
      baseLine: 0
    });
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
