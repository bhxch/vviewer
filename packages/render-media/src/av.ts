// av.ts — 音视频渲染器（M4 Task 6 ArtPlayer 升级）。
// 视频（mp4/m4v/webm/ogg + 流媒体 m3u8/flv）改 ArtPlayer（动态 import，不进主包）；
// 音频保持原生 <audio controls>（spec 决策不变）。流协议按扩展名分派：
// .m3u8 → 动态 import hls.js 的 loader；.flv/.ts → 动态 import mpegts.js 的 loader
// （hls.js/mpegts.js 为可选依赖，仅扩展名匹配时才加载）。blob URL 生命周期与 M1 一致：
// render 时 create，destroy 时 revoke；destroy 另调 art.destroy(removeHtml=true) 并释放
// 流播放器（hls/mpegts 实例）。类型分派/协议映射/配置构造为纯函数导出（单测直测；
// jsdom 无法真渲染 ArtPlayer，真实播放 E2E 留 T7）。
import type { Option } from 'artplayer';
import type Artplayer from 'artplayer';
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';

/** 扩展名 → blob MIME（流媒体清单/原始流同样标注，供 blob 元数据可读） */
const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
  m3u8: 'application/vnd.apple.mpegurl', flv: 'video/x-flv', ts: 'video/mp2t',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  oga: 'audio/ogg', opus: 'audio/ogg'
};

/** 视频形态扩展名（含流媒体；其余注册扩展名走原生音频） */
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'ogg', 'm3u8', 'flv']);

/** 类型分派纯函数：ext → 'video'（ArtPlayer）| 'audio'（原生 <audio>） */
export function playerKindOf(ext: string): 'video' | 'audio' {
  return VIDEO_EXTS.has(ext) ? 'video' : 'audio';
}

/** 流协议映射纯函数：ext → 应动态 import 的流播放器；null = 浏览器原生直接播 */
export function streamProtocolOf(ext: string): 'hls' | 'mpegts' | null {
  if (ext === 'm3u8') return 'hls';
  if (ext === 'flv' || ext === 'ts') return 'mpegts';
  return null;
}

/** MIME 映射纯函数（未知扩展名空串，blob 无类型） */
export function mediaMimeOf(ext: string): string {
  return MIME[ext] ?? '';
}

/** ArtPlayer 配置契约项（除 customType 外全部在此构造，单测逐项断言） */
export function buildArtConfig(container: HTMLElement, url: string, type: string, theme: string): Option {
  return {
    container: container as HTMLDivElement,
    url,
    type,
    autoplay: false,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    fullscreen: true,
    miniProgressBar: true,
    theme
  };
}

/** 流播放器释放回调（destroy 时统一执行，晚于 art.destroy） */
type Cleanup = () => void;
/** 与 ArtPlayer customType loader 签名对齐（省略第三参 art，未使用） */
type ArtLoader = (this: Artplayer, video: HTMLVideoElement, url: string) => unknown | Promise<unknown>;

/** hls.js loader：仅在 .m3u8 时动态 import（可选依赖不进主包） */
async function makeHlsLoader(cleanups: Cleanup[]): Promise<ArtLoader> {
  return async (_video, url) => {
    const Hls = (await import('hls.js')).default;
    if (!Hls.isSupported()) throw new Error('当前浏览器不支持 MSE，无法播放 HLS 流');
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(_video);
    cleanups.push(() => hls.destroy());
  };
}

/** mpegts.js loader：.flv → 'flv'、.ts → 'mpegts' 容器类型（仅匹配时动态 import） */
async function makeMpegtsLoader(ext: string, cleanups: Cleanup[]): Promise<ArtLoader> {
  return async (_video, url) => {
    const mpegts = (await import('mpegts.js')).default;
    const player = mpegts.createPlayer({ type: ext === 'flv' ? 'flv' : 'mpegts', url, isLive: false });
    player.attachMediaElement(_video);
    player.load();
    cleanups.push(() => player.destroy());
  };
}

/** 读主题强调色（app.css 的 --ui-accent，随明暗主题切换）；读不到回落 M1 蓝值 */
function readAccent(target: HTMLElement): string {
  return getComputedStyle(target).getPropertyValue('--ui-accent').trim() || '#0969da';
}

export const avRenderer: Renderer = {
  id: 'av',
  label: '音视频',
  extensions: ['mp4', 'm4v', 'webm', 'ogg', 'm3u8', 'flv', 'mp3', 'wav', 'flac', 'm4a', 'oga', 'opus'],
  // 注意：不注册 'ts'——codeRenderer（TypeScript）先占该扩展名，registry 重复注册会抛错；
  // mpegts 的 .ts 分派仅在 customType 层保留（archive 包内 ts 条目未来改路由时可用）
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, det: Detection): Promise<RenderedInstance> {
    // buffer 实际由普通 ArrayBuffer 支持；断言绕开 TS 5.9 BlobPart 的 ArrayBuffer 泛型收窄，避免大文件复制
    const url = URL.createObjectURL(new Blob([buffer as Uint8Array<ArrayBuffer>], { type: mediaMimeOf(det.ext) }));

    if (playerKindOf(det.ext) === 'audio') {
      const el = document.createElement('audio');
      el.setAttribute('controls', '');
      el.src = url;
      el.className = 'vv-av';
      target.replaceChildren(el);
      return {
        destroy() {
          el.pause();
          URL.revokeObjectURL(url);
          el.remove();
        }
      };
    }

    const Artplayer = (await import('artplayer')).default;
    const cleanups: Cleanup[] = [];
    const customType: NonNullable<Option['customType']> = {};
    if (streamProtocolOf(det.ext) === 'hls') {
      customType.m3u8 = await makeHlsLoader(cleanups);
    } else if (det.ext === 'flv' || det.ext === 'ts') {
      const loader = await makeMpegtsLoader(det.ext, cleanups);
      customType.flv = loader;
      customType.ts = loader;
    }
    const container = document.createElement('div');
    container.className = 'vv-av vv-artplayer';
    target.replaceChildren(container);
    const art = new Artplayer({ ...buildArtConfig(container, url, det.ext, readAccent(target)), customType });
    return {
      destroy() {
        for (const cleanup of cleanups) cleanup();
        art.destroy(true);
        URL.revokeObjectURL(url);
      }
    };
  }
};
