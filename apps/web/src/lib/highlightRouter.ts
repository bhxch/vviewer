// highlightRouter.ts — BUG-10：>2MB（hljs-block）大文件高亮的远程路由。
// code.ts 渲染端只认 attachHighlightRouter 注入的 fn（不感知策略）；本模块读
// settings 的 computePolicy 做硬护栏：local 恒 null；无服务端 path（用户添加的
// 文件/文件夹）恒 null、零 POST；remote || (auto && 有 path) 走远程——auto 失败
// console.warn + null 回退本地 hljs 分块（可用性优先），显式 remote 失败抛错
//（渲染端错误卡片，不静默回退）。经 computeRouter 组装鉴权头直连
// /api/compute/highlight。与 highlightClient 的常规远程高亮独立：该链路只在
// 本地阈值（2MB）已判定 hljs-block 之后才被问询。
import { decodeHighlightResponse, type ComputeSource, type HighlightInterval } from '@vviewer/core';
import { computeRouter } from './highlightClient';
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
  // auto 下 server-served 文件不限大小走服务端（spec §4 阶段 3）；失败回退本地 hljs 分块
  const call = computeRouter.remoteCall('/api/compute/highlight');
  if (!call) throw new Error('未连接服务器，无法远程高亮');
  // 不挂 tab 级 abort：tab 切换后渲染端以 destroyed 丢弃结果，短连接可接受
  //（常规远程高亮的 remoteAbort 管线在 highlightClient，本链路不经它）
  try {
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
