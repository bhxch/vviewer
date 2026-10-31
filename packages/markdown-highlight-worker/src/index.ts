// index.ts — @vviewer/markdown-highlight-worker 主线程装配面。
// 组合三件已有公开件为零配置 worker 高亮：HighlightClient（协议端：init 握手/
// 看门狗/同语言请求去重/批量取消）+ 区间→行 HTML 纯函数 + @vviewer/markdown 的
// setHighlightFence 注入缝。worker 文件 src/worker.js（两行 serveWorker）由宿主
// 打包器编译（vite `?worker` / new Worker(new URL(...), { type: 'module' })）；
// attachMarkdownHighlightWorker 缺省自建 worker——同目录相对 URL 在源码态
// （src/main.ts → src/worker.js）与发布态（dist/main.js → dist/worker.js，
// pack copies 承载）解析到同一字面路径。
//
// 失败链与 @vviewer/markdown 包内默认高亮器一致：worker 失败/未知语言 → 该块
// 降级 hljs → 原文；取消（HighlightCanceledError）重抛 → 管线静默跳过该块、
// 不 hljs 兜底（结果即将随文档丢弃）。worker 起不来（CSP/环境）时走宿主自建
// worker（makeWorker 覆盖）或退回包内默认主线程高亮器（不 attach 即可）。
import {
  HighlightClient,
  HighlightCanceledError,
  assignIntervalsToLines,
  renderLineHtml,
  type HighlightInterval,
  type WorkerInit,
} from '@vviewer/highlight';
import { setHighlightFence, type HighlightFence } from '@vviewer/markdown';

/** attach/create 共用选项。 */
export interface MarkdownHighlightWorkerOptions {
  /** 引擎配置（init 握手透传 HighlightClient→worker）：grammar/查询/runtime 来源。 */
  init?: WorkerInit & { debug?: boolean };
  /** worker 构造覆盖：缺省 new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })。 */
  makeWorker?: () => Worker;
  /** worker onerror/协议错误上报回调（如状态栏一次性提示；缺省 client 内 console）。 */
  onWorkerError?: (reason: string) => void;
}

export interface MarkdownHighlightWorkerHandle {
  /** HighlightFence 契约实现（亦可手动经 createMarkdownView 的 highlightFence 注入单视图）。 */
  fence: HighlightFence;
  /** 底层 client（进阶自管：进程池/自定义生命周期时直接用其 highlight/dispose）。 */
  client: HighlightClient;
  /** 解绑注入缝（attach 路径回默认主线程高亮器）并 dispose client（terminate worker、取消在途）。 */
  dispose(): void;
}

/**
 * 由现成 Worker 构造 HighlightFence 契约实现（不触碰注入缝）：worker 形态由宿主
 * 决定（?worker / new URL / ServiceWorker 形态皆可）。对 disposed client 的调用
 * 短路为 HighlightCanceledError 重抛——与「worker 已终止、结果即将作废」语义一致。
 */
export function createMarkdownHighlightFence(
  worker: Worker,
  options: MarkdownHighlightWorkerOptions = {},
): MarkdownHighlightWorkerHandle {
  const client = new HighlightClient(worker, options.init, options.onWorkerError);
  const fence: HighlightFence = async (code, lang) => {
    let intervals: HighlightInterval[];
    try {
      intervals = await client.highlight(code, lang); // init 完成前请求由 worker 侧排队
    } catch (err) {
      if (err instanceof HighlightCanceledError) throw err; // 取消：管线静默跳过该块
      return null; // worker 失败/未知语言：该块降级 hljs
    }
    return intervalsToLineHtml(code, intervals);
  };
  return { fence, client, dispose: () => client.dispose() };
}

/**
 * 一行接入：自建缺省 worker（makeWorker 可覆盖）+ 构造 fence + 注入模块缝。
 * dispose() 解绑（@vviewer/markdown 回落包内默认主线程高亮器）并终止 worker。
 */
export function attachMarkdownHighlightWorker(
  options: MarkdownHighlightWorkerOptions = {},
): MarkdownHighlightWorkerHandle {
  const worker = options.makeWorker
    ? options.makeWorker()
    : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const handle = createMarkdownHighlightFence(worker, options);
  setHighlightFence(handle.fence);
  const dispose = handle.dispose;
  handle.dispose = () => {
    setHighlightFence(null);
    dispose();
  };
  return handle;
}

// ---------- 区间 → 行 HTML（@vviewer/markdown highlightDefault 同源助手） ----------

/** 行表构建（wc -l 口径）：'a\nb\n' → ['a','b']；空文件 '' → []。 */
function buildLineIndex(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

/** 行起始偏移（UTF-16，含前序换行符）：'ab\ncd' → [0, 3]。 */
function buildLineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

/**
 * 区间 → 行 HTML（HighlightFence 契约产物形态）：区间按行分配（内层优先展平）
 * → 行文本 + 段落经 renderLineHtml 生成 span HTML（类名 ts-<capture>，与
 * markdown.css 的 .ts-* 映射段同一来源）。导出供自管 client 的进阶宿主复用。
 */
export function intervalsToLineHtml(code: string, intervals: readonly HighlightInterval[]): string {
  const lines = buildLineIndex(code);
  const byLine = new Map(
    assignIntervalsToLines([...intervals], buildLineOffsets(lines)).map((a) => [a.line, a.segs]),
  );
  return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
}
