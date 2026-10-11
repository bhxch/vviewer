// binary.worker.ts — 二进制解析 Worker 薄壳（模式同 highlight：核心纯函数 + serve + 类型共享）。
// 大 buffer 的结构解析不占主线程；handleRequest 为纯函数，jsdom 单测直调。
// Task 2：增 search 任务——分块扫描（searchScan），逐块 progress 流式回报，
// 累计 1000 截断，搜索 id 失效（新搜索/显式取消）即停且不发 done。
import { parseStruct, type ParseResult } from './struct';
import { scanAll, SEARCH_CHUNK_BYTES, SEARCH_MAX_HITS } from './searchScan';

export interface ParseStructRequest {
  id: number;
  kind: 'parse-struct';
  head: Uint8Array;
  budgetMs?: number;
  /** 文件尾窗（EOCD 扫描用，>8KB 归档的 entries 字段依赖它） */
  tail?: Uint8Array;
  /** 文件总字节数（tail 内偏移 → 文件绝对偏移的换算基准） */
  totalSize?: number;
}

export interface SearchRequest {
  id: number;
  kind: 'search';
  /** 搜索数据集（worker 侧持有独立副本） */
  data: Uint8Array;
  needle: Uint8Array;
  /** 大小写不敏感（文本搜索；ASCII 折叠） */
  caseInsensitive?: boolean;
}

export interface SearchCancelRequest {
  id: number;
  kind: 'search-cancel';
}

export type BinaryRequest = ParseStructRequest | SearchRequest | SearchCancelRequest;

export interface ParseStructResponse {
  id: number;
  ok: true;
  root: ParseResult['root'];
  truncated: boolean;
}

export interface ErrorResponse {
  id: number;
  ok: false;
  error: string;
}

export interface SearchProgressMessage {
  id: number;
  type: 'search-progress';
  /** 累计已扫描字节数 */
  scanned: number;
  /** 文件总字节数 */
  total: number;
  /** 本块新增命中数 */
  hits: number;
  /** 本块新增命中的绝对 offset（升序；主线程镜像累积） */
  offsets: number[];
}

export interface SearchDoneMessage {
  id: number;
  type: 'search-done';
  /** 累计命中达上限提前终止 */
  truncated: boolean;
}

export type BinaryResponse = ParseStructResponse | ErrorResponse;
export type SearchResponse = SearchProgressMessage | SearchDoneMessage;
export type BinaryWorkerMessage = BinaryResponse | SearchResponse;

/** 请求处理器（Worker 与测试共用；search 为流式任务，走 serveBinaryWorker） */
export function handleRequest(req: BinaryRequest): BinaryResponse {
  if (req.kind !== 'parse-struct') {
    return {
      id: 'id' in req ? req.id : 0,
      ok: false,
      error: `binary.worker 不支持的单发任务类型: ${req.kind}`
    };
  }
  try {
    const { root, truncated } = parseStruct(req.head, {
      budgetMs: req.budgetMs,
      tail: req.tail,
      totalSize: req.totalSize
    });
    return { id: req.id, ok: true, root, truncated };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Worker 上下文（真实 Worker/self 环境） */
interface WorkerCtx {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: BinaryWorkerMessage) => void;
}

export interface ServeBinaryWorkerOptions {
  /** 搜索块大小（测试注入小值驱动多块路径）；默认 1MB */
  chunkSize?: number;
  /** 搜索命中上限（测试注入小值驱动截断路径）；默认 1000 */
  maxHits?: number;
}

/** 单个搜索任务：分块扫描 + 逐块 progress，id 失效（isCurrent false）即停不发 done */
async function runSearch(
  ctx: WorkerCtx,
  req: SearchRequest,
  isCurrent: () => boolean,
  opts: ServeBinaryWorkerOptions
): Promise<void> {
  try {
    const res = await scanAll(req.data, req.needle, {
      chunkSize: opts.chunkSize,
      maxHits: opts.maxHits,
      fold: req.caseInsensitive === true,
      shouldContinue: isCurrent,
      onChunk: (info) => {
        ctx.postMessage({
          id: req.id,
          type: 'search-progress',
          scanned: info.scanned,
          total: info.total,
          hits: info.hits,
          offsets: info.offsets
        });
      }
    });
    if (res.aborted || !isCurrent()) return; // 搜索 id 失效即停
    ctx.postMessage({ id: req.id, type: 'search-done', truncated: res.truncated });
  } catch (e) {
    if (isCurrent()) {
      ctx.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Worker 消息循环（Worker 与测试共用）：块间让出使取消/新搜索即时生效 */
export function serveBinaryWorker(ctx: WorkerCtx, opts: ServeBinaryWorkerOptions = {}): void {
  let activeSearchId = 0;
  ctx.onmessage = (ev: MessageEvent) => {
    const req = ev.data as BinaryRequest;
    if (req.kind === 'search-cancel') {
      activeSearchId = 0; // 失效当前搜索：块边界停扫、不发 done
      return;
    }
    if (req.kind === 'search') {
      const id = req.id;
      activeSearchId = id; // 新搜索自动失效旧任务
      void runSearch(ctx, req, () => activeSearchId === id, opts);
      return;
    }
    ctx.postMessage(handleRequest(req));
  };
}

const selfCtx = (globalThis as { self?: WorkerCtx }).self ?? null;
if (selfCtx) serveBinaryWorker(selfCtx);
