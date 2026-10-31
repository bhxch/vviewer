// client.ts — binary.worker 的薄壳客户端：请求 id 配对、dispose 终止。
// Task 2 增流式搜索：search/cancelSearch（id 失效语义——新搜索自动取消旧任务，
// 迟到的旧 id 消息静默丢弃）；进度/完成经回调上抛，命中列表由 client 累积后
// 在 onDone 一次性交付（onProgress 另携本块增量供调用方渐进镜像）。
// Task 6（io-streaming）增窗口模式：search 改传 size + read 闭包（无 data），
// worker 以 search-need 驱动、本端取块回灌 search-chunk——超大文件不再整件
// 驻留主线程；读失败/短读/超时 abort 任务并携 error 收尾。data 旧形态照常。
import type {
  BinaryRequest,
  BinaryWorkerMessage,
  SearchCancelRequest,
  SearchChunkRequest,
  SearchDoneMessage,
  SearchNeedMessage,
  SearchProgressMessage,
  SearchRequest,
  SearchWindowRequest
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
  /** 窗口模式供数失败（读失败/短读/超时）：任务已 abort，offsets 为已累计部分 */
  error?: string;
}

/** need 等待回灌的超时（防悬挂 read 致搜索忙碌态永不复位；测试注入小值驱动） */
export const SEARCH_NEED_TIMEOUT_MS = 30_000;

/** 窗口模式块读取闭包（与 core StreamCtx.read 同构：区间 end 含） */
export type SearchChunkRead = (r: { start: number; end: number }) => Promise<Uint8Array<ArrayBuffer>>;

/** 搜索回调（两模式共用） */
interface SearchCallbacks {
  /** 大小写不敏感（仅文本搜索有意义；ASCII 折叠） */
  caseInsensitive?: boolean;
  onProgress?: (p: SearchProgressInfo) => void;
  onDone?: (r: SearchDoneInfo) => void;
}

/**
 * 搜索选项（Task 6 两形态，互斥）：全量模式传 data（client slice 副本 transfer，
 * 调用方原件不受 detach 影响）；窗口模式传 size + read（worker need/chunk 握手
 * 逐块拉取，needTimeoutMs 可注入小值驱动超时路径）。
 */
export type SearchOptions =
  | ({ data: Uint8Array } & SearchCallbacks)
  | ({ size: number; read: SearchChunkRead; needTimeoutMs?: number } & SearchCallbacks);

/** 活跃搜索任务状态（data 全量 / 窗口 need-chunk 两模式共用） */
interface ActiveSearchState {
  id: number;
  offsets: number[];
  onProgress?: (p: SearchProgressInfo) => void;
  onDone?: (r: SearchDoneInfo) => void;
  /** 窗口模式供数闭包（data 模式为 null——不会收到 search-need） */
  read: SearchChunkRead | null;
  /** 文件总字节数（终审 F3 全量判定基准；data 模式 0——不收 need） */
  size: number;
  /** need 回灌超时（仅窗口模式使用） */
  needTimeoutMs: number;
  /** 在途 need 的超时定时器（供数落定/任务终结时清除） */
  needTimer: ReturnType<typeof setTimeout> | null;
}

