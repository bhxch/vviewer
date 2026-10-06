import { browser } from '$app/environment';
import { HighlightClient } from '@vviewer/highlight';
import { attachHighlightClient } from '@vviewer/render-text';

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
  attachHighlightClient(client);
  return client;
}
