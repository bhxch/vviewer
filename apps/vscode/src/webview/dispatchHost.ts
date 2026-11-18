// dispatchHost.ts — webview ⇄ host 往返桥（spec H T3）。
//
// webview 内**无 console 出口**（webview console 不回传 host）→ 一切异常反馈走
// `report` 通道上行；相对文件读、导出写盘、外链打开同理走消息面。
//
// 请求/响应按 id 配对（`createRequestIdFactory`——与 host 侧同源的单调 id 语义）。
import { createRequestIdFactory, type HostToWebview, type WebviewToHost } from '../host/protocol';

/** webview 侧的 VSCode API 面（postMessage 单向通道） */
export interface WebviewApi {
  postMessage(message: unknown): void;
}

/** 桥的构造入参 */
export interface HostBridgeOptions {
  /** VSCode webview API */
  api: WebviewApi;
  /** 请求 id 分配器（缺省自建——每个 webview 一个实例） */
  nextId?: () => number;
}

/** 按路径读文件的结果 */
export interface FileReadResult {
  bytes: Uint8Array | null;
  error?: string;
}

/** 导出结果 */
export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** host 往返桥（webview 侧） */
export class HostBridge {
  private readonly api: WebviewApi;
  private readonly nextId: () => number;
  private readonly pendingFiles = new Map<number, (result: FileReadResult) => void>();
  private readonly pendingExports = new Map<number, (result: ExportResult) => void>();

  constructor(options: HostBridgeOptions) {
    this.api = options.api;
    this.nextId = options.nextId ?? createRequestIdFactory();
  }

  /** 上报就绪（宿主据此投递 init——就绪握手，见 protocol.ts 的 ready 约定） */
  ready(): void {
    const message: WebviewToHost = { kind: 'ready' };
    this.api.postMessage(message);
  }

  /** 按路径读文件（相对链接/相对图片探测面，spec §7 ①②） */
  readFile(path: string): Promise<Uint8Array | null> {
    const id = this.nextId();
    const promise = new Promise<FileReadResult>((resolve) => {
      this.pendingFiles.set(id, resolve);
    });
    const message: WebviewToHost = { kind: 'read-file', id, path };
    this.api.postMessage(message);
    return promise.then((result) => result.bytes);
  }

  /** 导出 HTML（宿主 showSaveDialog + 写盘；返回落盘路径，未落盘为 null） */
  exportHtml(html: string, suggestedName: string): Promise<string | null> {
    const id = this.nextId();
    const promise = new Promise<ExportResult>((resolve) => {
      this.pendingExports.set(id, resolve);
    });
    const message: WebviewToHost = { kind: 'export-html', id, html, suggestedName };
    this.api.postMessage(message);
    return promise.then((result) => (result.ok && result.path ? result.path : null));
  }

  /** 打开外部链接（经宿主原生 open——不经 webview 导航） */
  openExternal(url: string): void {
    const message: WebviewToHost = { kind: 'open-external', url };
    this.api.postMessage(message);
  }

  /** 请求宿主把当前文档切到该相对路径（spec §7 ①） */
  navigate(path: string): void {
    const message: WebviewToHost = { kind: 'navigate', path };
    this.api.postMessage(message);
  }

  /** 上报 toc 折叠态（宿主持久化到 workspaceState——spec §4.2） */
  setTocCollapsed(collapsed: boolean): void {
    const message: WebviewToHost = { kind: 'toc-collapsed', collapsed };
    this.api.postMessage(message);
  }

  /** 上报（webview 无 console 出口 → 走 host 通道） */
  report(level: 'warn' | 'error', message: string): void {
    const payload: WebviewToHost = { kind: 'report', level, message };
    this.api.postMessage(payload);
  }

  /** 宿主消息入口（按 id 配对响应） */
  handleMessage(message: HostToWebview): void {
    switch (message.kind) {
      case 'file-bytes': {
        const resolve = this.pendingFiles.get(message.id);
        if (!resolve) return;
        this.pendingFiles.delete(message.id);
        resolve({ bytes: message.bytes, error: message.error });
        return;
      }
      case 'export-result': {
        const resolve = this.pendingExports.get(message.id);
        if (!resolve) return;
        this.pendingExports.delete(message.id);
        resolve({ ok: message.ok, path: message.path, error: message.error });
        return;
      }
      default:
        return;
    }
  }
}
