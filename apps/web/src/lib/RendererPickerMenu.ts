// RendererPickerMenu.ts — 渲染器自选双入口（布局自由化 Task 3）共享候选构造。
// 状态栏指示器（ViewerPane，壳 A）与 tab 右键「打开方式」子菜单（TabBar →
// TabContextMenu，壳 B）两壳共用；既有 MetaPanel「打开方式」下拉（C 项入口 B）
// 不动，候选面经 openWithOf 委托保持同集同序。纯函数无 runes/DOM——根 vitest 无
// svelte 插件不可直测 .svelte.ts 运行时模块（openWith.ts 同款约束），类型经
// metaStore 结构镜像、Tab 形状以结构化入参承接（不引 openFlow.svelte 运行时）。
import type { Registry } from '@bhxch/vviewer-core';
import type { FileOpenWith } from './metaStore.svelte';
import { openWithOf } from './openWith';

/** 「更多/收起附加候选」哨兵 id（议题一）：纯 UI 语义项，不进 FileOpenWith 数据面，
 * 三壳渲染「更多渲染器…」/「收起」时作 option id 使用，选择处拦截面见各壳。 */
export const MORE_RENDERER_ID = '__more__';
export const LESS_RENDERER_ID = '__less__';

/** 候选项：id '' = 「自动」（两壳选择即 tabStore.setRendererOverride(tabId, null)
 * 清除 override，MetaPanel onOpenWith 同语义）；current = 该候选当前生效。 */
export interface RendererCandidate {
  id: string;
  label: string;
  current: boolean;
}

/** FileOpenWith → 候选（current 标记 = 选中态 id 比对）。ViewerPane 已持有
 * openWithOf 结果（MetaPanel 上行值）时复用同一映射，不再二次查询 registry。 */
export function candidatesOf(ow: FileOpenWith): RendererCandidate[] {
  return ow.options.map((o) => ({ id: o.id, label: o.label, current: o.id === ow.current }));
}

/** 标量入口：与 openWithOf 同参（ViewerPane 持 dispatch 真值 res.rendererId/det.ext）。
 * 候选集/顺序/存在性守卫全部委托 openWithOf——等价性由构造保证，单测仍显式钉住。 */
export function rendererCandidates(
  registry: Pick<Registry, 'byId' | 'all'>,
  overrideRenderer: string | undefined,
  rendererId: string,
  detExt: string
): RendererCandidate[] {
  return candidatesOf(openWithOf(registry, overrideRenderer, rendererId, detExt));
}

/** 名称扩展名（小写、无点）。隐藏文件（.gitignore）/无扩展名/尾点 → ''。 */
export function extOfName(name: string): string {
  const at = name.lastIndexOf('.');
  if (at <= 0 || at === name.length - 1) return '';
  return name.slice(at + 1).toLowerCase();
}

/** Tab 入口（右键壳 B 专用，TabBar 组装子菜单用）：结构化承接 Tab 的渲染运行时
 * 字段（lastRendererId/lastDetExt 由 ViewerPane 渲染成功时写入、不进会话快照）。
 * 未渲染过的 tab（恢复会话后未展示过的他组 tab 等）两字段缺省——rendererId ''
 * 被守卫滤除、扩展名以名称派生兜底，候选面与首次渲染后的真值面一致（签名纠偏
 * 改派 det.ext 的罕见差异在 tab 首次渲染后自然收敛）。 */
export function rendererCandidatesOfTab(
  registry: Pick<Registry, 'byId' | 'all'>,
  tab: {
    overrideRenderer?: string;
    lastRendererId?: string;
    lastDetExt?: string;
    source: { name: string };
  }
): RendererCandidate[] {
  return rendererCandidates(
    registry,
    tab.overrideRenderer,
    tab.lastRendererId ?? '',
    tab.lastDetExt ?? extOfName(tab.source.name)
  );
}
