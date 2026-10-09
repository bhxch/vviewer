import { resolve } from '$app/paths';
import { browser } from '$app/env';

// kit 3 移除了 `$app/paths` 的 `base` 字符串导出：以 `resolve('/')` 求得
// 「<base>/」前缀（base='' 时为 '/'，子路径托管时为 '/<base>/'），静态资产
// URL（grammars/queries/runtime wasm）由它拼接，语义与 kit2 的 `${base}/...` 一致。
const baseUrl = resolve('/');
import { HighlightClient, HighlightCanceledError, type GrammarTable } from '@vviewer/highlight';
import { attachHighlightClient, type CodeHighlightClient, type HighlightCallContext } from '@vviewer/render-text';
import {
  createComputeRouter,
  decodeHighlightResponse,
  encodeCanceled,
  highlightRemoteEligible,
  remoteLanguageAdvertised,
  type ComputeRouter,
  type ComputeSource,
  type HighlightInterval
} from '@vviewer/core';
import { resolveHighlightResult } from './computeResult';
import { assembleGrammarLayers } from './grammarLayers';
import { loadCapabilities, loadComputeLanguages, loadLastServer } from './openFlow.svelte';
import { loadSettings } from './stores/settings';

/**
 * 应用级 HighlightClient 单例：随首个调用方惰性创建（viewer.ts 启动时预热），
 * 注入 render-text 的 codeRenderer；tab 切换经 cancelHighlight() 取消未完成请求。
 * 失败（如 worker 创建失败）保持 rejected，不重试——渲染端自行降级 hljs；
 * manifest 各层加载失败经 grammarLayers 跳层折叠，不再导致整体 rejected。
 *
 * M6：注入前经 compute router 路由——远程 store 文件（有服务端 path 语义）在
 * auto/remote 策略且服务器宣告 compute 能力时走 POST /api/compute/highlight，
 * 其余走本地 tree-sitter worker；结果统一带执行位置回调（状态栏指示）。
 * 注入语言路由：auto 下 INJECTION_LANGS（服务端带 injections.scm 的语言）不装配
 * remoteFn——服务端 v1 无 injection，本地高亮保注入完整；显式 remote 仍远程。
 *
 * P2 资产三层解析链（spec §3）：grammar manifest 按同源 → 服务端 → CDN 逐层
 * fetch 并 first-wins 合并（grammarLayers.ts），条目 base 标明 wasm 来源层。
 * 服务端层为连接时快照——create() 随首次调用只跑一次，会话中新连接的服务器
 * 不会进入资产链，需刷新页面生效（compute 路由则实时读取，与此不同）。
 */

let clientPromise: Promise<HighlightClient> | null = null;

/** 在途远程高亮的中止控制器（cancelHighlight 随 tab 切换一并 abort，不等无主响应）。 */
let remoteAbort: AbortController | null = null;

/** grammar manifest（create() 三层合并后缓存）：主线程预热 grammar wasm 查条目用（base 标来源层）。 */
let grammarManifest: GrammarTable | null = null;

/** 已预热资产 URL：同一资产仅首个调用触发预热（控制权交接前监听/定时器不随调用累积） */
const warmedUrls = new Set<string>();

/**
 * 主线程预热高亮 wasm 资产（BUG-06 离线闭环的主通道）：grammar/runtime wasm 由
 * worker 内 fetch，Chrome 对 module worker 的控制语义实测不经页面 SW（路由已注册、
 * 主线程 fetch 即建缓存，worker fetch 则绕过）——主线程 fetch 是资产进入
 * vv-grammars 与 vv-runtime 运行时 CacheFirst 缓存的唯一通道，离线重开依赖此缓存。
 * 按 URL 幂等（warmedUrls）：稳定期 controller 在位直接 fetch 命中 CacheFirst。
 * 等待条件是 controller 就位而非 ready：实测 ready（SW active）resolve 时
 * clientsClaim 的控制权尚未传播到本页（controller 仍 null），此刻 fetch 不经 SW；
 * controllerchange 后才真正受控。10s 兜底防 claim 缺失时永不预热（fetch 至多有
 * 浏览器 HTTP 缓存收益）。无 SW 注册时 ready 永挂，预热自然不执行。
 */
