// diagramGate.ts — 图表外联闸（spec H T5）。
//
// 约束②「运行时零外网 CDN 依赖」与 README「离线（断网）全功能」冒烟项，在自然实现下
// **不成立**——三处外联路径必须逐条封堵（本模块封前两处，包内 allowRemote 缝封第三处）：
//
// 1. **`modeOf` 的逐语言映射**：`effectiveModeOf`（packages/vviewer-markdown/src/pipeline.ts:201）
//    语义是「requested==='local' 时 `type.local && type.engine` → 'local'，否则
//    `type.krokiType ? 'kroki' : 'source'」→ 对注册表中 **17 个 `local:false` 但有
//    `krokiType` 的类型**（plantuml/c4plantuml/ditaa/blockdiag/nwdiag/actdiag/seqdiag/
//    erd/pikchr/packetdiag/rackdiag/goat/wireviz/structurizr/symbolator/tikz/umlet）
//    请求 'local' 仍会被**升格为 kroki 外联**。故闸关时须**逐语言**判定。
// 2. **CDN 引擎族必须出 'source'**：excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/
//    dbml/d2 虽 `local:true`，但 engine 是 CDN 直链（packages/vviewer-render-diagram/src/
//    markdown/cdnEngines.ts:5 的 `CDN_DEFAULT='https://cdn.jsdelivr.net/npm'`）——
//    `cdnEnginesHost` 只能换 host、不能禁用。
// 3. **local 引擎失败的降级链含 kroki 外联一跳**：包内降级链（pipeline.ts 的 local 失败
//    catch → `appendKrokiImg()` → kroki URL 的 `<img src>`）——由包内 additive 缝
//    `DiagramRenderOptions.allowRemote` 封（false 时直接落源码块，不经 kroki）。
//
// 闸开时的语义与 web 端同（允许升格）；闸关时**永不**返回 'kroki'/'official'/'server'。
import { resolveDiagramType, type DiagramMode } from '@bhxch/vviewer-render-diagram';

/**
 * 真离线引擎集（本地渲染不产生任何外联请求）。
 *
 * - mermaid：本地包渲染
 * - graphviz：viz-js（本地 wasm）；**'hpcc' 渲染器走 CDN 外联**——`resolveDiagramRenderer`
 *   恒返回 undefined 即禁选（graphviz 默认渲染器即 viz-js）
 * - nomnoml / math：本地包渲染
 * - svgbob：本地 wasm 引擎
 */
export const OFFLINE_ENGINES: ReadonlySet<string> = new Set([
  'mermaid',
  'graphviz',
  'nomnoml',
  'math',
  'svgbob'
]);

/** 图表闸的设置面（扩展设置的两项） */
export interface DiagramGateSettings {
  /** 图表渲染模式（'off' = 落源码块） */
  diagramMode: 'local' | 'kroki' | 'off';
  /** 是否允许外联图表服务（默认 false——零外网 CDN 依赖） */
  allowRemoteServices: boolean;
}

/**
 * 逐语言的生效模式。
 *
 * - **闸关**（`allowRemoteServices === false`，默认）：仅离线引擎族给 'local'；其余
 *   （17 个 kroki-only 类型 + 8 个 CDN 引擎族 + 未知语言）一律 'source'（源码块，
 *   零外联）。
 * - **闸开**：'off' → 'source'；'kroki' → 有 krokiType 者 'kroki'、其余 'source'；
 *   'local' → 有本地引擎者 'local'、否则（kroki-only）'kroki'（与 web 端同语义，允许升格）。
 */
export function resolveDiagramMode(lang: string, settings: DiagramGateSettings): DiagramMode {
  const type = resolveDiagramType(lang);
  if (!type) return 'source';
  if (!settings.allowRemoteServices) {
    const offline = type.local && type.engine !== undefined && OFFLINE_ENGINES.has(type.engine);
    return offline ? 'local' : 'source';
  }
  if (settings.diagramMode === 'off') return 'source';
  if (settings.diagramMode === 'kroki') return type.krokiType ? 'kroki' : 'source';
  // 'local'
  if (type.local && type.engine) return 'local';
  return type.krokiType ? 'kroki' : 'source';
}

/**
 * 图表渲染器覆盖：**恒 undefined**。
 *
 * graphviz 有两个渲染器（viz-js 本地 / hpcc 走 CDN 外联）——'hpcc' 禁选（外联渲染器），
 * 缺省即注册表默认渲染器（viz-js，本地）。
 */
export function resolveDiagramRenderer(_lang: string, _settings: DiagramGateSettings): string | undefined {
  return undefined;
}

/**
 * 包内 allowRemote 缝的取值：闸关 → false（包内降级链不经 kroki）；闸开 → true。
 * 缺省 undefined 亦为既有行为（apps/web 零改动），但扩展侧恒给显式值。
 */
export function allowRemoteOf(settings: DiagramGateSettings): boolean {
  return settings.allowRemoteServices;
}
