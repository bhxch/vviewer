import { TreeSitterEngine, type GrammarTable } from './core-parse';
import type { QueryFile } from './queries';
import type { HighlightRequest, HighlightResponse } from './types';

/** Worker 初始化参数：核心引擎的全部配置（Node 传目录路径，浏览器可传虚拟映射/清单）。 */
export interface WorkerInit {
  queriesDir?: string;
  queries?: Record<string, QueryFile>;
  grammarsDir?: string;
  grammars?: GrammarTable;
  grammarsBase?: string;
  runtimeDir?: string;
  maxInjectionDepth?: number;
}

/** 请求处理器：HighlightRequest → HighlightResponse（engine 固定 'tree-sitter'）。 */
export type RequestHandler = (req: HighlightRequest) => Promise<HighlightResponse>;

/** 由引擎配置构造请求处理器（Worker 与测试共用）。 */
export async function createHandler(engine: TreeSitterEngine): Promise<RequestHandler> {
  return async (req) => {
    const r = await engine.highlight(req.text, req.lang, req.injectionsDepth ?? 0);
    return r.ok
      ? { id: req.id, ok: true, intervals: r.intervals, engine: 'tree-sitter' }
      : { id: req.id, ok: false, error: r.error, engine: 'tree-sitter' };
  };
}

/** 创建引擎并返回请求处理器。 */
export async function initWorker(init: WorkerInit): Promise<RequestHandler> {
  const engine = await TreeSitterEngine.create(init);
  return createHandler(engine);
}

/** Worker 上下文（仅真实 Worker/jsdom 环境存在 self）。 */
type WorkerCtx = {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: HighlightResponse) => void;
};

function workerCtx(): WorkerCtx | null {
  return (globalThis as { self?: WorkerCtx }).self ?? null;
}

function inWorker(): boolean {
  // jsdom/Node 下没有 WorkerGlobalScope，不会误绑 onmessage
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
}

/** 真实 Worker 环境：首条消息 `{ kind: 'init', ...WorkerInit }`，后续消息为 HighlightRequest。 */
export function serveWorker(): void {
  const ctx = workerCtx();
  if (!ctx) return;
  let handler: Promise<RequestHandler> | null = null;
  ctx.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { kind?: string } & HighlightRequest & WorkerInit;
    if (data.kind === 'init') {
      handler = initWorker(data);
      return;
    }
    const req = data as HighlightRequest;
    (handler ?? Promise.reject(new Error('worker 未初始化（缺少 init 消息）')))
      .then((h) => h(req))
      .then((res) => ctx.postMessage(res))
      .catch((e: unknown) =>
        ctx.postMessage({
          id: req.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          engine: 'tree-sitter',
        }),
      );
  };
}

if (inWorker()) serveWorker();
