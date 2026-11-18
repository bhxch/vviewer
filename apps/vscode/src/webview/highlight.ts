// highlight.ts — tree-sitter 离线高亮链路（spec H T4）。
//
// 链路：fetch(worker 源) → Blob → objectURL → **blob worker** → `HighlightClient`
// （包内 `packages/vviewer-highlight/src/client.ts`）→ 适配为 render-text 的
// `CodeHighlightClient` 鸭子面 → `attachHighlightClient` 注入 code 渲染器。
//
// blob worker 要点（RF 6）：
// - **worker bundle 必须 IIFE 自包含**（无 import）——blob worker 无模块解析面；
//   构建侧由 `apps/vscode/build.mjs` 的 worker 产物保证。
// - worker 源 URL 必须是 `asWebviewUri` 绝对 URL（blob worker 内一切相对资产 URL 失效）。
//
// 引擎档位（`vviewer.code.highlightEngine`）：'tree-sitter'（默认）｜'hljs'（不起 worker，
// 走渲染器内置 hljs 兜底）｜'plain'（纯文本，无着色）。
//
// 降级矩阵（RF 3：**可见**，不静默）：
// - worker 起活失败（fetch 非 2xx / Blob / Worker 构造抛错）→ hljs + 顶部提示条
// - worker 初始化看门狗超时（包内 `INIT_TIMEOUT_MS` 15s）→ hljs + 顶部提示条
// - 语言不在本地 grammar 清单 → 该语言落 hljs（清单感知门，apps/web 同款语义）
//
// **围栏桥不在此注入**：`setHighlightFence` 由 T3 的装配层统一注入（缝只注入一次——
// 重复注入即语义漂移）。本模块只做 client 适配与 attach。
import { HighlightClient } from '@bhxch/vviewer-highlight';
import {
  attachHighlightClient,
  type CodeHighlightClient,
  type HighlightCallContext
} from '@bhxch/vviewer-render-text';
import type { AssetUris, WebviewSettings } from '../host/protocol';
import { hasLocalGrammar, resolveAssetBases } from './assets';

/** 引擎档位 */
export type HighlightEngineTier = 'tree-sitter' | 'hljs' | 'plain';

/** 降级码（稳定标识符——非显示串；显示文案走 i18n 目录） */
export type DegradationCode = 'worker-failed' | 'init-timeout' | 'no-grammar';

/** 引擎态（可见面的唯一数据源） */
export interface EngineState {
  /** 当前生效的引擎 */
  engine: HighlightEngineTier;
  /** 是否降级（降级原因经可见面呈现，不静默） */
  degraded: boolean;
  /** 降级码（稳定标识符） */
  code: DegradationCode | null;
  /** 降级细节（技术原因/语言名——运行时数据，非目录文案） */
  detail: string | null;
}

/** 档位裁决（纯函数——单点裁决，单测锁） */
export function resolveHighlightEngine(settings: WebviewSettings): HighlightEngineTier {
  const value = settings.highlightEngine;
  return value === 'hljs' || value === 'plain' ? value : 'tree-sitter';
}

/** 起活决策（纯函数） */
export interface EngineStartup {
  /** 是否需要起 worker */
  startWorker: boolean;
  /** 起活后的引擎态 */
  engine: HighlightEngineTier;
  degraded: boolean;
  code: DegradationCode | null;
}

/**
 * 起活决策：
 * - 'plain' / 'hljs' → **不起 worker**（省内存与启动时间）
 * - 'tree-sitter' + 起活失败 → 降级 'hljs'（可见）
 */
export function decideEngineStartup(
  requested: HighlightEngineTier,
  workerStartFailed = false
): EngineStartup {
  if (requested === 'plain') {
    return { startWorker: false, engine: 'plain', degraded: false, code: null };
  }
  if (requested === 'hljs') {
    return { startWorker: false, engine: 'hljs', degraded: false, code: null };
  }
  if (workerStartFailed) {
    return { startWorker: true, engine: 'hljs', degraded: true, code: 'worker-failed' };
  }
  return { startWorker: true, engine: 'tree-sitter', degraded: false, code: null };
}

/** 起活入参 */
export interface StartHighlightOptions {
  /** 资产 URI（worker 源 + 三段基址 + grammar 清单） */
  assets: AssetUris;
  /** 当前设置（引擎档位） */
  settings: WebviewSettings;
  /** 降级回调（可见面——顶部提示条 + toc 徽标） */
  onDegraded?: (state: EngineState) => void;
}

