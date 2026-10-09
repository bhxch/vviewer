import type { HighlightContext, HighlightInterval, HighlightRequest, HighlightResponse } from './types';
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
 * BUG-06 可观测：worker.onerror/onmessageerror 经 onWorkerError 上报应用层，
 * 在途请求统一 reject（不悬挂），后续请求短路——此前两类失败零提示静默降级 hljs。
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
  /** 首个致命失败原因（看门狗超时或 worker 错误），短路后续请求时如实转述 */
  private initFailureReason = '';
  /** 应用层错误上报回调（状态栏一次性提示或 console 显式标签） */
  private readonly onWorkerError?: (reason: string) => void;

  constructor(worker: Worker, init?: WorkerInit, onWorkerError?: (reason: string) => void) {
    this.worker = worker;
    this.onWorkerError = onWorkerError;
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
    // worker 脚本 404/MIME 异常/运行期崩溃：onerror 触发后 worker 不会再回包，
    // 与看门狗同语义收敛到 failWorker（reject 在途 + 上报 + 短路后续请求）
    this.worker.onerror = (ev: ErrorEvent) => {
      const detail = ev.message || '脚本加载失败';
      const file = ev.filename ? `（${ev.filename}）` : '';
      this.failWorker(`worker 错误：${detail}${file}`);
    };
    // 消息无法反序列化：协议已坏，同样按致命失败处理
    this.worker.onmessageerror = () => {
      this.failWorker('worker 消息反序列化失败（onmessageerror）');
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
      this.failWorker(
        `初始化超时（${INIT_TIMEOUT_MS / 1000}s 无响应）·排查 worker chunk 是否 404/MIME 异常`
      );
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

  /**
   * worker 致命失败（onerror/onmessageerror/看门狗超时）统一收敛：
   * 上报应用层 → 短路后续请求 → reject 全部在途请求（普通 Error，渲染端接 hljs 兜底）。
   * 幂等：首次失败即清看门狗，避免超时与错误双报。
   * 取舍（评审 R1 知情备案）：onerror 一律致命短路偏保守——带 message 的运行期
   * 未捕获错误下 worker 常仍可服务，理论上可仅上报不短路；但正常请求路径已被
   * serveWorker 的 try/catch 全包裹（dispatch/init），该场景罕见，宁可全会话降级
   * hljs 也不冒险反复打到病态 worker。如需精确区分（message 空 = 脚本加载失败
   * 必然短路；带 message = 仅上报），属后续增强非缺陷。
   */
  private failWorker(reason: string): void {
    if (this.disposed) return;
    this.initFailed = true;
    this.initFailureReason = reason;
    this.onWorkerError?.(reason);
    if (this.initTimer !== null) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    const err = new Error(`highlight worker 失败：${reason}`);
    for (const [, p] of [...this.pending]) p.reject(err);
    this.pending.clear();
    this.pendingByLang.clear();
  }

  /**
   * 高亮文本。同 lang 有未完成请求时取消它（其 Promise 以 HighlightCanceledError reject）。
   * ctx.chunk（可选）为子文本窗口语义标注：调用方保证 text 即该窗口子文本，worker/engine
   * 不感知行号、不做切分（spec §5.1 子文本 parse 裁决），返回区间相对 text；行号平移归调用侧。
   */
  highlight(text: string, lang: string, ctx?: HighlightContext): Promise<HighlightInterval[]> {
    if (this.disposed) return Promise.reject(new HighlightCanceledError());
    if (this.initFailed) {
      return Promise.reject(new Error(`highlight worker 不可用：${this.initFailureReason}`));
    }
    const prevId = this.pendingByLang.get(lang);
    if (prevId !== undefined) this.cancel(prevId);
    const id = this.nextId++;
    this.pendingByLang.set(lang, id);
    return new Promise<HighlightInterval[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: HighlightRequest = { id, text, lang };
      if (ctx?.chunk) req.chunk = ctx.chunk;
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
