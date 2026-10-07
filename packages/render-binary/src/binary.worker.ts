// binary.worker.ts — 二进制解析 Worker 薄壳（模式同 highlight：核心纯函数 + serve + 类型共享）。
// 大 buffer 的结构解析不占主线程；handleRequest 为纯函数，jsdom 单测直调。
import { parseStruct, type ParseResult } from './struct';

export interface ParseStructRequest {
  id: number;
  kind: 'parse-struct';
  head: Uint8Array;
  budgetMs?: number;
}

export type BinaryRequest = ParseStructRequest;

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

export type BinaryResponse = ParseStructResponse | ErrorResponse;

/** 请求处理器（Worker 与测试共用） */
export function handleRequest(req: BinaryRequest): BinaryResponse {
  try {
    const { root, truncated } = parseStruct(req.head, { budgetMs: req.budgetMs });
    return { id: req.id, ok: true, root, truncated };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Worker 上下文（真实 Worker/self 环境） */
interface WorkerCtx {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: BinaryResponse) => void;
}

export function serveBinaryWorker(ctx: WorkerCtx): void {
  ctx.onmessage = (ev: MessageEvent) => {
    ctx.postMessage(handleRequest(ev.data as BinaryRequest));
  };
}

const selfCtx = (globalThis as { self?: WorkerCtx }).self ?? null;
if (selfCtx) serveBinaryWorker(selfCtx);
