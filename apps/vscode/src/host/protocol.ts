// protocol.ts — host ↔ webview 消息协议（spec H T2）。
//
// 纯 .ts 模块：**零 `vscode` import**（`import * as vscode from 'vscode'` 在运行时不存在，
// vitest 直解析会红——评审订正⑧同款纪律）→ 可被单测直测形状与判别。
//
// 方向约定：
// - HostToWebview：host → webview（init / 设置 / 主题 / 按路径读文件的结果 / 导出结果）
// - WebviewToHost：webview → host（就绪 / 按路径读文件 / 导出 HTML / 打开外链 / 报告）
//
// id 纪律：`read-file` 与 `export-html` 的请求 id 由 host 侧单调递增分配（`createRequestIdFactory`），
// 响应按 id 配对——webview 无 console 出口（webview console 不回传 host），故一切异常
// 反馈走 `report` 通道。
import type { GrammarTable } from '@bhxch/vviewer-highlight';

/** 扩展设置面（归一后的形态——脏值回落缺省，见 settings.ts） */
export interface WebviewSettings {
  /** toc 面板停靠侧 */
  tocSide: 'left' | 'right';
  /** toc 面板默认收起 */
  tocDefaultCollapsed: boolean;
  /** 高亮引擎档位 */
  highlightEngine: 'tree-sitter' | 'hljs' | 'plain';
  /** 图表渲染模式（'off' = 落源码块） */
  diagramMode: 'local' | 'kroki' | 'off';
  /** 是否允许外联图表服务（默认 false——零外网 CDN 依赖） */
  allowRemoteServices: boolean;
  /** 外链图片策略 */
  externalImages: 'blocked' | 'manual' | 'auto';
  /** 外链图片白名单（trim + 去空 + 小写） */
  externalImageAllowlist: string[];
}

/** 设置缺省值（spec §4.5 与计划 Global Constraints 一致） */
export const DEFAULT_WEBVIEW_SETTINGS: WebviewSettings = {
  tocSide: 'right',
  tocDefaultCollapsed: true,
  highlightEngine: 'tree-sitter',
  diagramMode: 'local',
  allowRemoteServices: false,
  externalImages: 'blocked',
  externalImageAllowlist: []
};

/**
 * 资产 URI 族（**全部为 `webview.asWebviewUri` 绝对 URL**——RF 5：三段资产基址与
 * 三个 worker URL 同族，不得混用相对路径）。
 *
 * 三个 worker 各有专名，**无悬空 `workerUrl` 字段**（Errata ⑦）：
 * - `highlightWorkerSourceUrl`：tree-sitter 高亮 worker 的**源**（webview 侧 fetch 后转
 *   blob worker——worker bundle 必须 IIFE 自包含，无 import）
 * - `binaryWorkerUrl`：hex 解析 worker
 * - `pdfWorkerModernUrl` / `pdfWorkerLegacyUrl`：pdfjs worker 双分支（**选支在 webview
 *   侧**按 `preferModernBuild()` 能力判定——host 不引 pdfjs，避免把 pdfjs 打进 host bundle）
 */
export interface AssetUris {
  /** grammar wasm 目录基址（尾斜杠） */
  grammarsBase: string;
  /** queries 目录基址（尾斜杠——`fetch(`${dir}/${name}`)` 语义，core-parse.ts:484） */
  queriesBase: string;
  /** tree-sitter runtime wasm 所在目录基址（尾斜杠——`joinPath(runtimeDir, 'tree-sitter.wasm')`） */
  runtimeDir: string;
  /** grammar 清单（manifest 的 grammars 键集） */
  grammars: GrammarTable;
  /** hex 解析 worker URL */
  binaryWorkerUrl: string;
  /** pdfjs worker（现代构建）URL */
  pdfWorkerModernUrl: string;
  /** pdfjs worker（legacy 构建）URL */
  pdfWorkerLegacyUrl: string;
  /** katex 字体目录基址（尾斜杠） */
  fontsBase: string;
  /** katex 排印样式 URL */
  katexCssUrl: string;
  /**
   * **自包含** katex 导出样式 URL（woff2 字体已转 data URI 内联、woff/ttf 回退段已
   * 移除）——导出单文件无相对资产可引，字体必须内联（构建期产物）。
   */
  katexExportCssUrl: string;
  /**
   * 打包主题表 URL（裁剪为 onelight + serika-dark 两条）——webview 侧按活动主题 kind
   * 取一条，经 `themeToCssVars` 算出 `--vv-ts-*` 捕获色（裁量 4：MVP 按 kind 注入，
   * 读 VSCode 活动主题 JSON 精确注入列为增强）。
   */
  themesUrl: string;
  /** tree-sitter 高亮 worker 源 URL（blob worker 源） */
  highlightWorkerSourceUrl: string;
}

