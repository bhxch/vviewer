import type { HighlightInterval, HighlightRequest, HighlightResponse } from './types';
import type { InitMessage, WorkerInit } from './worker';

/** 取消的请求 reject 此错误（name 为 HighlightCanceled）。 */
export class HighlightCanceledError extends Error {
  constructor() {
    super('highlight 请求已取消');
    this.name = 'HighlightCanceled';
  }
}

interface Pending {
  resolve: (intervals: HighlightInterval[]) => void;
  reject: (e: unknown) => void;
}

/**
 * Worker 客户端：请求去重（同 lang 连续请求取消前一个未完成者）、批量取消、释放。
 * highlight 返回区间数组；worker 报错或请求被取消时 Promise reject。
 */
export class HighlightClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly pendingByLang = new Map<string, number>();
  private nextId = 1;
  private disposed = false;

  constructor(worker: Worker, init?: WorkerInit) {
    this.worker = worker;
    this.worker.onmessage = (ev: MessageEvent<HighlightResponse>) => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      for (const [lang, id] of this.pendingByLang) {
        if (id === res.id) this.pendingByLang.delete(lang);
      }
      if (res.ok) p.resolve(res.intervals ?? []);
      else p.reject(new Error(res.error ?? 'highlight 失败'));
    };
    // 握手：首条 init 消息携带引擎配置（serveWorker 排队等待 init 后才处理请求）
    const handshake: InitMessage = { kind: 'init', ...init };
    this.worker.postMessage(handshake);
  }

  /** 高亮文本。同 lang 有未完成请求时取消它（其 Promise 以 HighlightCanceledError reject）。 */
  highlight(text: string, lang: string): Promise<HighlightInterval[]> {
    if (this.disposed) return Promise.reject(new HighlightCanceledError());
    const prevId = this.pendingByLang.get(lang);
    if (prevId !== undefined) this.cancel(prevId);
    const id = this.nextId++;
    this.pendingByLang.set(lang, id);
    return new Promise<HighlightInterval[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: HighlightRequest = { id, text, lang };
      this.worker.postMessage(req);
    });
  }

  /** 取消全部未完成请求（各自以 HighlightCanceledError reject）。 */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
    this.pendingByLang.clear();
  }

  /** 取消全部请求并终止 worker。 */
  dispose(): void {
    this.cancelAll();
    this.disposed = true;
    this.worker.terminate();
  }

  private cancel(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new HighlightCanceledError());
  }
}
