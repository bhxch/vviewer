// av.ts — 音视频渲染器（M4 Task 6 ArtPlayer 升级 + e2e 修复批次）。
// 视频（mp4/m4v/webm/ogg/ts + 流媒体 m3u8/flv）改 ArtPlayer（动态 import，不进主包）；
// 音频保持原生 <audio controls>（spec 决策不变）。流协议按扩展名分派：
// .m3u8 → 动态 import hls.js（仅 remote store 直连 + pLoader 清单改写，本地 store 明确报错）；
// .flv/.ts → 动态 import mpegts.js 的 loader（hls.js/mpegts.js 为可选依赖，仅扩展名匹配时才加载）。
// HLS 直连（BUG-01）：清单走 /api/file?path= 直连 URL，pLoader 在响应期把清单文本中的
// 相对分片/URI 属性改写为 /api/file 绝对地址（rewriteHlsManifest；相对分片不能依赖
// base 合并——url-toolkit 的 query 不继承，不改写会 404），分片请求直达服务端且经
// xhrSetup 附加 Bearer。blob URL 生命周期与 M1 一致：render 时 create，destroy 时
// revoke；视频路径的 createObjectURL 推迟到 ArtPlayer 构造前一刻——动态 import/构造
// 失败时不创建，构造抛错则 revoke 后 rethrow，绝不泄漏；HLS 直连不建 blob，无 revoke 面。
// destroy 另调 art.destroy(removeHtml=true) 并释放流播放器（hls/mpegts 实例）。
// 流 loader（hls.js/mpegts.js 动态 import + 播放器装配）整体 try/catch：装配失败转
// ArtPlayer notice 提示并吞掉异常；运行期 fatal 错误（Hls.Events.ERROR / mpegts ERROR /
// video error）升级为统一错误卡片（BUG-01 消除静默无限重试、BUG-14 替换黑屏+瞬时
// Reconnect 计数），卡片带「重试」（重跑本渲染器 render）与「降级查看」（hex 兜底）按钮，
// 重试/降级成功产出的新实例由本渲染闭包级联托管（本实例 destroy 时级联释放，不泄漏）。
// 类型分派/协议映射/配置构造/HLS 直连解析/清单改写/fatal 决策为纯函数导出（单测直测；
// jsdom 无法真渲染 ArtPlayer，真实播放 E2E 留 T7）。
import { getHexFallbackRenderer, getRemoteBase, showErrorCard } from '@vviewer/core';
import type { ErrorCardAction } from '@vviewer/core';
import type { Option } from 'artplayer';
import type Artplayer from 'artplayer';
import type { Detection, Encoding, FileSource, RenderedInstance, Renderer } from '@vviewer/core';

/** 扩展名 → blob MIME（流媒体清单/原始流同样标注，供 blob 元数据可读） */
// mov（QuickTime 容器，H.264 轨道主流浏览器可播）与 aac（ADTS 裸流）为浏览器
// 可播子集的补充（终审 M3）；不保证所有编码可解码——不可解时 video/audio 元素
// 报 error，与 mp4 同语义。
const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogg: 'video/ogg',
  m3u8: 'application/vnd.apple.mpegurl', flv: 'video/x-flv', ts: 'video/mp2t',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  oga: 'audio/ogg', opus: 'audio/ogg'
};

/** 视频形态扩展名（含流媒体；'ts' 由 dispatcher 签名改派进入，BUG-01） */
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogg', 'm3u8', 'flv', 'ts']);

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
/** 流运行期 fatal 错误升级回调：实现方转统一错误卡片（BUG-01/14） */
type StreamFatalHandler = (message: string) => void;

/** loader 失败 → ArtPlayer 顶部 notice 提示（用户可见，不黑屏）；notice 不可用时静默 */
function notifyLoaderFailure(art: Artplayer, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    art.notice.show = `流播放器加载失败：${message}`;
  } catch {
    // 容器已卸载等极端场景下 notice 不存在，放弃提示即可
  }
}

// ---------- HLS 直连（BUG-01：m3u8 不再包 blob，分片按真实 URL 解析） ----------

/** 会话内上次连接的鉴权存储键（与 apps/web openFlow.svelte.ts 的 LAST_SERVER_KEY 同源：
 * hls.js 的分片 XHR 无法走 store.request 统一注入头，token 只能读会话存储；缺失则不带）。 */
