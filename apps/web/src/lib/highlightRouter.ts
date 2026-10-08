// highlightRouter.ts — BUG-10：>2MB 文件在显式 remote 策略下的远程高亮路由。
// code.ts 渲染端只认 attachHighlightRouter 注入的 fn（不感知策略）；本模块读
// settings 的 computePolicy 做硬护栏（非 remote 恒返回 null → 留本地 hljs 分块，
// 3MB 文件在 auto 下零 POST），remote 时经 computeRouter 组装鉴权头直连
// /api/compute/highlight。与 highlightClient 的常规远程高亮独立：该链路只在
// 本地阈值（2MB）已判定 hljs-block 之后才被问询，失败不回退（渲染端错误卡片）。
import { decodeHighlightResponse, type ComputeSource, type HighlightInterval } from '@vviewer/core';
import { computeRouter } from './highlightClient';
import { loadSettings } from './stores/settings';

/**
 * code.ts hljs-block 分支的大文件路由契约：
 * 返回 null = 留在本地 hljs 分块；非 null = 远程 intervals（tree-sitter 路径渲染）；
 * 抛错 = 显式 remote 失败（渲染端如实错误卡片，不静默回退）。
 */
export async function routeLargeFileHighlight(
  src: ComputeSource,
  lang: string
): Promise<HighlightInterval[] | null> {
  // 硬护栏：仅显式 remote 问路由；auto/local 一律本地（回归护栏：3MB auto 无 POST）。
  // 置于注入侧而非渲染端，是既定裁决——渲染端只认回调结果，不重复实现策略。
  if (loadSettings().computePolicy !== 'remote') return null;
  // 本地文件无服务端 path 语义，远程高亮无从谈起
  if (typeof src.path !== 'string' || src.path === '') return null;
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
}
