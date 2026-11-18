// links.ts — 相对链接 / 相对图片解析（spec H T5，承接 spec §7 ①②）。
//
// 相对图片：webview 内以 blob URL 呈现（宿主读 sibling bytes → webview 建 blob URL）——
// blob 生命周期由**包内视图托管**（markdown 包的图片 resolver 登记并随渲染实例 destroy
//  revoke，packages/vviewer-markdown/src/markdownRenderer.ts 的 resolveRelativeImages）。
//
// 相对链接：经宿主往返探测（read-file 消息 + Uri.joinPath）——命中则请求宿主切文档
// （同一 custom editor 内切换），未命中则顶部提示条提示（role="status"）。
//
// 外链：不经 webview 导航（走宿主原生 open）。
import type {
  MarkdownImageResolver,
  RelativeLinkOpener,
  RelativeLinkResolver
} from '@bhxch/vviewer-markdown';

/** 宿主往返面（由 dispatchHost 的 HostBridge 承接） */
export interface LinkBridge {
  /** 按路径读文件（相对路径，相对当前文档） */
  readFile(path: string): Promise<Uint8Array | null>;
  /** 请求宿主把当前文档切到该相对路径 */
  navigate(path: string): void;
}

/** 相对图片解析器：宿主读字节 → webview 建 blob URL（失败返回 null＝保留原 src） */
export function createImageResolver(bridge: LinkBridge): MarkdownImageResolver {
  return async (src: string) => {
    const bytes = await bridge.readFile(src);
    if (!bytes || bytes.length === 0) return null;
    return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  };
}

/**
 * 相对链接解析器：读文件成功即视为命中（扩展无多 store 语义——目录与文件的区分在
 * MVP 不做，命中即按文件打开）。
 */
export function createLinkResolver(bridge: LinkBridge): RelativeLinkResolver {
  return async (href: string) => {
    const bytes = await bridge.readFile(href);
    if (!bytes) return { kind: 'missing', path: href };
    return { kind: 'file', storeId: 'single', path: href };
  };
}

/**
 * 相对链接打开通道：命中文件 → 请求宿主切文档；缺件 → 提示回调（顶部提示条）。
 */
export function createLinkOpener(
  bridge: LinkBridge,
  onMissing: (path: string) => void
): RelativeLinkOpener {
  return (target, href) => {
    if (target.kind === 'file') {
      bridge.navigate(target.path);
      return;
    }
    onMissing(target.path ?? href);
  };
}
