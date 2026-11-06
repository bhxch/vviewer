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
// 桥法（module worker）：同源 blob 引导体 = URL 垫片 + 动态 import 原 CDN 脚本
// + 就绪标记；主线程侧 bridged 实例缓冲就绪前的 postMessage。
// - URL 垫片：CDN 引擎脚本内存在 new URL(相对路径, self.location.href) 形态的兄弟
//   资产解析（wordperfect worker 的 libwpd.mjs/libwpd.wasm），blob worker 的 location
//   是 opaque URL 不可作相对基（FO-04 实证 Invalid URL）；垫片在该失基形态回落原
//   worker URL（CDN 绝对地址）为基——兄弟解析语义与直连构造逐字一致（CDN 直连时
//   location.href 恰为本 worker URL）。仅桥内 worker 实例全局生效，页面全局零触碰；
//   失基以外路径透传原生 URL 行为。
// - 动态 import 而非静态：ESM 依赖先于导入方求值，静态 import 达不到「垫片先于被引
//   模块求值」的次序。
// - 就绪缓冲：动态 import 期间 worker 初始脚本已结束，主线程构造后立刻 postMessage
//   的首请求会先于 CDN 模块挂监听而丢失（v3 实证 FO-01..07 全灭）——bridged 实例
//   缓冲就绪前的 postMessage，worker 引导完成（postMessage 就绪标记）后按序放行；
//   标记经 stopImmediatePropagation 对页面监听隐藏。classic 备案（importScripts 同步
//   引导，无竞态）：不缓冲不标记。
// 同源 URL 直通不包（本地 /libarchive/ worker、SW 脚本等零影响）；data:/blob: 原样
// 放行。桥仅改「构造入口的 URL」，Worker 契约面（addEventListener/terminate/事件）
// 经继承保留；instanceof Worker 成立。
//
// 装配：AppShell.svelte 模块级副作用 import（先于任何 foreign 渲染）；重复导入幂等
// （模块只执行一次 + 挂标防二次包装）。SSR 不装（typeof Worker 守卫）。

/** 已包装标记（防测试/热更下的二次包装叠加） */
const BRIDGED = '__vvForeignWorkerBridged';

/** 引导体→主线程的就绪标记（postMessage 数据形状；CDP 端标记仅作 flush 信号） */
const READY_MARKER = '__vvForeignWorkerBridgeReady';

/** module worker 引导体：URL 垫片（opaque location 基失基 → 回落原 worker URL 基）
 * + 动态 import 原 CDN 脚本 + 就绪标记（import 落定、CDN 监听挂上后发）。 */
function moduleBootstrap(raw: string): string {
  return [
    `const BASE = ${JSON.stringify(raw)};`,
    '{',
    '  const NativeURL = URL;',
    '  class BridgedURL extends NativeURL {',
    '    constructor(u, base) {',
    '      try {',
    '        return super(u, base);',
    '      } catch {',
    '        return super(u, BASE);',
    '      }',
    '    }',
    '  }',
    '  self.URL = BridgedURL;',
    '}',
    `import(${JSON.stringify(raw)}).then(() => {`,
    `  self.postMessage({ ${JSON.stringify(READY_MARKER)}: true });`,
    '});'
  ].join('\n');
}

interface PendingPost {
  args: unknown[];
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
  if (kind === 'module') {
    return URL.createObjectURL(new Blob([moduleBootstrap(parsed.href)], { type: 'text/javascript' }));
  }
  // classic 备案：importScripts 引导（CDN 脚本内相对 importScripts 以 blob 为基会
  // 失基——@file-viewer 全族均为 module 构造，此路径现网不可达）
  return URL.createObjectURL(
    new Blob([`importScripts(${JSON.stringify(parsed.href)});`], { type: 'text/javascript' })
  );
}

export function installForeignWorkerBridge(): void {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return; // SSR/无 Worker 环境
  const Native = window.Worker as typeof Worker & { [BRIDGED]?: boolean };
  if (Native === undefined || Native[BRIDGED] === true) return;
  class ForeignBridgedWorker extends Worker {
    /** 就绪前缓冲的 postMessage（module 引导桥专用；classic 直通恒空） */
    private __pending: PendingPost[] = [];
    private __ready: boolean;

    constructor(url: string | URL, options?: WorkerOptions) {
      const kind = options?.type === 'module' ? 'module' : 'classic';
      const bridged = bridgeWorkerUrl(url, kind);
      super(bridged, options);
      // 缓冲仅对「实际被桥」的 module worker 生效（跨域 → blob 引导 → 等就绪标记）；
      // 同源直通与 classic 引导零缓冲——同源 worker 不经引导体，就绪标记永不到来，
      // 缓冲会把首请求吞掉（FO2-02 binary.worker 实证：hex 解析挂死、状态栏清空）
      const isBridged =
        typeof bridged === 'string' && bridged.startsWith('blob:') && kind === 'module';
      this.__ready = !isBridged;
      if (this.__ready) return;
      // 就绪标记拦截（本监听先于页面任何监听注册，stopImmediatePropagation 即对
      // 页面不可见）：标记到达 = CDN 模块已求值、其消息监听已挂，缓冲按序放行
      this.addEventListener(
        'message',
        (ev: MessageEvent) => {
          if (ev.data !== null && typeof ev.data === 'object' && (ev.data as Record<string, unknown>)[READY_MARKER] === true) {
            ev.stopImmediatePropagation();
            this.__ready = true;
            const pending = this.__pending;
            this.__pending = [];
            for (const p of pending) {
              (this.postMessage as (data: unknown, transfer?: Transferable[]) => void)(p.args[0], p.args[1] as Transferable[] | undefined);
            }
          }
        },
        { capture: false }
      );
    }

    override postMessage(data: unknown, transfer?: Transferable[]): void;
    override postMessage(data: unknown, options?: StructuredSerializeOptions): void;
    override postMessage(data: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
      if (!this.__ready) {
        this.__pending.push({ args: [data, transferOrOptions] });
        return;
      }
      super.postMessage(data, transferOrOptions as StructuredSerializeOptions);
    }
  }
  (ForeignBridgedWorker as typeof Worker & { [BRIDGED]?: boolean })[BRIDGED] = true;
  window.Worker = ForeignBridgedWorker;
}

installForeignWorkerBridge();