export class BinaryClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private activeSearch: ActiveSearchState | null = null;
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
        this.clearNeedTimer(s);
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
  private onSearchMessage(res: SearchProgressMessage | SearchDoneMessage | SearchNeedMessage): void {
    const s = this.activeSearch;
    if (!s || s.id !== res.id) return;
    if (res.type === 'search-progress') {
      s.offsets.push(...res.offsets);
      s.onProgress?.({ scanned: res.scanned, total: res.total, hits: res.hits, offsets: res.offsets });
      return;
    }
    if (res.type === 'search-need') {
      this.supplyChunk(s, res);
      return;
    }
    this.clearNeedTimer(s);
    this.activeSearch = null;
    s.onDone?.({ truncated: res.truncated, offsets: s.offsets });
  }

  private clearNeedTimer(s: ActiveSearchState): void {
    if (s.needTimer !== null) {
      clearTimeout(s.needTimer);
      s.needTimer = null;
    }
  }

  /**
   * 窗口供数（Task 6）：search-need 区间 [start, end) 经 read 闭包取块（换算为
   * end 含）回灌 search-chunk，超返回且恰为整文件时判定 Range-less 全量原样单
   * chunk 供给（终审 F3），其余超返回钳到区间长度（同 hexSource cap 语义；不
   * transfer——切片视图底层 buffer 可能与来源共享，结构化克隆自行拷贝）。
   * 读失败/短读/超时 → abortWindowSearch；落定前任务被取代/取消/释放则静默丢弃。
   */
  private supplyChunk(s: ActiveSearchState, need: SearchNeedMessage): void {
    if (s.read === null) return; // data 模式不会收到 need；无闭包即协议违约，忽略
    const want = need.end - need.start;
    s.needTimer = setTimeout(() => {
      s.needTimer = null;
      this.abortWindowSearch(s, `search-need 供数超时（${s.needTimeoutMs}ms）`);
    }, s.needTimeoutMs);
    void s.read({ start: need.start, end: need.end - 1 }).then(
      (bytes) => {
        if (this.activeSearch !== s) return; // 供给期间已被取代/取消/释放
        this.clearNeedTimer(s);
        if (bytes.length < want) {
          this.abortWindowSearch(s, `search-chunk 短读：请求 ${want} 字节，实得 ${bytes.length}`);
          return;
        }
        // 超返回恰为整文件（终审 F3）= 服务器忽略 Range 回 200 全量：clamp 会以
        // 文件头冒充请求区间（扫描字节错位）——全量原样作为单 chunk 供给，worker
        // 校验 start 一致后整扫，nextStart 一步越过 size 正常收尾
        const rangeless = bytes.length > want && bytes.length === s.size;
        const chunk: SearchChunkRequest = {
          id: s.id,
          type: 'search-chunk',
          start: need.start,
          bytes: rangeless ? bytes : bytes.subarray(0, want)
        };
        this.worker.postMessage(chunk);
      },
      (e: unknown) => {
        if (this.activeSearch !== s) return;
        this.clearNeedTimer(s);
        this.abortWindowSearch(s, e instanceof Error ? e.message : String(e));
      }
    );
  }

  /** 窗口任务 abort：发 cancel 使 worker 停发 need（id 失效）+ onDone 携 error 收尾 */
  private abortWindowSearch(s: ActiveSearchState, error: string): void {
    if (this.activeSearch !== s) return;
    this.clearNeedTimer(s);
    this.activeSearch = null;
    const cancel: SearchCancelRequest = { id: s.id, kind: 'search-cancel' };
    this.worker.postMessage(cancel);
    s.onDone?.({ truncated: false, offsets: s.offsets, error });
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
   * 丢弃），worker 收到新请求后亦因搜索 id 失效在块边界停扫。全量模式 data 被
   * slice 出独立副本并 transfer，调用方原件不受影响；窗口模式发无 data 请求，
   * 后续经 read 闭包按 search-need 逐块供数。
   */
  search(needle: Uint8Array, opts: SearchOptions): void {
    const id = this.nextId++;
    const full = 'data' in opts;
    this.activeSearch = {
      id,
      offsets: [],
      onProgress: opts.onProgress,
      onDone: opts.onDone,
      read: full ? null : opts.read,
      size: full ? 0 : opts.size,
      needTimeoutMs: full ? SEARCH_NEED_TIMEOUT_MS : (opts.needTimeoutMs ?? SEARCH_NEED_TIMEOUT_MS),
      needTimer: null
    };
    if (full) {
      const data = opts.data.slice();
      const req: SearchRequest = { id, kind: 'search', data, needle, caseInsensitive: opts.caseInsensitive };
      this.worker.postMessage(req, [data.buffer as ArrayBuffer]);
      return;
    }
    // 窗口模式（Task 6）：无 data 请求——worker 以 search-need 驱动逐块拉取
    const req: SearchWindowRequest = { id, kind: 'search', size: opts.size, needle, caseInsensitive: opts.caseInsensitive };
    this.worker.postMessage(req);
  }

  /** 取消当前搜索（id 失效语义）：worker 在块边界停扫，此后不再有回调 */
  cancelSearch(): void {
    const s = this.activeSearch;
    if (!s) return;
    this.clearNeedTimer(s);
    this.activeSearch = null;
    this.worker.postMessage({ id: s.id, kind: 'search-cancel' });
  }

  dispose(): void {
    this.worker.terminate();
    if (this.activeSearch !== null) this.clearNeedTimer(this.activeSearch);
    this.activeSearch = null;
    const err = new Error('binary client 已释放');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