function warmHighlightAsset(url: string): void {
  if (!('serviceWorker' in navigator) || warmedUrls.has(url)) return;
  warmedUrls.add(url);
  void navigator.serviceWorker.ready
    .then(
      () =>
        new Promise<void>((resolve) => {
          if (navigator.serviceWorker.controller) return resolve();
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
          setTimeout(resolve, 10_000);
        })
    )
    .then(() => fetch(url))
    .catch(() => {});
}

/** 惰性创建/获取单例；SSR 下返回 null（Worker 仅存在于浏览器端）。 */
export function ensureHighlightClient(): Promise<HighlightClient> | null {
  if (!browser) return null;
  if (!clientPromise) {
    clientPromise = create().catch((e: unknown) => {
      // BUG-06 可观测：创建期失败（manifest 404 / new Worker 抛错）同样显式上报，
      // 不再零提示静默降级 hljs；rethrow 保持既有 rejected 语义（不重试）
      console.error(`[vviewer] tree-sitter worker 加载失败：${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
  }
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
      // 首次调用某语言时主线程预热其 grammar wasm（进 vv-grammars-* CacheFirst）；
      // warmHighlightAsset 按 URL 幂等，同语言重复调用为 no-op
      const g = grammarManifest?.[lang];
      if (g) warmHighlightAsset(`${g.base}grammars/${g.file}`);
      const record = (ok: boolean): void => {
        dbg.__vvLastHighlightMs = performance.now() - t0;
        dbg.__vvLastHighlightLang = lang;
        dbg.__vvLastHighlightOk = ok;
      };
      const src = ctx?.src;
      const policy = loadSettings().computePolicy;
      // 装配 remoteFn 即"本调用尝试过远程"（policy 非 local 且 auto 下非注入语言，
      // 且 BUG-06c：auto 下语言在服务端宣告集合内——集合未知（旧服务端）保持先试
      // 远程；显式 remote 是用户选择，不做集合门控，失败如实错误卡片不静默降级）；
      // auto 回退本地时 where 为 local，据此在状态栏之外补一条 console.warn 留痕
      const remoteAttempted =
        !!src &&
        policy !== 'local' &&
        highlightRemoteEligible(policy, lang) &&
        (policy === 'remote' || remoteLanguageAdvertised(lang, new Set(loadComputeLanguages())));
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
  // 三层资产解析链（spec §3）：同源 → 服务端（连接时快照，会话中新连接需刷新
  // 页面才进入资产链）→ CDN。各层失败跳层不阻塞；同名语言 first-wins 归更近层。
  // 环境变量经 vite define 静态替换，构建时定型。
  const cdnBase = (import.meta.env.VV_GRAMMAR_CDN as string | undefined) || null;
  const serverBase = loadLastServer()?.baseUrl ?? null;
  const { grammars } = await assembleGrammarLayers({
    sameOriginBase: `${baseUrl}grammars/`,
    serverBase,
    cdnBase
  });
  grammarManifest = grammars;
  const worker = new Worker(new URL('./ts-worker.ts', import.meta.url), { type: 'module' });
  const client = new HighlightClient(
    worker,
    {
      grammars,
      grammarsBase: `${baseUrl}grammars/`, // 第 1 层缺省 base；合并表每条已带 base，实际不再回落
      queriesBase: `${baseUrl}queries/`, // vite 启动时从 packages/highlight/assets/queries 拷贝到 static/queries
      // runtime 随 base：子路径托管（Pages）下 worker 内 Parser.init 按
      // locateFile(joinPath(runtimeDir, file)) 取 /<base>/tree-sitter.wasm，
      // 根绝对 '/' 在子路径下 404 → init 失败 → 全部高亮静默回退 hljs
      runtimeDir: baseUrl // web-tree-sitter runtime 位于 static/tree-sitter.wasm（base='' 时即 '/'）
    },
    // BUG-06 可观测：worker 脚本/消息错误经显式标签上报——此前该类失败零提示
    // 静默降级 hljs，是「本地 tree-sitter 全链失效却无任何痕迹」的主要观测障碍
    (reason) => {
      console.error(`[vviewer] tree-sitter worker 加载失败：${reason}`);
    }
  );
  attachHighlightClient(withDebug(client));
  // 预热 runtime wasm：同上，worker 内 fetch 不经 SW，主线程预热使其进 vv-runtime-*
  // CacheFirst（离线重开代码文件的 runtime 来源）
  warmHighlightAsset(`${baseUrl}tree-sitter.wasm`);
  return client;
}