/** 主题载荷（kind + `--ui-*` 令牌快照） */
export interface ThemePayload {
  kind: 'dark' | 'light';
  cssVars: Record<string, string>;
}

/**
 * 大文件上限（200MB）——对齐 web 端 `PLAIN_MAX_BYTES`
 * （packages/vviewer-render-text/src/code/strategy.ts:92）。
 *
 * 放在协议模块（host 与 webview 共用）：host 侧据此**不读**超限文件，webview 侧据
 * `doc.size` 与同一阈值判定并显示引导占位——两侧同源，不各自硬编码。
 */
export const MAX_BYTES = 200 * 1024 * 1024;

/** host → webview */
export type HostToWebview =
  | {
      kind: 'init';
      doc: { name: string; path: string; size: number; bytes: Uint8Array; languageId?: string };
      theme: ThemePayload;
      settings: WebviewSettings;
      assets: AssetUris;
    }
  | { kind: 'settings'; settings: WebviewSettings }
  | { kind: 'theme'; theme: ThemePayload }
  | { kind: 'file-bytes'; id: number; bytes: Uint8Array | null; error?: string }
  | { kind: 'export-request' }
  | { kind: 'export-result'; id: number; ok: boolean; path?: string; error?: string };

/** webview → host */
export type WebviewToHost =
  | { kind: 'ready' }
  | { kind: 'read-file'; id: number; path: string }
  | { kind: 'export-html'; id: number; html: string; suggestedName: string }
  | { kind: 'open-external'; url: string }
  /** 相对链接导航（spec §7 ①）：请求宿主把当前文档切到该相对路径 */
  | { kind: 'navigate'; path: string }
  | { kind: 'report'; level: 'warn' | 'error'; message: string };

/** host → webview 的消息 kind 全集（穷举面——新增 kind 须同步） */
export const HOST_TO_WEBVIEW_KINDS = [
  'init',
  'settings',
  'theme',
  'file-bytes',
  'export-request',
  'export-result'
] as const;

/** webview → host 的消息 kind 全集（穷举面——新增 kind 须同步） */
export const WEBVIEW_TO_HOST_KINDS = [
  'ready',
  'read-file',
  'export-html',
  'open-external',
  'navigate',
  'report'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 判别：是否为 host → webview 消息（kind 穷举） */
export function isHostToWebview(message: unknown): message is HostToWebview {
  if (!isRecord(message)) return false;
  const kind = message['kind'];
  return typeof kind === 'string' && (HOST_TO_WEBVIEW_KINDS as readonly string[]).includes(kind);
}

/** 判别：是否为 webview → host 消息（kind 穷举） */
export function isWebviewToHost(message: unknown): message is WebviewToHost {
  if (!isRecord(message)) return false;
  const kind = message['kind'];
  return typeof kind === 'string' && (WEBVIEW_TO_HOST_KINDS as readonly string[]).includes(kind);
}

/**
 * 请求 id 分配器（单调递增，从 1 起）——`read-file` / `export-html` 的请求与响应按 id 配对。
 * 每个 host 会话一个实例（避免跨会话 id 撞号）。
 */
export function createRequestIdFactory(): () => number {
  let next = 1;
  return () => next++;
}