const LAST_SERVER_KEY = 'vviewer-last-server';

function readSessionToken(): string | null {
  try {
    const raw = sessionStorage.getItem(LAST_SERVER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { token?: unknown };
    return typeof v.token === 'string' && v.token !== '' ? v.token : null;
  } catch {
    return null; // 隐私模式/损坏 JSON：按无 token 处理（服务器未配 token 时放行）
  }
}

/** HLS 直连源：服务端 base（含可能的反代前缀，归一化无尾斜杠）+ 直连 URL + 鉴权 token（可空） */
export interface HlsDirectSource {
  base: string;
  url: string;
  token: string | null;
}

/**
 * m3u8 直连源解析（BUG-01）：仅 remote store（有服务端 base）支持——清单经直连 URL
 * 交给 hls.js，清单/分片文本由 pLoader 改写为 /api/file 绝对地址（见 rewriteHlsManifest，
 * 相对分片不能依赖 base 合并：url-toolkit 合并时 query 不继承，/api/file?path= 的
 * base 会让 seg0.ts 落到不存在的 /api/seg0.ts）。本地 store（localfiles/zip 内嵌等）
 * 返回 null，由 render 抛明确错误（spec 允许的收窄档）。
 */
export function resolveHlsDirect(source: FileSource): HlsDirectSource | null {
  const base = getRemoteBase(source.storeId);
  if (!base) return null;
  return {
    base,
    url: `${base}/api/file?path=${encodeURIComponent(source.path)}`,
    token: readSessionToken()
  };
}

/** hls.js 清单 URL → 清单 store 内 path：直连/改写后的 URL 形如 `<base>/api/file?path=<enc>`；
 * 其他形态（blob: 等）返回 null（清单文本原样通过，不改写） */
export function manifestPathOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith('/api/file')) return null;
    return u.searchParams.get('path');
  } catch {
    return null;
  }
}

/** 相对 URI → `<base>/api/file?path=<相对清单目录解析后的 store 路径>`；
 * 带 scheme 的绝对 URI（http/https/data 等）原样返回；根相对（/ 开头）按 store 根解析 */
export function absolutizeHlsUri(baseUrl: string, manifestDir: string, uri: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
  const raw = uri.startsWith('/') ? uri.slice(1) : manifestDir ? `${manifestDir}/${uri}` : uri;
  return `${baseUrl}/api/file?path=${encodeURIComponent(raw)}`;
}

/**
 * 清单改写（BUG-01 核心，纯函数）：把分片行与 URI="..." 属性中的相对地址改写为
 * /api/file 绝对地址（相对各自清单 path 的目录解析）。hls.js 的 base 合并不继承
 * query，直连 ?path= URL 必须改写后分片才可达；多层清单（master→子清单）场景下
 * pLoader 对每份清单文本（含子清单）都执行本函数，子清单内部分片同样正确改写。
 */
export function rewriteHlsManifest(text: string, baseUrl: string, manifestPath: string): string {
  const dir = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : '';
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) return absolutizeHlsUri(baseUrl, dir, trimmed);
      if (!line.includes('URI="')) return line; // 普通标签（#EXTM3U/#EXTINF 等）原样
      return line.replace(/URI="([^"]*)"/g, (whole, uri: string) =>
        uri === '' ? whole : `URI="${absolutizeHlsUri(baseUrl, dir, uri)}"`);
    })
    .join('\n');
}

/**
 * hls.js 清单 loader（pLoader 位）：默认 loader 的薄包装，在响应回调里对清单文本执行
 * rewriteHlsManifest（清单自身 path 从 context.url 的 ?path= 提取）。分片走默认 loader
 * （清单内 URI 已被改写为绝对地址），token 鉴权仍由全局 xhrSetup 附加。
 */
