// client.ts — binary.worker 的薄壳客户端：请求 id 配对、dispose 终止。
// Task 2 增流式搜索：search/cancelSearch（id 失效语义——新搜索自动取消旧任务，
// 迟到的旧 id 消息静默丢弃）；进度/完成经回调上抛，命中列表由 client 累积后
// 在 onDone 一次性交付（onProgress 另携本块增量供调用方渐进镜像）。
import type {
  BinaryRequest,
  BinaryWorkerMessage,
  SearchDoneMessage,
  SearchProgressMessage
} from './binary.worker';
import type { ParseResult } from './struct';

interface Pending {
  resolve: (r: ParseResult) => void;
  reject: (e: Error) => void;
}

/** 搜索进度（每次块扫描后一次；offsets 为本块新增命中的绝对偏移） */
export interface SearchProgressInfo {
  scanned: number;
  total: number;
  hits: number;
  offsets: number[];
}

/** 搜索完成（offsets 为全量命中列表；truncated = 累计达上限提前终止） */
export interface SearchDoneInfo {
  truncated: boolean;
  offsets: number[];
}

export interface SearchOptions {
  /** 搜索数据集：client 内部 slice 出独立副本 transfer，调用方原件不受 detach 影响 */
  data: Uint8Array;
  /** 大小写不敏感（仅文本搜索有意义；ASCII 折叠） */
  caseInsensitive?: boolean;
  onProgress?: (p: SearchProgressInfo) => void;
  onDone?: (r: SearchDoneInfo) => void;
}

export class BinaryClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private activeSearch: {
    id: number;
    offsets: number[];
    onProgress?: (p: SearchProgressInfo) => void;
    onDone?: (r: SearchDoneInfo) => void;
  } | null = null;
  private nextId = 1;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<BinaryWorkerMessage>) => {
      const res = ev.data;
      if ('type' in res) {
        this.onSearchMessage(res);
        return;
      }
      // worker 搜索任务抛错 → ErrorResponse：以已累计命中收尾，避免取消按钮滞留
      const s = this.activeSearch;
      if (s !== null && s.id === res.id && !res.ok) {
        this.activeSearch = null;
        s.onDone?.({ truncated: false, offsets: s.offsets });
        return;
      }
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve({ root: res.root, truncated: res.truncated });
      else p.reject(new Error(res.error));
    };
  }

  /** 流式搜索消息路由：id 失效（被新搜索取代/已取消）的迟到消息一律丢弃 */
  private onSearchMessage(res: SearchProgressMessage | SearchDoneMessage): void {
    const s = this.activeSearch;
    if (!s || s.id !== res.id) return;
    if (res.type === 'search-progress') {
      s.offsets.push(...res.offsets);
      s.onProgress?.({ scanned: res.scanned, total: res.total, hits: res.hits, offsets: res.offsets });
      return;
    }
    this.activeSearch = null;
    s.onDone?.({ truncated: res.truncated, offsets: s.offsets });
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

  /**
   * 发起搜索（流式）。新搜索自动取消旧任务：覆盖 activeSearch（旧 id 的后续消息
   * 丢弃），worker 收到新请求后亦因搜索 id 失效在块边界停扫。data 会被 slice
   * 出独立副本并 transfer，调用方原件不受影响。
   */
  search(needle: Uint8Array, opts: SearchOptions): void {
    const id = this.nextId++;
    this.activeSearch = { id, offsets: [], onProgress: opts.onProgress, onDone: opts.onDone };
    const data = opts.data.slice();
    const req: BinaryRequest = { id, kind: 'search', data, needle, caseInsensitive: opts.caseInsensitive };
    this.worker.postMessage(req, [data.buffer as ArrayBuffer]);
  }

  /** 取消当前搜索（id 失效语义）：worker 在块边界停扫，此后不再有回调 */
  cancelSearch(): void {
    const s = this.activeSearch;
    if (!s) return;
    this.activeSearch = null;
    this.worker.postMessage({ id: s.id, kind: 'search-cancel' });
  }

  dispose(): void {
    this.worker.terminate();
    this.activeSearch = null;
    const err = new Error('binary client 已释放');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
