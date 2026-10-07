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

/** 初始化看门狗：构造（发 init 握手）后这么久仍无任何 worker 回包 → 视为 worker 不可用。 */
export const INIT_TIMEOUT_MS = 15_000;

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
  /** worker 曾回过任何消息（含 init 失败的报错）：看门狗即解除 */
  private workerAlive = false;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  /** 看门狗触发：worker 从未回包（脚本加载失败/wasm 卡死等），后续请求直接失败 */
  private initFailed = false;

  constructor(worker: Worker, init?: WorkerInit) {
    this.worker = worker;
    this.worker.onmessage = (ev: MessageEvent<HighlightResponse>) => {
      this.markWorkerAlive();
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
    // 初始化看门狗：worker 静默（脚本/wasm/grammar 加载挂死）时拒绝全部未完成
    // 请求并短路后续请求——渲染端以普通 Error 接通 hljs 兜底，不永久悬挂。
    // worker 回过任意消息（含 init 失败报错）即视为存活，看门狗解除。
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      if (this.workerAlive || this.disposed) return;
      this.initFailed = true;
      const err = new Error(`highlight worker 初始化超时（${INIT_TIMEOUT_MS / 1000}s 无响应）`);
      for (const [, p] of [...this.pending]) p.reject(err);
      this.pending.clear();
      this.pendingByLang.clear();
    }, INIT_TIMEOUT_MS);
    // Node/vitest 下不因看门狗计时器吊住进程退出
    (this.initTimer as unknown as { unref?: () => void }).unref?.();
  }

  private markWorkerAlive(): void {
    if (this.workerAlive) return;
    this.workerAlive = true;
    if (this.initTimer !== null) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
  }

  /** 高亮文本。同 lang 有未完成请求时取消它（其 Promise 以 HighlightCanceledError reject）。 */
  highlight(text: string, lang: string): Promise<HighlightInterval[]> {
    if (this.disposed) return Promise.reject(new HighlightCanceledError());
    if (this.initFailed) {
      return Promise.reject(new Error(`highlight worker 初始化超时（${INIT_TIMEOUT_MS / 1000}s 无响应）`));
    }
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
    if (this.initTimer !== null) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    this.worker.terminate();
  }

  private cancel(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new HighlightCanceledError());
  }
}
