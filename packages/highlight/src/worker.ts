import { TreeSitterEngine, type EngineInitProgress, type GrammarTable } from './core-parse';
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

/** 创建引擎并返回请求处理器。onInitProgress（可选，Task 9 spike 取证面）为 init 阶段
 *  打点回调：仅 serveWorker 在 init 握手携带 debug 开关时以闭包注入——结构化克隆不可
 *  经消息携带函数，故回调不入 WorkerInit 契约。debug 注入时同时派生 onQueryLoaded
 *  （Task 4 细口径）：远程 query 资产逐文件 fetch 完成折算为一帧 query-loaded（detail=
 *  文件相对名），复用同一探针回调与帧类型——client 侧 init-progress 统一分流不变。
 *  缺省（无开关）两回调均不注入：engine 零打点，线上行为逐字节不变。 */
export async function initWorker(
  init: WorkerInit,
  onInitProgress?: (p: EngineInitProgress) => void
): Promise<RequestHandler> {
  const engine = await TreeSitterEngine.create(
    onInitProgress
      ? {
          ...init,
          onInitProgress,
          onQueryLoaded: (file: string) => onInitProgress({ stage: 'query-loaded', detail: file }),
        }
      : init
  );
  return createHandler(engine);
}

/** worker → client 的 init 阶段探针帧（Task 9 spike 取证面）：仅 init 握手携带 debug
 *  开关时出现，缺省（开关关闭）零出现。client 侧不计为存活证据（markWorkerAlive 不触发）。
 *  query 逐文件帧（query-loaded，Task 4 细口径）同型复用本帧：每份 query 资产 fetch 完成
 *  一帧、detail 为文件相对名，时序可在 ready 之后（首次高亮的惰性加载）。 */
export interface InitProgressFrame {
  kind: 'init-progress';
  stage: string;
  detail?: string;
}

/** Worker 上下文（仅真实 Worker/jsdom 环境存在 self）。 */
type WorkerCtx = {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: HighlightResponse | InitProgressFrame) => void;
};

/** client → worker 的首条握手消息（与 serveWorker 协议对齐）。 */
export interface InitMessage extends WorkerInit {
  kind: 'init';
  /** init 阶段探针开关（Task 9 spike）：true 时 serveWorker 注入进度回调，逐阶段回
   *  init-progress 帧。缺省省略该键——线上握手与既有协议逐字节一致。 */
  debug?: boolean;
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
    const data = ev.data as { kind?: string; debug?: boolean } & HighlightRequest & WorkerInit;
    if (data.kind === 'init') {
      if (handler) return; // 忽略重复 init
      // init-progress 探针（Task 9 spike 取证面）：data 解构为 init 配置与 debug 开关两份，
      // 进度回调以闭包注入 initWorker——结构化克隆不可经消息携带函数，onInitProgress
      // 不进 WorkerInit 契约。debug 未开（缺省）：不注入回调 → engine 零打点 → 零探针帧，
      // 行为与既有协议逐字节一致。
      const { debug, ...initConfig } = data;
      // 握手键显式剔除（deferred 卫生：非 _kind rest 剥离形态）——传入 initWorker
      // 的配置只含引擎配置，不含协议帧字段 kind/debug
      delete initConfig.kind;
      handler = initWorker(
        initConfig,
        debug
          ? (p) => {
              ctx.postMessage({
                kind: 'init-progress',
                stage: p.stage,
                ...(p.detail !== undefined ? { detail: p.detail } : {}),
              });
            }
          : undefined
      )
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
