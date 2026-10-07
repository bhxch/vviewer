// av.test.ts — avRenderer ArtPlayer 升级单测：jsdom 无法真渲染 ArtPlayer（真实播放 E2E 留 T7），
// 这里直测类型分派/流协议映射/配置构造/MIME 映射纯函数 + 音频原生 <audio> 路径（blob 生命周期不变）。
import { describe, expect, it, vi } from 'vitest';
import { avRenderer, buildArtConfig, mediaMimeOf, playerKindOf, streamProtocolOf } from '../src/av';

describe('playerKindOf：扩展名 → 播放器形态', () => {
  it('视频类（含流媒体 m3u8/flv）→ video，音频类 → audio', () => {
    for (const ext of ['mp4', 'm4v', 'webm', 'ogg', 'm3u8', 'flv']) {
      expect(playerKindOf(ext)).toBe('video');
    }
    for (const ext of ['mp3', 'wav', 'flac', 'm4a', 'oga', 'opus']) {
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

describe('avRenderer', () => {
  /** 最小 FileSource 桩（av 渲染只读 det.ext，source 仅透传） */
  function fakeSource(name: string): Parameters<typeof avRenderer.render>[2] {
    return {
      storeId: 'localfiles:samples',
      storeLabel: 'samples',
      path: name,
      name,
      store: { id: 'x', displayName: () => 'x', listChildren: async () => [], read: async () => new Uint8Array() }
    };
  }

  it('extensions：新增 m3u8/flv，仍含既有音视频；不注册 ts（codeRenderer 先占，重复注册会被 registry 拒绝）', () => {
    for (const ext of ['mp4', 'm4v', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'm4a', 'oga', 'opus']) {
      expect(avRenderer.extensions).toContain(ext);
    }
    expect(avRenderer.extensions).toContain('m3u8');
    expect(avRenderer.extensions).toContain('flv');
    expect(avRenderer.extensions).not.toContain('ts');
  });

  it('音频保持原生 <audio controls>，destroy 撤销 blob URL（ArtPlayer 仅视频）', async () => {
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
    instance.destroy();
    expect(revoke).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('blob MIME 按扩展名标注（视频/音频/流媒体清单）', () => {
    expect(mediaMimeOf('mp4')).toBe('video/mp4');
    expect(mediaMimeOf('webm')).toBe('video/webm');
    expect(mediaMimeOf('mp3')).toBe('audio/mpeg');
    expect(mediaMimeOf('m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(mediaMimeOf('flv')).toBe('video/x-flv');
    expect(mediaMimeOf('ts')).toBe('video/mp2t');
    expect(mediaMimeOf('nope')).toBe('');
  });
});