function makeRewritingPlaylistLoader(Hls: typeof import('hls.js').default, baseUrl: string): unknown {
  interface InnerLoader {
    load(context: unknown, config: unknown, callbacks: unknown): void;
    abort(): void;
    destroy(): void;
  }
  interface LoaderCallbacksLike {
    onSuccess(response: { data: unknown }, stats: unknown, ctx: { url?: string }, networkDetails?: unknown): void;
    onError(...args: unknown[]): void;
    onTimeout(...args: unknown[]): void;
  }
  const DefaultLoader = Hls.DefaultConfig.loader;
  return class RewritingPlaylistLoader {
    private inner: InnerLoader;
    constructor(config: unknown) {
      this.inner = new DefaultLoader(config as never) as unknown as InnerLoader;
    }
    load(context: { url?: string }, config: unknown, callbacks: LoaderCallbacksLike): void {
      const wrapped: LoaderCallbacksLike = {
        onSuccess: (response: { data: unknown }, stats: unknown, ctx: { url?: string }, networkDetails?: unknown) => {
          const manifestPath = manifestPathOf(ctx?.url ?? '');
          if (typeof response?.data === 'string' && manifestPath !== null) {
            callbacks.onSuccess(
              { ...response, data: rewriteHlsManifest(response.data, baseUrl, manifestPath) },
              stats,
              ctx,
              networkDetails
            );
          } else {
            callbacks.onSuccess(response, stats, ctx, networkDetails);
          }
        },
        onError: (...args: unknown[]) => callbacks.onError(...args),
        onTimeout: (...args: unknown[]) => callbacks.onTimeout(...args)
      };
      this.inner.load(context, config, wrapped);
    }
    abort(): void {
      this.inner.abort();
    }
    destroy(): void {
      this.inner.destroy();
    }
  };
}

