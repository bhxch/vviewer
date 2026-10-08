// client.ts — binary.worker 的薄壳客户端：请求 id 配对、dispose 终止。
// 无取消/去重（结构树解析单发低频，与 highlight 的流式高亮场景不同）。
import type { BinaryRequest, BinaryResponse } from './binary.worker';
import type { ParseResult } from './struct';

interface Pending {
  resolve: (r: ParseResult) => void;
  reject: (e: Error) => void;
}

export class BinaryClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<BinaryResponse>) => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve({ root: res.root, truncated: res.truncated });
      else p.reject(new Error(res.error));
    };
  }

  /**
   * 解析文件头结构。head 会被 transfer 到 worker（调用后不可再读）；opts.tail
   * （EOCD 尾窗）同样 transfer——两段 slice 各自持有独立 ArrayBuffer，可同批转移。
   */
  parseStruct(
    head: Uint8Array,
    opts?: { budgetMs?: number; tail?: Uint8Array; totalSize?: number }
  ): Promise<ParseResult> {
    const id = this.nextId++;
    const req: BinaryRequest = {
      id,
      kind: 'parse-struct',
      head,
      budgetMs: opts?.budgetMs,
      tail: opts?.tail,
      totalSize: opts?.totalSize
    };
    const transfer: ArrayBuffer[] = [head.buffer as ArrayBuffer];
    if (opts?.tail) transfer.push(opts.tail.buffer as ArrayBuffer);
    return new Promise<ParseResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(req, transfer);
    });
  }

  dispose(): void {
    this.worker.terminate();
    const err = new Error('binary client 已释放');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
