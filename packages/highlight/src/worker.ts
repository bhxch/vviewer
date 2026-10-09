import { TreeSitterEngine, type GrammarTable } from './core-parse';
import type { QueryFile } from './queries';
import type { HighlightRequest, HighlightResponse } from './types';

/** Worker 初始化参数：核心引擎的全部配置（Node 传目录路径，浏览器可传 fetch 基础路径/虚拟映射/清单）。 */
export interface WorkerInit {
  queriesDir?: string;
  queries?: Record<string, QueryFile>;
  queriesBase?: string;
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
    const r = await engine.highlight(req.text, req.lang, req.injectionsDepth ?? 0, req.chunk);
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

/** client → worker 的首条握手消息（与 serveWorker 协议对齐）。 */
export interface InitMessage extends WorkerInit {
  kind: 'init';
}

function workerCtx(): WorkerCtx | null {
  return (globalThis as { self?: WorkerCtx }).self ?? null;
}

function inWorker(): boolean {
  // jsdom/Node 下没有 WorkerGlobalScope，不会误绑 onmessage
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
}

/**
 * 真实 Worker 环境：首条消息为 `{ kind: 'init', ...WorkerInit }`（HighlightClient 构造时发送），
 * 后续消息为 HighlightRequest。init 先于请求处理；请求先于 init 到达时排队，init 完成后按序派发。
 */
export function serveWorker(): void {
  const ctx = workerCtx();
  if (!ctx) return;
  let handler: Promise<RequestHandler> | null = null;
  const queued: HighlightRequest[] = [];

  const postError = (req: HighlightRequest, e: unknown): void => {
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      engine: 'tree-sitter',
    });
  };
  const dispatch = async (req: HighlightRequest, h: RequestHandler): Promise<void> => {
    try {
      ctx.postMessage(await h(req));
    } catch (e) {
      postError(req, e);
    }
  };

  ctx.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { kind?: string } & HighlightRequest & WorkerInit;
    if (data.kind === 'init') {
      if (handler) return; // 忽略重复 init
      handler = initWorker(data)
        .then((h) => {
          for (const req of queued.splice(0)) void dispatch(req, h);
          return h;
        })
        .catch((e: unknown) => {
          // BUG-06 可观测：init 失败首错升级 console.error——僵尸 worker 的静默性
          // 是「零 wasm 请求、零用户可见错误」报告现象的主要观测障碍；
          // 附资产排查提示（runtime/grammar wasm 404 或 MIME 不当为最常见成因）。
          console.error(
            '[vviewer] tree-sitter worker init 失败（排查 /tree-sitter.wasm、/grammars/*.wasm 是否 404/MIME 异常）:',
            e
          );
          // init 失败：排队请求逐个报错，后续请求同样失败
          for (const req of queued.splice(0)) postError(req, e);
          throw e;
        });
      // handler 保持 rejected 供后续请求走 postError 分支；此处 no-op 消费
      // 防止"init 失败且队列空"时 rejected promise 无消费者 → unhandledrejection
      void handler.catch(() => {});
      return;
    }
    const req = data as HighlightRequest;
    if (handler) void handler.then((h) => dispatch(req, h)).catch((e: unknown) => postError(req, e));
    else queued.push(req);
  };
}

if (inWorker()) serveWorker();
