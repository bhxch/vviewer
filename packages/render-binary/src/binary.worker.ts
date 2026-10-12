// binary.worker.ts — 二进制解析 Worker 薄壳（模式同 highlight：核心纯函数 + serve + 类型共享）。
// 大 buffer 的结构解析不占主线程；handleRequest 为纯函数，jsdom 单测直调。
// Task 2：增 search 任务——分块扫描（searchScan），逐块 progress 流式回报，
// 累计 1000 截断，搜索 id 失效（新搜索/显式取消）即停且不发 done。
// Task 6（io-streaming）：search 增窗口形态——请求无 data 改带 size，worker 以
// search-need（1MB 步进、末块钳制）驱动主线程经 search-chunk 逐块供数，scanChunk
// 语义（overlap 去重/块内判停/进度/maxHits/cancel 失效）与 data 全量模式一致；
// data 旧协议照常服务（向后兼容）。
import { parseStruct, type ParseResult } from './struct';
import { scanAll, scanChunk, foldBytes, SEARCH_CHUNK_BYTES, SEARCH_MAX_HITS } from './searchScan';

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
  /** 搜索数据集（worker 侧持有独立副本；全量模式） */
  data: Uint8Array;
  needle: Uint8Array;
  /** 大小写不敏感（文本搜索；ASCII 折叠） */
  caseInsensitive?: boolean;
}

/**
 * 窗口模式搜索请求（io-streaming Task 6，spec §4.1 搜索）：无 data——worker 以
 * search-need（chunkSize 步进、末块钳制到 size）驱动主线程经 search-chunk 逐块
 * 供数，分块扫描语义与 data 全量模式一致。超大文件不再整件驻留主线程。
 */
export interface SearchWindowRequest {
  id: number;
  kind: 'search';
  /** 文件总字节数（need 末块钳制的事实来源） */
  size: number;
  needle: Uint8Array;
  /** 大小写不敏感（文本搜索；ASCII 折叠） */
  caseInsensitive?: boolean;
}

export interface SearchCancelRequest {
  id: number;
  kind: 'search-cancel';
}

/**
 * 主线程 → worker 的窗口搜索块回灌（Task 6 need/chunk 握手的数据供给）：字节对应
 * search-need 的 [start, end) 区间（start 一致、足额；client 侧已做钳制/abort）。
 */
export interface SearchChunkRequest {
  id: number;
  type: 'search-chunk';
  /** 本块起始绝对偏移（与对应 search-need.start 一致） */
  start: number;
  /** 块字节（长度 = need.end - need.start） */
  bytes: Uint8Array;
}

export type BinaryRequest = ParseStructRequest | SearchRequest | SearchWindowRequest | SearchCancelRequest;

/** worker 入站消息（任务请求 + 窗口搜索块回灌） */
export type BinaryWorkerInput = BinaryRequest | SearchChunkRequest;

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

/** worker → 主线程的窗口搜索数据需求（Task 6）：[start, end) 区间（end 不含），end 已钳制到 size */
export interface SearchNeedMessage {
  id: number;
  type: 'search-need';
  start: number;
  end: number;
}

export type BinaryResponse = ParseStructResponse | ErrorResponse;
export type SearchResponse = SearchProgressMessage | SearchDoneMessage | SearchNeedMessage;
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

/** data 全量模式搜索任务：分块扫描 + 逐块 progress，id 失效（isCurrent false）即停不发 done。
 * 窗口模式不经过本函数（serveBinaryWorker 内的 need/chunk 状态机消息驱动） */
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

/** 窗口搜索任务状态（Task 6 need/chunk 握手状态机；分块参数与 scanAll 同构） */
interface WindowSearchState {
  id: number;
  /** 已按 caseInsensitive 折叠的 needle */
  needle: Uint8Array;
  size: number;
  /** 块大小（≥ needle.length，保证 overlap 去重语义成立） */
  chunkSize: number;
  /** overlap = needle.length - 1（跨块命中去重回借字节数） */
  overlap: number;
  maxHits: number;
  /** 下一 need 区间起点（= 已供给区域末尾） */
  nextStart: number;
  /** 累计命中（绝对 offset，升序） */
  offsets: number[];
  /** 前块窗口尾部 overlap 字节（原始未折叠；供下块组窗去重；首块为空） */
  tail: Uint8Array;
  fold: boolean;
}

/** 拼接两段字节（窗口组窗：前块尾 overlap + 新块；新分配，不共享底层缓冲） */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Worker 消息循环（Worker 与测试共用）：data 全量模式块间让出使取消/新搜索即时
 * 生效；窗口模式（Task 6）为消息驱动的 need/chunk 状态机——每个消息边界（cancel/
 * 新请求/块回灌）天然即时生效 */
