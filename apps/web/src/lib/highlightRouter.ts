// highlightRouter.ts — BUG-10：>2MB（hljs-block）大文件高亮的远程路由。
// code.ts 渲染端只认 attachHighlightRouter 注入的 fn（不感知策略）；本模块读
// settings 的 computePolicy 做硬护栏：local 恒 null；无服务端 path（用户添加的
// 文件/文件夹）恒 null、零 POST；remote 恒走远程；auto 须过服务端可服务门
//（capabilities 含 compute 且语言已宣告，见下）且有服务端 path 才走远程——auto
// 失败 console.warn + null 回退本地 hljs 分块（可用性优先），显式 remote 失败
// 抛错（渲染端错误卡片，不静默回退）。经 computeRouter 组装鉴权头直连
// /api/compute/highlight。与 highlightClient 的常规远程高亮独立：该链路只在
// 本地阈值（2MB）已判定 hljs-block 之后才被问询。
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
 * code.ts hljs-block 分支的大文件路由契约（spec §4 阶段 3）：
 * 返回 null = 留在本地 hljs 分块；非 null = 远程 intervals（tree-sitter 路径渲染）；
 * 抛错 = 显式 remote 失败（渲染端如实错误卡片，不静默回退）。
 */
export async function routeLargeFileHighlight(
  src: ComputeSource,
  lang: string
): Promise<HighlightInterval[] | null> {
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
    const res = await fetch(call.url, {
      method: 'POST',
      headers: { ...call.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: src.path, lang })
    });
    if (!res.ok) throw new Error(`远程高亮失败: HTTP ${res.status}`);
    return decodeHighlightResponse(await res.json());
  } catch (err) {
    // 失败分流（!res.ok 与 fetch 网络异常同进 catch）：显式 remote 抛错如实错误
    // 卡片（静默回退会掩盖服务端故障）；auto 可用性优先，warn 留痕后回退本地
    // hljs 分块（>20MB 服务端 413 亦落此回退，阶段 4 解除）
    if (policy === 'auto') {
      console.warn(
        `[vviewer] 大文件远程高亮失败，回退本地分块：${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
    throw err;
  }
}
