// highlightRouter.ts — BUG-10：>2MB（hljs-block）大文件高亮的远程路由。
// code.ts 渲染端只认 attachHighlightRouter 注入的 fn（不感知策略）；本模块读
// settings 的 computePolicy 做硬护栏：local 恒 null；无服务端 path（用户添加的
// 文件/文件夹）恒 null、零 POST；remote 恒走远程；auto 须过服务端可服务门
//（capabilities 含 compute 且语言已宣告，见下）且有服务端 path 才走远程——auto
// 失败 console.warn + null 回退本地 hljs 分块（可用性优先），显式 remote 失败
// 抛错（渲染端错误卡片，不静默回退）。经 computeRouter 组装鉴权头直连
// /api/compute/highlight。与 highlightClient 的常规远程高亮独立：该链路只在
// 本地阈值（2MB）已判定 hljs-block 之后才被问询。
// CMP-02/2：附带会话缓存（cacheId 令牌校验），同 (path,lang,range) 重开时
// 响应体降为服务端确认极小帧（见 sessionHighlights 注）。
import {
  decodeHighlightResponse,
  remoteLanguageAdvertised,
  type ComputeSource,
  type HighlightInterval
} from '@vviewer/core';
import { computeRouter } from './highlightClient';
import { loadCapabilities, loadComputeLanguages } from './openFlow.svelte';
import { loadSettings } from './stores/settings';

/**
 * 大文件路由的 chunk 级结果（阶段 4 range 契约，spec §5.1）：
 * intervals 相对 chunk 首行（服务端已按 range 截取），渲染侧以 baseLine 平移
 * 到全文件行号——与本地 chunk 路径（client.highlight 子文本）对称，本路由不平移。
 */
export interface LargeFileHighlightChunk {
  intervals: HighlightInterval[];
  /** chunk 首行的全文件 0 基行号；旧服务端响应无此字段（serde rename 前部署）兜 0 */
  baseLine: number;
}

/**
 * CMP-02/2 会话缓存：同 (path,lang,range) 关标签重开时，响应体以服务端令牌
 * 校验命中——服务端回 `{"cached":true,"cacheId","baseLine"}` 极小帧（不再重复
 * 传输 MB 级 intervals 本体，BUG-10 验收 2「二次打开可观测更快」的可观测面），
 * intervals 复用本会话缓存。键含 range 维度（chunk 粒度）；令牌由服务端按
 * (缓存键+响应内容) 生成，文件变更（mtime/size 变键）、LRU 淘汰、服务重启都
 * 令校验不匹配而回完整响应，客户端随之刷新条目——正确性不依赖本缓存。
 * 容量 16 条 FIFO（重开场景为最近文件的小子集；intervals 每 chunk 数十 KB 级）。
 */
interface SessionHighlightEntry {
  cacheId: string;
  intervals: HighlightInterval[];
}

const sessionHighlights = new Map<string, SessionHighlightEntry>();
const SESSION_HIGHLIGHT_CAP = 16;

function sessionHighlightKey(
  path: string,
  lang: string,
  range?: { startLine: number; lineCount: number }
): string {
  return range ? `${path}\u0000${lang}\u0000${range.startLine}:${range.lineCount}` : `${path}\u0000${lang}`;
}

function sessionHighlightGet(key: string): SessionHighlightEntry | undefined {
  const entry = sessionHighlights.get(key);
  if (entry) sessionHighlights.set(key, entry); // touch：移到插入序末尾
  return entry;
}

function sessionHighlightPut(key: string, entry: SessionHighlightEntry): void {
  sessionHighlights.delete(key);
  sessionHighlights.set(key, entry);
  while (sessionHighlights.size > SESSION_HIGHLIGHT_CAP) {
    const oldest = sessionHighlights.keys().next().value;
    if (oldest === undefined) break;
    sessionHighlights.delete(oldest);
  }
}

/**
 * code.ts hljs-block 分支的大文件路由契约（spec §4 阶段 3 + §5.1 阶段 4 range）：
 * 返回 null = 留在本地 hljs 分块；非 null = 远程 chunk {intervals, baseLine}
 *（tree-sitter 路径渲染，区间相对 baseLine）；抛错 = 显式 remote 失败（渲染端
 * 如实错误卡片，不静默回退）。range 缺省 = 全文件请求（body 不带 range 字段，
 * 旧请求语义）；渲染层（Task 4）对 server-served 大文件按可视区传 chunk。
 */