export function serveBinaryWorker(ctx: WorkerCtx, opts: ServeBinaryWorkerOptions = {}): void {
  let activeSearchId = 0;
  let winSearch: WindowSearchState | null = null;

  /** 发下一条数据需求：[nextStart, nextStart + chunkSize)（末块钳制到 size） */
  const postNeed = (s: WindowSearchState): void => {
    ctx.postMessage({
      id: s.id,
      type: 'search-need',
      start: s.nextStart,
      end: Math.min(s.nextStart + s.chunkSize, s.size)
    });
  };

  /** 窗口任务收尾：清状态并发 done（truncated = 累计命中达 maxHits 提前终止） */
  const finishWindowSearch = (s: WindowSearchState, truncated: boolean): void => {
    winSearch = null;
    ctx.postMessage({ id: s.id, type: 'search-done', truncated });
  };

  /** 窗口块扫描（searchScan 既有语义）：组窗（前块尾 overlap + 本块）→ scanChunk
   * （overlap 去重、块内 maxHits 配额即时判停）→ progress → 截断/末块 done，否则
   * 续发 need。区间错位/空块属协议违约：宁败勿静默挂起（错误响应使 client 以已
   * 累计命中收尾，同 worker 崩溃语义） */
  const onWindowChunk = (s: WindowSearchState, msg: SearchChunkRequest): void => {
    if (msg.start !== s.nextStart || msg.bytes.length === 0) {
      winSearch = null;
      ctx.postMessage({
        id: s.id,
        ok: false,
        error: `search-chunk 协议违约: start ${msg.start}（期望 ${s.nextStart}）、${msg.bytes.length} 字节`
      });
      return;
    }
    const rawWin = concatBytes(s.tail, msg.bytes);
    const winStart = s.nextStart - s.tail.length;
    const win = s.fold ? foldBytes(rawWin) : rawWin;
    // 块内即时判停：传剩余配额（maxHits - 已收），累计恰好封顶（同 scanAll）
    const hits = scanChunk(win, s.needle, winStart, s.tail.length, s.maxHits - s.offsets.length);
    for (const h of hits) s.offsets.push(h);
    s.nextStart = msg.start + msg.bytes.length;
    s.tail = rawWin.subarray(Math.max(0, rawWin.length - s.overlap));
    ctx.postMessage({
      id: s.id,
      type: 'search-progress',
      scanned: s.nextStart,
      total: s.size,
      hits: hits.length,
      offsets: hits.slice()
    });
    if (s.offsets.length >= s.maxHits) {
      finishWindowSearch(s, true);
      return;
    }
    if (s.nextStart >= s.size) {
      finishWindowSearch(s, false);
      return;
    }
    postNeed(s);
  };

  ctx.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as BinaryWorkerInput;
    if ('type' in msg) {
      // 窗口搜索块回灌：id 失效（取消/被新搜索取代）的迟到块一律丢弃
      if (winSearch !== null && winSearch.id === msg.id && activeSearchId === msg.id) {
        onWindowChunk(winSearch, msg);
      }
      return;
    }
    const req = msg;
    if (req.kind === 'search-cancel') {
      activeSearchId = 0; // 失效当前搜索：块边界停扫/不再发 need、不发 done
      winSearch = null;
      return;
    }
    if (req.kind === 'search') {
      const id = req.id;
      activeSearchId = id; // 新搜索自动失效旧任务（data/窗口两形态一致）
      winSearch = null;
      if (!('data' in req)) {
        // 窗口模式（Task 6）：进入 need/chunk 握手。空 needle/空文件同 scanAll
        // 直接 done；否则发首条 need 开始逐块供数
        const pin = req.caseInsensitive === true ? foldBytes(req.needle) : req.needle;
        if (pin.length === 0 || req.size <= 0) {
          ctx.postMessage({ id, type: 'search-done', truncated: false });
          return;
        }
        const state: WindowSearchState = {
          id,
          needle: pin,
          size: req.size,
          chunkSize: Math.max(1, opts.chunkSize ?? SEARCH_CHUNK_BYTES, pin.length),
          overlap: pin.length - 1,
          maxHits: Math.max(1, opts.maxHits ?? SEARCH_MAX_HITS),
          nextStart: 0,
          offsets: [],
          tail: new Uint8Array(0),
          fold: req.caseInsensitive === true
        };
        winSearch = state;
        postNeed(state);
        return;
      }
      void runSearch(ctx, req, () => activeSearchId === id, opts);
      return;
    }
    ctx.postMessage(handleRequest(req));
  };
}

const selfCtx = (globalThis as { self?: WorkerCtx }).self ?? null;
if (selfCtx) serveBinaryWorker(selfCtx);
