import { browser } from '$app/environment';
import { HighlightClient } from '@vviewer/highlight';
import { attachHighlightClient, type CodeHighlightClient, type HighlightCallContext } from '@vviewer/render-text';
import { createComputeRouter, type ComputeRouter, type ComputeSource, type HighlightInterval } from '@vviewer/core';
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
 */

let clientPromise: Promise<HighlightClient> | null = null;

/** 惰性创建/获取单例；SSR 下返回 null（Worker 仅存在于浏览器端）。 */
export function ensureHighlightClient(): Promise<HighlightClient> | null {
  if (!browser) return null;
  if (!clientPromise) clientPromise = create();
  return clientPromise;
}

/** tab 切换时取消全部未完成高亮请求（client 尚未创建则无事可做）。 */
export function cancelHighlight(): void {
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

/** 应用侧 compute 路由单例：能力/策略/远程端点实时读取（连接与设置变化即时生效）。 */
const computeRouter: ComputeRouter = createComputeRouter({
  hasCompute: () => loadCapabilities().includes('compute'),
  policy: () => loadSettings().computePolicy,
  remote: {
    base: () => loadLastServer()?.baseUrl ?? null,
    token: () => loadLastServer()?.token ?? null
  }
});

/**
 * 远程高亮：POST /api/compute/highlight（Bearer），响应 { intervals }。
 * 未连接服务器（无 base）抛错——router 的 auto 会回退本地，remote 策略如实报错。
 * （服务端 highlight 端点在 M6 后续任务实现；本批该请求 404 时 auto 回退本地。）
 */
async function remoteHighlight(
  src: ComputeSource,
  lang: string
): Promise<HighlightInterval[]> {
  const call = computeRouter.remoteCall('/api/compute/highlight');
  if (!call) throw new Error('未连接服务器，无法远程高亮');
  const res = await fetch(call.url, {
    method: 'POST',
    headers: { ...call.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ src: { path: src.path, storeId: src.storeId }, lang })
  });
  if (!res.ok) throw new Error(`远程高亮失败: HTTP ${res.status}`);
  const body = (await res.json()) as { intervals?: unknown };
  if (!Array.isArray(body.intervals)) throw new Error('远程高亮响应缺少 intervals');
  return body.intervals as HighlightInterval[];
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
      // runRouted 从不 reject（失败折叠为 ok:false），onFulfilled 内统一回调
      return computeRouter
        .routeHighlight(
          src ? { ...src, text } : { text },
          lang,
          () => client.highlight(text, lang),
          src ? (s, l) => remoteHighlight(s, l) : undefined
        )
        .then((res) => {
          ctx?.onWhere?.(res.where);
          record(res.ok);
          if (res.ok && res.data) return res.data;
          throw new Error(res.error ?? '高亮失败');
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