/** hls.js 配置：xhrSetup 为全部分片/清单 XHR 附加 Bearer（token 缺失不附加） */
export function buildHlsConfig(token: string | null): { xhrSetup: (xhr: XMLHttpRequest, url: string) => void } {
  return {
    xhrSetup: (xhr) => {
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
  };
}

export type HlsFatalStep = 'retry' | 'recover' | 'card';

/**
 * fatal 错误决策（BUG-01 重试上限）：网络类允许一次 startLoad 重试、媒体类允许一次
 * recoverMediaError，第二次 fatal 或其他类型直接转错误卡片——杜绝静默无限重试。
 */
export function hlsFatalDecision(fatalCount: number, errorType: string): HlsFatalStep {
  if (fatalCount > 1) return 'card';
  if (errorType === 'mediaError') return 'recover';
  if (errorType === 'networkError') return 'retry';
  return 'card';
}

/** HTMLMediaElement error code → 可读文案（截断 mp4 常见 code=4） */
export function videoErrorMessage(code: number | null | undefined): string {
  switch (code) {
    case 1: return '播放被中止（MEDIA_ERR_ABORTED）';
    case 2: return '网络错误（MEDIA_ERR_NETWORK）';
    case 3: return '解码失败：文件损坏或编码不支持（MEDIA_ERR_DECODE）';
    case 4: return '媒体源不可达或格式不支持（MEDIA_ERR_SRC_NOT_SUPPORTED）';
    default: return '未知错误';
  }
}

/** hls.js loader：仅在 .m3u8 时动态 import（可选依赖不进主包）；装配失败 notice 提示并吞异常，
 * 运行期 fatal 按 hlsFatalDecision 决策（重试上限），终态经 onFatal 升级错误卡片。
 * pLoader 为改写 loader：清单/子清单文本中的相对分片在响应期改写为 /api/file 绝对地址 */
async function makeHlsLoader(
  direct: HlsDirectSource,
  cleanups: Cleanup[],
  onFatal: StreamFatalHandler
): Promise<ArtLoader> {
  return async function (this: Artplayer, video, url) {
    try {
      const Hls = (await import('hls.js')).default;
      if (!Hls.isSupported()) throw new Error('当前浏览器不支持 MSE，无法播放 HLS 流');
      const hls = new Hls({
        ...buildHlsConfig(direct.token),
        // 结构上兼容 hls.js 的 PlaylistLoaderConstructor（load/abort/destroy + 构造器），
        //但其类型带泛型装载细节，断言注入（运行时协议由 makeRewritingPlaylistLoader 保证）
        pLoader: makeRewritingPlaylistLoader(Hls, direct.base) as never
      });
      let fatals = 0;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        fatals += 1;
        const step = hlsFatalDecision(fatals, String(data.type));
        if (step === 'retry') {
          hls.startLoad();
          return;
        }
        if (step === 'recover') {
          hls.recoverMediaError();
          return;
        }
        onFatal(`HLS 流错误：${String(data.details ?? '未知错误')}`);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      cleanups.push(() => hls.destroy());
    } catch (err) {
      notifyLoaderFailure(this, err);
    }
  };
}

/** mpegts.js loader：.flv → 'flv'、.ts → 'mpegts' 容器类型（仅匹配时动态 import）；
 * 装配失败 notice 提示并吞异常，运行期 ERROR 事件经 onFatal 升级错误卡片 */
async function makeMpegtsLoader(ext: string, cleanups: Cleanup[], onFatal: StreamFatalHandler): Promise<ArtLoader> {
  return async function (this: Artplayer, video, url) {
    try {
      const mpegts = (await import('mpegts.js')).default;
      const player = mpegts.createPlayer({ type: ext === 'flv' ? 'flv' : 'mpegts', url, isLive: false });
      player.on(mpegts.Events.ERROR, (errorType: unknown) => {
        onFatal(`流播放错误（${String(errorType)}），播放已终止`);
      });
      player.attachMediaElement(video);
      player.load();
      cleanups.push(() => player.destroy());
    } catch (err) {
      notifyLoaderFailure(this, err);
    }
  };
}

/**
 * ArtPlayer 主题色（终审 B3 裁决：CSS 变量驱动，零 JS 跟随）。
 * ArtPlayer 5.x 把 option.theme 写进容器内联自定义属性 `--art-theme`，全部主题色
 * 消费点（进度条/音量/选中态等）都是 `var(--art-theme)`——而 CSS 自定义属性的值
 * 允许引用其他变量，故直接传 `var(--ui-accent, <fallback>)`：明暗主题切换（含
 * system 模式的 OS 级切换）时播放器 UI 即时跟随，无需重建播放器或监听事件。
 * （原 render 时 getComputedStyle 读一次 --ui-accent 的做法在主题切换后残留旧色。）
 */
const ART_THEME = 'var(--ui-accent, #0969da)';

export const avRenderer: Renderer = {
  id: 'av',
  label: '音视频',
  extensions: ['mp4', 'm4v', 'mov', 'webm', 'ogg', 'm3u8', 'flv', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'oga', 'opus'],
  // 注意：不注册 'ts'——codeRenderer（TypeScript）先占该扩展名，registry 重复注册会抛错；
  // .ts 的播放路径由 dispatcher 的 mpegts 签名改派进入（BUG-01），此处仅保留 customType 分派
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection): Promise<RenderedInstance> {
    // buffer 实际由普通 ArrayBuffer 支持；断言绕开 TS 5.9 BlobPart 的 ArrayBuffer 泛型收窄，避免大文件复制
    const makeBlob = (): Blob => new Blob([buffer as Uint8Array<ArrayBuffer>], { type: mediaMimeOf(det.ext) });
    // BUG-01：HLS 仅支持 remote store 直连（分片按真实 URL 解析）；本地 store 明确报错，
    // 消除「静默挂起」（错误卡片由 dispatcher catch 统一呈现）
    const hlsDirect = det.ext === 'm3u8' ? resolveHlsDirect(source) : null;
    if (det.ext === 'm3u8' && !hlsDirect) {
      throw new Error('本地文件的 HLS（m3u8）暂不支持播放：请通过顶栏「连接服务器」打开该文件');
    }

    if (playerKindOf(det.ext) === 'audio') {
      const url = URL.createObjectURL(makeBlob());
      const el = document.createElement('audio');
      el.setAttribute('controls', '');
      el.src = url;
      el.className = 'vv-av';
      target.replaceChildren(el);
      const instance: RenderedInstance & { getMeta(): { size: number; encoding?: Encoding } } = {
        // BUG-04 握手点 2 代工：av 实例暴露大小与编码（SHELL-12 验收要求媒体至少大小+编码）
        getMeta: () => ({ size: buffer.length, encoding: det.encoding }),
        destroy() {
          el.pause();
          URL.revokeObjectURL(url);
          el.remove();
        }
      };
      return instance;
    }

    // blob URL 推迟到 ArtPlayer 构造前一刻创建：动态 import 与 customType 装配失败时
    // 尚未创建（零泄漏）；构造抛错则 revoke 后 rethrow（destroy 永不执行的失败路径不再漏）。
    // HLS 直连不建 blob（url 为服务端真实地址），revoke 面天然不存在。
    const Artplayer = (await import('artplayer')).default;
    const cleanups: Cleanup[] = [];
    // 运行期 fatal 升级通道：loader 内部错误事件 → showMediaError（art 构造前先占位）
    let mediaFatal: StreamFatalHandler = () => {};
    const customType: NonNullable<Option['customType']> = {};
    if (streamProtocolOf(det.ext) === 'hls') {
      customType.m3u8 = await makeHlsLoader(hlsDirect!, cleanups, (m) => mediaFatal(m));
    } else if (det.ext === 'flv' || det.ext === 'ts') {
      const loader = await makeMpegtsLoader(det.ext, cleanups, (m) => mediaFatal(m));
      customType.flv = loader;
      customType.ts = loader;
    }
    const container = document.createElement('div');
    container.className = 'vv-av vv-artplayer';
    target.replaceChildren(container);
    const url = hlsDirect ? hlsDirect.url : URL.createObjectURL(makeBlob());
    let art: InstanceType<typeof Artplayer>;
    try {
      // 主题色传 CSS 变量引用（见 ART_THEME 注释）：随主题切换自动跟随
      art = new Artplayer({ ...buildArtConfig(container, url, det.ext, ART_THEME), customType });
    } catch (err) {
      if (!hlsDirect) URL.revokeObjectURL(url);
      throw err;
    }

    // ---------- BUG-14：运行期错误 → 统一错误卡片（重试/降级查看） ----------
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const cleanup of cleanups) cleanup(); // hls/mpegts 实例先于 art.destroy 释放
      try {
        art.destroy(true);
      } catch {
        // 容器已被替换等极端场景：art 内部状态清理失败可忽略（DOM 已由 replaceChildren 摘除）
      }
      if (!hlsDirect) URL.revokeObjectURL(url);
    };
    let cardShown = false;
    // 重试/降级成功产出的新实例由本渲染闭包级联托管：ViewerPane 持有的 live 仍是本卡片
    // 实例（旧播放器实例），tab 关闭/重渲染时 destroy 走级联释放——重试产出的新播放器
    // /hex 实例不会成为无人持有的泄漏源（spec BUG-14 风险节「新实例归属」问题的自持解法）
    let liveChild: RenderedInstance | null = null;
    const takeOver = (instance: RenderedInstance): void => {
      liveChild?.destroy(); // 同一插槽先释放上一个成功实例（重试→降级为互斥替换语义）
      liveChild = instance;
    };
    const buildActions = (): ErrorCardAction[] => {
      const actions: ErrorCardAction[] = [
        {
          label: '重试',
          onClick: () => {
            // 重跑本渲染器 render（自持闭包）；再失败转新错误卡片（按钮随重建，信息不丢）
            avRenderer.render(buffer, target, source, det)
              .then(takeOver)
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                showErrorCard(target, message, source, { actions: buildActions() });
              });
          }
        }
      ];
      const hex = getHexFallbackRenderer();
      if (hex) {
        actions.push({
          label: '降级查看',
          onClick: () => {
            release(); // 先释放播放器资源（blob/worker），再以 hex 渲染原始字节（当前为原始字节视图）
            Promise.resolve(hex.render(buffer, target, source, det))
              .then(takeOver) // hex 实例同样级联托管（tab 关闭时随本实例销毁）
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                showErrorCard(target, message, source);
              });
          }
        });
      }
      return actions;
    };
    const showMediaError = (message: string): void => {
      if (cardShown) return; // 首错收口：HLS fatal 已出卡片时，后续 video error 不再双报
      cardShown = true;
      release(); // 摘除黑屏容器并释放播放器资源，错误卡片随即替换
      showErrorCard(target, `无法播放此媒体：${message}`, source, { actions: buildActions() });
    };
    mediaFatal = showMediaError;
    // video 运行期解码错误（截断 mp4 等）：ArtPlayer 转发 video 'error' 事件
    art.on('error', () => {
      const mediaErr = (art as unknown as { video?: HTMLVideoElement | null }).video?.error;
      showMediaError(videoErrorMessage(mediaErr?.code));
    });

    const instance: RenderedInstance & { getMeta(): { size: number; encoding?: Encoding } } = {
      // BUG-04 握手点 2 代工：av 实例暴露大小与编码（SHELL-12 验收要求媒体至少大小+编码）
      getMeta: () => ({ size: buffer.length, encoding: det.encoding }),
      destroy() {
        release(); // 幂等：错误卡片 release 后 destroy 为 no-op
        liveChild?.destroy(); // 级联：销毁重试/降级托管的成功实例
      }
    };
    return instance;
  }
};
