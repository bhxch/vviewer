// av.test.ts — avRenderer 单测：jsdom 无法真渲染 ArtPlayer（真实播放 E2E 留 T7），
// 这里直测类型分派/流协议映射/配置构造/MIME 映射/HLS 直连解析/fatal 决策纯函数
// + 音频原生 <audio> 路径（blob 生命周期不变 + getMeta 代工）+ 本地 m3u8 明确报错。
// 末例以 vi.mock 令 ArtPlayer 构造抛错，验证 T7 修复：构造失败路径 revoke blob URL 后 rethrow。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRemoteStore } from '@vviewer/core';
import type { RenderedInstance } from '@vviewer/core';
import {
  avRenderer,
  buildArtConfig,
  buildHlsConfig,
  hlsFatalDecision,
  mediaMimeOf,
  playerKindOf,
  resolveHlsDirect,
  streamProtocolOf,
  videoErrorMessage
} from '../src/av';
import type { FileSource } from '@vviewer/core';

vi.mock('artplayer', () => ({
  default: class {
    constructor() {
      throw new Error('artplayer 构造失败（测试注入）');
    }
  }
}));

describe('playerKindOf：扩展名 → 播放器形态', () => {
  it('视频类（含流媒体 m3u8/flv 与签名改派的 ts）→ video，音频类 → audio', () => {
    for (const ext of ['mp4', 'm4v', 'mov', 'webm', 'ogg', 'm3u8', 'flv', 'ts']) {
      expect(playerKindOf(ext)).toBe('video');
    }
    for (const ext of ['mp3', 'wav', 'flac', 'm4a', 'aac', 'oga', 'opus']) {
      expect(playerKindOf(ext)).toBe('audio');
    }
  });
});

describe('streamProtocolOf：流协议 → 动态 import 的 loader 选择', () => {
  it('m3u8 → hls（hls.js），flv/ts → mpegts（mpegts.js），其余 null（原生播放）', () => {
    expect(streamProtocolOf('m3u8')).toBe('hls');
    expect(streamProtocolOf('flv')).toBe('mpegts');
    expect(streamProtocolOf('ts')).toBe('mpegts');
    for (const ext of ['mp4', 'webm', 'mp3', 'wav']) {
      expect(streamProtocolOf(ext)).toBeNull();
    }
  });
});

describe('buildArtConfig：ArtPlayer 配置构造（契约项逐项断言）', () => {
  it('container/url/type 直传；autoplay 关、setting/playbackRate/aspectRatio/fullscreen/miniProgressBar 开', () => {
    const container = document.createElement('div');
    const cfg = buildArtConfig(container, 'blob:fake-url', 'mp4', '#0969da');
    expect(cfg.container).toBe(container);
    expect(cfg.url).toBe('blob:fake-url');
    expect(cfg.type).toBe('mp4');
    expect(cfg.autoplay).toBe(false);
    expect(cfg.setting).toBe(true);
    expect(cfg.playbackRate).toBe(true);
    expect(cfg.aspectRatio).toBe(true);
    expect(cfg.fullscreen).toBe(true);
    expect(cfg.miniProgressBar).toBe(true);
    expect(cfg.theme).toBe('#0969da');
  });
});

describe('resolveHlsDirect / buildHlsConfig：HLS 直连（BUG-01）', () => {
  afterEach(() => {
    sessionStorage.removeItem('vviewer-last-server');
  });

  it('remote store → /api/file 直连 URL（分片按真实 URL 解析，非 blob:）', () => {
    const store = createRemoteStore('http://127.0.0.1:8321', 'tkn', 'data');
    try {
      const source: FileSource = {
        storeId: store.id, storeLabel: 'data', path: 'media/video.m3u8', name: 'video.m3u8', store
      };
      const direct = resolveHlsDirect(source);
      expect(direct).not.toBeNull();
      expect(direct!.url).toBe('http://127.0.0.1:8321/api/file?path=media%2Fvideo.m3u8');
      expect(direct!.url.startsWith('blob:')).toBe(false);
    } finally {
      store.close(); // 清理模块级 remoteBaseById 登记
    }
  });

  it('token 从会话存储读取；缺失/无记录 → null（xhrSetup 不附加）', () => {
    sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: 'http://x:1', token: 'sess-tkn' }));
    const localSource: FileSource = {
      storeId: 'remote:whatever', storeLabel: 'l', path: 'a.m3u8', name: 'a.m3u8',
      store: { id: 'remote:whatever', displayName: () => 'l', listChildren: async () => [], read: async () => new Uint8Array() }
    };
    expect(resolveHlsDirect(localSource)).toBeNull(); // 无 base 登记 → 本地档

    const store = createRemoteStore('http://127.0.0.1:8322', null, 'data');
    try {
      const direct = resolveHlsDirect({
        storeId: store.id, storeLabel: 'data', path: 'a.m3u8', name: 'a.m3u8', store
      });
      expect(direct!.token).toBe('sess-tkn');
    } finally {
      store.close();
    }

    sessionStorage.removeItem('vviewer-last-server');
    const store2 = createRemoteStore('http://127.0.0.1:8323', null, 'data');
    try {
      const direct = resolveHlsDirect({
        storeId: store2.id, storeLabel: 'data', path: 'a.m3u8', name: 'a.m3u8', store: store2
      });
      expect(direct!.token).toBeNull();
    } finally {
      store2.close();
    }
  });

  it('非 remote store（localfiles/zip 内嵌）→ null（本地档明确报错的判定源）', () => {
    for (const storeId of ['localfiles:samples', 'zip:inner.zip', 'single:f.mp4', 'localfs:x']) {
      expect(resolveHlsDirect({
        storeId, storeLabel: 'l', path: 'a.m3u8', name: 'a.m3u8',
        store: { id: storeId, displayName: () => 'l', listChildren: async () => [], read: async () => new Uint8Array() }
      })).toBeNull();
    }
  });

  it('buildHlsConfig：xhrSetup 附加 Bearer；token 为空不附加', () => {
    const calls: Array<[string, string]> = [];
    const xhr = { setRequestHeader: (k: string, v: string) => calls.push([k, v]) } as unknown as XMLHttpRequest;
    buildHlsConfig('t0k3n').xhrSetup(xhr, 'http://x/api/file');
    expect(calls).toEqual([['Authorization', 'Bearer t0k3n']]);
    calls.length = 0;
    buildHlsConfig(null).xhrSetup(xhr, 'http://x/api/file');
    expect(calls).toEqual([]);
  });
});

