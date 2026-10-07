import { browser } from '$app/environment';
import { HighlightClient } from '@vviewer/highlight';
import { attachHighlightClient, type CodeHighlightClient } from '@vviewer/render-text';

/**
 * 应用级 HighlightClient 单例：随首个调用方惰性创建（viewer.ts 启动时预热），
 * 注入 render-text 的 codeRenderer；tab 切换经 cancelHighlight() 取消未完成请求。
 * 失败（如 manifest 加载失败）保持 rejected，不重试——渲染端自行降级 hljs。
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

/**
 * 给注入渲染端的 client 包一层计时：每次 highlight 完成（成功/失败）后把耗时
 * 写入 window.__vvLastHighlight*（E2E 性能断言读它；含 Worker 往返与解析全程）。
 * 原始实例经 window.__vvHighlightClient 暴露（E2E 语言可用性探测用）。
 */
function withDebug(client: HighlightClient): CodeHighlightClient {
  const dbg = window as unknown as HighlightDebug;
  dbg.__vvHighlightClient = client;
  return {
    highlight(text, lang) {
      const t0 = performance.now();
      const record = (ok: boolean): void => {
        dbg.__vvLastHighlightMs = performance.now() - t0;
        dbg.__vvLastHighlightLang = lang;
        dbg.__vvLastHighlightOk = ok;
      };
      return client.highlight(text, lang).then(
        (intervals) => {
          record(true);
          return intervals;
        },
        (err: unknown) => {
          record(false);
          throw err;
        }
      );
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
