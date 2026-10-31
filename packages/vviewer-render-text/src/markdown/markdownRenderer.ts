// markdownRenderer.ts — 转出口（shim）：markdown 渲染器实现已随 @bhxch/vviewer-markdown
// 组合包迁出（packages/vviewer-markdown/src/markdownRenderer.ts，自本包参数化：getRemoteBase
// → setResolveRemoteBase 注入缝、vv:* 事件 → 实例 applyTheme、围栏高亮 →
// setHighlightFence 注入缝 + 包内默认高亮器）。本文件显式 re-export 保持
// '@bhxch/vviewer-render-text/markdown/markdownRenderer' 子路径导出符号面与拆分前逐符号
// 一致（apps/web 与 test/ 的既有 import 零感知）；包内新增面（createMarkdownView
// 等）不属本转出口，需组合包语义时直接 import '@bhxch/vviewer-markdown'。
// fenceToHtml 是唯一的非转出口符号：它是「HighlightClient worker 单例 → 围栏
// HTML」的桥接实现，依赖本包 code/ 的 waitForAttachedClient/renderLineHtml 等
// （client 由 apps/web highlightClient.ts attach 于本包 code 模块，桥必须与
// attach 同包），保留在此供宿主经组合包的 setHighlightFence 注入。
export {
  markdownRenderer,
  slugifyHeading,
  assignHeadingIds,
  remapHeadingHashLinks,
  extractToc,
  collectTextNodes,
  renderMarkdownBody,
  MARKUP_MAX_BYTES,
  setMarkdownBackend,
  getMarkdownBackend,
  setHighlightFence,
  setMarkdownImageResolver,
  getMarkdownImageResolver,
  setDiagramOptions,
  getDiagramOptions,
  type MarkdownEngineState,
  type MarkdownBackendCall,
  type MarkdownBackend,
  type MarkdownImageResolver,
  type DiagramRenderOptions,
  type MarkdownFileMeta
} from '@bhxch/vviewer-markdown';

import { HighlightCanceledError, type HighlightInterval } from '@bhxch/vviewer-highlight';
import {
  waitForAttachedClient,
  buildLineIndex,
  buildLineOffsets,
  assignIntervalsToLines,
  renderLineHtml
} from '../code';

/**
 * 围栏代码高亮桥（组合包 pipeline 的 highlightFence 实现，原 markdownRenderer
 * 内置实现原样迁留）：HighlightClient 区间 → 行分配 → span HTML（类名经
 * captureToCssClass，与 code 渲染器同一来源）。client 未就绪时等待注入
 * （waitForAttachedClient：CDN 层构建使启动预热不再保证早于首个 markdown tab，
 * 同步读 null 会让围栏永久落 hljs 兜底——MD-05/THEME-05 实测竞态）；超时/创建
 * 失败放行 null、语言不在 grammar 清单等失败同样返回 null → 管线内 hljs 兜底；
 * 请求被取消（tab 切换）时重抛 HighlightCanceledError → 管线静默跳过该块、
 * 不再跑 hljs 兜底（结果即将随 tab 丢弃，整篇兜底纯属空转）。
 * 接线：apps/web viewer.ts 启动时 setHighlightFence(fenceToHtml)——单一路径，
 * 组合包内默认主线程高亮器不参与（不双轨化）。
 */
export async function fenceToHtml(code: string, lang: string): Promise<string | null> {
  const client = await waitForAttachedClient();
  if (!client) return null;
  let intervals: HighlightInterval[];
  try {
    intervals = await client.highlight(code, lang);
  } catch (err) {
    if (err instanceof HighlightCanceledError) throw err; // 取消：管线跳过，不 hljs 兜底
    return null; // 其余失败：管线内 hljs 兜底
  }
  const lines = buildLineIndex(code);
  const byLine = new Map(
    assignIntervalsToLines(intervals, buildLineOffsets(lines)).map((a) => [a.line, a.segs])
  );
  return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
}