export async function routeLargeFileHighlight(
  src: ComputeSource,
  lang: string,
  range?: { startLine: number; lineCount: number }
): Promise<LargeFileHighlightChunk | null> {
  const policy = loadSettings().computePolicy;
  // 硬护栏：local 恒本地。置于注入侧而非渲染端，是既定裁决——渲染端只认回调
  // 结果，不重复实现策略。
  if (policy === 'local') return null;
  // 本地文件无服务端 path 语义，远程高亮无从谈起（用户添加的文件/文件夹恒本地）
  if (typeof src.path !== 'string' || src.path === '') return null;
  // auto 门（BUG-06c 同源，调和 spec §4「auto 判定不看大小」与「>2MB 硬护栏」两段：
  // server-served 不限大小的放宽以服务端真实可服务为前提）——与 ≤2MB 常规链路
  //（highlightClient 装配处）的 hasCompute 门 + 宣告门对齐：capabilities 无 compute
  //（file-only 服务器）或语言未在服务端 computeLanguages 宣告集合内时零请求直落
  // 本地 hljs 分块；集合为空 = 未知（旧服务端），保持先试远程。显式 remote 是用户
  // 选择，不做此门控（失败走 catch 分流如实报错）。
  if (
    policy === 'auto' &&
    !(loadCapabilities().includes('compute') &&
      remoteLanguageAdvertised(lang, new Set(loadComputeLanguages())))
  ) {
    return null;
  }
  // auto 下 server-served 文件不限大小走服务端（spec §4 阶段 3）；失败回退本地 hljs 分块。
  // remoteCall 判空在 try 内：auto 未连接 → warn+null 回退；remote 未连接 → 抛错错误卡片
  try {
    const call = computeRouter.remoteCall('/api/compute/highlight');
    if (!call) throw new Error('未连接服务器，无法远程高亮');
    // 不挂 tab 级 abort：tab 切换后渲染端以 destroyed 丢弃结果，短连接可接受
    //（常规远程高亮的 remoteAbort 管线在 highlightClient，本链路不经它）
    // CMP-02/2：会话缓存有条目则随请求携带 cacheId 令牌，服务端校验命中回极小帧
    const key = sessionHighlightKey(src.path, lang, range);
    const cached = sessionHighlightGet(key);
    const res = await fetch(call.url, {
      method: 'POST',
      headers: { ...call.headers, 'content-type': 'application/json' },
      // range 随参透传（驼峰即服务端 serde rename 后的形状，Task 1）；缺省不带
      // range 字段——旧请求语义，服务端按全文件 text 模式应答 baseLine=0
      body: JSON.stringify({
        path: src.path,
        lang,
        ...(range ? { range } : {}),
        ...(cached ? { cacheId: cached.cacheId } : {})
      })
    });
    if (!res.ok) throw new Error(`远程高亮失败: HTTP ${res.status}`);
    // json 单次消费：decode 与 baseLine 同源读取；baseLine 缺失 = 旧服务端，兜 0
    const json: unknown = await res.json();
    const rawBaseLine = (json as { baseLine?: unknown }).baseLine;
    const baseLine =
      typeof rawBaseLine === 'number' && Number.isFinite(rawBaseLine) ? rawBaseLine : 0;
    // 服务端确认命中（CMP-02/2）：极小帧不含 intervals，复用会话缓存条目。
    // 条目必在（令牌即来自它；被容量逐出则本轮请求根本不会带令牌）
    if ((json as { cached?: unknown }).cached === true) {
      if (cached) return { intervals: cached.intervals, baseLine };
      throw new Error('远程高亮缓存命中但本地会话条目缺失');
    }
    const intervals = decodeHighlightResponse(json);
    const cacheId = (json as { cacheId?: unknown }).cacheId;
    if (typeof cacheId === 'string' && cacheId !== '') {
      // 旧服务端无 cacheId：不缓存，行为与此前一致
      sessionHighlightPut(key, { cacheId, intervals });
    }
    return { intervals, baseLine };
  } catch (err) {
    // 失败分流（!res.ok 与 fetch 网络异常同进 catch）：显式 remote 抛错如实错误
    // 卡片（静默回退会掩盖服务端故障）；auto 可用性优先，warn 留痕后回退本地
    // hljs 分块（阶段 4 range 分块后请求不再超 20MB 上限；chunk 内单行超长等
    // 413 仍落此回退）
    if (policy === 'auto') {
      console.warn(
        `[vviewer] 大文件远程高亮失败，回退本地分块：${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
    throw err;
  }
}
