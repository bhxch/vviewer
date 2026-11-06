// foreignWorkerBridge.ts — 跨域 Worker blob 引导桥（统一验证阶段实证缺陷修复）。
//
// 背景（spec §6.2 部署姿态的浏览器约束补面）：foreign 桥接渲染器的引擎 worker/wasm
// 资产走 @file-viewer/assets-* 的 jsdelivr CDN 直链（spec 决策⑧「大资产不进本项目
// dist」）。wasm/script 的跨域 fetch（CORS）浏览器放行，但 `new Worker(跨域 URL)`
// 被 Worker 同源硬约束直接 SecurityError 拒绝（构造期同步抛错，SW/HTTP 缓存均不及
// 介入）——psd（photoshop.worker.js）、iWork、Hangul、WordPerfect 等专有引擎面因此
// 整体不可用（FO2-04/FO-04 e2e 快照实证：Failed to construct 'Worker': Script at
// 'https://cdn.jsdelivr.net/...' cannot be accessed from origin）。
//
// 修法：同源 blob 引导——跨 URL 构造 Worker 时改从「一行引导 blob」构造，引导体对
// 原 CDN 脚本做模块导入（import '<绝对 URL>'）/经典导入（importScripts('<绝对 URL>')）：
// - 引导 blob 同源 → Worker 构造放行；导入请求为普通 CORS fetch（jsdelivr ACAO:*），
//   顺带落 vv-foreign-assets CacheFirst（SW 规则对 worker 内 fetch 同样生效）；
// - module worker：CDN 脚本内的相对导入以 CDN URL 为基解析，语义与直连构造一致；
//   经典 worker 的 importScripts 相对路径会以 blob 为基——@file-viewer 全族 worker
//   均为自包含 bundle（photoshop.worker.js 实核零相对导入，{ type: 'module' } 构造），
//   经典路径留备案注不特判。
// 同源 URL 直通不包（本地 /libarchive/ worker、SW 脚本等零影响）；data:/blob: URL
// 原样放行。桥仅改「构造入口的 URL」，Worker 契约面（postMessage/terminate/事件）
// 原样继承；instanceof Worker 成立。
//
// 装配：AppShell.svelte 模块级副作用 import（先于任何 foreign 渲染）；重复导入幂等
// （模块只执行一次 + BridgeWorker 挂标防二次包装）。SSR 不装（typeof Worker 守卫）。

/** 已包装标记（防测试/热更下的二次包装叠加） */
const BRIDGED = '__vvForeignWorkerBridged';

function bootstrapSource(raw: string, kind: 'module' | 'classic'): string {
  // 引导体：绝对 URL 单行导入。module 用静态 import（相对导入以 CDN URL 为基，
  // 语义不变）；classic 用 importScripts（@file-viewer 全族无此形态，备案注）。
  return kind === 'module' ? `import ${JSON.stringify(raw)};` : `importScripts(${JSON.stringify(raw)});`;
}

function bridgeWorkerUrl(url: string | URL, kind: 'module' | 'classic'): string | URL {
  let parsed: URL;
  try {
    parsed = new URL(String(url), location.href);
  } catch {
    return url; // 不可解析的原样放行（构造期由浏览器报错，行为同未桥）
  }
  if (parsed.origin === location.origin) return url; // 同源直通
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url; // blob:/data: 等原样
  return URL.createObjectURL(new Blob([bootstrapSource(parsed.href, kind)], { type: 'text/javascript' }));
}

export function installForeignWorkerBridge(): void {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return; // SSR/无 Worker 环境
  const Native = window.Worker as typeof Worker & { [BRIDGED]?: boolean };
  if (Native === undefined || Native[BRIDGED] === true) return;
  class ForeignBridgedWorker extends Worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(bridgeWorkerUrl(url, options?.type === 'module' ? 'module' : 'classic'), options);
    }
  }
  (ForeignBridgedWorker as typeof Worker & { [BRIDGED]?: boolean })[BRIDGED] = true;
  window.Worker = ForeignBridgedWorker;
}

installForeignWorkerBridge();
