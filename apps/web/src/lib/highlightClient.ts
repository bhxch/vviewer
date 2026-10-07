import { browser } from '$app/environment';
import { HighlightClient, HighlightCanceledError } from '@vviewer/highlight';
import { attachHighlightClient, type CodeHighlightClient, type HighlightCallContext } from '@vviewer/render-text';
import {
  createComputeRouter,
  decodeHighlightResponse,
  encodeCanceled,
  highlightRemoteEligible,
  type ComputeRouter,
  type ComputeSource,
  type HighlightInterval
} from '@vviewer/core';
import { resolveHighlightResult } from './computeResult';
import { loadCapabilities, loadLastServer } from './openFlow.svelte';
import { loadSettings } from './stores/settings';

/**
 * 应用级 HighlightClient 单例：随首个调用方惰性创建（viewer.ts 启动时预热），
 * 注入 render-text 的 codeRenderer；tab 切换经 cancelHighlight() 取消未完成请求。
 * 失败（如 manifest 加载失败）保持 rejected，不重试——渲染端自行降级 hljs。
 *
 * M6：注入前经 compute router 路由——远程 store 文件（有服务端 path 语义）在
 * auto/remote 策略且服务器宣告 compute 能力时走 POST /api/compute/highlight，
 * 其余走本地 tree-sitter worker；结果统一带执行位置回调（状态栏指示）。
 * 注入语言路由：auto 下 INJECTION_LANGS（服务端带 injections.scm 的语言）不装配
 * remoteFn——服务端 v1 无 injection，本地高亮保注入完整；显式 remote 仍远程。
 */

let clientPromise: Promise<HighlightClient> | null = null;

/** 在途远程高亮的中止控制器（cancelHighlight 随 tab 切换一并 abort，不等无主响应）。 */
let remoteAbort: AbortController | null = null;

/** 惰性创建/获取单例；SSR 下返回 null（Worker 仅存在于浏览器端）。 */
export function ensureHighlightClient(): Promise<HighlightClient> | null {
  if (!browser) return null;
  if (!clientPromise) clientPromise = create();
  return clientPromise;
}

/** tab 切换时取消全部未完成高亮请求（client 尚未创建则无事可做）。 */
export function cancelHighlight(): void {
  remoteAbort?.abort(); // 在途远程高亮一并中止（router 按 remote 失败折叠，auto 回退本地）
  remoteAbort = null;
  if (!clientPromise) return;
  void clientPromise.then((c) => c.cancelAll()).catch(() => {});
}

/** E2E 观测用的最近一次高亮计时记录（__vv 前缀调试约定，生产无读取方）。 */
interface HighlightDebug {
  __vvHighlightClient?: HighlightClient;
  __vvLastHighlightMs?: number;
  __vvLastHighlightLang?: string;
  __vvLastHighlightOk?: boolean;
}

/** 应用侧 compute 路由单例：能力/策略/远程端点实时读取（连接与设置变化即时生效）。
 * M7 起同时供 viewer.ts 的 markdown 后端注入使用（highlight/markdown 共用同一裁决）。 */
export const computeRouter: ComputeRouter = createComputeRouter({
  hasCompute: () => loadCapabilities().includes('compute'),
  policy: () => loadSettings().computePolicy,
  remote: {
    base: () => loadLastServer()?.baseUrl ?? null,
    token: () => loadLastServer()?.token ?? null
  }
});

/**
 * 远程高亮：POST /api/compute/highlight（Bearer），body {path, lang}。
 * 响应为紧凑编码 {intervals: [[s,e,ci]...], captures: [name...]}，
 * 经 decodeHighlightResponse 展开为 HighlightInterval[]。
 * 未连接服务器或无服务端 path 抛错——router 的 auto 会回退本地，
 * remote 策略如实报错（不静默回退）。
 */