/** 高亮运行时 */
export interface HighlightRuntime {
  /** 注入渲染器的 client（null = 未起 worker——渲染器走 hljs/plain 兜底） */
  client: CodeHighlightClient | null;
  /** 引擎态 */
  state: EngineState;
  /** 释放（dispose client + 撤销 blob URL + 解绑 attach） */
  dispose(): void;
}

/**
 * 不起 worker 的运行时（plain / hljs 档位）。
 *
 * **必须显式 `attachHighlightClient(null)`**：render-text 的 attach 相位默认停在
 * `pending`，`waitForAttachedClient` 会等满默认超时（10s）才放行 null —— 逐个代码围栏
 * 各等一次（markdown 的 runHighlight 是串行 for 循环）→ hljs 档渲染含围栏的文档阻塞
 * 数十秒。解绑后相位落到 `failed` 终态 → 等待者立即放行 → 走 hljs 兜底（毫秒级）。
 */
function inertRuntime(engine: HighlightEngineTier): HighlightRuntime {
  attachHighlightClient(null);
  return {
    client: null,
    state: { engine, degraded: false, code: null, detail: null },
    dispose(): void {
      // 无 worker 可释放
    }
  };
}

/**
 * 起高亮运行时（worker 起活 + client 适配 + attach）。
 *
 * 失败面（RF 3）：起活失败 → `attachHighlightClient(null)`（放行渲染端等待者走 hljs
 * 兜底，不等超时）+ 降级回调（可见）+ 返回降级态。
 */
export async function startHighlightRuntime(options: StartHighlightOptions): Promise<HighlightRuntime> {
  const requested = resolveHighlightEngine(options.settings);
  const startup = decideEngineStartup(requested);
  if (!startup.startWorker) return inertRuntime(startup.engine);

  const bases = resolveAssetBases(options.assets);
  const table = options.assets.grammars;

  let worker: Worker;
  let blobUrl: string;
  try {
    const response = await fetch(options.assets.highlightWorkerSourceUrl);
    if (!response.ok) {
      // 技术诊断串（非目录文案）——英文，与仓内 console 英文化纪律同口径；
      // 用户可见的中文句式由 i18n 目录的降级文案承担（engineBadge.ts）
      throw new Error(`highlight worker source unreachable: HTTP ${response.status}`);
    }
    const source = await response.text();
    blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(blobUrl);
  } catch (e: unknown) {
    // 起活失败 → 放行等待者走 hljs 兜底（不等看门狗超时），并可见上报
    attachHighlightClient(null);
    const state: EngineState = {
      engine: 'hljs',
      degraded: true,
      code: 'worker-failed',
      detail: e instanceof Error ? e.message : String(e)
    };
    options.onDegraded?.(state);
    return {
      client: null,
      state,
      dispose(): void {
        // 无 worker 可释放
      }
    };
  }

  const client = new HighlightClient(
    worker,
    {
      grammars: table,
      grammarsBase: bases.grammarsBase,
      queriesBase: bases.queriesBase,
      runtimeDir: bases.runtimeDir
    },
    (reason: string) => {
      // worker 致命失败（脚本加载失败 / 消息反序列化失败 / 初始化看门狗超时 15s）
      // 区分看门狗超时与其它致命失败：包内 client.ts 的超时原因串以「超时」开头
      // （中文原文用 \u 转义形态保留——D8 审计纪律：非翻译数据值不入目录）。
      // 耦合说明：包内措辞若变更，本判定退化为 'worker-failed'——**降级结论不变**
      // （两者均落 hljs + 顶部提示条可见），仅提示语的分类标签变。
      const code: DegradationCode = reason.includes('\u8d85\u65f6') ? 'init-timeout' : 'worker-failed';
      const state: EngineState = { engine: 'hljs', degraded: true, code, detail: reason };
      options.onDegraded?.(state);
    }
  );

  const adapter: CodeHighlightClient = {
    highlight(text: string, lang: string, ctx?: HighlightCallContext) {
      return client.highlight(text, lang, ctx?.chunk ? { chunk: ctx.chunk } : undefined);
    },
    outline(text: string, lang: string) {
      return client.outline(text, lang);
    },
    cancelOutline(lang: string) {
      client.cancelOutline(lang);
    },
    /** 清单感知判定（缺省 fake 为 true——此处给真实清单） */
    hasLocalGrammar(lang: string) {
      return hasLocalGrammar(table, lang);
    }
  };
  attachHighlightClient(adapter);

  return {
    client: adapter,
    state: { engine: 'tree-sitter', degraded: false, code: null, detail: null },
    dispose(): void {
      attachHighlightClient(null);
      client.dispose();
      URL.revokeObjectURL(blobUrl);
    }
  };
}