describe('hlsFatalDecision：fatal 错误决策（重试上限，杜绝无限重试）', () => {
  it('网络 fatal 首次重试、媒体 fatal 首次 recover、第二次 fatal 或其他类型转错误卡片', () => {
    expect(hlsFatalDecision(1, 'networkError')).toBe('retry');
    expect(hlsFatalDecision(1, 'mediaError')).toBe('recover');
    expect(hlsFatalDecision(2, 'networkError')).toBe('card');
    expect(hlsFatalDecision(2, 'mediaError')).toBe('card');
    expect(hlsFatalDecision(1, 'otherError')).toBe('card');
  });
});

describe('videoErrorMessage：HTMLMediaElement error code → 可读文案', () => {
  it('截断 mp4 的 code=4 → 源不可达/格式不支持；未知 code 有兜底文案', () => {
    expect(videoErrorMessage(4)).toContain('MEDIA_ERR_SRC_NOT_SUPPORTED');
    expect(videoErrorMessage(3)).toContain('MEDIA_ERR_DECODE');
    expect(videoErrorMessage(undefined)).toContain('未知');
  });
});

describe('avRenderer', () => {
  /** 最小 FileSource 桩（av 渲染只读 det.ext 与 m3u8 直连解析，其余仅透传） */
  function fakeSource(name: string, storeId = 'localfiles:samples'): FileSource {
    return {
      storeId,
      storeLabel: 'samples',
      path: name,
      name,
      store: { id: 'x', displayName: () => 'x', listChildren: async () => [], read: async () => new Uint8Array() }
    };
  }

  it('extensions：新增 m3u8/flv 与 mov/aac，仍含既有音视频；不注册 ts（签名改派由 dispatcher 完成）', () => {
    for (const ext of ['mp4', 'm4v', 'mov', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'oga', 'opus']) {
      expect(avRenderer.extensions).toContain(ext);
    }
    expect(avRenderer.extensions).toContain('m3u8');
    expect(avRenderer.extensions).toContain('flv');
    expect(avRenderer.extensions).not.toContain('ts');
  });

  it('音频保持原生 <audio controls>，destroy 撤销 blob URL（ArtPlayer 仅视频）；实例带 getMeta（BUG-04 代工）', async () => {
    // jsdom 不实现 createObjectURL/revokeObjectURL，测试桩之
    const create = vi.fn(() => 'blob:mock');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await avRenderer.render(new Uint8Array(8), target, fakeSource('click.mp3'), { ext: 'mp3' } as never);
    const el = target.querySelector('audio');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('controls')).toBe('');
    expect(el?.src).toBe('blob:mock');
    expect(target.querySelector('.art-video-player')).toBeNull(); // 不走 ArtPlayer
    expect((instance as RenderedInstance & { getMeta(): { size: number } }).getMeta().size).toBe(8);
    instance.destroy();
    expect(revoke).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('本地 store 的 m3u8 明确报错（不再静默挂起；错误卡片由 dispatcher catch 呈现）', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    await expect(
      avRenderer.render(new Uint8Array(16), target, fakeSource('local.m3u8'), { ext: 'm3u8' } as never)
    ).rejects.toThrow('HLS');
    expect(target.querySelector('.vv-av')).toBeNull(); // 未挂载播放器
    target.remove();
  });

  it('blob MIME 按扩展名标注（视频/音频/流媒体清单）', () => {
    expect(mediaMimeOf('mp4')).toBe('video/mp4');
    expect(mediaMimeOf('mov')).toBe('video/quicktime');
    expect(mediaMimeOf('webm')).toBe('video/webm');
    expect(mediaMimeOf('aac')).toBe('audio/aac');
    expect(mediaMimeOf('mp3')).toBe('audio/mpeg');
    expect(mediaMimeOf('m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(mediaMimeOf('flv')).toBe('video/x-flv');
    expect(mediaMimeOf('ts')).toBe('video/mp2t');
    expect(mediaMimeOf('nope')).toBe('');
  });

  it('T7 回归：ArtPlayer 构造失败时 blob URL 不泄漏（revoke 后 rethrow，destroy 永不执行的路径）', async () => {
    const create = vi.fn(() => 'blob:mock-fail');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const target = document.createElement('div');
    document.body.append(target);
    // 文件头 vi.mock 注入构造抛错 → render 必然 reject
    await expect(
      avRenderer.render(new Uint8Array(8), target, fakeSource('clip.mp4'), { ext: 'mp4' } as never)
    ).rejects.toThrow('artplayer 构造失败');
    // 失败前已 create 的 URL 必须被 revoke（次数成对，destroy 之外的失败路径不漏）
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    target.remove();
  });
});