async function remoteHighlight(
  src: ComputeSource,
  lang: string
): Promise<HighlightInterval[]> {
  const call = computeRouter.remoteCall('/api/compute/highlight');
  if (!call) throw new Error('未连接服务器，无法远程高亮');
  if (!src.path) throw new Error('远程高亮需要文件的服务端 path');
  // 挂 tab 级 abort：cancelHighlight（tab 切换）时中止在途请求，不留无主连接
  const ac = new AbortController();
  remoteAbort = ac;
  try {
    const res = await fetch(call.url, {
      method: 'POST',
      headers: { ...call.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: src.path, lang }),
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`远程高亮失败: HTTP ${res.status}`);
    return decodeHighlightResponse(await res.json());
  } finally {
    if (remoteAbort === ac) remoteAbort = null;
  }
}

/**
 * 给注入渲染端的 client 包一层计时 + compute 路由：highlight 先问 router
 * （本地 tree-sitter worker vs 远程端点），完成后把耗时与执行位置写入
 * window.__vvLastHighlight*（E2E 性能断言读它）。
 * 原始实例经 window.__vvHighlightClient 暴露（E2E 语言可用性探测用）。
 */
function withDebug(client: HighlightClient): CodeHighlightClient {
  const dbg = window as unknown as HighlightDebug;
  return {
    highlight(text, lang, ctx?: HighlightCallContext) {
      const t0 = performance.now();
      const record = (ok: boolean): void => {
        dbg.__vvLastHighlightMs = performance.now() - t0;
        dbg.__vvLastHighlightLang = lang;
        dbg.__vvLastHighlightOk = ok;
      };
      const src = ctx?.src;
      const policy = loadSettings().computePolicy;
      // 装配 remoteFn 即"本调用尝试过远程"（policy 非 local 且 auto 下非注入语言）；
      // auto 回退本地时 where 为 local，据此在状态栏之外补一条 console.warn 留痕
      const remoteAttempted =
        !!src && policy !== 'local' && highlightRemoteEligible(policy, lang);
      // runRouted 从不 reject（失败折叠为 ok:false），onFulfilled 内统一回调；
      // 结果身份收敛进 resolveHighlightResult：取消重建 HighlightCanceledError
      //（render-text 以该类型静默丢弃），显式 remote 失败抛 RemoteComputeError
      //（render-text 以该类型显示错误卡，不降级 hljs）。
      return computeRouter
        .routeHighlight(
          src ? { ...src, text } : { text },
          lang,
          () =>
            client.highlight(text, lang).catch((err: unknown) => {
              if (err instanceof Error && err.name === 'HighlightCanceled') throw encodeCanceled(err);
              throw err;
            }),
          // 注入语言路由（INJECTION_LANGS）：auto 下服务端 v1 无 injection，
          // 远程高亮会丢注入区间——不装配 remoteFn 留在本地；显式 remote 仍远程。
          remoteAttempted ? (s, l) => remoteHighlight(s, l) : undefined
        )
        .then((res) => {
          ctx?.onWhere?.(res.where);
          record(res.ok);
          if (remoteAttempted && res.where === 'local') {
            // auto 回退：远程失败已由 router 折叠，本地高亮兜住可用性；
            // 状态栏 where 已回 local，这里补可观测痕迹（one-off 提示最小实现）
            console.warn(`[vviewer] 远程高亮失败，已回退本地高亮：${res.error ?? '未知原因'}`);
          }
          return resolveHighlightResult(res);
        });
    }
  };
}

async function create(): Promise<HighlightClient> {
  const res = await fetch('/grammars/manifest.json');
  if (!res.ok) throw new Error(`grammar manifest 加载失败: HTTP ${res.status}`);
  const manifest = (await res.json()) as {
    grammars: Record<string, { file: string; aliases?: string[] }>;
  };
  const worker = new Worker(new URL('./ts-worker.ts', import.meta.url), { type: 'module' });
  const client = new HighlightClient(worker, {
    grammars: manifest.grammars,
    grammarsBase: '/grammars/',
    queriesBase: '/queries/', // vite 启动时从 packages/highlight/assets/queries 拷贝到 static/queries
    runtimeDir: '/' // web-tree-sitter runtime 位于 static/tree-sitter.wasm
  });
  attachHighlightClient(withDebug(client));
  return client;
}
